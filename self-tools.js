// ── Self-Tools — LLM-callable tools that let the AI manage the Fauna app ──
// These tools let the AI introspect and control the application:
// memory, models, settings, projects, instructions, notifications.

/**
 * @typedef {{getModels: () => Array<{id: string, name: string}>, getSettings: () => object, sendToRenderer: (channel: string, ...args: any[]) => void, sendNotification: (title: string, body: string) => void}} SelfToolContext
 */

import {
  remember as factsRemember, recall as factsRecall, forget as factsForget,
  listFacts, getStats as factsGetStats,
} from './memory-store.js';
import {
  createProject, getAllProjects, getProject,
  addBacklogItem, listBacklog, prioritizeBacklog,
} from './project-manager.js';
import { renderCircuit } from './lib/circuit-renderer.js';
import { validateCircuit } from './lib/circuit-validate.js';
import { SYMBOLS, listSymbolTypes } from './lib/circuit-symbols.js';
import { simulateCircuit } from './lib/circuit-simulate.js';
import { packWidgetResult } from './lib/dynamic-widgets.js';
import {
  createJob as videoCreateJob,
  getJob as videoGetJob,
  listJobs as videoListJobs,
  patchJob as videoPatchJob,
  runStep as videoRunStep,
  runAll as videoRunAll,
  subscribe as videoSubscribe,
} from './server/video/job.js';
import { buildVideoStudioWidget } from './server/video/widget-bundle.js';
import { getCopilotClient as videoGetCopilotClient } from './server/copilot/auth.js';
import {
  synthSingleKokoro,
  synthKokoroPodcast,
  probeKokoroDuration,
} from './server/routes/kokoro-tts.js';
import {
  createLesson as lessonCreate,
  loadLesson as lessonLoad,
  LESSON_KINDS,
  ACTION_DOS as LESSON_ACTIONS,
} from './server/lesson/generator.js';
import { buildLessonWidget } from './server/lesson/widget-bundle.js';
import {
  searchStockImages,
  downloadStockImages,
  availableImageProviders,
} from './server/media/stock-images.js';
import {
  savePlaybookEntry, listPlaybookEntries, getPlaybookEntry,
  touchPlaybookEntry, deletePlaybookEntry,
} from './playbook-store.js';
import {
  listVisibleWindows as macListVisibleWindows,
  arrangeWindows as macArrangeWindows,
  getScreenBounds as macGetScreenBounds,
} from './server/lib/window-context.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';

const HOME = os.homedir();

function _runCmd(cmd, argv, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (input != null) { child.stdin.end(input); } else { child.stdin.end(); }
  });
}

// ── Native helper (macOS) ─────────────────────────────────────────────
// Single Swift binary built once and cached, dispatching sub-commands via
// argv. Drops latency from ~1s (swift interpreter) to ~10ms per call.

const FAUNA_HELPER_SWIFT = `
import Foundation
import CoreGraphics
import ApplicationServices
import AppKit

let args = CommandLine.arguments
let cmd = args.count > 1 ? args[1] : ""
func d(_ i: Int) -> Double { return args.count > i ? (Double(args[i]) ?? 0) : 0 }
func s(_ i: Int) -> String { return args.count > i ? args[i] : "" }

func mouseMove(_ x: Double, _ y: Double) {
  if let e = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) { e.post(tap: .cghidEventTap) }
}
func mouseClick(_ x: Double, _ y: Double, right: Bool = false, clicks: Int = 1) {
  let down: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let up: CGEventType   = right ? .rightMouseUp   : .leftMouseUp
  let btn: CGMouseButton = right ? .right : .left
  for i in 1...clicks {
    if let e = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: btn) {
      e.setIntegerValueField(.mouseEventClickState, value: Int64(i)); e.post(tap: .cghidEventTap)
    }
    if let e = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: btn) {
      e.setIntegerValueField(.mouseEventClickState, value: Int64(i)); e.post(tap: .cghidEventTap)
    }
    if clicks > 1 { Thread.sleep(forTimeInterval: 0.05) }
  }
}
func mouseDrag(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
  if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: CGPoint(x: x1, y: y1), mouseButton: .left) { e.post(tap: .cghidEventTap) }
  Thread.sleep(forTimeInterval: 0.05)
  let steps = 20
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let x = x1 + (x2 - x1) * t; let y = y1 + (y2 - y1) * t
    if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) { e.post(tap: .cghidEventTap) }
    Thread.sleep(forTimeInterval: 0.01)
  }
  if let e = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: CGPoint(x: x2, y: y2), mouseButton: .left) { e.post(tap: .cghidEventTap) }
}
func mouseScroll(_ dy: Double) {
  if let e = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0) { e.post(tap: .cghidEventTap) }
}
func mousePosition() -> (Double, Double) {
  let p = NSEvent.mouseLocation
  let h = NSScreen.main?.frame.height ?? 0
  return (p.x, h - p.y)
}

// ── Keyboard ───────────────────────────────────────────────────────────
// US-QWERTY virtual key map for common keys
let kVK: [String: CGKeyCode] = [
  "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,
  "e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,
  "7":26,"-":27,"8":28,"0":29,"]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"l":37,"j":38,
  "'":39,"k":40,";":41,"\\\\":42,",":43,"/":44,"n":45,"m":46,".":47,"\`":50,
  "return":36,"enter":36,"tab":48,"space":49," ":49,"delete":51,"backspace":51,
  "escape":53,"esc":53,"left":123,"right":124,"down":125,"up":126,
  "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111,
  "home":115,"end":119,"pageup":116,"pagedown":121
]
let kFlags: [String: CGEventFlags] = [
  "cmd":.maskCommand,"command":.maskCommand,"meta":.maskCommand,"super":.maskCommand,
  "shift":.maskShift,"alt":.maskAlternate,"option":.maskAlternate,"opt":.maskAlternate,
  "ctrl":.maskControl,"control":.maskControl,"fn":.maskSecondaryFn
]

func typeText(_ text: String) {
  // CGEventKeyboardSetUnicodeString — types arbitrary Unicode without VK mapping
  for ch in text {
    let s = String(ch)
    let utf16 = Array(s.utf16)
    if let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) {
      utf16.withUnsafeBufferPointer { buf in down.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buf.baseAddress) }
      down.post(tap: .cghidEventTap)
    }
    if let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
      utf16.withUnsafeBufferPointer { buf in up.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: buf.baseAddress) }
      up.post(tap: .cghidEventTap)
    }
  }
}

func pressCombo(_ combo: String) -> Bool {
  // "cmd+shift+a" -> flags + base key
  let parts = combo.lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
  var flags: CGEventFlags = []
  var base: CGKeyCode? = nil
  for p in parts {
    if let f = kFlags[p] { flags.insert(f) }
    else if let k = kVK[p] { base = k }
  }
  guard let key = base else { return false }
  if let down = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: true) {
    down.flags = flags; down.post(tap: .cghidEventTap)
  }
  if let up = CGEvent(keyboardEventSource: nil, virtualKey: key, keyDown: false) {
    up.flags = flags; up.post(tap: .cghidEventTap)
  }
  return true
}

// ── Accessibility (UI tree) ────────────────────────────────────────────
func axString(_ el: AXUIElement, _ attr: String) -> String? {
  var v: CFTypeRef?
  if AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let s = v as? String { return s }
  return nil
}
func axRect(_ el: AXUIElement) -> CGRect? {
  var posV: CFTypeRef?
  var sizV: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posV) == .success,
        AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizV) == .success,
        let pos = posV, let siz = sizV else { return nil }
  var p = CGPoint.zero, s = CGSize.zero
  AXValueGetValue(pos as! AXValue, .cgPoint, &p)
  AXValueGetValue(siz as! AXValue, .cgSize, &s)
  return CGRect(origin: p, size: s)
}
func axChildren(_ el: AXUIElement) -> [AXUIElement] {
  var v: CFTypeRef?
  if AXUIElementCopyAttributeValue(el, kAXChildrenAttribute as CFString, &v) == .success, let arr = v as? [AXUIElement] { return arr }
  return []
}

let CLICKABLE_ROLES: Set<String> = ["AXButton","AXLink","AXCheckBox","AXRadioButton","AXMenuItem","AXMenuButton","AXPopUpButton","AXTextField","AXTextArea","AXSearchField","AXTabGroup","AXCell"]

struct UINode { var role: String; var title: String; var x: Int; var y: Int; var w: Int; var h: Int; var path: String; var children: [UINode] }

func walk(_ el: AXUIElement, _ path: String, _ depth: Int, _ maxDepth: Int) -> UINode? {
  let role = axString(el, kAXRoleAttribute as String) ?? "?"
  let title = axString(el, kAXTitleAttribute as String) ?? axString(el, kAXValueAttribute as String) ?? axString(el, kAXDescriptionAttribute as String) ?? ""
  let rect = axRect(el) ?? .zero
  var node = UINode(role: role, title: title, x: Int(rect.minX), y: Int(rect.minY), w: Int(rect.width), h: Int(rect.height), path: path, children: [])
  if depth < maxDepth {
    let kids = axChildren(el)
    for (i, k) in kids.enumerated() {
      if let n = walk(k, path + "/" + String(i), depth + 1, maxDepth) { node.children.append(n) }
    }
  }
  return node
}

func nodeToJSON(_ n: UINode, clickableOnly: Bool) -> String {
  var out = "{"
  out += "\\"role\\":" + jsonStr(n.role)
  out += ",\\"title\\":" + jsonStr(n.title)
  out += ",\\"x\\":\\(n.x),\\"y\\":\\(n.y),\\"w\\":\\(n.w),\\"h\\":\\(n.h)"
  out += ",\\"path\\":" + jsonStr(n.path)
  if clickableOnly && CLICKABLE_ROLES.contains(n.role) {
    out += ",\\"clickable\\":true"
  }
  if !n.children.isEmpty {
    out += ",\\"children\\":["
    out += n.children.map { nodeToJSON($0, clickableOnly: clickableOnly) }.joined(separator: ",")
    out += "]"
  }
  out += "}"
  return out
}
func jsonStr(_ s: String) -> String {
  var out = "\\""
  for c in s {
    switch c {
      case "\\"": out += "\\\\\\""
      case "\\\\": out += "\\\\\\\\"
      case "\\n": out += "\\\\n"
      case "\\r": out += "\\\\r"
      case "\\t": out += "\\\\t"
      default:
        if c.asciiValue != nil && c.asciiValue! < 0x20 { out += String(format: "\\\\u%04x", c.asciiValue!) }
        else { out.append(c) }
    }
  }
  out += "\\""
  return out
}

func uiTree(maxDepth: Int, clickableOnly: Bool) -> String {
  guard let app = NSWorkspace.shared.frontmostApplication else { return "{\\"error\\":\\"no frontmost app\\"}" }
  let pid = app.processIdentifier
  let axApp = AXUIElementCreateApplication(pid)
  var winV: CFTypeRef?
  guard AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &winV) == .success, let win = winV else {
    // Fall back to app root
    let n = walk(axApp, "", 0, maxDepth) ?? UINode(role: "AXApplication", title: app.localizedName ?? "", x: 0, y: 0, w: 0, h: 0, path: "", children: [])
    return "{\\"app\\":" + jsonStr(app.localizedName ?? "") + ",\\"tree\\":" + nodeToJSON(n, clickableOnly: clickableOnly) + "}"
  }
  let node = walk(win as! AXUIElement, "", 0, maxDepth) ?? UINode(role: "AXWindow", title: "", x: 0, y: 0, w: 0, h: 0, path: "", children: [])
  return "{\\"app\\":" + jsonStr(app.localizedName ?? "") + ",\\"tree\\":" + nodeToJSON(node, clickableOnly: clickableOnly) + "}"
}

func frontmostApp() -> String {
  guard let app = NSWorkspace.shared.frontmostApplication else { return "{\\"error\\":\\"no frontmost app\\"}" }
  let pid = app.processIdentifier
  let axApp = AXUIElementCreateApplication(pid)
  var winTitle = ""
  var winX = 0, winY = 0, winW = 0, winH = 0
  var winV: CFTypeRef?
  if AXUIElementCopyAttributeValue(axApp, kAXFocusedWindowAttribute as CFString, &winV) == .success, let win = winV {
    let w = win as! AXUIElement
    winTitle = axString(w, kAXTitleAttribute as String) ?? ""
    if let r = axRect(w) { winX = Int(r.minX); winY = Int(r.minY); winW = Int(r.width); winH = Int(r.height) }
  }
  var screens = "["
  for (i, sc) in NSScreen.screens.enumerated() {
    if i > 0 { screens += "," }
    let f = sc.frame
    screens += "{\\"index\\":\\(i),\\"x\\":\\(Int(f.minX)),\\"y\\":\\(Int(f.minY)),\\"w\\":\\(Int(f.width)),\\"h\\":\\(Int(f.height))}"
  }
  screens += "]"
  var out = "{"
  out += "\\"app\\":" + jsonStr(app.localizedName ?? "")
  out += ",\\"bundleId\\":" + jsonStr(app.bundleIdentifier ?? "")
  out += ",\\"pid\\":\\(pid)"
  out += ",\\"window\\":{\\"title\\":" + jsonStr(winTitle) + ",\\"x\\":\\(winX),\\"y\\":\\(winY),\\"w\\":\\(winW),\\"h\\":\\(winH)}"
  out += ",\\"screens\\":" + screens
  out += "}"
  return out
}

switch cmd {
  case "mouse_move":     mouseMove(d(2), d(3))
  case "mouse_click":    mouseClick(d(2), d(3))
  case "mouse_double":   mouseClick(d(2), d(3), clicks: 2)
  case "mouse_right":    mouseClick(d(2), d(3), right: true)
  case "mouse_drag":     mouseDrag(d(2), d(3), d(4), d(5))
  case "mouse_scroll":   mouseScroll(d(2))
  case "mouse_position":
    let (x, y) = mousePosition()
    print("{\\"x\\":\\(x),\\"y\\":\\(y)}")
    exit(0)
  case "type":           typeText(s(2))
  case "key":            if !pressCombo(s(2)) { FileHandle.standardError.write("bad combo\\n".data(using: .utf8)!); exit(3) }
  case "ui_tree":
    let depth = Int(s(2)) ?? 8
    let clickOnly = s(3) == "1"
    print(uiTree(maxDepth: depth, clickableOnly: clickOnly))
    exit(0)
  case "frontmost_app":
    print(frontmostApp())
    exit(0)
  default:
    FileHandle.standardError.write("unknown cmd: \\(cmd)\\n".data(using: .utf8)!); exit(2)
}
print("ok")
`;

const FAUNA_HELPER_VERSION = 'v3'; // bump to force rebuild
let _faunaHelperPath = null;

async function _getFaunaHelper() {
  if (process.platform !== 'darwin') throw new Error('fauna-helper is macOS-only');
  if (_faunaHelperPath && fs.existsSync(_faunaHelperPath)) return _faunaHelperPath;
  const dir = path.join(HOME, 'Library', 'Application Support', '@eichho', 'fauna', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const sha = crypto.createHash('sha256').update(FAUNA_HELPER_SWIFT).update(FAUNA_HELPER_VERSION).digest('hex').slice(0, 12);
  const bin = path.join(dir, 'fauna-helper-' + sha);
  if (fs.existsSync(bin)) { _faunaHelperPath = bin; return bin; }
  const src = path.join(dir, 'fauna-helper-' + sha + '.swift');
  fs.writeFileSync(src, FAUNA_HELPER_SWIFT, 'utf8');
  const r = await _runCmd('/usr/bin/swiftc', ['-O', '-o', bin, src]);
  if (r.code !== 0) {
    if (/swiftc: not found|No such file/.test(r.stderr)) {
      throw new Error('Swift toolchain missing. Install Xcode Command Line Tools: xcode-select --install');
    }
    throw new Error('fauna-helper compile failed: ' + (r.stderr || '').slice(0, 500));
  }
  _faunaHelperPath = bin;
  return bin;
}

function _classifyHelperError(stderr) {
  const s = stderr || '';
  if (/not (?:trusted|permitted)|accessibility|denied|kAXError|AXError/i.test(s)) {
    return 'Accessibility permission missing for Fauna. Grant in System Settings → Privacy & Security → Accessibility, then quit and relaunch Fauna.';
  }
  return null;
}

async function _faunaMouse(args) {
  const action = String(args.action || '').trim();
  if (!action) throw new Error('action required');
  const plat = process.platform;
  if (plat !== 'darwin' && plat !== 'win32') {
    throw new Error('fauna_mouse supports macOS and Windows only (current: ' + plat + ')');
  }
  const needsXY = ['move', 'click', 'double_click', 'right_click', 'drag'].includes(action);
  if (needsXY && (!Number.isFinite(args.x) || !Number.isFinite(args.y))) {
    throw new Error('x and y required for action ' + action);
  }
  if (action === 'drag' && (!Number.isFinite(args.toX) || !Number.isFinite(args.toY))) {
    throw new Error('toX and toY required for drag');
  }
  if (action === 'scroll' && !Number.isFinite(args.dy)) {
    throw new Error('dy required for scroll');
  }

  // Click-preview HUD — flash a visible target ring at (x,y) just before the
  // click fires so the user can see what Fauna is about to interact with.
  // Skipped for `move`/`scroll` (no discrete target) and when args.silent===true.
  const previewKind = action === 'click' ? 'click'
                    : action === 'double_click' ? 'click'
                    : action === 'right_click' ? 'right'
                    : action === 'drag' ? 'drag'
                    : null;
  if (previewKind && !args.silent && typeof global.__faunaShowClickPreview === 'function') {
    try {
      global.__faunaShowClickPreview({
        kind: previewKind, x: args.x, y: args.y,
        toX: args.toX, toY: args.toY,
      });
      // Brief delay so the user actually sees the ring before the click lands.
      await new Promise(r => setTimeout(r, 240));
    } catch (_) {}
  }

  if (plat === 'darwin') {
    const helper = await _getFaunaHelper();
    const cmdMap = { move: 'mouse_move', click: 'mouse_click', double_click: 'mouse_double', right_click: 'mouse_right', drag: 'mouse_drag', scroll: 'mouse_scroll' };
    const argv = [cmdMap[action]];
    if (action === 'scroll') argv.push(String(args.dy));
    else if (action === 'drag') argv.push(String(args.x), String(args.y), String(args.toX), String(args.toY));
    else argv.push(String(args.x), String(args.y));
    const r = await _runCmd(helper, argv);
    if (r.code !== 0) {
      const e = _classifyHelperError(r.stderr);
      return { ok: false, error: e || ('mouse command failed (exit ' + r.code + ')'), stderr: (r.stderr || '').slice(0, 500) };
    }
    return { ok: true, action, platform: 'darwin' };
  }

  // win32
  const ps = `
$signature = @'
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(int dwFlags, int dx, int dy, int dwData, int dwExtraInfo);
'@
$mouse = Add-Type -MemberDefinition $signature -Name MouseInput -Namespace FaunaMouse -PassThru
$action = $args[0]
function Do-Click($x, $y, $btn, $clicks) {
  $mouse::SetCursorPos([int]$x, [int]$y)
  $down = if ($btn -eq 'right') { 0x0008 } else { 0x0002 }
  $up   = if ($btn -eq 'right') { 0x0010 } else { 0x0004 }
  for ($i = 0; $i -lt $clicks; $i++) { $mouse::mouse_event($down, 0, 0, 0, 0); $mouse::mouse_event($up, 0, 0, 0, 0) }
}
switch ($action) {
  'move'         { $mouse::SetCursorPos([int]$args[1], [int]$args[2]) }
  'click'        { Do-Click $args[1] $args[2] 'left' 1 }
  'double_click' { Do-Click $args[1] $args[2] 'left' 2 }
  'right_click'  { Do-Click $args[1] $args[2] 'right' 1 }
  'drag' {
    $mouse::SetCursorPos([int]$args[1], [int]$args[2]); $mouse::mouse_event(0x0002, 0, 0, 0, 0)
    Start-Sleep -Milliseconds 50
    $mouse::SetCursorPos([int]$args[3], [int]$args[4]); $mouse::mouse_event(0x0004, 0, 0, 0, 0)
  }
  'scroll' { $mouse::mouse_event(0x0800, 0, 0, [int]([double]$args[1] * -120), 0) }
}
Write-Output 'ok'
`;
  const argv = ['-NoProfile', '-NonInteractive', '-Command', ps, '-Args', action];
  if (action === 'scroll') argv.push(String(args.dy));
  else if (action === 'drag') argv.push(String(args.x), String(args.y), String(args.toX), String(args.toY));
  else if (needsXY) argv.push(String(args.x), String(args.y));
  const r = await _runCmd('powershell.exe', argv);
  if (r.code !== 0) return { ok: false, error: 'mouse command failed (exit ' + r.code + ')', stderr: (r.stderr || '').slice(0, 500) };
  return { ok: true, action, platform: 'win32' };
}

async function _faunaMousePosition() {
  const plat = process.platform;
  if (plat === 'darwin') {
    const helper = await _getFaunaHelper();
    const r = await _runCmd(helper, ['mouse_position']);
    if (r.code !== 0) return { ok: false, error: _classifyHelperError(r.stderr) || 'failed', stderr: (r.stderr || '').slice(0, 300) };
    try { return { ok: true, ...JSON.parse(r.stdout.trim()) }; } catch (e) { return { ok: false, error: 'bad output: ' + r.stdout.slice(0, 200) }; }
  }
  if (plat === 'win32') {
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $p = [System.Windows.Forms.Cursor]::Position; Write-Output ("{""x"":" + $p.X + ",""y"":" + $p.Y + "}")`;
    const r = await _runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    if (r.code !== 0) return { ok: false, error: 'failed', stderr: (r.stderr || '').slice(0, 300) };
    try { return { ok: true, ...JSON.parse(r.stdout.trim()) }; } catch (e) { return { ok: false, error: 'bad output' }; }
  }
  return { ok: false, error: 'unsupported platform: ' + plat };
}

async function _faunaKeyboard(args) {
  const plat = process.platform;
  const action = String(args.action || '').trim();
  if (action !== 'type' && action !== 'key') throw new Error('action must be "type" or "key"');
  if (action === 'type' && typeof args.text !== 'string') throw new Error('text required for action=type');
  if (action === 'key'  && typeof args.combo !== 'string') throw new Error('combo required for action=key (e.g. "cmd+c", "shift+tab")');

  if (plat === 'darwin') {
    const helper = await _getFaunaHelper();
    const argv = action === 'type' ? ['type', args.text] : ['key', args.combo];
    const r = await _runCmd(helper, argv);
    if (r.code !== 0) {
      const e = _classifyHelperError(r.stderr);
      return { ok: false, error: e || ('keyboard command failed (exit ' + r.code + ')'), stderr: (r.stderr || '').slice(0, 500) };
    }
    return { ok: true, action, platform: 'darwin' };
  }
  if (plat === 'win32') {
    // SendKeys-style; combo translated to SendKeys notation
    let sendStr;
    if (action === 'type') {
      // Escape SendKeys special chars
      sendStr = args.text.replace(/([+^%~(){}[\]])/g, '{$1}');
    } else {
      const parts = args.combo.toLowerCase().split('+').map(p => p.trim());
      const modMap = { cmd: '^', ctrl: '^', control: '^', shift: '+', alt: '%', meta: '^' };
      const keyMap = { enter: '{ENTER}', tab: '{TAB}', escape: '{ESC}', esc: '{ESC}', backspace: '{BACKSPACE}', delete: '{DELETE}', space: ' ', up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}', end: '{END}' };
      let mods = '', key = '';
      for (const p of parts) {
        if (modMap[p]) mods += modMap[p];
        else key = keyMap[p] || p;
      }
      sendStr = mods + key;
    }
    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${JSON.stringify(sendStr)}); Write-Output 'ok'`;
    const r = await _runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    if (r.code !== 0) return { ok: false, error: 'keyboard failed (exit ' + r.code + ')', stderr: (r.stderr || '').slice(0, 500) };
    return { ok: true, action, platform: 'win32' };
  }
  return { ok: false, error: 'unsupported platform: ' + plat };
}

async function _faunaUITree(args) {
  const plat = process.platform;
  const maxDepth = Math.max(1, Math.min(20, Number(args.maxDepth) || 8));
  const clickableOnly = !!args.clickableOnly;
  if (plat === 'darwin') {
    const helper = await _getFaunaHelper();
    const r = await _runCmd(helper, ['ui_tree', String(maxDepth), clickableOnly ? '1' : '0']);
    if (r.code !== 0) {
      const e = _classifyHelperError(r.stderr);
      return { ok: false, error: e || ('ui_tree failed (exit ' + r.code + ')'), stderr: (r.stderr || '').slice(0, 500) };
    }
    try {
      const parsed = JSON.parse(r.stdout);
      return { ok: true, ...parsed };
    } catch (e) {
      return { ok: false, error: 'bad output: ' + r.stdout.slice(0, 200) };
    }
  }
  if (plat === 'win32') {
    // PowerShell UIAutomation traversal
    const ps = `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::FocusedElement
if ($null -eq $root) { Write-Output '{"error":"no focused element"}'; exit 0 }
function NodeToObj($el, $depth, $maxDepth, $path) {
  $r = $el.Current
  $rect = $r.BoundingRectangle
  $obj = [ordered]@{
    role = $r.ControlType.ProgrammaticName
    title = $r.Name
    x = [int]$rect.X; y = [int]$rect.Y; w = [int]$rect.Width; h = [int]$rect.Height
    path = $path
  }
  if ($depth -lt $maxDepth) {
    $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    $children = @()
    for ($i = 0; $i -lt $kids.Count; $i++) { $children += (NodeToObj $kids[$i] ($depth + 1) $maxDepth ($path + "/" + $i)) }
    if ($children.Count -gt 0) { $obj.children = $children }
  }
  return $obj
}
$out = [ordered]@{ app = (Get-Process -Id ([System.Diagnostics.Process]::GetCurrentProcess().Id)).MainWindowTitle; tree = (NodeToObj $root 0 ${maxDepth} '') }
$out | ConvertTo-Json -Depth 30 -Compress
`;
    const r = await _runCmd('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
    if (r.code !== 0) return { ok: false, error: 'ui_tree failed', stderr: (r.stderr || '').slice(0, 500) };
    try { return { ok: true, ...JSON.parse(r.stdout) }; } catch (e) { return { ok: false, error: 'bad output' }; }
  }
  return { ok: false, error: 'unsupported platform: ' + plat };
}

// fauna_screen_context — one-call snapshot of what the user is looking at.
// Bundles: frontmost app + window bounds + display list + clickable AX nodes
// (top N flattened, with screen-space coords). Designed for Clippy-style
// companion mode so the model can answer "what am I looking at?" in one tool
// round-trip instead of chaining fauna_list_windows + fauna_ui_tree.
function _flattenAX(node, out, max) {
  if (!node || out.length >= max) return;
  if (node.role && node.title !== undefined) {
    const clickable = /Button|Link|CheckBox|RadioButton|MenuItem|MenuButton|PopUpButton|TextField|TextArea|SearchField|Tab|Cell/i.test(node.role || '');
    if (clickable || (node.title && node.title.length > 0 && node.title.length < 80)) {
      out.push({
        role: node.role,
        title: (node.title || '').slice(0, 80),
        x: node.x, y: node.y, w: node.w, h: node.h,
        path: node.path,
        cx: Math.round((node.x || 0) + (node.w || 0) / 2),
        cy: Math.round((node.y || 0) + (node.h || 0) / 2),
      });
    }
  }
  if (Array.isArray(node.children)) {
    for (const c of node.children) {
      if (out.length >= max) break;
      _flattenAX(c, out, max);
    }
  }
}

async function _faunaScreenContext(args) {
  const plat = process.platform;
  const max = Math.max(5, Math.min(120, Number(args?.maxNodes) || 40));
  const depth = Math.max(3, Math.min(15, Number(args?.depth) || 8));
  if (plat === 'darwin') {
    const helper = await _getFaunaHelper();
    const [frontR, treeR] = await Promise.all([
      _runCmd(helper, ['frontmost_app']),
      _runCmd(helper, ['ui_tree', String(depth), '0']),
    ]);
    if (frontR.code !== 0) {
      const e = _classifyHelperError(frontR.stderr);
      return { ok: false, error: e || ('frontmost_app failed (exit ' + frontR.code + ')'), stderr: (frontR.stderr || '').slice(0, 500) };
    }
    let front, tree;
    try { front = JSON.parse(frontR.stdout); } catch (_) { front = { error: 'bad frontmost output' }; }
    try { tree = treeR.code === 0 ? JSON.parse(treeR.stdout) : null; } catch (_) { tree = null; }
    const nodes = [];
    if (tree?.tree) _flattenAX(tree.tree, nodes, max);
    return {
      ok: true,
      platform: 'darwin',
      app: front.app,
      bundleId: front.bundleId,
      pid: front.pid,
      window: front.window,
      screens: front.screens,
      nodes,
      nodeCount: nodes.length,
      truncated: nodes.length >= max,
    };
  }
  if (plat === 'win32') {
    const ui = await _faunaUITree({ maxDepth: depth, clickableOnly: false });
    if (!ui.ok) return ui;
    const nodes = [];
    if (ui.tree) _flattenAX(ui.tree, nodes, max);
    return { ok: true, platform: 'win32', app: ui.app || '', window: { title: ui.app || '' }, screens: [], nodes, nodeCount: nodes.length, truncated: nodes.length >= max };
  }
  return { ok: false, error: 'unsupported platform: ' + plat };
}

function _resolveFaunaWritePath(filePath, cwd) {
  if (!filePath) throw new Error('path required');
  let resolved;
  if (String(filePath).startsWith('/')) resolved = String(filePath);
  else if (String(filePath).startsWith('~/')) resolved = String(filePath).replace(/^~/, HOME);
  else if (cwd) resolved = path.join(String(cwd).replace(/^~/, HOME), String(filePath));
  else resolved = path.join(HOME, String(filePath));
  resolved = path.resolve(resolved);
  if (!resolved.startsWith(HOME) && !resolved.startsWith('/tmp')) throw new Error('Path outside allowed directories: ' + resolved);
  return resolved;
}

function _atomicFastWrite(abs, buffer) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.~fauna-fast-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function _writeFastFile(args = {}) {
  const abs = _resolveFaunaWritePath(args.path, args.cwd);
  const encoding = args.encoding || 'utf8';
  const existed = fs.existsSync(abs);
  if (args.overwrite === false && existed && !args.append) throw new Error('Refusing to overwrite existing file: ' + abs);
  let content = String(args.content ?? '');
  if (args.append && existed) content = fs.readFileSync(abs, encoding) + content;
  const buffer = Buffer.from(content, encoding);
  const bytes = buffer.length;
  const lines = content.length ? content.split('\n').length : 0;
  if (args.reject_empty !== false && bytes === 0) throw new Error('Refusing to write empty file: ' + abs);
  if (args.minBytes != null && bytes < Number(args.minBytes)) throw new Error('Content too short for ' + abs + ': ' + bytes + ' bytes < ' + args.minBytes);
  if (args.minLines != null && lines < Number(args.minLines)) throw new Error('Content too short for ' + abs + ': ' + lines + ' lines < ' + args.minLines);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  if (args.sha256 && args.sha256 !== sha256) throw new Error('sha256 mismatch for ' + abs + ': expected ' + args.sha256 + ', got ' + sha256);
  let backup = null;
  if (args.backup && existed) {
    backup = abs + '.~fauna-backup-' + Date.now();
    fs.copyFileSync(abs, backup);
  }
  _atomicFastWrite(abs, buffer);
  return { path: abs, bytes, lines, sha256, existed, op: args.append ? 'append' : 'write', backup };
}

// ── Tool definitions ────────────────────────────────────────────────────

export const SELF_TOOL_DEFS = [
  // ── Memory tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_remember',
      description: 'Remember a fact about the user. Use when the user shares preferences, makes decisions, or gives context you should recall later. Categories: preference, fact, decision, context.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to remember (max 500 chars)' },
          category: { type: 'string', enum: ['preference', 'fact', 'decision', 'context'], description: 'Category' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_recall',
      description: 'Search your memory for facts about the user. Returns matching facts scored by relevance and recency. Call with empty keywords for the most recent facts.',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'Space-separated keywords to search for' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_forget',
      description: 'Forget a specific fact by its ID. Use when the user asks you to forget something or a fact is no longer accurate.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The fact ID to forget' },
        },
        required: ['id'],
      },
    },
  },

  // ── Model tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_list_models',
      description: 'List all available AI models. Returns model IDs, names, and vendors.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_switch_model',
      description: 'Switch the active AI model. The change takes effect on the next message (not the current one).',
      parameters: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model ID to switch to (e.g. "gpt-4o", "claude-sonnet-4-20250514")' },
        },
        required: ['model'],
      },
    },
  },

  // ── Settings tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_get_settings',
      description: 'Get current app settings: active model, thinking budget, max context turns, Figma MCP status.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_set_thinking_budget',
      description: 'Set the extended thinking budget for reasoning models. The change takes effect on the next message.',
      parameters: {
        type: 'object',
        properties: {
          budget: { type: 'string', enum: ['off', 'low', 'medium', 'high', 'max'], description: 'Thinking budget level' },
        },
        required: ['budget'],
      },
    },
  },

  // ── Project tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_create_project',
      description: 'Create a new project in Fauna. Returns the project object with its ID.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Short description' },
          rootPath: { type: 'string', description: 'Absolute path to the project root directory' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_list_projects',
      description: 'List all projects. Returns project names, IDs, and root paths.',
      parameters: { type: 'object', properties: {} },
    },
  },

  // ── Instruction tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_save_instruction',
      description: 'Save a learned instruction to the Playbook. Use when you discover a successful strategy or pattern the user would want to reuse. The instruction persists across conversations.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title for the instruction' },
          body: { type: 'string', description: 'The full instruction text' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        },
        required: ['title', 'body'],
      },
    },
  },

  // ── Notification tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_send_notification',
      description: 'Send a native OS notification to the user. Use for important alerts, completed background tasks, or urgent information that needs attention even if the user is not looking at the app.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Notification title' },
          body: { type: 'string', description: 'Notification body text' },
        },
        required: ['title', 'body'],
      },
    },
  },

  // ── Fast file tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_write_file',
      description: 'Write a brand-new file or fully replace one. PREFER fauna_apply_patch for edits to existing files — only reach for fauna_write_file when the file does not exist yet or you are replacing it wholesale. Writes server-side with temp+rename and returns path/bytes/sha256 without rendering file bytes in chat.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/ path, or path relative to cwd' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths' },
          content: { type: 'string', description: 'Full file content' },
          append: { type: 'boolean', description: 'Append content to existing file instead of replacing' },
          overwrite: { type: 'boolean', description: 'Set false to refuse overwriting existing files' },
          minBytes: { type: 'number', description: 'Optional minimum byte count guard' },
          minLines: { type: 'number', description: 'Optional minimum line count guard' },
          sha256: { type: 'string', description: 'Optional expected final content sha256' },
          backup: { type: 'boolean', description: 'Optional: create a backup copy before overwriting. Defaults false for speed.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_write_files',
      description: 'Fast VS Code-style bulk file write. Prefer this for projects and multi-file changes instead of file-plan markdown. Preflights all files, writes server-side with temp+rename, and returns compact results.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Optional working directory for relative file paths' },
          expected_file_count: { type: 'number', description: 'Optional guard for exact number of files' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
                append: { type: 'boolean' },
                overwrite: { type: 'boolean' },
                minBytes: { type: 'number' },
                minLines: { type: 'number' },
                sha256: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
          backup: { type: 'boolean', description: 'Optional: create backup copies before overwriting. Defaults false for speed.' },
        },
        required: ['files'],
      },
    },
  },

  // ── Shell exec (native tool, server-side) ──
  {
    type: 'function',
    function: {
      name: 'fauna_shell_exec',
      description: 'Run a shell command server-side and get the result back in the SAME assistant turn (no client round-trip). PREFER this over markdown ```bash blocks whenever tools are available — it keeps the agent loop running so you can chain steps without asking the user to continue. Output is captured and returned. SAFE commands (ls, cat, grep, git status, npm test, etc.) execute immediately. UNSAFE/destructive commands (rm -rf, sudo, dd, mkfs, curl|sh, etc.) are refused and you must fall back to a ```bash markdown block so the user can review and approve.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run (single line or && / ; chained).' },
          cwd: { type: 'string', description: 'Optional working directory. Defaults to the user home.' },
          timeoutMs: { type: 'number', description: 'Optional timeout in ms. Default 300000 (5 min). Hard cap.' },
          reason: { type: 'string', description: 'Optional one-line reason this command is being run. Helps with audit and debugging.' },
        },
        required: ['command'],
      },
    },
  },

  // ── File read ──
  {
    type: 'function',
    function: {
      name: 'fauna_read_file',
      description: 'Read a UTF-8 text file from disk and get the contents back in the SAME assistant turn. PREFER this over running cat/head/tail via fauna_shell_exec — it returns structured data and is the canonical way to VERIFY edits before claiming a task is done.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/path, or path relative to cwd.' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths.' },
          startLine: { type: 'number', description: 'Optional 1-based start line. If omitted, reads from the beginning.' },
          endLine: { type: 'number', description: 'Optional 1-based inclusive end line. If omitted, reads to the end.' },
          maxBytes: { type: 'number', description: 'Optional hard cap on bytes returned. Defaults 200000.' },
        },
        required: ['path'],
      },
    },
  },

  // ── Exact-string replace ──
  {
    type: 'function',
    function: {
      name: 'fauna_replace_string',
      description: 'Replace one exact string in a file. Use only when a single localized change is clearer than a patch. For anything beyond one small substitution — multi-line edits, multiple hunks, or multi-file changes — PREFER fauna_apply_patch. The old_string must be unique; include 3–5 lines of surrounding context to disambiguate.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, ~/path, or path relative to cwd.' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths.' },
          old_string: { type: 'string', description: 'Exact literal text to replace (must match a single occurrence including whitespace/indentation).' },
          new_string: { type: 'string', description: 'Replacement text. Pass empty string to delete.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },

  // ── Multi-file patch ──
  {
    type: 'function',
    function: {
      name: 'fauna_apply_patch',
      description: 'PRIMARY edit tool. Apply a freeform patch across one or more files in a single transaction — use for any edit to an existing file, including small one-hunk changes. Faster and cheaper than fauna_write_file (no full-file re-render) and safer than fauna_replace_string for anything more than one substitution. Do NOT re-read the file after a successful apply — the tool already confirms. Patch DSL: *** Begin Patch / *** Update File: <path> / @@ context / -removed / +added / *** End Patch.',
      parameters: {
        type: 'object',
        properties: {
          patch: { type: 'string', description: 'The full apply_patch text including *** Begin Patch and *** End Patch markers.' },
          cwd: { type: 'string', description: 'Optional working directory for relative paths inside the patch.' },
        },
        required: ['patch'],
      },
    },
  },

  // ── Browser actions (renderer-driven via client-tool RPC) ──
  {
    type: 'function',
    function: {
      name: 'fauna_browser',
      description: 'Drive the in-app WEB browser webview (navigate to http(s):// or file:// URLs, click/type DOM selectors, extract HTML, evaluate JS, take page screenshot, etc.). ONLY use this for actual web pages or local HTML files. DO NOT use this for desktop apps (Figma desktop, Slack desktop, VS Code, Finder, native macOS/Windows UIs) — those require fauna_mouse / fauna_keyboard / fauna_ui_tree / fauna_arrange_windows instead. DO NOT call this just to "take a screenshot" of the user\'s screen — there is no screen capture here, only the current webview page. DO NOT open it speculatively at the start of a task; only call it once you have decided you need a web URL. PREFER this over markdown ```browser-action fenced blocks when web automation is genuinely needed.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'One of: navigate, click, type, extract, evaluate, screenshot, scroll, wait, new-tab, switch-tab, close-tab, list-tabs.',
          },
          url: { type: 'string', description: 'URL for navigate / new-tab.' },
          selector: { type: 'string', description: 'CSS selector for click / type / extract / scroll.' },
          text: { type: 'string', description: 'Text to type for the type action.' },
          js: { type: 'string', description: 'JavaScript to run for the evaluate action.' },
          tabId: { type: 'string', description: 'Tab id for switch-tab / close-tab.' },
          waitMs: { type: 'number', description: 'Milliseconds to wait for the wait action.' },
        },
        required: ['action'],
      },
    },
  },

  // ── Circuit diagrams ──
  {
    type: 'function',
    function: {
      name: 'fauna_list_circuit_symbols',
      description: 'List the component types supported by fauna_render_circuit/fauna_validate_circuit, with their pin names and directions. Call this FIRST when the user asks for a circuit/schematic so you know the available symbols.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_render_circuit',
      description: 'Render a circuit schematic from a JSON DSL. Returns SVG markup the caller can embed in a gen-ui SVG block or an artifact. Component coords are in grid units (default 10 px). Wires reference "compId.pinName". Use fauna_list_circuit_symbols first to learn pin names.',
      parameters: {
        type: 'object',
        properties: {
          doc: {
            type: 'object',
            description: 'Circuit DSL document',
            properties: {
              title: { type: 'string' },
              grid: { type: 'number', description: 'Grid size in SVG units (default 10)' },
              components: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Unique component instance id, e.g. "r1"' },
                    type: { type: 'string', description: 'Symbol type, e.g. "resistor"' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    rot: { type: 'number', enum: [0, 90, 180, 270] },
                    value: { type: 'string', description: 'Short display label (≤10 chars), e.g. "10k", "1uF", "5V". Long strings are truncated.' },
                    spice: { type: 'string', description: 'Optional. Full SPICE source expression for vsource (e.g. "PULSE(0 5 0 1u 1u 0.5m 1m)", "SIN(0 1 1k)"). Used only by the simulator; keep `value` short for display.' },
                    props: { type: 'object' },
                  },
                  required: ['id', 'type', 'x', 'y'],
                },
              },
              wires: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    from: { description: 'Either "compId.pinName" or { x, y } in grid units' },
                    to:   { description: 'Either "compId.pinName" or { x, y } in grid units' },
                  },
                  required: ['from', 'to'],
                },
              },
            },
            required: ['components'],
          },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_validate_circuit',
      description: 'Structural lint of a circuit DSL (no simulation). Detects power shorts, dangling pins, floating islands, duplicate drivers, reversed polarized components, and missing decoupling. ALWAYS call this after fauna_render_circuit and surface errors/warnings to the user.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL document (same shape as fauna_render_circuit)' },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_simulate_circuit',
      description: 'Compile the circuit DSL to a SPICE netlist and run ngspice to compute real behaviour (operating-point voltages/currents, transient waveforms, AC sweeps, DC sweeps). Requires `ngspice` on PATH; if missing, returns the netlist and an install hint. Use this for questions like "does it oscillate", "what is V_out", "what current flows".',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL document (same shape as fauna_render_circuit)' },
          analysis: {
            type: 'object',
            description: 'Analysis spec. Defaults to operating point if omitted.',
            properties: {
              type: { type: 'string', enum: ['op', 'tran', 'ac', 'dc'] },
              step: { type: 'string', description: 'tran step, e.g. "1u"' },
              stop: { type: 'string', description: 'tran stop, e.g. "10m"' },
              start: { type: 'string' },
              uic: { type: 'boolean', description: 'tran: use initial conditions' },
              sweep: { type: 'string', enum: ['dec', 'oct', 'lin'], description: 'ac sweep mode' },
              points: { type: 'number', description: 'ac points per decade/octave or linear count' },
              fstart: { type: 'string', description: 'ac start frequency, e.g. "1"' },
              fstop: { type: 'string', description: 'ac stop frequency, e.g. "1Meg"' },
              source: { type: 'string', description: 'dc sweep source name (must match an emitted V<id>)' },
            },
            required: ['type'],
          },
        },
        required: ['doc'],
      },
    },
  },

  // ── Desktop window context (macOS) ──
  {
    type: 'function',
    function: {
      name: 'fauna_list_windows',
      description: 'List the apps the user currently has visible on their desktop, including each window\'s title, position (x,y) and size (w,h), plus which app is frontmost and the main screen bounds. Use this whenever the user asks "what apps are open", "which window is focused", "tile / arrange / move my windows", or you need spatial context before calling fauna_arrange_windows. Works on macOS (requires Accessibility permission for Fauna) and Windows (uses User32).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_arrange_windows',
      description: 'Move and/or resize specific app windows. Pass an array of moves; each move targets one app and sets {x,y,w,h} in screen coordinates. Use fauna_list_windows first to get exact app names and the screen size — then compute coords (e.g. half-screen split, quadrants). windowIndex defaults to 1 (frontmost window of that app); use windowTitle for exact-match targeting. Works on macOS (requires Accessibility permission) and Windows (uses User32 SetWindowPos).',
      parameters: {
        type: 'object',
        properties: {
          moves: {
            type: 'array',
            description: 'List of per-window placements.',
            items: {
              type: 'object',
              properties: {
                app: { type: 'string', description: 'Process name as shown by fauna_list_windows (e.g. "Safari", "Visual Studio Code").' },
                x: { type: 'number', description: 'Target left edge in screen pixels.' },
                y: { type: 'number', description: 'Target top edge in screen pixels.' },
                w: { type: 'number', description: 'Target width in pixels.' },
                h: { type: 'number', description: 'Target height in pixels.' },
                windowIndex: { type: 'number', description: '1-based window index for the app. Defaults to 1.' },
                windowTitle: { type: 'string', description: 'Exact window title to match instead of using windowIndex.' },
              },
              required: ['app'],
            },
          },
        },
        required: ['moves'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_mouse',
      description: 'Control the user\'s mouse cursor: move, click, double-click, right-click, drag, or scroll. Uses macOS Quartz (built-in Swift) on darwin and PowerShell on Windows — no extra binaries required. REQUIRES Accessibility permission for Fauna on macOS. Coordinates are in screen pixels (origin top-left). Use fauna_list_windows first if you need the screen size, or fauna_ui_tree to find clickable elements symbolically. Actions: "move" (just move), "click" (move + left click), "double_click", "right_click", "drag" (press at x,y then release at toX,toY), "scroll" (wheel scroll dy lines at current position; positive=down).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['move', 'click', 'double_click', 'right_click', 'drag', 'scroll'], description: 'What to do.' },
          x: { type: 'number', description: 'Target x in screen pixels (required for move/click/double_click/right_click/drag).' },
          y: { type: 'number', description: 'Target y in screen pixels (required for move/click/double_click/right_click/drag).' },
          toX: { type: 'number', description: 'Drag release x (required for drag).' },
          toY: { type: 'number', description: 'Drag release y (required for drag).' },
          dy: { type: 'number', description: 'Scroll amount in wheel lines (required for scroll). Positive scrolls down.' },
          silent: { type: 'boolean', description: 'If true, suppress the visible click-preview ring (HUD flash). Default false — every click/drag/right-click briefly highlights the target so the user can see what is about to be clicked.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_mouse_position',
      description: 'Read the current mouse cursor position (x, y in screen pixels, top-left origin). Use to verify moves or capture where the user is pointing. REQUIRES Accessibility permission for Fauna on macOS.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_keyboard',
      description: 'Type text or press a key combo on the user\'s machine. action="type" types literal text (Unicode-safe). action="key" presses a combo like "cmd+c", "shift+tab", "ctrl+alt+delete". Modifier names: cmd/command/meta, shift, alt/option, ctrl/control, fn. Key names: a-z, 0-9, return/enter, tab, space, escape/esc, delete/backspace, up/down/left/right, home/end, pageup/pagedown, f1-f12. REQUIRES Accessibility permission for Fauna on macOS.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['type', 'key'], description: 'type=literal text, key=combo press.' },
          text: { type: 'string', description: 'Text to type (action=type).' },
          combo: { type: 'string', description: 'Key combo like "cmd+c" (action=key).' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_ui_tree',
      description: 'Get the Accessibility tree of the user\'s focused window — every button, link, text field, menu item, etc. with role, title, screen bounds (x,y,w,h), and tree path. Use this BEFORE fauna_mouse to click elements symbolically (read coordinates from the tree) instead of guessing pixels. Pass clickableOnly=true to filter to interactive elements only. macOS uses AXUIElement; Windows uses UI Automation. REQUIRES Accessibility permission for Fauna on macOS.',
      parameters: {
        type: 'object',
        properties: {
          maxDepth: { type: 'number', description: 'Max tree depth (default 8, max 20). Deeper = more detail, more tokens.' },
          clickableOnly: { type: 'boolean', description: 'If true, mark only clickable roles (button, link, text field, menu item, etc).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_screen_context',
      description: 'ONE-CALL snapshot of what the user is currently looking at on their computer. Returns: frontmost app (name, bundleId, pid), focused window (title + screen bounds), display list, and a FLATTENED list of clickable/named Accessibility nodes (role, title, x/y/w/h, plus precomputed cx/cy center coords ready for fauna_mouse). Prefer this over chaining fauna_list_windows + fauna_ui_tree when starting a task in companion/Clippy mode — it gives the model immediate situational awareness in a single round-trip. Pass maxNodes (default 40) and depth (default 8) to control verbosity. macOS requires Accessibility permission.',
      parameters: {
        type: 'object',
        properties: {
          maxNodes: { type: 'number', description: 'Max flattened nodes returned (default 40, range 5-120).' },
          depth:    { type: 'number', description: 'Max AX tree depth to walk (default 8, range 3-15).' },
        },
      },
    },
  },
  // ── Backlog (feature intake + prioritization) ──────────────────────────
  {
    type: 'function',
    function: {
      name: 'fauna_feature_request_create',
      description: 'Append a feature request or backlog item to the active project backlog. Use when the user describes wanting something new, when reflection surfaces a gap, or when debate produces a follow-up. Returns the created item id.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title (<= 200 chars).' },
          body:  { type: 'string', description: 'Details, acceptance criteria, links (<= 4000 chars).' },
          tags:  { type: 'array', items: { type: 'string' }, description: 'Optional tags (e.g. must/should/could/wont for MoSCoW, or feature/bug/chore).' },
          rice:  {
            type: 'object',
            description: 'Optional RICE estimate. All numbers 0-10.',
            properties: {
              reach: { type: 'number' }, impact: { type: 'number' },
              confidence: { type: 'number' }, effort: { type: 'number' },
            },
          },
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_backlog_list',
      description: 'List backlog items for a project, ordered by score when prioritized. Useful before triage or planning.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
          status:    { type: 'string', description: 'Filter: new | groomed | in-progress | done | dropped.' },
          limit:     { type: 'number', description: 'Max items (default 50).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_backlog_prioritize',
      description: 'Score and rank backlog items. method="rice" (default) computes RICE = reach*impact*confidence/effort. method="moscow" buckets by must/should/could/wont tags.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
          method:    { type: 'string', enum: ['rice', 'moscow'], description: 'Prioritization method.' },
        },
      },
    },
  },
  // ── Plan (TODOs) ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'fauna_plan',
      description: 'Maintain a structured TODO list for the current task. Use a plan when: the task is non-trivial and spans multiple actions; there are logical phases or dependencies where sequencing matters; the user asked for more than one thing in a single prompt; you generate additional steps mid-flight. Invariants: exactly ONE item in_progress at a time; mark items completed individually (no batch completions); set an item to in_progress BEFORE working it (never jump pending → completed); finish with all items completed or explicitly canceled before ending the turn. High-quality plan example: [{"id":1,"title":"Add CLI entry with file args","status":"completed"},{"id":2,"title":"Parse Markdown via CommonMark","status":"in-progress"},{"id":3,"title":"Apply semantic HTML template","status":"not-started"},{"id":4,"title":"Handle code blocks, images, links","status":"not-started"},{"id":5,"title":"Add error handling for invalid files","status":"not-started"}]. Low-quality plan (avoid — too vague): [{"title":"Create CLI tool"},{"title":"Add Markdown parser"},{"title":"Convert to HTML"}]. Pass the FULL list every call (both existing and new items).',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Complete current plan. Must include ALL items, in order.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number', description: 'Sequential 1-based id.' },
                title: { type: 'string', description: 'Concise action-oriented label (3-7 words).' },
                status: { type: 'string', enum: ['not-started', 'in-progress', 'completed', 'cancelled'] },
              },
              required: ['id', 'title', 'status'],
            },
          },
          explanation: { type: 'string', description: 'Optional rationale for plan changes (added items, reorders, status flips). Required when you cancel an item.' },
        },
        required: ['items'],
      },
    },
  },
  // ── Chain of debate (multi-perspective sub-agents + judge) ─────────────
  {
    type: 'function',
    function: {
      name: 'fauna_consult_debate',
      description: 'Run a structured chain-of-debate over a hard decision. Invokes N independent perspectives in parallel (no tools), cross-presents them for critique, then a judge synthesizes a recommendation. Use BEFORE committing to an ambiguous architectural choice or when the user explicitly asks for multiple opinions.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The decision or question to debate.' },
          context:  { type: 'string', description: 'Relevant background (existing approach, constraints). Optional but improves quality.' },
          perspectives: {
            type: 'array',
            items: { type: 'string' },
            description: 'Named perspectives, e.g. ["security", "performance", "simplicity"]. 2-5 recommended. Defaults to ["pragmatist","skeptic","architect"].',
          },
        },
        required: ['question'],
      },
    },
  },
  // ── Video Studio (MoneyPrinterTurbo-style short-form video generator) ────
  // Pipeline: script → terms → audio → subtitle → footage → render
  // Each step is idempotent + resumable. Tool calls stream progress as
  // tool_call events. fauna_video_create emits the Video Studio widget
  // so the user sees a live preview + can iterate (edit script, swap voice,
  // re-render, etc.) without leaving the chat.
  {
    type: 'function',
    function: {
      name: 'fauna_video_create',
      description:
        'Create a short-form video generation job and emit the Video Studio preview widget. The pipeline (script → terms → audio → subtitle → footage → render) starts automatically and streams progress; the widget shows live updates. Use whenever the user asks to make / generate / produce a video, short, Reel, TikTok, or Shorts. Do NOT also call fauna_video_run_all — it\'s already running. Set autorun:false only if the user wants to edit the params before kicking off render. ' +
        'AFTER calling this tool, keep your chat reply to ONE short sentence (e.g. "On it — Video Studio is below."). The widget already shows the subject, duration, aspect, voice, progress chips, and iteration buttons — do NOT re-list any of that in chat, and do NOT suggest next actions like "you can edit the script" / "switch to 16:9" since those buttons are visible in the widget itself.',
      parameters: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'What the video is about (drives the script).' },
          durationSec: { type: 'number', description: 'Target spoken duration in seconds (default 30, range 8–120).' },
          aspect: { type: 'string', enum: ['9:16', '16:9', '1:1'], description: 'Aspect ratio (default 9:16 vertical).' },
          voice: { type: 'string', description: 'TTS voice. Defaults to kokoro:af_bella (bundled high-quality neural). Override with another Kokoro voice like kokoro:am_michael, kokoro:bf_emma, kokoro:bm_george, etc. Leave unset unless the user asks for a specific voice.' },
          language: { type: 'string', description: "Language code (default 'en')." },
          localFolder: { type: 'string', description: 'Optional absolute path to a folder of local mp4 clips. If set, skips stock search.' },
          autorun: { type: 'boolean', description: 'Auto-start the pipeline (default true). Set false to let the user/model edit params first.' },
        },
        required: ['subject'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_video_run_all',
      description: 'Run the entire pipeline for a job end-to-end (script → render). Idempotent — already-completed steps are skipped. Streams progress as tool_call events.',
      parameters: {
        type: 'object',
        properties: { jobId: { type: 'string' } },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_video_step',
      description: 'Run a single pipeline step. Use to re-run a specific step after editing (e.g. step="render" after the user tweaks the script).',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          step: { type: 'string', enum: ['script', 'terms', 'audio', 'subtitle', 'materials', 'render'] },
        },
        required: ['jobId', 'step'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_video_patch',
      description: 'Edit a job between steps. Set any of {subject, durationSec, aspect, voice, language, script, terms, bgmFile}. Patching script auto-invalidates audio/subtitle/render so they re-run; changing voice invalidates audio onward; aspect invalidates materials+render.',
      parameters: {
        type: 'object',
        properties: {
          jobId: { type: 'string' },
          subject: { type: 'string' },
          durationSec: { type: 'number' },
          aspect: { type: 'string', enum: ['9:16', '16:9', '1:1'] },
          voice: { type: 'string' },
          language: { type: 'string' },
          script: { type: 'string' },
          terms: { type: 'array', items: { type: 'string' } },
          bgmFile: { type: 'string' },
        },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_video_get',
      description: 'Return current job state — params, artifacts, steps completed, error info, and asset paths (final.mp4, audio.mp3, subtitles.srt).',
      parameters: {
        type: 'object',
        properties: { jobId: { type: 'string' } },
        required: ['jobId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_video_list',
      description: 'List all video jobs (most recent first). Returns id, subject, state, and timestamps.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ── Kokoro TTS — ad-hoc "speak this" and multi-voice podcasts ──────────
  {
    type: 'function',
    function: {
      name: 'fauna_speak',
      description:
        'Synthesize text into an audio file with the bundled Kokoro neural TTS, returning a URL the renderer can play. Use this when the user asks to "read aloud", "read me this article", "say this", "narrate", or otherwise wants spoken audio for a single chunk of text. After calling it, emit a gen-ui block with a MediaPlayer (type:"audio", src: returned url, title: <short label>, autoplay:true) so the audio plays inline. Do NOT use this for multi-speaker podcasts — use fauna_podcast for that. Returns {ok, url, durationSec, voice}.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The text to read aloud. Plain text, may contain punctuation. Max ~20000 chars. Strip markdown formatting first if reading a markdown article.' },
          voice: { type: 'string', description: 'Optional Kokoro voice id. Defaults to af_bella. Other good picks: af_heart (warm), am_michael (US male), bf_emma (UK female), bm_george (UK male). Accepts "kokoro:<id>" or bare id.' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_podcast',
      description:
        'Generate a multi-voice podcast / dialogue from an ordered list of speaker turns and return ONE audio URL covering all turns concatenated with natural pauses between speakers. Use this when the user asks for a "podcast", "dialogue", "conversation", "interview", "two-host", or "multi-voice" reading — including "make a podcast from this article" (you script the back-and-forth first, then call this). After calling it, emit a gen-ui block with a MediaPlayer (type:"audio", src: returned url, title:<show title>, autoplay:true). Returns {ok, url, durationSec, segmentCount}.',
      parameters: {
        type: 'object',
        properties: {
          segments: {
            type: 'array',
            description: 'Ordered speaker turns. Each turn is {voice, text}. Alternate voices for hosts/guests. Example: [{voice:"am_michael",text:"Welcome back to the show…"},{voice:"bf_emma",text:"Thanks Mike, today we\'re digging into…"}]',
            items: {
              type: 'object',
              properties: {
                voice: { type: 'string', description: 'Kokoro voice id (e.g. "af_bella", "am_michael", "bf_emma", "bm_george"). Accepts "kokoro:<id>" or bare id.' },
                text:  { type: 'string', description: 'What this speaker says on this turn. One or more sentences.' },
              },
              required: ['voice', 'text'],
            },
          },
          gapSec: { type: 'number', description: 'Silence (seconds) inserted between consecutive turns. Default 0.35.' },
          title: { type: 'string', description: 'Optional podcast title (used only for caller context — not embedded in the audio).' },
        },
        required: ['segments'],
      },
    },
  },
  // ── Interactive whiteboard lessons (live-animated, audio-synced) ───────
  {
    type: 'function',
    function: {
      name: 'fauna_lesson_create',
      description:
        'Generate an interactive whiteboard lesson and mount it INLINE in chat as a sandboxed runtime widget — NOT a video file. The widget shows a 1280×720 whiteboard that animates props (text, LaTeX equations, shapes, arrows, function plots, number lines, code, molecules, embedded svg/circuits) in sync with per-scene Kokoro narration. Use this whenever the user wants to be TAUGHT something visually — "explain", "teach me", "walk me through", "interactive lesson on", "show me how X works", anything where a moving illustration would help more than prose. Returns immediately after audio synthesis; the widget then plays scene-by-scene on user gesture. Do NOT also produce a separate fauna_speak / fauna_video_create call for the same topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What the lesson teaches. Be specific: "How does the derivative of sin(x) become cos(x)?", "Pythagorean theorem with a visual proof", "Why does ice float on water?".' },
          durationMin: { type: 'number', description: 'Target length in minutes (1–10). Default 5. Longer = more scenes; expect ~2.5 scenes per minute.' },
          voice: { type: 'string', description: 'Kokoro voice id for narration. Defaults to af_bella. Pick a calm voice for math/science (am_michael, bf_emma).' },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_lesson_get',
      description: 'Load a previously generated lesson document by id. Returns the full DSL JSON including scene narration, actions, and audio URLs. Useful for inspection or re-mounting.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_list_lesson_kinds',
      description: 'Return the catalog of prop kinds and action verbs available to lesson DSLs. Call this before drafting a lesson manually if you need a reference; otherwise fauna_lesson_create handles DSL generation internally.',
      parameters: { type: 'object', properties: {} },
    },
  },
  // ── Stock imagery (Pexels / Unsplash / Pixabay) ────────────────────────
  // Use these any time you need real photographs for a generated artefact
  // (websites, slide decks, social cards, marketing copy, etc.). The tool
  // automatically picks whichever provider key the user has configured and
  // falls back to the next one if a search returns nothing.
  {
    type: 'function',
    function: {
      name: 'fauna_stock_image_search',
      description:
        'Search Pexels / Unsplash / Pixabay for photographs and return remote URLs + credit info. Auto-uses whichever provider key the user has configured (fallback in that order). Returns {ok, results:[{url, thumb, width, height, photographer, sourceUrl, source}]}. Use BEFORE generating websites, slide decks, blog posts, or anything that benefits from real imagery. To embed straight away use the returned url; to bundle into a project folder follow up with fauna_stock_image_download.',
      parameters: {
        type: 'object',
        properties: {
          query:     { type: 'string', description: 'Search phrase, e.g. "mountain sunset", "developer at laptop".' },
          aspect:    { type: 'string', enum: ['landscape', 'portrait', 'square'], description: 'Preferred orientation. Defaults to landscape.' },
          count:     { type: 'number', description: 'Max results (1–24). Default 6.' },
          providers: { type: 'array', items: { type: 'string', enum: ['pexels', 'unsplash', 'pixabay'] }, description: 'Optional explicit order; default = auto by available keys.' },
          mode:      { type: 'string', enum: ['first', 'merge'], description: '"first" (default) returns the first provider that has hits; "merge" concatenates all.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_stock_image_download',
      description:
        'Download stock images (typically the results of fauna_stock_image_search) to a local folder so they can be referenced from generated HTML, slide decks, PDFs, etc. Returns the same items with an added `path` field per image. Always credit the photographer (returned in the search results) in any produced artefact.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Image objects to download — each must include at least {url, source}. Pass results from fauna_stock_image_search directly.',
            items: {
              type: 'object',
              properties: {
                url:    { type: 'string' },
                source: { type: 'string' },
                photographer: { type: 'string' },
                sourceUrl:    { type: 'string' },
                width:  { type: 'number' },
                height: { type: 'number' },
              },
              required: ['url'],
            },
          },
          destDir: { type: 'string', description: 'Absolute folder path to save into (will be created). Use a project-scoped path like ~/Documents/Fauna/assets/<project>/.' },
          prefix:  { type: 'string', description: 'Filename prefix. Default "img".' },
        },
        required: ['items', 'destDir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_stock_image_providers',
      description: 'List which stock-image providers the user has configured keys for (Pexels / Unsplash / Pixabay).',
      parameters: { type: 'object', properties: {} },
    },
  },
];

// ── Dynamic Widget tool definitions (gated by enableDynamicWidgets flag) ──
// These are registered only when the user opts in via Settings.
export const DYNAMIC_WIDGET_TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'fauna_emit_widget',
      description:
        'Render an interactive, sandboxed HTML/JS widget in the chat and register its actions as ephemeral tools for the rest of this conversation. Use this whenever the user wants something interactive (3D viewer, kanban, sliders, custom dashboard) — the widget defines the buttons/controls and YOU call them via the registered tool names (w_<id>__<name>). Bundle.html is the inner DOM, bundle.js is the widget script which calls `widget.on("toolName", async (args) => result)` to wire each tool, and `widget.emit(event, data)` to push state. No network access inside the widget. ' +
        'DO NOT use this for media playback or playlists — for audio, video, podcast lists, YouTube embeds, image carousels, or any "play these items" request, use the inline gen-ui ```gen-ui block with the built-in `MediaPlayer`, `Playlist`, or `Carousel` components instead (they are native, accessible, and savable to projects). Reserve `fauna_emit_widget` for genuinely interactive controls that have no gen-ui equivalent.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short human title shown above the widget.' },
          bundle: {
            type: 'object',
            description: 'The widget code bundle.',
            properties: {
              html: { type: 'string', description: 'Inner HTML for the widget body.' },
              css:  { type: 'string', description: 'Optional CSS for the widget.' },
              js:   { type: 'string', description: 'JS that calls widget.on(name, fn) for each declared tool.' },
            },
            required: ['html', 'js'],
          },
          tools: {
            type: 'array',
            description: 'Tool manifest — each entry becomes callable as w_<widgetId>__<name>.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Tool name, [a-z][a-z0-9_]*.' },
                description: { type: 'string' },
                parameters: { type: 'object', description: 'JSON Schema for the tool arguments.' },
              },
              required: ['name'],
            },
          },
        },
        required: ['bundle', 'tools'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_save_widget_to_playbook',
      description:
        'Save the most recently emitted widget (by widgetId) into the playbook under a memorable name so the user can re-launch it on future tasks. Optionally add a description and tags.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'The widgetId returned by fauna_emit_widget.' },
          name: { type: 'string', description: 'Human-readable name, e.g. "3D Model Viewer".' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['widgetId', 'name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_list_playbook',
      description: 'List saved playbook widgets the user can re-launch. Returns metadata only (no bundle source).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional name/description filter.' },
          tag: { type: 'string', description: 'Optional tag filter.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_load_widget_from_playbook',
      description:
        'Re-mount a previously saved widget from the playbook. This calls fauna_emit_widget internally with the saved bundle and tool manifest — the widget will be live for the rest of this conversation.',
      parameters: {
        type: 'object',
        properties: {
          idOrName: { type: 'string', description: 'Playbook entry id or name.' },
        },
        required: ['idOrName'],
      },
    },
  },
];

// ── Tool executor ───────────────────────────────────────────────────────
// Returns { result: string } for each tool call.
// `context` provides access to runtime state (models list, IPC sender, etc.)

export function executeSelfTool(toolName, args, context = {}) {
  switch (toolName) {
    // ── Memory ──
    case 'fauna_remember':
      return JSON.stringify(factsRemember(args.text, args.category));
    case 'fauna_recall':
      return JSON.stringify(factsRecall(args.keywords));
    case 'fauna_forget':
      return JSON.stringify(factsForget(args.id));

    // ── Shell exec ──
    case 'fauna_shell_exec': {
      if (typeof context.runShell !== 'function') {
        return JSON.stringify({ ok: false, error: 'fauna_shell_exec is not available in this context.' });
      }
      return context.runShell(args);
    }

    // ── File read ──
    case 'fauna_read_file': {
      try {
        const abs = _resolveFaunaWritePath(args.path, args.cwd);
        if (!fs.existsSync(abs)) return JSON.stringify({ ok: false, error: 'File not found: ' + abs });
        const st = fs.statSync(abs);
        if (st.isDirectory()) return JSON.stringify({ ok: false, error: 'Path is a directory: ' + abs });
        const maxBytes = typeof args.maxBytes === 'number' && args.maxBytes > 0 ? Math.min(args.maxBytes, 1_000_000) : 200_000;
        let content = fs.readFileSync(abs, 'utf8');
        const totalLines = content.length ? content.split('\n').length : 0;
        let truncated = false;
        if (args.startLine || args.endLine) {
          const lines = content.split('\n');
          const start = Math.max(1, Number(args.startLine) || 1);
          const end = Math.min(lines.length, Number(args.endLine) || lines.length);
          content = lines.slice(start - 1, end).join('\n');
        }
        if (content.length > maxBytes) {
          content = content.slice(0, maxBytes);
          truncated = true;
        }
        return JSON.stringify({ ok: true, path: abs, bytes: st.size, totalLines, content, truncated });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    // ── Exact-string replace ──
    case 'fauna_replace_string': {
      try {
        const abs = _resolveFaunaWritePath(args.path, args.cwd);
        if (!fs.existsSync(abs)) return JSON.stringify({ ok: false, error: 'File not found: ' + abs });
        const oldStr = String(args.old_string ?? '');
        const newStr = String(args.new_string ?? '');
        if (!oldStr) return JSON.stringify({ ok: false, error: 'old_string must not be empty' });
        const original = fs.readFileSync(abs, 'utf8');
        const firstIdx = original.indexOf(oldStr);
        if (firstIdx === -1) {
          return JSON.stringify({ ok: false, error: 'old_string not found in file', code: 'OLD_STRING_NOT_FOUND', path: abs });
        }
        const occurrences = original.split(oldStr).length - 1;
        if (occurrences > 1) {
          return JSON.stringify({ ok: false, error: 'old_string matches ' + occurrences + ' times — add surrounding context lines to make it unique', code: 'OLD_STRING_AMBIGUOUS', path: abs, occurrences });
        }
        const updated = original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length);
        const buf = Buffer.from(updated, 'utf8');
        _atomicFastWrite(abs, buf);
        return JSON.stringify({ ok: true, path: abs, bytes: buf.length, lines: updated.split('\n').length });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    // ── Multi-file patch ──
    case 'fauna_apply_patch': {
      if (typeof context.applyPatch !== 'function') {
        return JSON.stringify({ ok: false, error: 'fauna_apply_patch is not available in this context.' });
      }
      try {
        const results = context.applyPatch({ patch: args.patch, cwd: args.cwd });
        return JSON.stringify({ ok: true, results });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message, blocked: !!e.blocked });
      }
    }

    // ── Browser action (renderer-driven via client-tool RPC) ──
    case 'fauna_browser': {
      if (typeof context.callClientTool !== 'function') {
        return JSON.stringify({ ok: false, error: 'fauna_browser is not available in this context (no renderer attached).' });
      }
      return context.callClientTool('browser', args, { timeoutMs: 60000 }).then(
        function(result) {
          if (typeof result === 'string' && result.length > 8000) {
            return result.slice(0, 8000) + '\n…[truncated ' + (result.length - 8000) + ' chars]';
          }
          return typeof result === 'string' ? result : JSON.stringify(result);
        },
        function(e) {
          return JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) });
        }
      );
    }

    // ── Models ──
    case 'fauna_list_models':
      return JSON.stringify(context.getModels?.() || []);
    case 'fauna_switch_model': {
      const models = context.getModels?.() || [];
      const valid = models.find(m => m.id === args.model);
      if (!valid) return JSON.stringify({ ok: false, error: `Model "${args.model}" not found. Use fauna_list_models to see available models.` });
      context.sendToRenderer?.('self-tool:switch-model', args.model);
      return JSON.stringify({ ok: true, model: args.model, note: 'Model change takes effect on the next message.' });
    }

    // ── Settings ──
    case 'fauna_get_settings':
      return JSON.stringify(context.getSettings?.() || {});
    case 'fauna_set_thinking_budget': {
      const valid = ['off', 'low', 'medium', 'high', 'max'].includes(args.budget);
      if (!valid) return JSON.stringify({ ok: false, error: 'Invalid budget. Use: off, low, medium, high, max' });
      context.sendToRenderer?.('self-tool:set-thinking-budget', args.budget);
      return JSON.stringify({ ok: true, budget: args.budget, note: 'Budget change takes effect on the next message.' });
    }

    // ── Projects ──
    case 'fauna_create_project': {
      const proj = createProject({ name: args.name, description: args.description, rootPath: args.rootPath });
      return JSON.stringify({ ok: true, project: { id: proj.id, name: proj.name, rootPath: proj.rootPath } });
    }
    case 'fauna_list_projects': {
      const all = getAllProjects();
      return JSON.stringify(all.map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath, description: p.description })));
    }

    // ── Instructions ──
    case 'fauna_save_instruction': {
      // Server-side: write directly to playbook localStorage is client-only,
      // so we send an event to renderer to call addPlaybookFromAI()
      context.sendToRenderer?.('self-tool:save-instruction', {
        title: args.title,
        body: args.body,
        tags: args.tags || [],
      });
      return JSON.stringify({ ok: true, title: args.title });
    }

    // ── Notifications ──
    case 'fauna_send_notification': {
      context.sendNotification?.(args.title, args.body);
      return JSON.stringify({ ok: true, title: args.title });
    }

    // ── Fast file writes ──
    case 'fauna_write_file': {
      try {
        const started = Date.now();
        const result = _writeFastFile(args || {});
        return JSON.stringify({ ok: true, ms: Date.now() - started, result });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    // ── Circuit tools ──
    case 'fauna_list_circuit_symbols': {
      const types = listSymbolTypes().map(t => {
        const s = SYMBOLS[t];
        return {
          type: t,
          pins: Object.entries(s.pins).map(([name, def]) => ({ name, dir: def.dir })),
          aliases: s.pinAliases ? Object.keys(s.pinAliases) : [],
          polarized: !!s.polarized,
          isPower: s.isPower || null,
        };
      });
      return JSON.stringify({ ok: true, types });
    }
    case 'fauna_render_circuit': {
      try {
        const result = renderCircuit(args.doc);
        return JSON.stringify({ ok: true, ...result });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_validate_circuit': {
      try {
        const result = validateCircuit(args.doc);
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_simulate_circuit': {
      return simulateCircuit(args.doc, args.analysis)
        .then(r => {
          // Trim data arrays to keep tool-output payloads reasonable.
          if (r.results && r.results.plots) {
            for (const p of r.results.plots) {
              if (p.points > 200) {
                const stride = Math.ceil(p.points / 200);
                const sampled = {};
                for (const v of p.variables) sampled[v] = p.data[v].filter((_, i) => i % stride === 0);
                p.data = sampled;
                p.sampledFrom = p.points;
                p.points = sampled[p.variables[0]].length;
              }
            }
          }
          return JSON.stringify(r);
        })
        .catch(e => JSON.stringify({ ok: false, error: e.message }));
    }

    case 'fauna_write_files': {
      try {
        const started = Date.now();
        const files = Array.isArray(args.files) ? args.files : [];
        if (!files.length) throw new Error('files array required');
        if (args.expected_file_count != null && Number(args.expected_file_count) !== files.length) {
          throw new Error('Expected ' + args.expected_file_count + ' files, received ' + files.length);
        }
        const seen = new Set();
        for (const file of files) {
          const abs = _resolveFaunaWritePath(file.path, args.cwd);
          if (seen.has(abs)) throw new Error('Duplicate write target: ' + abs);
          seen.add(abs);
          if (file.content === undefined) throw new Error('Missing content for ' + file.path);
        }
        const results = files.map(file => _writeFastFile({ ...file, cwd: args.cwd, backup: args.backup || file.backup }));
        return JSON.stringify({ ok: true, ms: Date.now() - started, results });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    // ── Dynamic Widgets ─────────────────────────────────────────────────
    case 'fauna_emit_widget':
      return _emitWidget(args, context);

    case 'fauna_save_widget_to_playbook': {
      try {
        const reg = context.getLiveWidget?.(args.widgetId);
        if (!reg) {
          return JSON.stringify({ ok: false, error: `Widget "${args.widgetId}" not found in this conversation. Emit it first with fauna_emit_widget.` });
        }
        const result = savePlaybookEntry({
          name: args.name,
          description: args.description,
          tags: args.tags,
          bundle: reg.bundle,
          tools: reg.tools,
        });
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    case 'fauna_list_playbook':
      return JSON.stringify(listPlaybookEntries({ tag: args.tag, query: args.query }));

    case 'fauna_load_widget_from_playbook': {
      const entry = getPlaybookEntry(args.idOrName);
      if (!entry) return JSON.stringify({ ok: false, error: `No playbook entry "${args.idOrName}"` });
      touchPlaybookEntry(entry.id);
      return _emitWidget({
        title: entry.name,
        bundle: entry.bundle,
        tools: entry.tools,
        _fromPlaybook: entry.id,
      }, context);
    }

    // ── Desktop window context (macOS) ──
    case 'fauna_list_windows': {
      return Promise.all([
        macListVisibleWindows().catch(e => ({ ok: false, error: e.message })),
        macGetScreenBounds().catch(() => ({ ok: false })),
      ]).then(([info, screen]) => JSON.stringify({
        ...info,
        screen: screen && screen.ok ? screen : null,
      }));
    }
    case 'fauna_arrange_windows': {
      const moves = Array.isArray(args && args.moves) ? args.moves : [];
      return macArrangeWindows(moves)
        .then(r => JSON.stringify(r))
        .catch(e => JSON.stringify({ ok: false, error: e.message }));
    }
    case 'fauna_mouse': {
      return _faunaMouse(args || {}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: e.message }));
    }
    case 'fauna_mouse_position': {
      return _faunaMousePosition().then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: e.message }));
    }
    case 'fauna_keyboard': {
      return _faunaKeyboard(args || {}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: e.message }));
    }
    case 'fauna_ui_tree': {
      return _faunaUITree(args || {}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: e.message }));
    }
    case 'fauna_screen_context': {
      return _faunaScreenContext(args || {}).then(r => JSON.stringify(r)).catch(e => JSON.stringify({ ok: false, error: e.message }));
    }

    // ── Backlog ──
    case 'fauna_feature_request_create': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      const entry = addBacklogItem(pid, {
        title: args.title, body: args.body, tags: args.tags, rice: args.rice,
        source: 'agent',
      });
      if (!entry) return JSON.stringify({ ok: false, error: 'project not found' });
      return JSON.stringify({ ok: true, id: entry.id, projectId: pid, item: entry });
    }
    case 'fauna_backlog_list': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      return JSON.stringify({ ok: true, items: listBacklog(pid, { status: args.status, limit: args.limit }) });
    }
    case 'fauna_backlog_prioritize': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      const r = prioritizeBacklog(pid, { method: args.method || 'rice' });
      if (!r) return JSON.stringify({ ok: false, error: 'project not found' });
      return JSON.stringify(r);
    }

    // ── Plan (TODOs) ──
    case 'fauna_plan': {
      const items = Array.isArray(args.items) ? args.items : [];
      if (!items.length) return JSON.stringify({ ok: false, error: 'items required (non-empty array)' });
      const norm = [];
      const errors = [];
      let inProgress = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        const id = Number.isFinite(it.id) ? it.id : i + 1;
        const title = String(it.title || '').trim();
        const status = String(it.status || 'not-started');
        if (!title) errors.push(`item ${i + 1}: missing title`);
        if (!['not-started', 'in-progress', 'completed', 'cancelled'].includes(status)) {
          errors.push(`item ${i + 1}: invalid status "${status}"`);
        }
        if (status === 'in-progress') inProgress++;
        norm.push({ id, title, status });
      }
      if (inProgress > 1) errors.push(`exactly one item may be in_progress at a time (found ${inProgress})`);
      if (errors.length) return JSON.stringify({ ok: false, error: errors.join('; '), plan: norm });
      // Surface to renderer so the UI can render a checklist (best-effort).
      try {
        if (typeof context.sendToRenderer === 'function') {
          context.sendToRenderer('fauna:plan-update', { items: norm, explanation: args.explanation || '' });
        }
      } catch (_) {}
      const total = norm.length;
      const done = norm.filter(x => x.status === 'completed').length;
      const cur = norm.find(x => x.status === 'in-progress');
      return JSON.stringify({
        ok: true,
        items: norm,
        summary: `${done}/${total} complete${cur ? `; current: ${cur.title}` : ''}`,
      });
    }

    // ── Chain of debate ──
    case 'fauna_consult_debate': {
      if (typeof context.callLLM !== 'function') {
        return JSON.stringify({ ok: false, error: 'LLM bridge not available in this context' });
      }
      const question = String(args.question || '').trim();
      if (!question) return JSON.stringify({ ok: false, error: 'question required' });
      const ctx = String(args.context || '');
      const perspectives = Array.isArray(args.perspectives) && args.perspectives.length
        ? args.perspectives.slice(0, 5).map(String)
        : ['pragmatist', 'skeptic', 'architect'];

      return (async () => {
        const round1 = await Promise.all(perspectives.map(p => context.callLLM({
          system: `You are the "${p}" perspective in a structured debate. Give a sharp, opinionated 4-6 sentence answer from your perspective only. Do not hedge. No preamble.`,
          user: (ctx ? `Context:\n${ctx}\n\n` : '') + `Question: ${question}`,
          maxTokens: 350,
          temperature: 0.6,
        }).then(text => ({ perspective: p, text }))));

        const proposalsText = round1.map(r => `### ${r.perspective}\n${r.text}`).join('\n\n');

        const round2 = await Promise.all(round1.map(r => context.callLLM({
          system: `You are the "${r.perspective}" perspective. Critique the OTHER perspectives' proposals below. 3-5 sentences. Where do they fail? What did they miss? Be specific. No preamble.`,
          user: `Question: ${question}\n\nAll proposals:\n${proposalsText}\n\nYour own proposal was:\n${r.text}\n\nCritique the others.`,
          maxTokens: 300,
          temperature: 0.5,
        }).then(text => ({ perspective: r.perspective, text }))));

        const critiquesText = round2.map(c => `### ${c.perspective} critiques\n${c.text}`).join('\n\n');

        const judge = await context.callLLM({
          system: 'You are an impartial judge. Read the proposals and critiques, then output: (1) the single recommended decision in one sentence, (2) the top 2-3 reasons, (3) explicit risks/tradeoffs, (4) any open questions. Be concrete and short.',
          user: `Question: ${question}\n\nProposals:\n${proposalsText}\n\nCritiques:\n${critiquesText}`,
          maxTokens: 500,
          temperature: 0.3,
        });

        return JSON.stringify({
          ok: true,
          question,
          perspectives: round1,
          critiques: round2,
          recommendation: judge,
        });
      })();
    }

    // ── Video Studio ─────────────────────────────────────────────────────
    case 'fauna_video_create': {
      try {
        const job = videoCreateJob({
          subject: args.subject,
          durationSec: args.durationSec,
          aspect: args.aspect,
          voice: args.voice,
          language: args.language,
          localFolder: args.localFolder,
        });
        const built = buildVideoStudioWidget(job);
        const widgetResult = _emitWidget({
          bundle: { html: built.bundle.html, js: built.bundle.js || '// inline' },
          tools: built.tools,
          title: built.title,
          _videoJob: job.id,
        }, context);
        // Auto-start the pipeline unless explicitly disabled. Streams progress
        // as tool_call events; runs in the background so this handler returns
        // immediately and the widget mounts right away.
        if (args.autorun !== false) {
          const client = videoGetCopilotClient();
          videoRunAll(job.id, { client }).catch(err => {
            try { context.sendSse?.({ type: 'tool_call', name: 'fauna_video_step', label: `pipeline failed: ${err.message}` }); } catch (_) {}
          });
          const unsub = videoSubscribe(job.id, (evt) => {
            try { context.sendSse?.({ type: 'tool_call', name: 'fauna_video_step', label: `${evt.step}: ${evt.message || evt.status}` }); } catch (_) {}
            if (evt.status === 'completed' && evt.step === 'render') unsub();
            if (evt.status === 'failed') unsub();
          });
        }
        return widgetResult;
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_video_run_all': {
      const jobId = String(args.jobId || '');
      if (!jobId) return JSON.stringify({ ok: false, error: 'jobId required' });
      // Stream progress events to chat as tool_call labels.
      const unsub = videoSubscribe(jobId, (evt) => {
        try { context.sendSse?.({ type: 'tool_call', name: 'fauna_video_step', label: `${evt.step}: ${evt.message || evt.status}` }); } catch (_) {}
      });
      return (async () => {
        try {
          const client = videoGetCopilotClient();
          await videoRunAll(jobId, { client });
          const job = videoGetJob(jobId);
          return JSON.stringify({
            ok: true,
            jobId,
            stepsDone: job.stepsDone,
            finalPath: job.artifacts.finalPath,
            footageSource: job.artifacts.footageSource,
            durationSec: job.artifacts.audioDurationSec,
          });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message, jobId });
        } finally {
          try { unsub(); } catch (_) {}
        }
      })();
    }
    case 'fauna_video_step': {
      const jobId = String(args.jobId || '');
      const step = String(args.step || '');
      if (!jobId || !step) return JSON.stringify({ ok: false, error: 'jobId and step required' });
      return (async () => {
        try {
          const client = videoGetCopilotClient();
          const job = await videoRunStep(jobId, step, { client });
          return JSON.stringify({ ok: true, jobId, step, stepsDone: job.stepsDone, artifacts: _videoArtifactSummary(job) });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message, jobId, step });
        }
      })();
    }
    case 'fauna_video_patch': {
      try {
        const jobId = String(args.jobId || '');
        if (!jobId) return JSON.stringify({ ok: false, error: 'jobId required' });
        const { jobId: _ignored, ...patch } = args;
        const r = videoPatchJob(jobId, patch);
        return JSON.stringify({ ok: true, jobId, invalidated: r.invalidated, stepsDone: r.job.stepsDone });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_video_get': {
      const job = videoGetJob(String(args.jobId || ''));
      if (!job) return JSON.stringify({ ok: false, error: 'not found' });
      return JSON.stringify({ ok: true, job: { ...job, artifacts: _videoArtifactSummary(job) } });
    }
    case 'fauna_video_list': {
      const jobs = videoListJobs().map(j => ({
        id: j.id, subject: j.params.subject, state: j.state, createdAt: j.createdAt,
        stepsDone: j.stepsDone, finalPath: j.artifacts.finalPath,
      }));
      return JSON.stringify({ ok: true, jobs });
    }

    // ── Kokoro TTS — ad-hoc speak + multi-voice podcasts ─────────────────
    case 'fauna_speak': {
      return (async () => {
        try {
          const text = String(args.text || '').trim();
          if (!text) return JSON.stringify({ ok: false, error: 'text required' });
          if (text.length > 20000) return JSON.stringify({ ok: false, error: 'text too long (>20000 chars)' });
          const { id, file, voice } = await synthSingleKokoro({ text, voice: args.voice });
          const durationSec = await probeKokoroDuration(file);
          return JSON.stringify({
            ok: true,
            id,
            url: `/api/kokoro-audio/${id}.mp3`,
            durationSec,
            voice,
          });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }
    case 'fauna_podcast': {
      return (async () => {
        try {
          const segments = Array.isArray(args.segments) ? args.segments : null;
          if (!segments || !segments.length) return JSON.stringify({ ok: false, error: 'segments required' });
          const gapSec = Number.isFinite(args.gapSec) ? Number(args.gapSec) : 0.35;
          const { id, file } = await synthKokoroPodcast({ segments, gapSec });
          const durationSec = await probeKokoroDuration(file);
          return JSON.stringify({
            ok: true,
            id,
            url: `/api/kokoro-audio/${id}.mp3`,
            durationSec,
            segmentCount: segments.length,
          });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }

    // ── Interactive whiteboard lessons ───────────────────────────────────
    case 'fauna_lesson_create': {
      return (async () => {
        try {
          const topic = String(args.topic || '').trim();
          if (!topic) return JSON.stringify({ ok: false, error: 'topic required' });
          const durationMin = Math.max(1, Math.min(10, Number(args.durationMin) || 5));
          const client = videoGetCopilotClient();
          // Stream phase updates to chat so the user sees progress.
          const onProgress = (evt) => {
            try {
              const label = evt.phase === 'script' ? 'Drafting lesson script…'
                : evt.phase === 'audio-start' ? `Synthesizing audio for ${evt.sceneCount} scenes…`
                : evt.phase === 'audio' ? `Audio scene ${evt.sceneIndex + 1}/${evt.total}`
                : evt.phase;
              context.sendSse?.({ type: 'tool_call', name: 'fauna_lesson_step', label });
            } catch (_) {}
          };
          const { id, lesson, warnings } = await lessonCreate({
            topic, durationMin, voice: args.voice, client, onProgress,
          });
          const built = buildLessonWidget({ lessonId: id, lesson });
          const widgetResult = _emitWidget({
            bundle: { html: built.bundle.html, js: built.bundle.js },
            tools: built.tools,
            title: built.title,
            _lessonId: id,
          }, context);
          // Augment the widget-emit result with summary metadata so the model
          // can reference scene/title info in its follow-up message.
          try {
            const obj = JSON.parse(widgetResult);
            obj.lessonId = id;
            obj.title = lesson.title;
            obj.sceneCount = lesson.scenes.length;
            obj.durationSec = lesson.scenes.reduce((a, s) => a + (s.audioDurationSec || 0), 0);
            if (warnings?.length) obj.warnings = warnings;
            return JSON.stringify(obj);
          } catch (_) { return widgetResult; }
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }
    case 'fauna_lesson_get': {
      const id = String(args.id || '');
      if (!id) return JSON.stringify({ ok: false, error: 'id required' });
      const lesson = lessonLoad(id);
      if (!lesson) return JSON.stringify({ ok: false, error: 'lesson not found' });
      return JSON.stringify({ ok: true, id, lesson });
    }
    case 'fauna_list_lesson_kinds': {
      return JSON.stringify({ ok: true, kinds: LESSON_KINDS, actions: [...LESSON_ACTIONS] });
    }

    // ── Stock imagery ─────────────────────────────────────────────────────
    case 'fauna_stock_image_search': {
      return (async () => {
        try {
          const res = await searchStockImages(String(args.query || ''), {
            aspect: args.aspect || 'landscape',
            count: Number(args.count) > 0 ? Number(args.count) : 6,
            providers: Array.isArray(args.providers) ? args.providers : null,
            mode: args.mode === 'merge' ? 'merge' : 'first',
          });
          return JSON.stringify(res);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message, results: [] });
        }
      })();
    }
    case 'fauna_stock_image_download': {
      return (async () => {
        try {
          if (!Array.isArray(args.items) || !args.items.length) {
            return JSON.stringify({ ok: false, error: 'items array required' });
          }
          if (!args.destDir || typeof args.destDir !== 'string') {
            return JSON.stringify({ ok: false, error: 'destDir required' });
          }
          const destDir = args.destDir.startsWith('~')
            ? path.join(os.homedir(), args.destDir.slice(1))
            : args.destDir;
          const results = await downloadStockImages(args.items, {
            destDir,
            prefix: typeof args.prefix === 'string' ? args.prefix : 'img',
          });
          return JSON.stringify({ ok: true, destDir, count: results.length, results });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }
    case 'fauna_stock_image_providers': {
      return JSON.stringify({ ok: true, providers: availableImageProviders() });
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown self-tool: ${toolName}` });
  }
}

function _videoArtifactSummary(job) {
  const a = job.artifacts || {};
  return {
    script: a.script ? a.script.slice(0, 500) + (a.script.length > 500 ? '…' : '') : null,
    terms: a.terms || null,
    audioFile: a.audioFile, audioDurationSec: a.audioDurationSec,
    subtitlePath: a.subtitlePath,
    footageSource: a.footageSource, clipsCount: (a.clips || []).length,
    finalPath: a.finalPath,
  };
}

// ── Dynamic Widget helpers ────────────────────────────────────────────
function _emitWidget(args, context) {
  try {
    if (!args?.bundle?.html || !args?.bundle?.js) {
      return JSON.stringify({ ok: false, error: 'bundle.html and bundle.js required' });
    }
    if (!Array.isArray(args.tools)) {
      return JSON.stringify({ ok: false, error: 'tools array required' });
    }
    const widgetId = 'w' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
    const tools = args.tools.map(t => ({
      name: t.name,
      description: t.description || '',
      parameters: t.parameters || { type: 'object', properties: {} },
    }));
    const registration = { widgetId, tools, bundle: args.bundle };

    // Mirror the bundle to a temp folder inside ~/Documents/Fauna so the user
    // can inspect / re-open / share the generated widget files outside the
    // chat UI. This is best-effort — failure here must not break emission.
    let savedPath = null;
    try {
      const root = process.env.FAUNA_DOCS || path.join(os.homedir(), 'Documents', 'Fauna');
      const dir = path.join(root, '.widgets-temp', widgetId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), String(args.bundle.html || ''), 'utf8');
      fs.writeFileSync(path.join(dir, 'widget.js'),  String(args.bundle.js   || ''), 'utf8');
      if (args.bundle.css) fs.writeFileSync(path.join(dir, 'widget.css'), String(args.bundle.css), 'utf8');
      fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
        widgetId,
        title: args.title || null,
        createdAt: new Date().toISOString(),
        tools: tools.map(t => ({ name: t.name, description: t.description })),
      }, null, 2), 'utf8');
      savedPath = dir;
    } catch (e) {
      console.warn('[fauna_emit_widget] could not mirror widget to disk:', e.message);
    }

    // Register the live widget so subsequent save-to-playbook / RPC routing
    // can find its bundle. The context wires both functions in chat.js.
    context.registerLiveWidget?.(widgetId, registration);

    // Notify the frontend via SSE so the iframe is mounted in the chat UI.
    context.sendSse?.({
      type: 'widget_emitted',
      widgetId,
      title: args.title || null,
      bundle: args.bundle,
      tools: tools.map(t => ({ name: t.name, description: t.description })),
      fromPlaybook: args._fromPlaybook || null,
    });

    // Pack a tool_result the model can see. We strip the bundle from the
    // model-visible payload — the model doesn't need to re-read its own code,
    // and including it would balloon the context window.
    return packWidgetResult(
      {
        ok: true,
        widgetId,
        title: args.title || null,
        exposed: tools.map(t => `w_${widgetId.replace(/[^a-z0-9]/gi,'').slice(0,24)}__${t.name}`),
        savedPath,
        note: 'Widget is now live. Call the exposed tool names to interact with it.' +
          (savedPath ? ` Files mirrored to ${savedPath}` : ''),
      },
      { widgetId, tools },
    );
  } catch (e) {
    return JSON.stringify({ ok: false, error: e.message });
  }
}

// ── Check if a tool name is a self-tool ─────────────────────────────────

const SELF_TOOL_NAMES = new Set([
  ...SELF_TOOL_DEFS.map(d => d.function.name),
  ...DYNAMIC_WIDGET_TOOL_DEFS.map(d => d.function.name),
]);
export function isSelfTool(name) {
  return SELF_TOOL_NAMES.has(name);
}
