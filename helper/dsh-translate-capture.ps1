# dsh-translate 外部划译伴生进程（Windows / Windows PowerShell 5.1，零外部依赖）
#
# 职责：DSH 页面之外的「划译」——
#   手势（拖选 / 双击选词）→ UIA TextPattern 读选区（不碰剪贴板）
#   → 读不到才注入一次 Ctrl+C 读剪贴板（带扫描码；读完还原）
#   → POST 到 DSH 的 /dsh-translate/api → 光标旁原生置顶浮窗显示译文。
#
# 浮窗视觉照 DSH 内页浮层（.dstr-pop）：400 DIP 宽 / 12px 圆角 / 卡片底色 / 标题栏 /
# 原文（灰、两行、虚线）/ 译文（13px、可滚动）/ 底栏（耗时 + 复制 + 关闭）。
# 颜色与字体由 DSH 客户端把主题 token 写进 -ThemePath（跟随亮/暗主题）。
# 想自己看效果：-TestOverlay 会画一帧并截图到 -ShotPath。
#
# 纪律：
#   · 不装运行时、不起浏览器：UIA 走 .NET 托管 API，浮窗走 WinForms 自绘。
#   · 剪贴板是用户的：只在 UIA 读不到时注入，注入前保存、读到文字后还原；终端窗口跳过。
#   · 一次手势只翻一次；同一段文字 5 秒内不重复翻；拖窗口/旧选区不误翻。
#   · 进程随 DSH 走：-ParentPid 指定的进程没了就自己退出；DSH 也会在插件卸载时杀掉本进程。

param(
    [int]$Port = 61213,
    [string]$Target = 'auto',
    [string]$Tone = 'natural',
    [int]$ParentPid = 0,
    [int]$PollMs = 45,
    [int]$MaxChars = 4000,
    [string]$LogPath = "$env:TEMP\dsh-translate-capture.log",
    [string]$ThemePath = '',
    [string]$ShotPath = "$env:TEMP\dsh-translate-overlay.png",
    [string]$TestAnchor = '',
    [switch]$SelfTest,
    [switch]$Probe,
    [switch]$TestOverlay,
    [switch]$NoUi
)

$ErrorActionPreference = 'Stop'
$script:ScriptVersion = '1.2.5'
$script:ThemePath = $ThemePath

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

$uiRefs = @([System.Windows.Forms.Form].Assembly.Location, [System.Drawing.Color].Assembly.Location)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

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
    [DllImport("user32.dll")] public static extern uint GetDpiForSystem();
}

/** 无边框卡片窗口：CS_DROPSHADOW 让 DWM 给一层系统阴影，双缓冲避免自绘闪烁。 */
public class DtCard : Form {
    public DtCard() {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
        this.DoubleBuffered = true;
    }
    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ClassStyle |= 0x20000; // CS_DROPSHADOW
            return cp;
        }
    }
}

/** 双缓冲的正文面板：自绘换行文本、自己处理滚轮，不出现原生滚动条。 */
public class DtPanel : Panel {
    public DtPanel() {
        this.DoubleBuffered = true;
        this.SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint, true);
    }
}
'@ -ReferencedAssemblies $uiRefs

[void][DTWin32]::SetProcessDPIAware()

# ───────────────────────────── 上下文 ─────────────────────────────

$script:ApiUrl = "http://127.0.0.1:$Port/dsh-translate/api"
$script:Http = New-Object System.Net.Http.HttpClient
$script:Http.Timeout = [TimeSpan]::FromSeconds(120)
$script:Task = $null
$script:TaskAt = 0
$script:LastText = ''
$script:LastTextAt = 0
$script:LeftDown = $false
$script:DownPoint = $null
$script:DownAt = 0
$script:LastClickAt = 0
$script:LastClickPoint = $null
$script:Overlay = $null
$script:BodyBox = $null
$script:Layout = $null
$script:TextBody = ''
$script:BodyTextHeight = 0
$script:BodyMaxScroll = 0
$script:BodyLineHeight = 16
$script:ScrollOffset = 0
$script:LastSource = ''
$script:Anchor = $null
$script:TitleText = ''
$script:SourceText = ''
$script:MetaText = ''
$script:Theme = $null
$script:ThemeAt = [DateTime]::MinValue
$script:FontScale = 0
$script:Scale = 1.0
$script:HiddenAt = 0
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

function Get-ProcessNameOfWindow([IntPtr]$hwnd) {
    try {
        $pid32 = [uint32]0
        [void][DTWin32]::GetWindowThreadProcessId($hwnd, [ref]$pid32)
        if ($pid32 -eq 0) { return '' }
        return (Get-Process -Id $pid32 -ErrorAction SilentlyContinue).ProcessName
    } catch { return '' }
}

# ───────────────────────────── 主题 ─────────────────────────────

function Get-IsDarkTheme() {
    try {
        $value = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
        return ($value.AppsUseLightTheme -eq 0)
    } catch { return $false }
}

function Parse-Color([string]$text, [System.Drawing.Color]$fallback) {
    if (-not $text) { return $fallback }
    $value = $text.Trim()
    $m = [regex]::Match($value, 'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)')
    if ($m.Success) {
        return [System.Drawing.Color]::FromArgb([int]$m.Groups[1].Value, [int]$m.Groups[2].Value, [int]$m.Groups[3].Value)
    }
    if ($value -match '^#([0-9a-fA-F]{8})$') {
        $hex = $value.Substring(1, 6)
        return [System.Drawing.Color]::FromArgb(
            [Convert]::ToInt32($hex.Substring(0, 2), 16),
            [Convert]::ToInt32($hex.Substring(2, 2), 16),
            [Convert]::ToInt32($hex.Substring(4, 2), 16))
    }
    if ($value -match '^#([0-9a-fA-F]{6})$') {
        $hex = $value.Substring(1)
        return [System.Drawing.Color]::FromArgb(
            [Convert]::ToInt32($hex.Substring(0, 2), 16),
            [Convert]::ToInt32($hex.Substring(2, 2), 16),
            [Convert]::ToInt32($hex.Substring(4, 2), 16))
    }
    if ($value -match '^#([0-9a-fA-F]{3})$') {
        $hex = $value.Substring(1)
        return [System.Drawing.Color]::FromArgb(
            [Convert]::ToInt32(('' + $hex[0] + $hex[0]), 16),
            [Convert]::ToInt32(('' + $hex[1] + $hex[1]), 16),
            [Convert]::ToInt32(('' + $hex[2] + $hex[2]), 16))
    }
    return $fallback
}

# 原生窗口只认字体族名：挑一个本机真装了的，避免 New-Object Font 直接抛。
# 主题 token 可能是带 alpha 的（DSH 的 --dsw-alias-* 有 #ffffff0f 这种写法）：
# 原生窗口没有 alpha 合成，先把 token 按 alpha 混到实底上，视觉才和页面一致。
function Get-ColorAlpha([string]$text) {
    if (-not $text) { return 1.0 }
    $value = $text.Trim()
    if ($value -match '^#[0-9a-fA-F]{8}$') { return [Convert]::ToInt32($value.Substring(7, 2), 16) / 255.0 }
    if ($value -match '^#[0-9a-fA-F]{4}$') { return [Convert]::ToInt32(('' + $value[4] + $value[4]), 16) / 255.0 }
    $m = [regex]::Match($value, 'rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([0-9.]+)\s*\)')
    if ($m.Success) { return [double]$m.Groups[1].Value }
    return 1.0
}

function Blend-Color([System.Drawing.Color]$color, [double]$alpha, [System.Drawing.Color]$backdrop) {
    if ($alpha -ge 1.0) { return $color }
    if ($alpha -le 0.0) { return $backdrop }
    $r = [int][Math]::Round(($color.R * $alpha) + ($backdrop.R * (1 - $alpha)))
    $g = [int][Math]::Round(($color.G * $alpha) + ($backdrop.G * (1 - $alpha)))
    $b = [int][Math]::Round(($color.B * $alpha) + ($backdrop.B * (1 - $alpha)))
    return [System.Drawing.Color]::FromArgb($r, $g, $b)
}

function Resolve-FontFamily([string]$stack) {
    $candidates = @()
    foreach ($part in ([string]$stack).Split(',')) {
        $name = $part.Trim().Trim('"', "'")
        if ($name -and $name -notmatch '^(system-ui|sans-serif|serif|monospace|ui-sans-serif|-apple-system|BlinkMacSystemFont)$') {
            $candidates += $name
        }
    }
    $candidates += @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI', 'Arial')
    try {
        $installed = @{}
        foreach ($family in [System.Drawing.FontFamily]::Families) { $installed[$family.Name] = $true }
        foreach ($candidate in $candidates) {
            if ($installed.ContainsKey($candidate)) { return $candidate }
        }
    } catch { }
    return 'Microsoft YaHei UI'
}

function Get-Theme() {
    $dark = @{
        bg             = [System.Drawing.Color]::FromArgb(36, 39, 46)
        layer1         = [System.Drawing.Color]::FromArgb(44, 48, 58)
        border         = [System.Drawing.Color]::FromArgb(58, 63, 75)
        labelPrimary   = [System.Drawing.Color]::FromArgb(230, 233, 240)
        labelSecondary = [System.Drawing.Color]::FromArgb(154, 163, 178)
        brand          = [System.Drawing.Color]::FromArgb(77, 107, 254)
        fontFamily     = 'Microsoft YaHei UI'
    }
    $light = @{
        bg             = [System.Drawing.Color]::FromArgb(252, 252, 253)
        layer1         = [System.Drawing.Color]::FromArgb(243, 245, 248)
        border         = [System.Drawing.Color]::FromArgb(227, 230, 235)
        labelPrimary   = [System.Drawing.Color]::FromArgb(28, 32, 40)
        labelSecondary = [System.Drawing.Color]::FromArgb(110, 118, 132)
        brand          = [System.Drawing.Color]::FromArgb(47, 111, 235)
        fontFamily     = 'Microsoft YaHei UI'
    }
    $base = @{}
    $src = if (Get-IsDarkTheme) { $dark } else { $light }
    foreach ($key in $src.Keys) { $base[$key] = $src[$key] }

    if ($script:ThemePath -and (Test-Path $script:ThemePath)) {
        try {
            $raw = Get-Content -Path $script:ThemePath -Raw -Encoding UTF8
            if ($raw) {
                $t = $raw | ConvertFrom-Json
                $solid = $base.bg
                if ($t.bgBase) { $solid = Parse-Color $t.bgBase $solid }
                if ($t.bgOverlay) {
                    $alpha = Get-ColorAlpha $t.bgOverlay
                    $base.bg = Blend-Color (Parse-Color $t.bgOverlay $solid) $alpha $solid
                } elseif ($t.bgLayer1) {
                    $base.bg = Parse-Color $t.bgLayer1 $solid
                } else {
                    $base.bg = $solid
                }
                if ($t.bgLayer1) {
                    $layerAlpha = Get-ColorAlpha $t.bgLayer1
                    $base.layer1 = Blend-Color (Parse-Color $t.bgLayer1 $base.bg) $layerAlpha $base.bg
                } elseif ($t.bgLayer2) {
                    $layerAlpha = Get-ColorAlpha $t.bgLayer2
                    $base.layer1 = Blend-Color (Parse-Color $t.bgLayer2 $base.bg) $layerAlpha $base.bg
                }
                if ($t.borderL2) {
                    $borderAlpha = Get-ColorAlpha $t.borderL2
                    $base.border = Blend-Color (Parse-Color $t.borderL2 $base.bg) $borderAlpha $base.bg
                } elseif ($t.borderL1) {
                    $borderAlpha = Get-ColorAlpha $t.borderL1
                    $base.border = Blend-Color (Parse-Color $t.borderL1 $base.bg) $borderAlpha $base.bg
                }
                if ($t.labelPrimary) { $base.labelPrimary = Parse-Color $t.labelPrimary $base.labelPrimary }
                if ($t.labelSecondary) { $base.labelSecondary = Parse-Color $t.labelSecondary $base.labelSecondary }
                if ($t.brandPrimary) { $base.brand = Parse-Color $t.brandPrimary $base.brand }
                if ($t.fontFamily) {
                    $resolved = Resolve-FontFamily ([string]$t.fontFamily)
                    if ($resolved) { $base.fontFamily = $resolved }
                }
            }
        } catch { }
    }
    return $base
}

function Update-Fonts() {
    $scale = if ($script:Scale -gt 0) { $script:Scale } else { 1.0 }
    if ($script:FontScale -eq $scale -and $script:FontBody) { return }
    $script:FontScale = $scale
    # 内页浮层是 CSS px：12/13/11 CSS px 在 DPI 缩放下要乘缩放系数，否则 200% 屏上只有一半大
    $script:FontTitle = New-Object System.Drawing.Font($script:Theme.fontFamily, [single](12 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $script:FontBody = New-Object System.Drawing.Font($script:Theme.fontFamily, [single](13 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $script:FontSmall = New-Object System.Drawing.Font($script:Theme.fontFamily, [single](11 * $scale), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
}

function Update-Theme {
    $now = Get-Date
    if ($script:Theme -and ($now - $script:ThemeAt).TotalSeconds -lt 1) {
        Update-Fonts
        return
    }
    $script:Theme = Get-Theme
    $script:ThemeAt = $now
    Update-Fonts
}

function Get-UiScale() {
    try {
        $dpi = [DTWin32]::GetDpiForSystem()
        if ($dpi -gt 0) { return $dpi / 96.0 }
    } catch { }
    return 1.0
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
    if (-not $rects -or $rects.Count -eq 0) { return $true }
    foreach ($r in $rects) {
        $h = [Math]::Max(1, $r.bottom - $r.top)
        $margin = [Math]::Max(8, $h)
        if ($x -ge ($r.left - $margin) -and $x -le ($r.right + $margin) -and
            $y -ge ($r.top - $margin) -and $y -le ($r.bottom + $margin)) { return $true }
    }
    return $false
}

# PDF/WebView 的文本层经常把词间空格吞掉（"TheInnerProduct"），逐字给模型只会原样吐回。
# 先试一次剪贴板取词（有空白就优先用它），再退化成按大小写边界补空格。
function Restore-WordSpacing([string]$text) {
    if (-not $text) { return $text }
    if ($text -match '\s') { return $text }
    if ($text.Length -lt 8) { return $text }
    $spaced = [regex]::Replace($text, '(?<=[a-z])(?=[A-Z])', ' ')
    $spaced = [regex]::Replace($spaced, '(?<=[A-Za-z])(?=[0-9])', ' ')
    $spaced = [regex]::Replace($spaced, '(?<=[0-9])(?=[A-Za-z])', ' ')
    return $spaced
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
    [DTWin32]::keybd_event(0x11, $scanCtrl, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 12
    [DTWin32]::keybd_event(0x43, $scanC, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 12
    [DTWin32]::keybd_event(0x43, $scanC, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 12
    [DTWin32]::keybd_event(0x11, $scanCtrl, 2, [UIntPtr]::Zero)
}

function Get-SelectionViaClipboard([IntPtr]$hwnd) {
    $class = Get-WindowClass $hwnd
    if ($script:TerminalClasses -contains $class) { return '' }
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

    # 只有在「剪贴板根本没被写过」时才算失败；序号变了就说明应用真的复制了，
    # 哪怕内容和上一次一样（重复选同一段）也是有效结果。
    if (-not $text -and $beforeText) { $text = '' }
    if ($text -and $saved) {
        try { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true) } catch { }
    }
    return $text
}

# ───────────────────────────── 浮窗 ─────────────────────────────

function New-RoundedPath([System.Drawing.RectangleF]$rect, [single]$radius) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    if ($d -le 1) { $path.AddRectangle($rect); return $path }
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc(($rect.Right - $d), $rect.Y, $d, $d, 270, 90)
    $path.AddArc(($rect.Right - $d), ($rect.Bottom - $d), $d, $d, 0, 90)
    $path.AddArc($rect.X, ($rect.Bottom - $d), $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Measure-WrappedHeight([System.Drawing.Graphics]$graphics, [string]$text, [System.Drawing.Font]$font, [int]$width) {
    if (-not $text) { return 0 }
    $format = New-Object System.Drawing.StringFormat
    $size = $graphics.MeasureString($text, $font, $width, $format)
    return [int][Math]::Ceiling($size.Height)
}

function Get-LineHeight([System.Drawing.Graphics]$graphics, [System.Drawing.Font]$font) {
    return [single][Math]::Ceiling($font.GetHeight($graphics))
}

function Ensure-Overlay() {
    if ($script:Overlay -and -not $script:Overlay.IsDisposed) { return $script:Overlay }
    if (-not $script:Scale) { $script:Scale = Get-UiScale }
    Update-Theme

    $form = New-Object DtCard
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.ShowInTaskbar = $false
    $form.TopMost = $true
    $form.KeyPreview = $true
    $form.BackColor = $script:Theme.bg
    $form.Width = 400
    $form.Height = 180

    $body = New-Object DtPanel
    $body.BackColor = $script:Theme.bg
    $body.TabStop = $false
    $body.Add_Paint({
        param($sender, $event)
        if (-not $script:TextBody) { return }
        $g = $event.Graphics
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        $format = New-Object System.Drawing.StringFormat
        $brush = New-Object System.Drawing.SolidBrush($script:Theme.labelPrimary)
        $rect = New-Object System.Drawing.RectangleF(0, (-1 * $script:ScrollOffset), ([single]$sender.Width), ([single]($script:BodyTextHeight + 40)))
        $g.DrawString($script:TextBody, $script:FontBody, $brush, $rect, $format)
        $brush.Dispose()
    })
    $body.Add_MouseWheel({
        param($sender, $event)
        if ($script:BodyMaxScroll -le 0) { return }
        $step = [Math]::Max(1, ($script:BodyLineHeight * 1.2))
        $script:ScrollOffset = [Math]::Min($script:BodyMaxScroll, [Math]::Max(0, ($script:ScrollOffset - ($event.Delta / 120) * $step)))
        $sender.Invalidate()
    })
    $form.Controls.Add($body)

    $form.Add_Paint({
        param($sender, $e)
        $layout = $script:Layout
        if (-not $layout) { return }
        $g = $e.Graphics
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
        $scale = $script:Scale
        $pad = 14 * $scale
        $rect = New-Object System.Drawing.RectangleF(0, 0, ($sender.Width - 0.5), ($sender.Height - 0.5))
        $path = New-RoundedPath $rect ([single](12 * $scale))
        $bgBrush = New-Object System.Drawing.SolidBrush($script:Theme.bg)
        $g.FillPath($bgBrush, $path)
        $borderPen = New-Object System.Drawing.Pen($script:Theme.border, 1)
        $g.DrawPath($borderPen, $path)

        $muted = New-Object System.Drawing.SolidBrush($script:Theme.labelSecondary)
        $titleFormat = New-Object System.Drawing.StringFormat
        $titleFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
        $g.DrawString($script:TitleText, $script:FontTitle, $muted, [single]$pad, [single]$layout.headerY, $titleFormat)

        $closeFormat = New-Object System.Drawing.StringFormat
        $closeFormat.Alignment = [System.Drawing.StringAlignment]::Far
        $closeFormat.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
        $g.DrawString('✕', $script:FontTitle, $muted, [single]($sender.Width - $pad - (2 * $scale)), [single]$layout.headerY, $closeFormat)

        if ($layout.sourceH -gt 0 -and $script:SourceText) {
            $sourceRect = New-Object System.Drawing.RectangleF([single]$pad, [single]$layout.sourceY, [single]($sender.Width - 2 * $pad), [single]$layout.sourceH)
            $sourceFormat = New-Object System.Drawing.StringFormat
            $sourceFormat.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
            $g.DrawString($script:SourceText, $script:FontSmall, $muted, $sourceRect, $sourceFormat)
            $dashPen = New-Object System.Drawing.Pen($script:Theme.border, 1)
            $dashPen.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dot
            $dashY = [int]($layout.bodyY - (7 * $scale))
            $g.DrawLine($dashPen, [single]$pad, [single]$dashY, [single]($sender.Width - $pad), [single]$dashY)
        }

        $footerPen = New-Object System.Drawing.Pen($script:Theme.border, 1)
        $g.DrawLine($footerPen, [single]0, [single]$layout.headerLineY, [single]$sender.Width, [single]$layout.headerLineY)
        $g.DrawLine($footerPen, [single]0, [single]$layout.footerLineY, [single]$sender.Width, [single]$layout.footerLineY)

        if ($layout.copyRect.Width -gt 0) {
            $buttonPath = New-RoundedPath $layout.copyRect ([single](8 * $scale))
            $buttonBg = New-Object System.Drawing.SolidBrush($script:Theme.layer1)
            $g.FillPath($buttonBg, $buttonPath)
            $g.DrawPath($borderPen, $buttonPath)
            $buttonFormat = New-Object System.Drawing.StringFormat
            $buttonFormat.Alignment = [System.Drawing.StringAlignment]::Center
            $buttonFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
            $strong = New-Object System.Drawing.SolidBrush($script:Theme.labelPrimary)
            $g.DrawString('复制', $script:FontSmall, $strong, $layout.copyRect, $buttonFormat)
            $buttonBg.Dispose()
        }

        $centerFormat = New-Object System.Drawing.StringFormat
        $centerFormat.Alignment = [System.Drawing.StringAlignment]::Center
        $centerFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
        if ($script:LastSource) {
            $g.DrawString('重译', $script:FontSmall, $muted, $layout.retryRect, $centerFormat)
        }
        if ($script:MetaText) {
            $metaFormat = New-Object System.Drawing.StringFormat
            $metaFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
            $metaRect = New-Object System.Drawing.RectangleF([single]$pad, [single]($layout.footerLineY + 2 * $scale), [single](190 * $scale), [single]($layout.footerH - 4 * $scale))
            $g.DrawString($script:MetaText, $script:FontSmall, $muted, $metaRect, $metaFormat)
        }
    })

    $form.Add_MouseDown({
        param($sender, $event)
        try {
            if ($event.Button -ne [System.Windows.Forms.MouseButtons]::Left) { return }
            $layout = $script:Layout
            if (-not $layout) { return }
            # RectangleF.Contains 只认 PointF/单精度；Event.Location 是整型 Point，直接传会抛
            $point = New-Object System.Drawing.PointF([single]$event.X, [single]$event.Y)
            if ($layout.closeRect.Contains($point)) { Hide-Overlay; return }
            if ($layout.copyRect.Contains($point)) {
                try { [System.Windows.Forms.Clipboard]::SetText($script:TextBody) } catch { }
                return
            }
            if ($layout.retryRect.Contains($point)) { Retry-Translate; return }
            $script:DragStart = $event.Location
            $script:DragOrigin = $sender.Location
        } catch {
            Write-Log ('overlay click failed: ' + $_.Exception.Message)
        }
    })
    $form.Add_MouseMove({
        param($sender, $event)
        try {
            if ($event.Button -eq [System.Windows.Forms.MouseButtons]::Left -and $script:DragStart) {
                $sender.Location = New-Object System.Drawing.Point(
                    ($script:DragOrigin.X + $event.X - $script:DragStart.X),
                    ($script:DragOrigin.Y + $event.Y - $script:DragStart.Y))
            }
        } catch { }
    })
    $form.Add_MouseUp({ $script:DragStart = $null })
    $form.Add_KeyDown({
        param($sender, $event)
        try {
            if ($event.KeyCode -eq [System.Windows.Forms.Keys]::Escape) { Hide-Overlay; $event.Handled = $true }
        } catch { }
    })
    $form.Add_Deactivate({
        try { Hide-Overlay } catch { }
    })

    $script:Overlay = $form
    $script:BodyBox = $body
    return $form
}

function Update-OverlayLayout([string]$source, [string]$body) {
    $form = $script:Overlay
    if (-not $form) { return }
    $scale = $script:Scale
    $width = 400 * $scale
    $pad = 14 * $scale
    $wrap = $width - 2 * $pad
    $graphics = $form.CreateGraphics()
    try {
        $titleH = [int](Get-LineHeight $graphics $script:FontTitle)
        $smallH = [int](Get-LineHeight $graphics $script:FontSmall)

        $sourceH = 0
        if ($source) {
            $needed = Measure-WrappedHeight $graphics $source $script:FontSmall ([int]$wrap)
            $sourceH = [Math]::Min([int](2 * $smallH), [Math]::Max([int]$smallH, $needed))
        }
        if ($body) {
            $needed = Measure-WrappedHeight $graphics $body $script:FontBody ([int]$wrap)
            $script:BodyTextHeight = $needed
            $bodyH = [Math]::Max([int]($smallH + 2), [Math]::Min([int](300 * $scale), $needed))
            $script:BodyMaxScroll = [Math]::Max(0, $needed - $bodyH)
            $script:BodyLineHeight = [int](Get-LineHeight $graphics $script:FontBody)
        } else {
            $script:BodyTextHeight = 0
            $script:BodyMaxScroll = 0
            $bodyH = [int]($smallH + 2)
        }
    } finally {
        $graphics.Dispose()
    }

    $headerH = [Math]::Max([int](20 * $scale), $titleH)
    $gap = [int](9 * $scale)
    $footerH = [int](30 * $scale)
    $headerY = [int]$pad
    $sourceY = $headerY + $headerH
    $bodyY = $sourceY + $(if ($sourceH -gt 0) { $sourceH + $gap } else { 0 })
    $footerLineY = $bodyY + $bodyH + $gap
    $totalH = $footerLineY + $footerH + $pad

    $copyW = [int](46 * $scale)
    $copyH = [int](22 * $scale)
    $retryW = [int](40 * $scale)
    $buttonY = $footerLineY + [int](($footerH - $copyH) / 2)
    $copyRect = New-Object System.Drawing.RectangleF([single]($width - $pad - $copyW), [single]$buttonY, [single]$copyW, [single]$copyH)
    $retryRect = New-Object System.Drawing.RectangleF([single]($width - $pad - $copyW - (8 * $scale) - $retryW), [single]$buttonY, [single]$retryW, [single]$copyH)
    $closeRect = New-Object System.Drawing.RectangleF([single]($width - $pad - (22 * $scale)), [single]($headerY - (2 * $scale)), [single](22 * $scale), [single]$titleH)

    $script:Layout = @{
        width       = [int]$width
        height      = [int]$totalH
        headerY     = $headerY
        sourceY     = $sourceY
        sourceH     = $sourceH
        bodyX       = [int]$pad
        bodyY       = $bodyY
        bodyW       = [int]$wrap
        bodyH       = [int]$bodyH
        footerLineY = $footerLineY
        footerH     = $footerH
        headerLineY = [int]($sourceY - 1)
        copyRect    = $copyRect
        retryRect   = $retryRect
        closeRect   = $closeRect
    }

    $form.Width = [int]$script:Layout.width
    $form.Height = [int]$script:Layout.height
    $script:BodyBox.Location = New-Object System.Drawing.Point([int]$script:Layout.bodyX, [int]$script:Layout.bodyY)
    $script:BodyBox.Size = New-Object System.Drawing.Size([int]$script:Layout.bodyW, [int]$script:Layout.bodyH)
    $script:BodyBox.BackColor = $script:Theme.bg
    $rect = New-Object System.Drawing.RectangleF(0, 0, ($form.Width - 0.5), ($form.Height - 0.5))
    $path = New-RoundedPath $rect ([single](12 * $scale))
    if ($form.Region) { $form.Region.Dispose() }
    $form.Region = New-Object System.Drawing.Region($path)
    $script:BodyBox.Invalidate()
}

function Show-Overlay([string]$title, [string]$source, [string]$body, [string]$meta, [int]$x, [int]$y) {
    if ($NoUi) { return }
    Update-Theme
    if (-not $script:Scale) { $script:Scale = Get-UiScale }
    $form = Ensure-Overlay
    $script:TitleText = $title
    $script:SourceText = $source
    $script:MetaText = $meta
    $script:TextBody = $body
    $script:ScrollOffset = 0
    Update-OverlayLayout $source $body

    $anchor = $script:Anchor
    $anchorX = if ($anchor) { [int]$anchor.left } else { $x }
    $anchorTop = if ($anchor) { [int]$anchor.top } else { $y }
    $anchorBottom = if ($anchor) { [int]$anchor.bottom } else { $y }
    $screen = [System.Windows.Forms.Screen]::FromPoint((New-Object System.Drawing.Point($anchorX, $anchorBottom)))
    $wa = $screen.WorkingArea
    $left = [Math]::Min([Math]::Max($wa.Left + 10, $anchorX), ($wa.Right - $form.Width - 10))
    $gap = [int](8 * $script:Scale)
    $top = $anchorBottom + $gap
    if (($top + $form.Height) -gt ($wa.Bottom - 10)) {
        # 下方放不下 → 翻到选区上方
        $flipped = $anchorTop - $form.Height - $gap
        $top = if ($flipped -ge ($wa.Top + 10)) { $flipped } else { [Math]::Max($wa.Top + 10, $wa.Bottom - 10 - $form.Height) }
    }
    if ($top -lt ($wa.Top + 10)) { $top = $wa.Top + 10 }
    $form.Location = New-Object System.Drawing.Point([int]$left, [int]$top)
    if (-not $form.Visible) { $form.Show() }
    $form.Invalidate()
    $script:BodyBox.Invalidate()
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

function Get-Point() {
    $pos = [DTWin32+POINT]::new()
    [void][DTWin32]::GetCursorPos([ref]$pos)
    return $pos
}

function Start-Translate([string]$text, [int]$x, [int]$y) {
    if ($NoUi) { return }
    $payload = @{
        action         = 'translate'
        text           = $text
        targetLanguage = $Target
        tone           = $Tone
    } | ConvertTo-Json -Compress
    $content = New-Object System.Net.Http.StringContent($payload, [System.Text.Encoding]::UTF8, 'application/json')
    $preview = $text
    if ($preview.Length -gt 90) { $preview = $preview.Substring(0, 90) + '…' }
    $script:LastSource = $text
    $script:TaskAt = [Environment]::TickCount
    try {
        $script:Task = $script:Http.PostAsync($script:ApiUrl, $content)
        Show-Overlay '翻译中…' $preview '正在翻译…' '' $x $y
    } catch {
        $script:Task = $null
        Show-Overlay '翻译失败' $preview ('翻译服务不可用：' + $_.Exception.Message) '' $x $y
    }
}

function Retry-Translate() {
    if (-not $script:LastSource) { return }
    $pos = Get-Point
    Start-Translate $script:LastSource $pos.X $pos.Y
}

function Complete-Translate() {
    if (-not $script:Task) { return }
    $task = $script:Task
    if (-not $task.IsCompleted) { return }
    $script:Task = $null
    $pos = Get-Point
    $preview = $script:SourceText
    try {
        $response = $task.Result
        $body = $response.Content.ReadAsStringAsync().Result
        $json = $body | ConvertFrom-Json
        if ($json.ok -eq $true) {
            $meta = ('{0} ms · {1}' -f [int]$json.ms, $json.targetLanguage)
            Show-Overlay ('→ ' + $json.targetLanguage) $preview $json.text $meta $pos.X $pos.Y
        } elseif ($json.error) {
            Show-Overlay '翻译失败' $preview $json.error.message '' $pos.X $pos.Y
        } else {
            Show-Overlay '翻译失败' $preview ('HTTP ' + [int]$response.StatusCode) '' $pos.X $pos.Y
        }
    } catch {
        Show-Overlay '翻译失败' $preview $_.Exception.Message '' $pos.X $pos.Y
    }
}

# ───────────────────────────── 手势 → 取词 → 翻译 ─────────────────────────────

function Set-AnchorFromRects([DTWin32+POINT]$point, $rects) {
    $left = [double]$point.X
    $top = [double]$point.Y
    $right = [double]$point.X
    $bottom = [double]$point.Y
    if ($rects -and $rects.Count -gt 0) {
        $left = $rects[0].left
        $top = $rects[0].top
        $right = $rects[0].right
        $bottom = $rects[0].bottom
        foreach ($r in $rects) {
            if ($r.left -lt $left) { $left = $r.left }
            if ($r.top -lt $top) { $top = $r.top }
            if ($r.right -gt $right) { $right = $r.right }
            if ($r.bottom -gt $bottom) { $bottom = $r.bottom }
        }
    }
    $script:Anchor = @{ left = $left; top = $top; right = $right; bottom = $bottom }
}

function Invoke-Gesture([DTWin32+POINT]$point, [DTWin32+POINT]$pressPoint) {
    $hwnd = [DTWin32]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { return }
    if ($script:Overlay -and -not $script:Overlay.IsDisposed -and $script:Overlay.Handle -eq $hwnd) { return }

    $processName = Get-ProcessNameOfWindow $hwnd
    if ($processName -imatch 'dsh-translate-capture') { return }
    if ($processName -imatch '^(DeepSeek Harness|dsh)') { return }

    $pointObj = New-Object System.Windows.Point($point.X, $point.Y)
    $text = ''
    $source = 'uia'
    if (-not $script:NoUia) {
        for ($attempt = 1; $attempt -le 2; $attempt++) {
            $found = $null
            try { $found = Get-SelectionViaUia $pointObj } catch { $found = $null }
            if ($found -and $found.text -and $found.text.Trim().Length -gt 0) {
                $near = (Test-PointNearRects $point.X $point.Y $found.rects)
                if (-not $near -and $pressPoint) { $near = (Test-PointNearRects $pressPoint.X $pressPoint.Y $found.rects) }
                if ($near) {
                    $text = $found.text
                    Set-AnchorFromRects $point $found.rects
                    break
                }
                Write-Log ("stale selection ignored chars=" + $found.text.Length)
                return
            }
            Start-Sleep -Milliseconds 160
        }
    }
    if (-not $script:Anchor) { Set-AnchorFromRects $point $null }
    # 关键：先 Trim 再判空白。PDF 选区文本常以 CRLF 结尾，末尾换行会被误判成词间空白，
    # 从而永远跳过下面的兜底（之前就栽在这里：看起来取不到词，其实是不再补空格）。
    if ($text) { $text = $text.Trim() }
    if (-not $text) {
        $source = 'clipboard'
        try { $text = Get-SelectionViaClipboard ($hwnd) } catch { $text = '' }
        if ($text) { $text = $text.Trim() }
        # 剪贴板这条路也一样：Edge 的 PDF 阅读器复制出来的文本也可能没有词间空格
        if ($text -and $text -notmatch '\s' -and $text.Length -ge 8) {
            $text = Restore-WordSpacing $text
            $source = 'clipboard-respaced'
        }
    } elseif ($text -notmatch '\s' -and $text.Length -ge 8) {
        # 完全没有词间空白：多半是 PDF 文本层，剪贴板通常更准
        $rescued = ''
        try { $rescued = Get-SelectionViaClipboard ($hwnd) } catch { $rescued = '' }
        if ($rescued) { $rescued = $rescued.Trim() }
        if ($rescued -and $rescued -match '\s') {
            $text = $rescued
            $source = 'clipboard-rescue'
        } else {
            $text = Restore-WordSpacing $text
            $source = 'uia-respaced'
        }
    }
    if (-not $text) { return }
    $text = $text.Trim()
    if ($text.Length -lt 2) { return }
    if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) }

    $now = [Environment]::TickCount
    if ($text -eq $script:LastText -and ($now - $script:LastTextAt) -lt 5000) { return }
    $script:LastText = $text
    $script:LastTextAt = $now

    $appLabel = (Get-ProcessNameOfWindow $hwnd)
    Write-Log ("gesture app=$appLabel source=$source chars=" + $text.Length)
    Start-Translate $text $point.X $point.Y
}

# ───────────────────────────── 浮窗冒烟（画一帧 + 截图） ─────────────────────────────

if ($TestOverlay) {
    $result = @{ ok = $false; error = ''; shot = ''; size = '' }
    try {
        $script:Scale = Get-UiScale
        $sampleSource = 'The quick brown fox jumps over the lazy dog. This sentence is deliberately long so the source block has to clamp to two lines and ellipsize instead of pushing the translation out of the card.'
        $sampleBody = "快速的棕色狐狸跳过了懒狗。这句话故意写得很长，用来检查译文区域在达到最大高度之前能不能正常换行、不被裁切，也不会把底栏顶出卡片之外。`r`n`r`n换行也要正常：第二段应该完整显示。"
        $script:LastSource = $sampleSource
        if ($TestAnchor) {
            $parts0 = $TestAnchor.Split(',')
            if ($parts0.Count -eq 4) {
                $script:Anchor = @{ left = [double]$parts0[0]; top = [double]$parts0[1]; right = [double]$parts0[2]; bottom = [double]$parts0[3] }
            }
        }
        Show-Overlay '→ 简体中文' $sampleSource $sampleBody '860 ms · zh-Hans' 240 220
        $deadline = [Environment]::TickCount + 800
        while ([Environment]::TickCount -lt $deadline) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
        $form = $script:Overlay
        $form.Refresh()
        [System.Windows.Forms.Application]::DoEvents()
        $bounds = $form.Bounds
        $capture = {
            param($path)
            $bmp = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height)
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
            $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
            $g.Dispose(); $bmp.Dispose()
        }
        & $capture $ShotPath
        $result.shot = $ShotPath
        $result.placed = ('left=' + $form.Left + ' top=' + $form.Top + ' size=' + $form.Width + 'x' + $form.Height + ' anchorBottom=' + $script:Anchor.bottom)
        if ($TestAnchor) {
            $parts = $TestAnchor.Split(',')
            if ($parts.Count -eq 4) {
                $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
                $script:Anchor = @{
                    left   = [double]($wa.Left + 200)
                    top    = [double]($wa.Bottom - 60)
                    right  = [double]($wa.Left + 700)
                    bottom = [double]($wa.Bottom - 40)
                }
                Show-Overlay '→ 简体中文（翻到上方）' $sampleSource $sampleBody '860 · zh-Hans' 240 220
                [System.Windows.Forms.Application]::DoEvents()
                $flipShot = [System.IO.Path]::ChangeExtension($ShotPath, $null) + 'flip.png'
                $bounds2 = $script:Overlay.Bounds
                $bmp2 = New-Object System.Drawing.Bitmap([int]$bounds2.Width, [int]$bounds2.Height)
                $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
                $g2.CopyFromScreen($bounds2.Location, [System.Drawing.Point]::Empty, $bounds2.Size)
                $bmp2.Save($flipShot, [System.Drawing.Imaging.ImageFormat]::Png)
                $g2.Dispose(); $bmp2.Dispose()
                $result.flipShot = $flipShot
                $result.flipPlaced = ('left=' + $script:Overlay.Left + ' top=' + $script:Overlay.Top + ' anchorTop=' + $script:Anchor.top)
            }
        }
        $result.size = ('{0}x{1}' -f $form.Width, $form.Height)
        # 命中测试回归：这两个表达式之前用 Point 传 RectangleF 会抛异常（点重译就弹 .NET 错误框）
        $layout = $script:Layout
        $copyPoint = New-Object System.Drawing.PointF([single]($layout.copyRect.X + 2), [single]($layout.copyRect.Y + 2))
        $retryPoint = New-Object System.Drawing.PointF([single]($layout.retryRect.X + 2), [single]($layout.retryRect.Y + 2))
        $result.hitTest = ('copy=' + $layout.copyRect.Contains($copyPoint) + ' retry=' + $layout.retryRect.Contains($retryPoint))
        $result.ok = $true
        Hide-Overlay
        if ($script:Overlay -and -not $script:Overlay.IsDisposed) { $script:Overlay.Dispose() }
    } catch {
        $result.error = $_.Exception.Message
    }
    $result | ConvertTo-Json
    if ($result.ok) { exit 0 } else { exit 1 }
}

# ───────────────────────────── 探针：光标处能不能取到选区 ─────────────────────────────

if ($Probe) {
    $hwnd = [DTWin32]::GetForegroundWindow()
    $pos = Get-Point
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
        ok          = $true
        foreground  = (Get-WindowTitle $hwnd)
        windowClass = (Get-WindowClass $hwnd)
        process     = (Get-ProcessNameOfWindow $hwnd)
        uia         = $uiaText
        clipboard   = $clipText
        source      = $(if ($uiaText) { 'uia' } elseif ($clipText) { 'clipboard' } else { 'none' })
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
        # 源码自检：非注释行以中文开头 → 一定是被转义劈开的坏行（曾经因此「划词没反应」）
        $suspicious = @()
        try {
            foreach ($line in (Get-Content -Path $PSCommandPath -Encoding UTF8)) {
                if ($line -match '^\s*[\u4e00-\u9fff]') { $suspicious += $line.Trim() }
            }
        } catch { }
        $result.sourceLint = ($suspicious.Count -eq 0)
        if ($suspicious.Count -gt 0) { $result.sourceLintSample = ($suspicious | Select-Object -First 3) -join ' | ' }

        # 取词后处理与锚点的纯逻辑断言
        $spaced = Restore-WordSpacing 'TheInnerProduct'
        $untouched = Restore-WordSpacing 'u and v are vectors'
        Set-AnchorFromRects ([DTWin32+POINT]@{ X = 100; Y = 200 }) @(@{ left = 90; top = 180; right = 400; bottom = 260 })
        $anchorOk = ($script:Anchor.left -eq 90 -and $script:Anchor.bottom -eq 260)
        $result.logic = @{
            respace     = $spaced
            respaceOk   = ($spaced -eq 'The Inner Product')
            keepSpaces  = ($untouched -eq 'u and v are vectors')
            anchorOk    = $anchorOk
        }

        $result.uia = ($null -ne [System.Windows.Automation.AutomationElement])
        $result.winforms = ($null -ne [System.Windows.Forms.Cursor])
        $statusJson = (Invoke-WebRequest -Uri $script:ApiUrl -Method Get -UseBasicParsing -TimeoutSec 10).Content
        $status = $statusJson | ConvertFrom-Json
        $result.httpStatus = ($status.ok -eq $true)
        $payload = @{ action = 'translate'; text = 'The companion process reads the selection with UI Automation first.'; targetLanguage = $Target } | ConvertTo-Json -Compress
        $resp = Invoke-WebRequest -Uri $script:ApiUrl -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($payload)) -UseBasicParsing -TimeoutSec 60
        $parsed = $resp.Content | ConvertFrom-Json
        $result.translate = @{ ok = $parsed.ok; text = $parsed.text; target = $parsed.targetLanguage }
        $result.ok = ($result.httpStatus -and $parsed.ok -eq $true -and $result.sourceLint -and $result.logic.respaceOk -and $result.logic.keepSpaces -and $result.logic.anchorOk)
    } catch {
        $result.error = $_.Exception.Message
    }
    $result | ConvertTo-Json -Depth 4 | Write-Output
    if ($result.ok) { exit 0 } else { exit 1 }
}

# ───────────────────────────── 单实例 + 主循环 ─────────────────────────────

$mutexName = "Local\dsh-translate-capture"
$pidFile = Join-Path $env:TEMP 'dsh-translate-capture.pid'
$mutex = $null
$ownedPidFile = $false
try {
    $mutex = New-Object System.Threading.Mutex($false, $mutexName)
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

$script:Scale = Get-UiScale
Write-Log ("start version=" + $script:ScriptVersion + " port=" + $Port + " target=" + $Target + " scale=" + $script:Scale + " parent=" + $ParentPid)

$parentCheckedAt = [Environment]::TickCount

try {
    while ($true) {
        Complete-Translate

        if ($ParentPid -gt 0) {
            $now = [Environment]::TickCount
            if (($now - $parentCheckedAt) -gt 3000) {
                $parentCheckedAt = $now
                if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
                    Write-Log 'parent process gone; exiting'
                    break
                }
            }
        }

        $pos = Get-Point
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
                $isDouble = ((($now - $script:LastClickAt) -lt 450) -and ($dist -lt 8))
            }
            if ($moved -ge 5 -or $isDouble) {
                try { Invoke-Gesture $pos $script:DownPoint } catch { Write-Log ('gesture failed: ' + $_.Exception.Message) }
            }
            $script:LastClickAt = $now
            $script:LastClickPoint = $pos
        }
        $script:LeftDown = $down

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
