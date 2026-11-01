import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location("voice_worker", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def test_import_and_validation_do_not_load_model_dependencies():
    # The optional engine is lazy; protocol parsing works in a small Python environment.
    request = {"id": "one", "action": "synthesize", "text": "你好。", "rate": 0}
    assert worker.validate_request(request) == request


@pytest.mark.parametrize("value", [None, {}, {"id": "one", "action": "shell"},
    {"id": "one", "action": "synthesize", "text": "", "rate": 0},
    {"id": "one", "action": "synthesize", "text": "a" * 601, "rate": 0},
    {"id": "one", "action": "synthesize", "text": "<|endofprompt|>", "rate": 0},
    {"id": "one", "action": "synthesize", "text": "你好", "rate": True}])
def test_protocol_rejects_commands_and_invalid_payloads(value):
    with pytest.raises(ValueError):
        worker.validate_request(value)


@pytest.mark.parametrize("profile", ["../escape", "/absolute", "voice-invalid", "official-demo/else"])
def test_profile_id_rejects_paths(profile):
    with pytest.raises(ValueError):
        worker.validate_request({"id": "one", "action": "use-profile", "profileId": profile})


def profile_fixture(tmp_path, seconds=4, silent=False, audio_format="wav"):
    import json
    import numpy as np
    import soundfile as sf
    from types import SimpleNamespace
    import torch
    profile_id = "voice-00000000-0000-0000-0000-000000000003"
    directory = tmp_path / profile_id
    directory.mkdir()
    lock = {"engine": {"revision": "engine"}, "model": {"revision": "model"}}
    (directory / "pending.json").write_text(json.dumps({"id": profile_id, "name": "测试", "text": "你好",
        "audioFile": "input." + audio_format, "engineRevision": "engine", "modelRevision": "model"}), encoding="utf-8")
    audio = np.zeros(int(16000 * seconds)) if silent else .2 * np.sin(np.arange(int(16000 * seconds)) / 16000 * 440 * 2 * np.pi)
    sf.write(directory / ("input." + audio_format), audio, 16000)
    engine = SimpleNamespace(frontend=SimpleNamespace(spk2info={}, device=torch.device("cpu")))
    engine.add_zero_shot_spk = lambda text, wav, speaker: engine.frontend.spk2info.update({speaker: {key: torch.ones(1) for key in worker.PROMPT_KEYS}})
    return engine, profile_id, directory, lock


@pytest.mark.parametrize("audio_format", ["wav", "flac", "mp3"])
def test_reference_normalizes_saves_and_loads_features_without_reextracting(tmp_path, audio_format):
    import soundfile as sf
    engine, profile_id, directory, lock = profile_fixture(tmp_path, audio_format=audio_format)
    source = directory / ("input." + audio_format)
    original = source.read_bytes()
    worker.prepare_profile(engine, profile_id, tmp_path, lock)
    assert source.read_bytes() == original
    assert sf.info(directory / "reference.wav").samplerate == 24000
    assert sf.info(directory / "reference.wav").format == "WAV"
    assert worker.read_profile_json(directory / "profile.json")["status"] == "ready"
    engine.frontend.spk2info.clear()
    engine.add_zero_shot_spk = lambda *args: pytest.fail("saved features must be reused")
    worker.use_profile(engine, profile_id, tmp_path, tmp_path / "bundled", lock)
    assert set(engine.frontend.spk2info[profile_id]) == worker.PROMPT_KEYS


@pytest.mark.parametrize("seconds,silent,audio_format", [(0.2, False, "wav"), (31, False, "wav"), (4, True, "wav"),
    (0.2, False, "mp3"), (31, False, "mp3"), (4, True, "mp3")])
def test_reference_rejects_duration_and_silence_before_publication(tmp_path, seconds, silent, audio_format):
    engine, profile_id, directory, lock = profile_fixture(tmp_path, seconds, silent, audio_format)
    with pytest.raises(ValueError):
        worker.prepare_profile(engine, profile_id, tmp_path, lock)
    assert not (directory / "profile.json").exists()


def test_corrupted_mp3_is_rejected_without_publishing_voice(tmp_path):
    engine, profile_id, directory, lock = profile_fixture(tmp_path, audio_format="mp3")
    source = directory / "input.mp3"
    broken = b"not an audio file" * 10
    source.write_bytes(broken)
    with pytest.raises((RuntimeError, ValueError)):
        worker.prepare_profile(engine, profile_id, tmp_path, lock)
    assert source.read_bytes() == broken
    assert not (directory / "profile.json").exists()


def test_failure_status_separates_vram_from_saved_voice_without_exposing_exception_data():
    result = worker.failure_info(RuntimeError("CUDA out of memory at private-path"), "ENGINE_LOAD")
    assert result["code"] == "GPU_MEMORY"
    assert "private-path" not in result["error"]
    assert worker.failure_info(ValueError("private recording text"), "PROFILE_LOAD")["code"] == "PROFILE_LOAD"


@pytest.mark.parametrize("extra", [{"style": "unknown"}, {"style": {}}, {"stream": 1}, {"stream": "true"}])
def test_style_and_stream_protocol_are_strict(extra):
    with pytest.raises(ValueError):
        worker.validate_request({"id": "one", "action": "synthesize", "text": "你好。", "rate": 0, **extra})


def engine_fixture():
    from types import SimpleNamespace
    import torch
    cached = {key: torch.ones(1) for key in worker.PROMPT_KEYS}
    calls = []
    frontend = SimpleNamespace(spk2info={"official-demo": cached})
    frontend._extract_text_token = lambda text: (torch.tensor([[len(text)]], dtype=torch.int32), torch.tensor([1], dtype=torch.int32))
    frontend.text_normalize = lambda text, split=True: [text]
    frontend.frontend_zero_shot = lambda *args: {**cached, "text": torch.tensor([[1]])}
    def tts(**kwargs):
        calls.append(kwargs)
        yield {"tts_speech": torch.ones(1, 6000) * .1}
        yield {"tts_speech": torch.ones(1, 6000) * .2}
    model = SimpleNamespace(tts=tts, token_hop_len=100)
    engine = SimpleNamespace(frontend=frontend, model=model, sample_rate=24000, _cute_partner_stream_hop=25)
    engine.inference_zero_shot = lambda *args, **kwargs: tts(**kwargs)
    return engine, cached, calls


@pytest.mark.parametrize("style", ["soft", "happy", "calm"])
def test_style_replaces_cached_prompt_per_request_without_mutating_saved_voice(style):
    import torch
    engine, cached, calls = engine_fixture()
    original = {key: value.clone() for key, value in cached.items()}
    list(worker.inference_with_style(engine, {"text": "你好。", "rate": 0, "style": style}, True))
    assert engine.model.token_hop_len == 25
    assert calls[0]["prompt_text"].item() == len(worker.STYLES[style])
    assert "llm_prompt_speech_token" not in calls[0]
    assert "llm_prompt_speech_token_len" not in calls[0]
    assert calls[0]["flow_embedding"] is cached["flow_embedding"]
    for key in original:
        assert torch.equal(original[key], cached[key])


def test_stream_emits_decodable_ordered_chunks_and_accounts_for_ack_wait(monkeypatch):
    import torch
    import io
    import base64
    import soundfile as sf
    import time
    engine, _, _ = engine_fixture()
    monkeypatch.setattr(torch.cuda, "reset_peak_memory_stats", lambda: None)
    monkeypatch.setattr(torch.cuda, "max_memory_allocated", lambda: 0)
    chunks, acknowledgements = [], []
    def acknowledge(index):
        acknowledgements.append(index)
        time.sleep(.006)
    result = worker.synthesize(engine, {"text": "你好。", "rate": 0, "style": "natural", "stream": True}, chunks.append, acknowledge)
    assert result["type"] == "audio-end"
    assert result["chunks"] == 2
    assert [chunk["index"] for chunk in chunks] == acknowledgements == [0, 1]
    assert sum(sf.info(io.BytesIO(base64.b64decode(c["audio"]))).frames for c in chunks) == 12000
    assert result["metrics"]["transportWaitMs"] >= 10
    assert result["metrics"]["totalMs"] >= result["metrics"]["synthesisMs"]


def test_nondefault_rate_and_legacy_clients_receive_one_complete_wave(monkeypatch):
    import torch
    import io
    import base64
    import soundfile as sf
    monkeypatch.setattr(torch.cuda, "reset_peak_memory_stats", lambda: None)
    monkeypatch.setattr(torch.cuda, "max_memory_allocated", lambda: 0)
    for value in [{"text": "你好。", "rate": 1, "stream": True}, {"text": "你好。", "rate": 0}]:
        engine, _, calls = engine_fixture()
        result = worker.synthesize(engine, value, lambda _: pytest.fail("must not emit chunks"))
        assert result["type"] == "audio"
        assert sf.info(io.BytesIO(base64.b64decode(result["audio"]))).frames == 12000
        assert calls[0]["stream"] is False
        assert calls[0]["speed"] == 1 + value["rate"] * .06


def test_acknowledgement_cannot_be_a_different_job_or_an_extra_request():
    import io
    import json
    valid = {"id": "one", "action": "chunk-ack", "index": 0}
    worker.read_chunk_ack("one", 0, io.StringIO(json.dumps(valid) + "\n"))
    for value in [{**valid, "id": "other"}, {**valid, "index": 1}, {**valid, "index": False}, {**valid, "text": "unexpected"}, {"action": "synthesize"}]:
        with pytest.raises(ValueError):
            worker.read_chunk_ack("one", 0, io.StringIO(json.dumps(value) + "\n"))
