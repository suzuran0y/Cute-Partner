[CmdletBinding()]
param([string]$NodePath)

$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
try {
    if (-not $NodePath) {
        $taskNode = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
        if ($taskNode) { $NodePath = $taskNode.Source }
        else { $NodePath = Join-Path $taskRoot 'node_modules\electron\dist\electron.exe' }
    }
    if (-not $NodePath -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
        throw 'The runtime is missing. Complete the base installation described in README section 3.3.'
    }
    # Share the normal start route, including logs and Electron environment handling.
    # Electron also supplies Node mode when Explorer has not refreshed its PATH.
    $taskStart = New-Object System.Diagnostics.ProcessStartInfo
    $taskStart.FileName = $NodePath
    $taskStart.Arguments = '"' + (Join-Path $taskRoot 'tools\start.cjs') + '"'
    $taskStart.WorkingDirectory = $taskRoot
    $taskStart.UseShellExecute = $false
    $taskStart.CreateNoWindow = $true
    $taskStart.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
    $taskProcess = [System.Diagnostics.Process]::Start($taskStart)
    try {
        $taskProcess.WaitForExit()
        $taskExitCode = $taskProcess.ExitCode
    } finally { $taskProcess.Dispose() }
    if ($taskExitCode -ne 0) { throw 'Startup failed. See apps/desktop/.runtime/desktop.log and README section 3.3.' }
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Cute-Partner', 'OK', 'Error') | Out-Null
    exit 1
}
