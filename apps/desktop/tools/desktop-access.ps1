$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    if ($request.action -eq 'desktop-list') {
        $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
        $items = @()
        foreach ($item in $windows) { try { $c = $item.Current; if ($c.NativeWindowHandle -ne 0 -and -not $c.IsOffscreen) { $items += @{ window = [string]$c.NativeWindowHandle; title = $c.Name; processId = $c.ProcessId } } } catch {} }
        @{ ok = $true; value = $items } | ConvertTo-Json -Depth 8 -Compress; exit
    }
    $handle = [long]::Parse($request.window)
    if ($handle -le 0) { throw 'invalid-window' }
    $window = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$handle)
    if ($null -eq $window -or $window.Current.IsOffscreen) { throw 'window-unavailable' }
    if ($request.action -eq 'desktop-action' -and $request.operation -eq 'focus') {
        $window.SetFocus(); @{ ok = $true; value = @{ focused = $true; window = $request.window } } | ConvertTo-Json -Compress; exit
    }
    $queue = New-Object 'System.Collections.Generic.Queue[System.Windows.Automation.AutomationElement]'
    $queue.Enqueue($window); $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $items = @(); $target = $null; $count = 0
    while ($queue.Count -gt 0 -and $count -lt 500) {
        $element = $queue.Dequeue(); $count++
        try {
            $current = $element.Current; $id = [string]::Join('.', $element.GetRuntimeId())
            if ($request.node -and $id -eq $request.node) { $target = $element; break }
            $invoke = $null; $value = $null
            $canInvoke = $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)
            $canValue = $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)
            $items += @{ node = $id; name = $current.Name; type = $current.ControlType.ProgrammaticName; enabled = $current.IsEnabled; offscreen = $current.IsOffscreen; invoke = $canInvoke; setValue = ($canValue -and -not $value.Current.IsReadOnly); password = $current.IsPassword }
            $child = $walker.GetFirstChild($element)
            while ($null -ne $child -and $queue.Count -lt 600) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
        } catch {}
    }
    if ($request.action -eq 'desktop-inspect') { @{ ok = $true; value = @{ window = $request.window; controls = $items; truncated = ($queue.Count -gt 0) } } | ConvertTo-Json -Depth 8 -Compress; exit }
    if ($null -eq $target -or -not $target.Current.IsEnabled -or $target.Current.IsPassword) { throw 'control-unavailable' }
    if ($request.operation -eq 'invoke') { $pattern = $target.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $pattern.Invoke() }
    elseif ($request.operation -eq 'set_value') { $pattern = $target.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); if ($pattern.Current.IsReadOnly) { throw 'readonly-control' }; $pattern.SetValue([string]$request.value) }
    else { throw 'unsupported-action' }
    @{ ok = $true; value = @{ action = $request.operation; window = $request.window; node = $request.node; applied = $true; verification = '请重新inspect确认目标状态；invoke成功不代表业务完成' } } | ConvertTo-Json -Depth 8 -Compress
} catch { @{ ok = $false; error = '窗口或控件不可用；请重新观察。部分自绘或提权窗口不支持此接口。' } | ConvertTo-Json -Compress; exit 1 }
