param([switch]$Plan)
$ErrorActionPreference = 'Stop'
$voiceRepoRoot = Split-Path -Parent $PSScriptRoot
$voiceDesktopRoot = Join-Path $voiceRepoRoot 'apps\desktop'
$voiceInstallRoot = Join-Path $voiceDesktopRoot '.runtime\components\voice-cosyvoice3\dev'
$voiceSourceRoot = Join-Path $voiceInstallRoot 'source'
$voicePython = Join-Path $voiceInstallRoot 'venv\Scripts\python.exe'
$voiceLock = Get-Content -LiteralPath (Join-Path $voiceDesktopRoot 'optional-modules\cosyvoice3\assets.lock.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$voiceSteps = @('核对 Python 3.11 与 Git','下载固定版本 CosyVoice 及子模块','创建独立 venv，安装锁定依赖（含 CUDA 12.1 PyTorch）','显式下载并逐文件核验语音权重','运行依赖检查与 worker pytest','执行本地合成/取消/退出验证，成功才注册模块')
Write-Output ('可选模块位置：' + $voiceInstallRoot)
$voiceSteps | ForEach-Object { Write-Output ('- ' + $_) }
Write-Output '模型文件约5.43GB，另需Python环境和下载空间；此安装不会调用聊天API。运行安装命令表示允许下载与本地合成验收。'
if ($Plan) { Write-Output '仅展示计划，没有安装、联网或合成。'; exit 0 }
function Invoke-VoiceStep([scriptblock]$Step) { & $Step; if ($LASTEXITCODE -ne 0) { throw ('步骤失败，退出码：' + $LASTEXITCODE + '。文件保留，可检查后重试。') } }
Get-Command git,py,node -ErrorAction Stop | Out-Null
Invoke-VoiceStep { py -3.11 -c "import sys; assert sys.version_info[:2] == (3,11)" }
if (Test-Path -LiteralPath $voiceSourceRoot) {
 $voiceCommit = (& git -C $voiceSourceRoot rev-parse HEAD).Trim()
 if ($LASTEXITCODE -ne 0 -or $voiceCommit -ne $voiceLock.engine.revision) { throw '已有源码版本不符，不覆盖。请改用新的独立安装位置或检查安装记录。' }
} else {
 New-Item -ItemType Directory -Path $voiceInstallRoot -Force | Out-Null
 Invoke-VoiceStep { git clone --no-checkout https://github.com/QwenAudio/CosyVoice.git $voiceSourceRoot }
 Invoke-VoiceStep { git -C $voiceSourceRoot checkout --detach $voiceLock.engine.revision }
 Invoke-VoiceStep { git -C $voiceSourceRoot submodule update --init --recursive }
}
if (-not (Test-Path -LiteralPath $voicePython)) { Invoke-VoiceStep { py -3.11 -m venv (Join-Path $voiceInstallRoot 'venv') } }
Invoke-VoiceStep { & $voicePython -m pip install torch==2.3.1+cu121 torchaudio==2.3.1+cu121 --index-url https://download.pytorch.org/whl/cu121 }
Invoke-VoiceStep { & $voicePython -m pip install -r (Join-Path $voiceDesktopRoot 'optional-modules\cosyvoice3\environment-win-cu121.lock.txt') }
Invoke-VoiceStep { node (Join-Path $voiceDesktopRoot 'tools\prepare-cosyvoice-assets.cjs') }
Invoke-VoiceStep { & $voicePython -m pip check }
Invoke-VoiceStep { & $voicePython -m pytest (Join-Path $voiceDesktopRoot 'optional-modules\cosyvoice3\test_worker.py') -q }
Invoke-VoiceStep { node (Join-Path $voiceDesktopRoot 'tools\check-cosyvoice.cjs') --register }
Write-Output '模块已通过本地准备与注册检查；重新打开角色后，在语音页选择音色。听感请自行试听。'
