"""Owned stdio-only CosyVoice3 worker. No network, playback, file searching or user data collection."""
import argparse
import base64
import contextlib
import io
import json
import os
from pathlib import Path
import re
import sys
import time

MAX_TEXT = 600
MAX_AUDIO = 5_000_000
STYLES = {"natural": None,
          "soft": "You are a helpful assistant. 请用温柔、清晰的普通话说话。<|endofprompt|>",
          "happy": "You are a helpful assistant. 请非常开心地说一句话。<|endofprompt|>",
          "calm": "You are a helpful assistant. 请用平静自然的语气说话。<|endofprompt|>"}
PROFILE_ID = re.compile(r"voice-[a-f0-9-]{36}\Z")
PROMPT_KEYS = {"prompt_text", "prompt_text_len", "llm_prompt_speech_token", "llm_prompt_speech_token_len",
               "flow_prompt_speech_token", "flow_prompt_speech_token_len", "prompt_speech_feat",
               "prompt_speech_feat_len", "llm_embedding", "flow_embedding"}


def validate_request(value):
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not 1 <= len(value["id"]) <= 100:
        raise ValueError("invalid request")
    if value.get("action") not in ("synthesize", "health", "shutdown", "use-profile", "prepare-profile"):
        raise ValueError("invalid action")
    profile = value.get("profileId", "official-demo")
    if not isinstance(profile, str) or profile != "official-demo" and not PROFILE_ID.fullmatch(profile):
        raise ValueError("invalid profile")
    if value["action"] == "prepare-profile" and not PROFILE_ID.fullmatch(profile):
        raise ValueError("invalid custom profile")
    if value["action"] == "synthesize":
        text, rate = value.get("text"), value.get("rate")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT or "<|" in text:
            raise ValueError("invalid spoken text")
        if type(rate) is not int or not -3 <= rate <= 3:
            raise ValueError("invalid rate")
        if not isinstance(value.get("style", "natural"), str) or value.get("style", "natural") not in STYLES or type(value.get("stream", False)) is not bool:
            raise ValueError("invalid style or stream")
    return value


def emit(value, output=None):
    output = output or sys.stdout
    output.write(json.dumps(value, ensure_ascii=False) + "\n")
    output.flush()


def failure_info(error, stage):
    if "out of memory" in str(error).lower():
        return {"code": "GPU_MEMORY", "error": "显存不足，请关闭其他占用显存的程序后重新加载声音"}
    messages = {"ENGINE_LOAD": "CosyVoice3模型加载失败，请重新加载声音或检查可选语音包",
                "PROFILE_LOAD": "所选音色未加载成功，请重新加载声音；若持续失败请检查保存的音色",
                "PROFILE_PREPARE": "参考音色准备失败，请检查3–30秒WAV/FLAC/MP3录音和对应文字",
                "VOICE_GENERATE": "本机语音生成失败，文字已保留"}
    return {"code": stage, "error": messages[stage], "retryable": stage == "ENGINE_LOAD" and not isinstance(error, (FileNotFoundError, ModuleNotFoundError, ValueError))}


def block_network():
    import socket
    def deny(*args, **kwargs):
        raise OSError("voice worker is offline")
    socket.create_connection = deny
    socket.socket.connect = deny
    socket.socket.connect_ex = deny


def load_engine(root):
    source, model = root / "source", root / "model"
    if not (model / "verified-assets.json").is_file() or not (source / "cosyvoice/cli/cosyvoice.py").is_file():
        raise ValueError("module files missing")
    sys.path[:0] = [str(source), str(source / "third_party/Matcha-TTS")]
    # Local paths only; missing assets must fail rather than trigger an implicit model download.
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1")
    import logging
    import torch
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    logging.disable(logging.CRITICAL)
    torch.set_num_threads(4)
    if not torch.cuda.is_available():
        raise RuntimeError("this module build requires CUDA")
    torch.cuda.reset_peak_memory_stats()
    from cosyvoice.cli.cosyvoice import AutoModel
    engine = AutoModel(model_dir=str(model), fp16=True, load_trt=False)
    engine._cute_partner_stream_hop = engine.model.token_hop_len
    engine.add_zero_shot_spk(
        "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。",
        str(source / "asset/zero_shot_prompt.wav"), "official-demo")
    return engine


def read_profile_json(file):
    if file.stat().st_size > 16384:
        raise ValueError("profile metadata too large")
    value = json.loads(file.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError("invalid profile metadata")
    return value


def prepare_profile(engine, profile_id, profiles, lock):
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    from math import gcd
    directory = profiles / profile_id
    metadata = read_profile_json(directory / "pending.json")
    if (metadata.get("id") != profile_id or metadata.get("audioFile") not in ("input.wav", "input.flac", "input.mp3")
            or metadata.get("engineRevision") != lock["engine"]["revision"]
            or metadata.get("modelRevision") != lock["model"]["revision"]):
        raise ValueError("invalid profile metadata")
    text, name = metadata.get("text"), metadata.get("name")
    if (not isinstance(text, str) or not text.strip() or len(text) > 500 or "<" in text or ">" in text
            or not isinstance(name, str) or not name.strip() or len(name) > 40):
        raise ValueError("invalid reference transcript")
    source = directory / metadata["audioFile"]
    if source.stat().st_size > 20_000_000:
        raise ValueError("reference too large")
    info = sf.info(source)
    seconds = info.frames / info.samplerate
    if info.channels not in (1, 2) or not 8000 <= info.samplerate <= 96000 or not 3 <= seconds <= 30:
        raise ValueError("reference must be 3-30 seconds, mono/stereo and 8-96kHz")
    audio, rate = sf.read(source, frames=30 * info.samplerate + 1, dtype="float32", always_2d=True)
    seconds = len(audio) / rate
    if not 3 <= seconds <= 30:
        raise ValueError("decoded reference must be 3-30 seconds")
    if not np.isfinite(audio).all():
        raise ValueError("non-finite reference audio")
    audio = audio.mean(axis=1)
    peak = float(np.abs(audio).max())
    if peak < 0.01 or float(np.sqrt(np.mean(audio ** 2))) < 0.001:
        raise ValueError("reference is silent")
    audio = audio * min(1, 0.9 / peak)
    divisor = gcd(rate, 24000)
    audio = resample_poly(audio, 24000 // divisor, rate // divisor)
    sf.write(directory / "reference.wav", audio, 24000, subtype="PCM_16")
    engine.add_zero_shot_spk("You are a helpful assistant.<|endofprompt|>" + text,
                             str(directory / "reference.wav"), profile_id)
    features = engine.frontend.spk2info[profile_id]
    torch.save({key: tensor.detach().cpu() for key, tensor in features.items()}, directory / "prompt.pt")
    ready = {"id": profile_id, "name": name.strip(), "text": text.strip(), "status": "ready",
             "seconds": round(seconds, 3), "engineRevision": lock["engine"]["revision"],
             "modelRevision": lock["model"]["revision"]}
    temporary = directory / "profile.json.tmp"
    temporary.write_text(json.dumps(ready, ensure_ascii=False), encoding="utf-8")
    temporary.replace(directory / "profile.json")


def use_profile(engine, profile_id, profiles, bundled, lock):
    import torch
    if profile_id in engine.frontend.spk2info:
        return
    for base in (bundled, profiles):
        directory = base / profile_id
        if (directory / "profile.json").is_file():
            break
    else:
        raise ValueError("saved voice not found")
    metadata = read_profile_json(directory / "profile.json")
    if (metadata.get("id") != profile_id or metadata.get("status") != "ready"
            or metadata.get("engineRevision") != lock["engine"]["revision"]
            or metadata.get("modelRevision") != lock["model"]["revision"]
            or (directory / "prompt.pt").stat().st_size > 20_000_000):
        raise ValueError("saved voice incompatible")
    features = torch.load(directory / "prompt.pt", map_location="cpu", weights_only=True)
    if not isinstance(features, dict) or set(features) != PROMPT_KEYS:
        raise ValueError("invalid saved features")
    if not all(isinstance(v, torch.Tensor) and v.numel() <= 2_000_000 and torch.isfinite(v).all() for v in features.values()):
        raise ValueError("invalid saved tensors")
    engine.frontend.spk2info[profile_id] = {key: tensor.to(engine.frontend.device) for key, tensor in features.items()}


def inference_with_style(engine, value, stream):
    profile = value.get("profileId", "official-demo")
    style = value.get("style", "natural")
    speed = 1 + value["rate"] * 0.06
    if stream:
        # The upstream stream loop grows this shared hop length. Reset it for repeatable first chunks.
        engine.model.token_hop_len = engine._cute_partner_stream_hop
    if style == "natural":
        yield from engine.inference_zero_shot(value["text"], "", "", zero_shot_spk_id=profile, stream=stream, speed=speed)
        return
    frontend = engine.frontend
    instruction, instruction_len = frontend._extract_text_token(STYLES[style])
    for text in frontend.text_normalize(value["text"], split=True):
        # Same instruct2 inputs as upstream, but replace cached transcript tokens explicitly.
        # Do not mutate spk2info or persist a different voice profile.
        inputs = frontend.frontend_zero_shot(text, "", "", engine.sample_rate, profile)
        inputs["prompt_text"], inputs["prompt_text_len"] = instruction, instruction_len
        inputs.pop("llm_prompt_speech_token", None)
        inputs.pop("llm_prompt_speech_token_len", None)
        yield from engine.model.tts(**inputs, stream=stream, speed=speed)


def read_chunk_ack(request_id, index, source=None):
    line = (source or sys.stdin).readline(16385)
    if not line or len(line) > 16384:
        raise ValueError("missing chunk acknowledgement")
    value = json.loads(line)
    if not isinstance(value, dict) or type(value.get("index")) is not int or value != {"id": request_id, "action": "chunk-ack", "index": index}:
        raise ValueError("invalid chunk acknowledgement")


def synthesize(engine, value, on_chunk=None, acknowledge=None):
    import torch
    import soundfile as sf
    import numpy as np
    seed = os.environ.get("CUTE_PARTNER_VOICE_TEST_SEED")
    if seed is not None:
        import random
        random.seed(int(seed))
        np.random.seed(int(seed))
        torch.manual_seed(int(seed))
        torch.cuda.manual_seed_all(int(seed))
    started, first_chunk = time.perf_counter(), None
    parts, samples, chunks, wait_seconds = [], 0, 0, 0
    torch.cuda.reset_peak_memory_stats()
    wire_stream = value.get("stream", False) and value["rate"] == 0 and on_chunk is not None
    engine_stream = (wire_stream or os.environ.get("CUTE_PARTNER_VOICE_ENGINE_STREAM") == "1") and value["rate"] == 0
    for output in inference_with_style(engine, value, engine_stream):
        first_chunk = first_chunk or time.perf_counter()
        part = output["tts_speech"].detach().float().cpu()
        if part.ndim != 2 or part.shape[0] != 1 or not part.shape[-1] or not torch.isfinite(part).all():
            raise ValueError("invalid engine audio")
        samples += part.shape[-1]
        if samples * 2 + 44 * (chunks + 1) > MAX_AUDIO or chunks >= 128:
            raise ValueError("audio exceeds limit")
        if wire_stream:
            buffer = io.BytesIO()
            sf.write(buffer, part.squeeze(0).numpy(), engine.sample_rate, format="WAV", subtype="PCM_16")
            on_chunk({"type": "audio-chunk", "index": chunks, "audio": base64.b64encode(buffer.getvalue()).decode("ascii")})
            wait_started = time.perf_counter()
            if acknowledge is None:
                raise ValueError("missing acknowledgement handler")
            acknowledge(chunks)
            wait_seconds += time.perf_counter() - wait_started
        else:
            parts.append(part)
        chunks += 1
    if not chunks:
        raise ValueError("empty audio")
    elapsed = time.perf_counter() - started
    seconds = samples / engine.sample_rate
    metrics = {"synthesisMs": round((elapsed - wait_seconds) * 1000), "firstEngineChunkMs": round((first_chunk - started) * 1000),
               "audioSeconds": round(seconds, 3), "rtf": round((elapsed - wait_seconds) / seconds, 3),
               "transportWaitMs": round(wait_seconds * 1000), "totalMs": round(elapsed * 1000), "chunkCount": chunks,
               "peakCudaMiB": round(torch.cuda.max_memory_allocated() / 1048576, 1)}
    if wire_stream:
        return {"type": "audio-end", "chunks": chunks, "metrics": metrics}
    audio = torch.cat(parts, dim=-1).squeeze(0).numpy()
    if not np.isfinite(audio).all():
        raise ValueError("invalid engine audio")
    buffer = io.BytesIO()
    sf.write(buffer, audio, engine.sample_rate, format="WAV", subtype="PCM_16")
    data = buffer.getvalue()
    if len(data) > MAX_AUDIO:
        raise ValueError("audio exceeds limit")
    return {"type": "audio", "audio": base64.b64encode(data).decode("ascii"), "metrics": metrics}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--bundled-profiles", required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stdin.reconfigure(encoding="utf-8")
    protocol_output = sys.stdout
    started = time.perf_counter()
    block_network()
    profiles, bundled = Path(args.profiles).resolve(), Path(args.bundled_profiles).resolve()
    lock = read_profile_json(Path(__file__).with_name("assets.lock.json"))
    try:
        with contextlib.redirect_stdout(sys.stderr):
            engine = load_engine(Path(args.root).resolve())
        emit({"type": "ready", "protocolVersion": 1, "capabilities": {"audioChunks": True, "styles": list(STYLES)}, "loadMs": round((time.perf_counter() - started) * 1000), "sampleRate": engine.sample_rate})
    except Exception as error:
        print("CosyVoice3 load failed: " + type(error).__name__, file=sys.stderr)
        if os.environ.get("CUTE_PARTNER_VOICE_DIAGNOSTICS") == "1":
            import traceback
            traceback.print_exc(file=sys.stderr)
        emit({"type": "fatal", **failure_info(error, "ENGINE_LOAD")})
        return 1
    while True:
        line = sys.stdin.readline(16385)
        if not line:
            break
        if len(line) > 16384:
            return 1
        request_id = None
        value = {}
        stage = "VOICE_GENERATE"
        try:
            value = validate_request(json.loads(line))
            request_id = value["id"]
            if value["action"] == "shutdown":
                emit({"id": request_id, "type": "bye"})
                break
            if value["action"] == "health":
                emit({"id": request_id, "type": "health", "ready": True})
                continue
            with contextlib.redirect_stdout(sys.stderr):
                profile_id = value.get("profileId", "official-demo")
                if value["action"] == "prepare-profile":
                    stage = "PROFILE_PREPARE"
                    prepare_profile(engine, profile_id, profiles, lock)
                    result = {"type": "profile-ready", "profileId": profile_id}
                else:
                    stage = "PROFILE_LOAD"
                    use_profile(engine, profile_id, profiles, bundled, lock)
                    if value["action"] == "use-profile":
                        import torch
                        torch.cuda.synchronize()
                    stage = "VOICE_GENERATE" if value["action"] == "synthesize" else "PROFILE_LOAD"
                    result = {"type": "profile-ready", "profileId": profile_id} if value["action"] == "use-profile" else synthesize(
                        engine, value, on_chunk=lambda chunk: emit({"id": request_id, **chunk}, protocol_output),
                        acknowledge=lambda index: read_chunk_ack(request_id, index))
            emit({"id": request_id, **result})
        except Exception as error:
            print("CosyVoice3 request failed: " + type(error).__name__, file=sys.stderr)
            if os.environ.get("CUTE_PARTNER_VOICE_DIAGNOSTICS") == "1":
                import traceback
                traceback.print_exc(file=sys.stderr)
            emit({"id": request_id, "type": "error", **failure_info(error, stage)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
