$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
    $taskInput = [Console]::In.ReadToEnd() | ConvertFrom-Json
    Add-Type -AssemblyName System.Speech
    $taskSynth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $taskVoices = @($taskSynth.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | ForEach-Object { @{ name = $_.VoiceInfo.Name; culture = $_.VoiceInfo.Culture.Name } })
    if ($taskInput.action -eq 'voices') { @{ ok = $true; voices = $taskVoices } | ConvertTo-Json -Depth 4 -Compress }
    else {
        if ($taskInput.text -isnot [string] -or $taskInput.text.Length -lt 1 -or $taskInput.text.Length -gt 600) { throw 'invalid-text' }
        $taskVoice = $taskVoices | Where-Object { $_.name -eq $taskInput.voice } | Select-Object -First 1
        if (-not $taskVoice) { $taskVoice = $taskVoices | Where-Object { $_.name -eq 'Microsoft Huihui Desktop' } | Select-Object -First 1 }
        if (-not $taskVoice) { $taskVoice = $taskVoices | Select-Object -First 1 }
        if (-not $taskVoice) { throw 'missing-voice' }
        $taskSynth.SelectVoice($taskVoice.name)
        $taskSynth.Rate = [Math]::Max(-3, [Math]::Min(3, [int]$taskInput.rate))
        $taskStream = New-Object System.IO.MemoryStream
        $taskSynth.SetOutputToWaveStream($taskStream)
        $taskSynth.Speak($taskInput.text)
        $taskBytes = $taskStream.ToArray()
        if ($taskBytes.Length -gt 5000000) { throw 'audio-too-long' }
        @{ ok = $true; voice = $taskVoice.name; audio = [Convert]::ToBase64String($taskBytes) } | ConvertTo-Json -Compress
        $taskStream.Dispose()
    }
    $taskSynth.Dispose()
} catch { [Console]::WriteLine('{"ok":false,"error":"本机中文语音合成不可用"}'); exit 1 }
