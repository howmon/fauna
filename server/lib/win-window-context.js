// win-window-context — Windows equivalent of mac-window-context. Uses
// PowerShell + User32 P/Invoke to enumerate top-level windows and move
// them. No native build required; ships with every Windows install.

import { execFile } from 'child_process';

const IS_WIN = process.platform === 'win32';

function runPowerShell(script, { timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) return reject(Object.assign(err, { stderr: String(stderr || '') }));
        resolve(String(stdout || ''));
      },
    );
  });
}

// PowerShell that defines a small Win32 helper, walks every top-level
// visible window, resolves the owning process, and emits JSON.
const LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class FaunaWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<object[]> Collect() {
    var list = new List<object[]>();
    IntPtr fg = GetForegroundWindow();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      bool min = IsIconic(h);
      list.Add(new object[] { (long)h, (int)pid, sb.ToString(), r.L, r.T, r.R - r.L, r.B - r.T, h == fg, min });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@ | Out-Null
$rows = [FaunaWin]::Collect()
$apps = @{}
foreach ($w in $rows) {
  $hwnd = $w[0]; $pid = [int]$w[1]; $title = [string]$w[2]
  $x = [int]$w[3]; $y = [int]$w[4]; $ww = [int]$w[5]; $hh = [int]$w[6]
  $front = [bool]$w[7]; $min = [bool]$w[8]
  $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
  if ($null -eq $proc) { continue }
  $name = $proc.ProcessName
  if (-not $apps.ContainsKey($pid)) {
    $apps[$pid] = [pscustomobject]@{ name = $name; pid = $pid; frontmost = $false; windows = New-Object System.Collections.ArrayList }
  }
  if ($front) { $apps[$pid].frontmost = $true }
  [void]$apps[$pid].windows.Add([pscustomobject]@{ title = $title; x = $x; y = $y; w = $ww; h = $hh; hwnd = $hwnd; minimized = $min })
}
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$scr = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$out = [pscustomobject]@{
  ok = $true
  apps = @($apps.Values)
  screen = [pscustomobject]@{ ok = $true; x = $scr.X; y = $scr.Y; width = $scr.Width; height = $scr.Height }
}
$out | ConvertTo-Json -Depth 6 -Compress
`;

export async function listVisibleWindows({ timeoutMs = 8000 } = {}) {
  if (!IS_WIN) return { ok: false, error: 'Windows only', apps: [] };
  let raw;
  try { raw = await runPowerShell(LIST_SCRIPT, { timeoutMs }); }
  catch (e) { return { ok: false, error: (e.stderr || e.message || String(e)).trim(), apps: [] }; }
  try {
    const parsed = JSON.parse(raw.trim() || '{}');
    const apps = Array.isArray(parsed.apps) ? parsed.apps : (parsed.apps ? [parsed.apps] : []);
    for (const a of apps) {
      a.windows = Array.isArray(a.windows) ? a.windows : (a.windows ? [a.windows] : []);
    }
    return { ok: true, apps, screen: parsed.screen || null };
  } catch (e) {
    return { ok: false, error: 'parse failed: ' + e.message, raw: raw.slice(0, 200), apps: [] };
  }
}

// arrangeWindows — moves windows by matching them via the same enumeration,
// then calling SetWindowPos on the chosen HWND. moves entries:
//   { app, x, y, w, h, windowIndex?, windowTitle? }
export async function arrangeWindows(moves, { timeoutMs = 10000 } = {}) {
  if (!IS_WIN) return { ok: false, error: 'Windows only', results: [] };
  if (!Array.isArray(moves) || !moves.length) return { ok: true, results: [] };

  const movesJson = JSON.stringify(moves).replace(/'/g, "''");
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class FaunaWin2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint SWP_NOZORDER = 0x0004;
  public const uint SWP_NOACTIVATE = 0x0010;
  public const int SW_RESTORE = 9;
  public static List<object[]> Enumerate() {
    var list = new List<object[]>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      uint pid = 0; GetWindowThreadProcessId(h, out pid);
      list.Add(new object[] { (long)h, (int)pid, sb.ToString() });
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@ | Out-Null
$moves = '` + movesJson + `' | ConvertFrom-Json
$rows = [FaunaWin2]::Enumerate()
$byApp = @{}
foreach ($r in $rows) {
  $proc = Get-Process -Id ([int]$r[1]) -ErrorAction SilentlyContinue
  if ($null -eq $proc) { continue }
  $key = $proc.ProcessName.ToLower()
  if (-not $byApp.ContainsKey($key)) { $byApp[$key] = New-Object System.Collections.ArrayList }
  [void]$byApp[$key].Add([pscustomobject]@{ hwnd = [IntPtr][long]$r[0]; title = [string]$r[2] })
}
$results = New-Object System.Collections.ArrayList
foreach ($m in @($moves)) {
  $appKey = ([string]$m.app).ToLower()
  $list = $byApp[$appKey]
  if ($null -eq $list -or $list.Count -eq 0) {
    [void]$results.Add([pscustomobject]@{ app = $m.app; ok = $false; error = 'app not found' }); continue
  }
  $target = $null
  if ($m.windowTitle) {
    foreach ($w in $list) { if ($w.title -eq $m.windowTitle) { $target = $w; break } }
  }
  if ($null -eq $target) {
    $idx = if ($m.windowIndex) { [int]$m.windowIndex } else { 1 }
    if ($idx -lt 1 -or $idx -gt $list.Count) { $idx = 1 }
    $target = $list[$idx - 1]
  }
  if ($null -eq $m.x -or $null -eq $m.y -or $null -eq $m.w -or $null -eq $m.h) {
    [void]$results.Add([pscustomobject]@{ app = $m.app; ok = $false; error = 'x/y/w/h required' }); continue
  }
  [FaunaWin2]::ShowWindow($target.hwnd, [FaunaWin2]::SW_RESTORE) | Out-Null
  $flags = [FaunaWin2]::SWP_NOZORDER -bor [FaunaWin2]::SWP_NOACTIVATE
  $ok = [FaunaWin2]::SetWindowPos($target.hwnd, [IntPtr]::Zero, [int]$m.x, [int]$m.y, [int]$m.w, [int]$m.h, $flags)
  [void]$results.Add([pscustomobject]@{ app = $m.app; ok = [bool]$ok; x = [int]$m.x; y = [int]$m.y; w = [int]$m.w; h = [int]$m.h })
}
[pscustomobject]@{ ok = (@($results) | Where-Object { -not $_.ok } | Measure-Object).Count -eq 0; results = @($results) } | ConvertTo-Json -Depth 5 -Compress
`;
  try {
    const raw = await runPowerShell(script, { timeoutMs });
    const parsed = JSON.parse(raw.trim() || '{}');
    const results = Array.isArray(parsed.results) ? parsed.results : (parsed.results ? [parsed.results] : []);
    return { ok: !!parsed.ok, results };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).trim(), results: [] };
  }
}

export async function getScreenBounds({ timeoutMs = 4000 } = {}) {
  if (!IS_WIN) return { ok: false, error: 'Windows only' };
  const script = `
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
[pscustomobject]@{ ok = $true; x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height } | ConvertTo-Json -Compress
`;
  try {
    const raw = await runPowerShell(script, { timeoutMs });
    return JSON.parse(raw.trim() || '{}');
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).trim() };
  }
}
