$ErrorActionPreference = 'Stop'
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'ctrl-tap.cs')
    [CtrlTapHost]::Run()
} catch { [Console]::Error.WriteLine('ctrl-hook-failed'); exit 1 }
