# dsh-translate 外部划译伴生进程（Windows / Windows PowerShell 5.1，零外部依赖）
#
# 职责：DSH 页面之外的「划译」——
#   手势（拖选 / 双击选词）→ UIA TextPattern 读选区（不碰剪贴板）
#   → 读不到才注入一次 Ctrl+C 读剪贴板（带扫描码；读完还原）
#   → POST 到 DSH 的 /dsh-translate/api → 光标旁原生置顶浮窗显示译文。
#
# 纪律：
#   · 不装任何运行时、不起浏览器：UIA 走 .NET 托管 API，浮窗走 WinForms。
#   · 剪贴板是用户的：只在 UIA 读不到时注入，注入前保存、读完还原；终端窗口一律跳过。
#   · 一次手势只翻一次；同一段文字 5 秒内不重复翻。
#   · 进程随 DSH 走：-ParentPid 指定的进程没了就自己退出；DSH 也会在插件卸载时杀掉本进程。
#
# 参数：
#   -Port         DSH Web 端口（默认 61213）
#   -Target       目标语言（auto / zh-Hans / zh-Hant / en / ja ...）
#   -Tone         语气（natural / literal / casual / formal / business）
#   -ParentPid    宿主进程 PID（看门狗用，0 = 不监控）
#   -PollMs       鼠标轮询间隔（默认 45ms）
#   -MaxChars     单次选区字符上限（默认 4000）
#   -LogPath      日志文件
#   -SelfTest     自检：装配 UIA/HTTP/窗口，跑一次真实翻译后退出（不装 UI 循环）
#   -NoUi         只取词不弹窗（排障用）

param(
    [int]$Port = 61213,
    [string]$Target = 'auto',
    [string]$Tone = 'natural',
    [int]$ParentPid = 0,
    [int]$PollMs = 45,
    [int]$MaxChars = 4000,
    [string]$LogPath = "$env:TEMP\dsh-translate-capture.log",
    [switch]$SelfTest,
    [switch]$Probe,
    [switch]$TestOverlay,
    [switch]$NoUi
)

$ErrorActionPreference = 'Stop'
$script:ScriptVersion = '1.1.0'

# ───────────────────────────── 日志 ─────────────────────────────

function Write-Log([string]$message) {
    try {
        $line = ('{0} {1}' -f (Get-Date -Format 'HH:mm:ss.fff'), $message)
        if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt 1MB)) { Remove-Item $LogPath -Force }
        Add-Content -Path $LogPath -Value $line -Encoding UTF8
    } catch { }
}

# ───────────────────────────── 原生互操作 ─────────────────────────────

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase, System.Windows.Forms, System.Drawing, System.Net.Http

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class DTWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@

[void][DTWin32]::SetProcessDPIAware()

# ───────────────────────────── 上下文 ─────────────────────────────

$script:ApiUrl = "http://127.0.0.1:$Port/dsh-translate/api"
$script:Http = New-Object System.Net.Http.HttpClient
$script:Http.Timeout = [TimeSpan]::FromSeconds(120)
$script:Task = $null
$script:PendingText = ''
$script:LastText = ''
$script:LastTextAt = 0
$script:LeftDown = $false
$script:DownPoint = $null
$script:DownAt = 0
$script:LastClickAt = 0
$script:LastClickPoint = $null
$script:Overlay = $null
$script:BodyBox = $null
$script:TitleLabel = $null
$script:HiddenAt = 0
$script:BusySince = 0
$script:TerminalClasses = @('ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'mintty', 'PseudoConsoleWindow', 'PuTTY')

# ───────────────────────────── 工具 ─────────────────────────────

function Get-WindowClass([IntPtr]$hwnd) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][DTWin32]::GetClassName($hwnd, $sb, $sb.Capacity)
    return $sb.ToString()
}

function Get-WindowTitle([IntPtr]$hwnd) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][DTWin32]::GetWindowText($hwnd, $sb, $sb.Capacity)
    return $sb.ToString()
}

function Get-TopLevelWindow([IntPtr]$hwnd) {
    return [DTWin32]::GetAncestor($hwnd, 2) # GA_ROOT
}

function Get-ProcessNameOfWindow([IntPtr]$hwnd) {
    try {
        $pid32 = [uint32]0
        [void][DTWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid32)
        if ($pid32 -eq 0) { return '' }
        return (Get-Process -Id $pid32 -ErrorAction SilentlyContinue).ProcessName
    } catch { return '' }
}

# ───────────────────────────── 取词：UIA 优先 ─────────────────────────────

function Convert-Rects([double[]]$flat) {
    $out = @()
    if (-not $flat) { return $out }
    for ($i = 0; $i + 3 -lt $flat.Length; $i += 4) {
        $out += @{ left = $flat[$i]; top = $flat[$i + 1]; right = $flat[$i] + $flat[$i + 2]; bottom = $flat[$i + 1] + $flat[$i + 3] }
    }
    return $out
}

function Test-PointNearRects([int]$x, [int]$y, $rects) {
    if (-not $rects -or $rects.Count -eq 0) { return $true }   # 拿不到矩形就不挡
    foreach ($r in $rects) {
        $h = [Math]::Max(1, $r.bottom - $r.top)
        $margin = [Math]::Max(8, $h)
        if ($x -ge ($r.left - $margin) -and $x -le ($r.right + $margin) -and
            $y -ge ($r.top - $margin) -and $y -le ($r.bottom + $margin)) { return $true }
    }
    return $false
}

function Get-SelectionViaUia([System.Windows.Point]$point) {
    $startElement = $null
    try { $startElement = [System.Windows.Automation.AutomationElement]::FromPoint($point) } catch { }

    $chains = @()
    if ($startElement) {
        $chain = @()
        $node = $startElement
        for ($i = 0; $i -lt 8 -and $node; $i++) {
            $chain += $node
            try { $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node) } catch { $node = $null }
        }
        $chains += , $chain
    }
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        if ($focused) {
            $chain = @()
            $node = $focused
            for ($i = 0; $i -lt 8 -and $node; $i++) {
                $chain += $node
                try { $node = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($node) } catch { $node = $null }
            }
            $chains += , $chain
        }
    } catch { }

    foreach ($chain in $chains) {
        foreach ($element in $chain) {
            try {
                $pattern = $null
                if (-not $element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$pattern)) { continue }
                if ($pattern.SupportedTextSelection -eq [System.Windows.Automation.SupportedTextSelection]::None) { continue }
                $ranges = $pattern.GetSelection()
                if (-not $ranges -or $ranges.Count -eq 0) { continue }
                $text = ''
                $rects = @()
                foreach ($range in $ranges) {
                    try { $text += $range.GetText(-1) } catch { }
                    try { $rects += Convert-Rects ($range.GetBoundingRectangles()) } catch { }
                }
                if ($text -and $text.Trim().Length -gt 0) { return @{ text = $text; rects = $rects } }
            } catch { }
        }
    }
    return $null
}

# ───────────────────────────── 取词：剪贴板兜底 ─────────────────────────────

function Send-CtrlC() {
    $scanC = [byte][DTWin32]::MapVirtualKey(0x43, 0)
    $scanCtrl = [byte][DTWin32]::MapVirtualKey(0x11, 0)
    [DTWin32]::keybd_event(0x11, $scanCtrl, 0, [UIntPtr]::Zero)       # Ctrl down
    Start-Sleep -Milliseconds 12
    [DTWin32]::keybd_event(0x43, $scanC, 0, [UIntPtr]::Zero)          # C down
    Start-Sleep -Milliseconds 12
    [DTWin32]::keybd_event(0x43, $scanC, 2, [UIntPtr]::Zero)          # C up
    Start-Sleep -Milliseconds 12
    [DTWin32]::keybd_event(0x11, $scanCtrl, 2, [UIntPtr]::Zero)       # Ctrl up
}

function Get-SelectionViaClipboard([IntPtr]$hwnd) {
    $class = Get-WindowClass $hwnd
    if ($script:TerminalClasses -contains $class) { return '' }
    # 用户此刻正按着 Ctrl 就别注入（会拆散用户自己的组合键）
    if (([DTWin32]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0) { return '' }

    $saved = $null
    try { $saved = [System.Windows.Forms.Clipboard]::GetDataObject() } catch { }
    $beforeText = ''
    try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $beforeText = [System.Windows.Forms.Clipboard]::GetText() } } catch { }
    $before = [DTWin32]::GetClipboardSequenceNumber()

    Send-CtrlC

    $deadline = [Environment]::TickCount + 600
    $text = ''
    while ([Environment]::TickCount -lt $deadline) {
        Start-Sleep -Milliseconds 40
        if ([DTWin32]::GetClipboardSequenceNumber() -ne $before) {
            try { $text = [System.Windows.Forms.Clipboard]::GetText() } catch { $text = '' }
            break
        }
    }

    # 注入后拿到的还是注入前那段文字 → 这次手势没有复制出新内容，当作没选中
    if ($text -and $beforeText -and $text -eq $beforeText) { $text = '' }

    # 还原用户原来的剪贴板（只在真的读到文字时还原；没读到就不碰）
    if ($text -and $saved) {
        try { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true) } catch { }
    }
    return $text
}

# ───────────────────────────── 浮窗 ─────────────────────────────

function Get-IsDarkTheme() {
    try {
        $value = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
        return ($value.AppsUseLightTheme -eq 0)
    } catch { return $false }
}

function Ensure-Overlay() {
    if ($script:Overlay -and -not $script:Overlay.IsDisposed) { return $script:Overlay }

    $form = New-Object System.Windows.Forms.Form
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.ShowInTaskbar = $false
    $form.TopMost = $true
    $form.Width = 440
    $form.Height = 132
    $form.Padding = New-Object System.Windows.Forms.Padding(0)
    $form.KeyPreview = $true

    $dark = Get-IsDarkTheme
    $bg = if ($dark) { [System.Drawing.Color]::FromArgb(32, 36, 48) } else { [System.Drawing.Color]::FromArgb(252, 252, 253) }
    $fg = if ($dark) { [System.Drawing.Color]::FromArgb(232, 235, 244) } else { [System.Drawing.Color]::FromArgb(28, 32, 40) }
    $muted = if ($dark) { [System.Drawing.Color]::FromArgb(150, 160, 180) } else { [System.Drawing.Color]::FromArgb(110, 118, 132) }
    $form.BackColor = $bg

    $title = New-Object System.Windows.Forms.Label
    $title.AutoSize = $false
    $title.Location = New-Object System.Drawing.Point(12, 8)
    $title.Size = New-Object System.Drawing.Size(416, 20)
    $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Regular)
    $title.ForeColor = $muted
    $title.Text = '翻译'
    $form.Controls.Add($title)

    $body = New-Object System.Windows.Forms.TextBox
    $body.Multiline = $true
    $body.ReadOnly = $true
    $body.BorderStyle = [System.Windows.Forms.BorderStyle]::None
    $body.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
    $body.WordWrap = $true
    $body.BackColor = $bg
    $body.ForeColor = $fg
    $body.Location = New-Object System.Drawing.Point(12, 32)
    $body.Size = New-Object System.Drawing.Size(416, 62)
    $body.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Regular)
    $body.Text = ''
    $form.Controls.Add($body)

    $close = New-Object System.Windows.Forms.Button
    $close.Text = '复制'
    $close.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $close.FlatAppearance.BorderSize = 0
    $close.ForeColor = $muted
    $close.BackColor = $bg
    $close.Location = New-Object System.Drawing.Point(336, 100)
    $close.Size = New-Object System.Drawing.Size(44, 24)
    $close.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
    $close.Add_Click({
        try {
            if ($script:BodyBox.Text) { [System.Windows.Forms.Clipboard]::SetText($script:BodyBox.Text) }
        } catch { }
    })
    $form.Controls.Add($close)

    $dismiss = New-Object System.Windows.Forms.Button
    $dismiss.Text = '关闭  Esc'
    $dismiss.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
    $dismiss.FlatAppearance.BorderSize = 0
    $dismiss.ForeColor = $muted
    $dismiss.BackColor = $bg
    $dismiss.Location = New-Object System.Drawing.Point(384, 100)
    $dismiss.Size = New-Object System.Drawing.Size(46, 24)
    $dismiss.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)
    $dismiss.Add_Click({ Hide-Overlay })
    $form.Controls.Add($dismiss)

    $form.Add_KeyDown({
        param($sender, $event)
        if ($event.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { Hide-Overlay; $event.Handled = $true }
    })
    $form.Add_Deactivate({ Hide-Overlay })
    $form.Add_MouseDown({
        param($sender, $event)
        if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
            $script:DragStart = $event.Location
            $script:DragOrigin = $sender.Location
        }
    })
    $form.Add_MouseMove({
        param($sender, $event)
        if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $script:DragStart) {
            $sender.Location = New-Object System.Drawing.Point(
                ($script:DragOrigin.X + $event.X - $script:DragStart.X),
                ($script:DragOrigin.Y + $event.Y - $script:DragStart.Y))
        }
    })
    $form.Add_MouseUp({ $script:DragStart = $null })

    $script:Overlay = $form
    $script:BodyBox = $body
    $script:TitleLabel = $title
    return $form
}

function Show-Overlay([string]$title, [string]$text, [int]$x, [int]$y) {
    if ($NoUi) { return }
    $form = Ensure-Overlay
    $script:TitleLabel.Text = $title
    $script:BodyBox.Text = $text
    $lines = 1
    if ($text) { $lines = ([Math]::Min(9, [Math]::Max(1, [Math]::Ceiling($text.Length / 44)))) }
    $form.Height = 92 + ($lines * 20)
    $script:BodyBox.Height = $form.Height - 70

    $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($x, $y)))
    $wa = $screen.WorkingArea
    $left = [Math]::Min([Math]::Max($wa.Left + 8, $x + 14), $wa.Right - $form.Width - 8)
    $top = $y + 18
    if ($top + $form.Height -gt $wa.Bottom - 8) { $top = $y - $form.Height - 12 }
    if ($top -lt $wa.Top + 8) { $top = $wa.Top + 8 }
    $form.Location = New-Object System.Drawing.Point($left, $top)
    $form.Show()
    $form.Activate()
    $script:HiddenAt = 0
}

function Hide-Overlay() {
    if ($script:Overlay -and -not $script:Overlay.IsDisposed -and $script:Overlay.Visible) {
        $script:Overlay.Hide()
        $script:HiddenAt = [Environment]::TickCount
    }
}

# ───────────────────────────── 翻译 ─────────────────────────────

function Start-Translate([string]$text, [int]$x, [int]$y) {
    if ($NoUi) { return }
    $payload = @{
        action         = 'translate'
        text           = $text
        targetLanguage = $Target
        tone           = $Tone
    } | ConvertTo-Json -Compress
    $content = New-Object System.Net.Http.StringContent($payload, [System.Text.Encoding]::UTF8, 'application/json')
    $script:PendingText = $text
    try {
        $script:Task = $script:Http.PostAsync($script:ApiUrl, $content)
    } catch {
        $script:Task = $null
        Show-Overlay '翻译失败' ('翻译服务不可用：' + $_.Exception.Message) $x $y
        return
    }
    Show-Overlay ('翻译中… → ' + $Target) $text.Substring(0, [Math]::Min(120, $text.Length)) $x $y
}

function Complete-Translate() {
    if (-not $script:Task) { return }
    $task = $script:Task
    if (-not $task.IsCompleted) { return }
    $script:Task = $null
    $pos = [DTWin32+POINT]::new()
    [void][DTWin32]::GetCursorPos([ref]$pos)
    try {
        $response = $task.Result
        $body = $response.Content.ReadAsStringAsync().Result
        $json = $body | ConvertFrom-Json
        if ($json.ok -eq $true) {
            $target = $json.targetLanguage
            Show-Overlay ('译文 → ' + $target) $json.text $pos.X $pos.Y
        } elseif ($json.error) {
            Show-Overlay '翻译失败' $json.error.message $pos.X $pos.Y
        } else {
            Show-Overlay '翻译失败' ('HTTP ' + [int]$response.StatusCode) $pos.X $pos.Y
        }
    } catch {
        Show-Overlay '翻译失败' $_.Exception.Message $pos.X $pos.Y
    }
}

# ───────────────────────────── 手势 → 取词 → 翻译 ─────────────────────────────

function Invoke-Gesture([DTWin32+POINT]$point, [DTWin32+POINT]$pressPoint) {
    $hwnd = [DTWin32]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return }
    if ($script:Overlay -and -not $script:Overlay.IsDisposed -and $script:Overlay.Handle -eq $hwnd) { return }

    $processName = Get-ProcessNameOfWindow $hwnd
    if ($processName -imatch 'dsh-translate-capture') { return }
    # DSH 自己的窗口交给页面内浮层（否则一次选中弹两个窗）
    if ($processName -imatch '^(DeepSeek Harness|dsh)') { return }

    $pointObj = New-Object System.Windows.Point($point.X, $point.Y)
    $text = ''
    $source = 'uia'
    if (-not $script:NoUia) {
        # 冷启动时 Chromium/WebView2 的无障碍树还没打开：第一次读不到就等 160ms 再读
        for ($attempt = 1; $attempt -le 2; $attempt++) {
            $found = $null
            try { $found = Get-SelectionViaUia $pointObj } catch { $found = $null }
            if ($found -and $found.text -and $found.text.Trim().Length -gt 0) {
                $near = (Test-PointNearRects $point.X $point.Y $found.rects)
                if (-not $near -and $pressPoint) { $near = (Test-PointNearRects $pressPoint.X $pressPoint.Y $found.rects) }
                if ($near) { $text = $found.text; break }
                # 选区不在这次手势的落点上：那是上一次留下的旧选区（或拖窗口时读到的残留），不翻
                Write-Log ("stale selection ignored chars=" + $found.text.Length)
                return
            }
            Start-Sleep -Milliseconds 160
        }
    }
    if (-not $text -or $text.Trim().Length -eq 0) {
        $source = 'clipboard'
        try { $text = Get-SelectionViaClipboard ($hwnd) } catch { $text = '' }
    }
    if (-not $text) { return }
    $text = $text.Trim()
    if ($text.Length -lt 2) { return }
    if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) }

    $now = [Environment]::TickCount
    if ($text -eq $script:LastText -and ($now - $script:LastTextAt) -lt 5000) { return }
    $script:LastText = $text
    $script:LastTextAt = $now

    Write-Log ("gesture source=$source chars=" + $text.Length)
    Start-Translate $text $point.X $point.Y
}

# ───────────────────────────── 浮窗冒烟：造一次窗、画一帧、然后退出 ─────────────────────────────

if ($TestOverlay) {
    $ok = $false
    $err = ''
    try {
        $pt = [DTWin32+POINT]::new()
        [void][DTWin32]::GetCursorPos([ref]$pt)
        Show-Overlay '译文 → 简体中文' '这是一条浮窗冒烟测试：能看到这行字就说明原生置顶窗口正常。' $pt.X $pt.Y
        $deadline = [Environment]::TickCount + 2500
        while ([Environment]::TickCount -lt $deadline) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 50
        }
        Hide-Overlay
        if ($script:Overlay -and -not $script:Overlay.IsDisposed) { $script:Overlay.Dispose() }
        $ok = $true
    } catch {
        $err = $_.Exception.Message
    }
    @{ ok = $ok; error = $err } | ConvertTo-Json
    if ($ok) { exit 0 } else { exit 1 }
}

# ───────────────────────────── 探针：光标处能不能取到选区 ─────────────────────────────

if ($Probe) {
    $hwnd = [DTWin32]::GetForegroundWindow()
    $pos = [DTWin32+POINT]::new()
    [void][DTWin32]::GetCursorPos([ref]$pos)
    $uiaText = ''
    try {
        $found = Get-SelectionViaUia (New-Object System.Windows.Point($pos.X, $pos.Y))
        if ($found) { $uiaText = $found.text }
    } catch { }
    $clipText = ''
    if (-not $uiaText) {
        try { $clipText = Get-SelectionViaClipboard $hwnd } catch { }
    }
    $result = [ordered]@{
        ok         = $true
        foreground = (Get-WindowTitle $hwnd)
        windowClass = (Get-WindowClass $hwnd)
        process    = (Get-ProcessNameOfWindow $hwnd)
        uia        = $uiaText
        clipboard  = $clipText
        source     = $(if ($uiaText) { 'uia' } elseif ($clipText) { 'clipboard' } else { 'none' })
    }
    $result | ConvertTo-Json -Depth 3
    exit 0
}

# ───────────────────────────── 自检 ─────────────────────────────

if ($SelfTest) {
    $result = [ordered]@{
        ok         = $false
        version    = $script:ScriptVersion
        psiVersion = $PSVersionTable.PSVersion.ToString()
        uia        = $false
        winforms   = $false
        httpStatus = $false
        translate  = $null
        error      = $null
    }
    try {
        $result.uia = ($null -ne [System.Windows.Automation.AutomationElement])
        $result.winforms = ($null -ne [System.Windows.Forms.Cursor])
        $statusJson = (Invoke-WebRequest -Uri $script:ApiUrl -Method Get -UseBasicParsing -TimeoutSec 10).Content
        $status = $statusJson | ConvertFrom-Json
        $result.httpStatus = ($status.ok -eq $true)
        $payload = @{ action = 'translate'; text = 'The companion process reads the selection with UI Automation first.'; targetLanguage = $Target } | ConvertTo-Json -Compress
        $resp = Invoke-WebRequest -Uri $script:ApiUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -UseBasicParsing -TimeoutSec 60
        $parsed = $resp.Content | ConvertFrom-Json
        $result.translate = @{ ok = $parsed.ok; text = $parsed.text; target = $parsed.targetLanguage }
        $result.ok = ($result.httpStatus -and $parsed.ok -eq $true)
    } catch {
        $result.error = $_.Exception.Message
    }
    $result | ConvertTo-Json -Depth 4 | Write-Output
    if ($result.ok) { exit 0 } else { exit 1 }
}

# ───────────────────────────── 单实例 + 主循环 ─────────────────────────────

# 单实例：会话内互斥体（Local\ 不需要 SeCreateGlobalPrivilege）；建不出来就用 PID 文件兜底
$mutexName = "Local\dsh-translate-capture"
$pidFile = Join-Path $env:TEMP 'dsh-translate-capture.pid'
$mutex = $null
$ownedPidFile = $false
try {
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
    # 重启时新进程可能比旧进程先起来：留 3 秒等旧实例退场，别把自己也退掉
    if (-not $mutex.WaitOne(3000)) {
        Write-Log 'another instance holds the mutex; exiting'
        exit 0
    }
} catch {
    $mutex = $null
}
if (-not $mutex) {
    try {
        if (Test-Path $pidFile) {
            $oldPid = 0
            [void][int]::TryParse((Get-Content $pidFile -Raw).Trim(), [ref]$oldPid)
            if ($oldPid -gt 0) {
                $old = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $oldPid) -ErrorAction SilentlyContinue
                if ($old -and $old.CommandLine -like '*dsh-translate-capture.ps1*') {
                    Write-Log 'another instance is running (pid file); exiting'
                    exit 0
                }
            }
        }
        Set-Content -Path $pidFile -Value $PID -Encoding ASCII
        $ownedPidFile = $true
    } catch { }
}

Write-Log ("start version=" + $script:ScriptVersion + " port=" + $Port + " target=" + $Target + " parent=" + $ParentPid)

$parentCheckedAt = [Environment]::TickCount
$lastLoop = [Environment]::TickCount

try {
    while ($true) {
        Complete-Translate

        # 父进程看门狗（DSH 退出/重启时不留幽灵进程）
        if ($ParentPid -gt 0) {
            $now = [Environment]::TickCount
            if ($now - $parentCheckedAt -gt 3000) {
                $parentCheckedAt = $now
                if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
                    Write-Log 'parent process gone; exiting'
                    break
                }
            }
        }

        # 鼠标手势
        $pos = [DTWin32+POINT]::new()
        [void][DTWin32]::GetCursorPos([ref]$pos)
        $down = (([DTWin32]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0)
        $now = [Environment]::TickCount

        if ($down -and -not $script:LeftDown) {
            $script:DownPoint = $pos
            $script:DownAt = $now
        }
        if (-not $down -and $script:LeftDown) {
            $moved = 0
            if ($script:DownPoint) {
                $dx = $pos.X - $script:DownPoint.X
                $dy = $pos.Y - $script:DownPoint.Y
                $moved = [Math]::Sqrt($dx * $dx + $dy * $dy)
            }
            $isDouble = $false
            if ($script:LastClickPoint) {
                $ddx = $pos.X - $script:LastClickPoint.X
                $ddy = $pos.Y - $script:LastClickPoint.Y
                $dist = [Math]::Sqrt($ddx * $ddx + $ddy * $ddy)
                $isDouble = (($now - $script:LastClickAt) -lt 450) -and ($dist -lt 8)
            }
            if ($moved -ge 5 -or $isDouble) {
                try { Invoke-Gesture $pos $script:DownPoint } catch { Write-Log ('gesture failed: ' + $_.Exception.Message) }
            }
            $script:LastClickAt = $now
            $script:LastClickPoint = $pos
        }
        $script:LeftDown = $down

        # 浮窗自动收起（20s）
        if ($script:Overlay -and -not $script:Overlay.IsDisposed -and $script:Overlay.Visible -and -not $script:Task) {
            if ($script:HiddenAt -eq 0) { $script:HiddenAt = $now }
            elseif (($now - $script:HiddenAt) -gt 20000) { Hide-Overlay }
        } elseif ($script:Task) {
            $script:HiddenAt = 0
        }

        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds $PollMs
    }
} finally {
    Write-Log 'exit'
    try { if ($script:Overlay -and -not $script:Overlay.IsDisposed) { $script:Overlay.Dispose() } } catch { }
    try { $script:Http.Dispose() } catch { }
    if ($mutex) { try { $mutex.ReleaseMutex() } catch { } ; $mutex.Dispose() }
    if ($ownedPidFile) { try { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue } catch { } }
}
