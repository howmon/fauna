// ── Self-Tools — LLM-callable tools that let the AI manage the Fauna app ──
// These tools let the AI introspect and control the application:
// memory, models, settings, projects, instructions, notifications.

/**
 * @typedef {{getModels: () => Array<{id: string, name: string}>, getSettings: () => object, sendToRenderer: (channel: string, ...args: any[]) => void, sendNotification: (title: string, body: string) => void}} SelfToolContext
 */

import {
  remember as factsRemember, recall as factsRecall, forget as factsForget,
  listFacts, getStats as factsGetStats, projectContainerTag,
} from './memory-store.js';
import {
  ingestDocument as ctxIngest,
  searchContext as ctxSearch,
  listDocuments as ctxListDocs,
  deleteDocument as ctxDeleteDoc,
  getStats as ctxGetStats,
} from './server/lib/context-store.js';
import { retrieveOutput } from './server/lib/tool-output-cache.js';
import { runDoctor } from './server/lib/doctor.js';
import {
  createProject, getAllProjects, getProject,
  addBacklogItem, listBacklog, prioritizeBacklog,
  updateBacklogItem, moveWorkItem, addWorkItemComment,
  setWorkItemLock, listAllWorkItems, getProjectBoard,
} from './project-manager.js';
import { renderCircuit } from './lib/circuit-renderer.js';
import { validateCircuit } from './lib/circuit-validate.js';
import { SYMBOLS, listSymbolTypes } from './lib/circuit-symbols.js';
import { simulateCircuit } from './lib/circuit-simulate.js';
import { listFootprints } from './lib/circuit-footprints.js';
import { layoutPcb, routePcb } from './lib/circuit-pcb.js';
import { renderBoard } from './lib/circuit-board-renderer.js';
import { checkBoard } from './lib/circuit-pcb-drc.js';
import { buildGuide } from './lib/circuit-guide.js';
import { packWidgetResult } from './lib/dynamic-widgets.js';
import { buildCatalog, routeSkill, attachEmbeddings } from './lib/skill-catalog.js';
import { scoreAmbiguity, interviewQuestions, createSeed as seedCreate, getSeed as seedGet, listSeeds as seedList } from './lib/seed-store.js';
import { unstuck as personasUnstuck } from './lib/personas.js';
import { auditPrompt } from './lib/prompt-audit.js';
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
  generateImage,
  editImage,
  availableImageGen,
} from './server/media/image-gen.js';
import {
  savePlaybookEntry, listPlaybookEntries, getPlaybookEntry,
  touchPlaybookEntry, deletePlaybookEntry,
} from './playbook-store.js';
import {
  listVisibleWindows as macListVisibleWindows,
  arrangeWindows as macArrangeWindows,
  getScreenBounds as macGetScreenBounds,
} from './server/lib/window-context.js';
import { scaffoldTemplate, listTemplates } from './server/app-templates.js';
import { buildShellEnv } from './server/lib/shell-env.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import * as devServerRegistry from './server/lib/dev-server-registry.js';
import { loadAgentManifest } from './server/lib/agent-manifest.js';
import { resolveWorkspaceContext } from './lib/workspace-context.js';
import { runWorkspaceDiagnostics } from './lib/diagnostics.js';
import { workspaceSymbols, symbolDefinition, symbolReferences, renameSymbol } from './lib/language-tools.js';
import { startTerminalSession, sendTerminalInput, getTerminalOutput, listTerminalSessions, killTerminalSession } from './lib/terminal-sessions.js';
import { parseTestResults, runTestResults } from './lib/test-results.js';
import {
  renderDocumentToPngs,
  documentGet,
  documentSet,
  documentIssues,
  documentMerge,
} from './server/lib/office-tools.js';

// Per-conversation active plan state. Survives across the multiple
// /api/chat requests that the client's plan auto-continue feature fires
// off when a turn is split — without this, the one-plan-per-turn guard
// in fauna_plan resets every hop and the model is free to drop a new
// disjoint plan after a failure.
const _activePlansByConv = new Map();
// Tracks the last `plan_update` payload signature we emitted per conversation.
// fauna_plan is allowed to be called every turn (the one-plan-per-turn guard
// already restricts shape changes), but emitting an SSE / renderer event when
// nothing has actually changed produces duplicate checklists in the chat log
// — exactly the spam pattern seen in the memory-context case-study transcript
// where the SAME 7-item plan rendered 5 times in a row with identical statuses.
const _lastPlanEmitSigByConv = new Map();

// Codex-parity: expose the active plan for a conversation so the chat route
// can re-inject it into the system prompt every turn. This keeps the model
// honest about "what's done / what's left" at low token cost (one compact
// checklist instead of re-summarizing the whole transcript).
export function getActivePlanForConv(convId) {
  if (!convId) return null;
  const state = _activePlansByConv.get(convId);
  if (!state || !Array.isArray(state.items) || !state.items.length) return null;
  return { items: state.items, explanation: state.explanation || '' };
}

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

// ── Global input capture (listen) ───────────────────────────────────────
// Installs a listen-only CGEventTap + NSWorkspace observer and streams one
// JSON object per line for mouse clicks, scrolls, modifier key-combos and app
// activations until the process is killed. Requires Accessibility permission.
let kVKName: [CGKeyCode: String] = {
  var m = [CGKeyCode: String]()
  for (k, v) in kVK { if m[v] == nil { m[v] = k } }
  return m
}()
func comboFromEvent(_ flags: CGEventFlags, _ key: CGKeyCode) -> String {
  var parts: [String] = []
  if flags.contains(.maskControl) { parts.append("ctrl") }
  if flags.contains(.maskAlternate) { parts.append("alt") }
  if flags.contains(.maskShift) { parts.append("shift") }
  if flags.contains(.maskCommand) { parts.append("cmd") }
  parts.append(kVKName[key] ?? "key\\(key)")
  return parts.joined(separator: "+")
}
func emitLine(_ json: String) {
  FileHandle.standardOutput.write((json + "\\n").data(using: .utf8)!)
}
let tapCallback: CGEventTapCallBack = { proxy, type, event, refcon in
  let now = Int(Date().timeIntervalSince1970 * 1000)
  switch type {
    case .leftMouseDown, .rightMouseDown:
      let loc = event.location
      let right = (type == .rightMouseDown)
      let clicks = event.getIntegerValueField(.mouseEventClickState)
      emitLine("{\\"type\\":\\"mouse-click\\",\\"x\\":\\(Int(loc.x)),\\"y\\":\\(Int(loc.y)),\\"button\\":\\"" + (right ? "right" : "left") + "\\",\\"double\\":" + (clicks >= 2 ? "true" : "false") + ",\\"t\\":\\(now)}")
    case .scrollWheel:
      let dy = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
      emitLine("{\\"type\\":\\"scroll\\",\\"dy\\":\\(-dy),\\"t\\":\\(now)}")
    case .keyDown:
      let flags = event.flags
      let hasMod = flags.contains(.maskCommand) || flags.contains(.maskControl) || flags.contains(.maskAlternate)
      if hasMod {
        let keycode = CGKeyCode(event.getIntegerValueField(.keyboardEventKeycode))
        emitLine("{\\"type\\":\\"key\\",\\"combo\\":" + jsonStr(comboFromEvent(flags, keycode)) + ",\\"t\\":\\(now)}")
      }
    default: break
  }
  return Unmanaged.passUnretained(event)
}
func runListen() {
  let nc = NSWorkspace.shared.notificationCenter
  nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
      let now = Int(Date().timeIntervalSince1970 * 1000)
      emitLine("{\\"type\\":\\"activate-app\\",\\"app\\":" + jsonStr(app.localizedName ?? "") + ",\\"t\\":\\(now)}")
    }
  }
  let mask: CGEventMask = (1 << CGEventType.leftMouseDown.rawValue) | (1 << CGEventType.rightMouseDown.rawValue) | (1 << CGEventType.scrollWheel.rawValue) | (1 << CGEventType.keyDown.rawValue)
  guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly, eventsOfInterest: mask, callback: tapCallback, userInfo: nil) else {
    FileHandle.standardError.write("event tap failed (Accessibility permission?)\\n".data(using: .utf8)!)
    exit(4)
  }
  let src = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
  CFRunLoopAddSource(CFRunLoopGetCurrent(), src, .commonModes)
  CGEvent.tapEnable(tap: tap, enable: true)
  emitLine("{\\"type\\":\\"listening\\",\\"t\\":\\(Int(Date().timeIntervalSince1970 * 1000))}")
  CFRunLoopRun()
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
  case "listen":
    runListen()
  default:
    FileHandle.standardError.write("unknown cmd: \\(cmd)\\n".data(using: .utf8)!); exit(2)
}
print("ok")
`;

const FAUNA_HELPER_VERSION = 'v4'; // bump to force rebuild
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

// ── Global system-input capture (recorder integration) ─────────────────────
// Spawns the fauna-helper `listen` mode (macOS CGEventTap) and buffers global
// mouse-click / scroll / key-combo / app-activation events with wall-clock
// timestamps. The recorder merges these into a recording as `system` steps so
// desktop automation is captured alongside in-browser DOM events.
let _sysCapture = null; // { proc, startedAt, events, buf }

export async function startSystemCapture() {
  if (process.platform !== 'darwin') return { ok: false, error: 'System input capture is macOS-only' };
  if (_sysCapture) return { ok: true, already: true, startedAt: _sysCapture.startedAt };
  const helper = await _getFaunaHelper();
  const proc = spawn(helper, ['listen'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const cap = { proc, startedAt: Date.now(), events: [], buf: '', error: null };
  proc.stdout.on('data', (chunk) => {
    cap.buf += chunk.toString();
    let idx;
    while ((idx = cap.buf.indexOf('\n')) !== -1) {
      const line = cap.buf.slice(0, idx).trim();
      cap.buf = cap.buf.slice(idx + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.type && ev.type !== 'listening') cap.events.push(ev);
      } catch (_) {}
    }
  });
  proc.stderr.on('data', (d) => { cap.error = (cap.error || '') + d.toString(); });
  proc.on('error', (e) => { cap.error = (cap.error || '') + (e && e.message || ''); });
  _sysCapture = cap;
  // Give the tap a beat to arm and surface an early permission failure.
  await new Promise((r) => setTimeout(r, 250));
  if (cap.error && /permission|not trusted|event tap failed/i.test(cap.error)) {
    try { cap.proc.kill('SIGTERM'); } catch (_) {}
    _sysCapture = null;
    return { ok: false, needsPermission: 'accessibility', error: 'Accessibility permission required to capture system input.' };
  }
  return { ok: true, startedAt: cap.startedAt };
}

// Stop capture and return the buffered events as recorder `system` steps, each
// with a `t` relative to capture start (ms) for merging into the timeline.
export function stopSystemCapture() {
  if (!_sysCapture) return { ok: true, steps: [] };
  const cap = _sysCapture;
  _sysCapture = null;
  try { cap.proc.kill('SIGTERM'); } catch (_) {}
  const steps = [];
  let i = 0;
  for (const ev of cap.events) {
    const t = Math.max(0, (ev.t || Date.now()) - cap.startedAt);
    const base = { type: 'system', id: 'st_sys_' + (i++), t };
    if (ev.type === 'mouse-click') steps.push({ ...base, sysAction: 'mouse-click', x: ev.x, y: ev.y, button: ev.button || 'left', double: !!ev.double });
    else if (ev.type === 'scroll') steps.push({ ...base, sysAction: 'scroll', dy: ev.dy });
    else if (ev.type === 'key') steps.push({ ...base, sysAction: 'key', combo: ev.combo });
    else if (ev.type === 'activate-app') steps.push({ ...base, sysAction: 'activate-app', app: ev.app });
  }
  return { ok: true, steps, startedAt: cap.startedAt };
}

export function systemCaptureStatus() {
  return { ok: true, capturing: !!_sysCapture, count: _sysCapture ? _sysCapture.events.length : 0 };
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

// Directories we never recurse into during file_search / grep — they are
// either huge (node_modules), VCS metadata (.git), build output (dist, build),
// caches (.next, .cache, .turbo, .parcel-cache), or system noise (Library on
// macOS — would scan ~30GB of mail/photos otherwise). Match by exact name.
const _FAUNA_SEARCH_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', '.turbo', '.parcel-cache', '.vite', '.svelte-kit',
  'coverage', '.nyc_output', '.pnpm-store', '__pycache__', '.venv', 'venv',
  '.gradle', 'target', 'bin', 'obj', '.idea', '.vscode-test',
  'Library', '.Trash', '.npm', '.yarn', '.bun',
]);

// Convert a simple glob (*, **, ?) into a RegExp. Anchored on both ends so
// "**/*.js" matches "src/foo/bar.js" but not "src/foo/bar.js.map".
function _faunaGlobToRegex(glob) {
  if (!glob) return null;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // ** = any depth (including zero segments). Consume optional /
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      // * = anything except /
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$()|{}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

// Recursive walker yielding relative file paths. Bounded by maxResults and
// skips _FAUNA_SEARCH_SKIP_DIRS unless includeIgnoredFiles is set.
// onFile(relPath) returns false to stop early.
function _faunaWalk(rootAbs, onFile, opts = {}) {
  const includeIgnoredFiles = opts.includeIgnoredFiles === true;
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = path.join(rootAbs, relDir);
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      const name = ent.name;
      if (!includeIgnoredFiles && name.startsWith('.') && name !== '.' && name !== '..') {
        // Skip dotfiles/dotdirs except a few we want to keep (e.g. .env, .github)
        // Actually skip all dot-prefixed dirs for safety; users rarely grep them.
        if (ent.isDirectory()) continue;
      }
      if (ent.isDirectory()) {
        if (!includeIgnoredFiles && _FAUNA_SEARCH_SKIP_DIRS.has(name)) continue;
        stack.push(path.join(relDir, name));
      } else if (ent.isFile()) {
        const rel = path.join(relDir, name);
        if (onFile(rel) === false) return;
      }
    }
  }
}

// Cheap binary-file detector: read first 8KB, look for NUL bytes. If found,
// treat as binary and skip in fauna_grep. Avoids dumping garbage into the
// model context when someone greps over a repo with PDFs / images / sqlite.
function _faunaIsBinary(absPath) {
  try {
    const fd = fs.openSync(absPath, 'r');
    const buf = Buffer.alloc(8192);
    const bytes = fs.readSync(fd, buf, 0, 8192, 0);
    fs.closeSync(fd);
    for (let i = 0; i < bytes; i++) if (buf[i] === 0) return true;
    return false;
  } catch (_) { return true; }
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

// ── Markdown section extraction (progressive disclosure) ──
// Given a full markdown body and a section heading (e.g. "Workflow"), return
// just that `## Workflow` block — the heading plus everything until the next
// `##` heading of the same or higher level. Case-insensitive match. Used by
// fauna_get_agent_instructions and fauna_get_skill so the model can fetch
// one named slice instead of a 30 KB body.
function _extractMarkdownSection(body, section) {
  if (!body || !section) return null;
  const target = String(section).trim().toLowerCase();
  const lines = String(body).split('\n');
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!m) continue;
    const heading = m[2].trim().toLowerCase();
    if (heading === target || heading.startsWith(target + ':')) {
      startIdx = i;
      startLevel = m[1].length;
      break;
    }
  }
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= startLevel) { endIdx = i; break; }
  }
  return lines.slice(startIdx, endIdx).join('\n').trim();
}

// List `## Heading` section names from a markdown body (for catalog use).
function _listMarkdownSections(body) {
  if (!body) return [];
  const out = [];
  const lines = String(body).split('\n');
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m && m[1].length <= 3) out.push(m[2].trim());
  }
  return out;
}

// Locate a skill SKILL.md on disk. Skills can live in:
//   <agentsDir>/<agent>/skills/<skill>/SKILL.md   (agent-scoped)
//   <agentsDir>/_skills/<skill>/SKILL.md          (global skills shared across agents)
//   <workspaceRoot>/skills/<skill>/SKILL.md       (repo-level pack, addyosmani layout)
//   ~/.config/fauna/skills/<skill>/SKILL.md       (user pack installed via /api/skills/import)
// Returns { path, scope, body } or null.
function _extraSkillRoots(context) {
  const roots = [];
  try {
    const ws = context && context.workspaceRoot;
    if (ws) roots.push({ root: path.join(ws, 'skills'), scope: 'repo' });
  } catch (_) {}
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) roots.push({ root: path.join(home, '.config', 'fauna', 'skills'), scope: 'user' });
  } catch (_) {}
  return roots;
}

function _findSkill(agentsDir, agentName, skillName, context) {
  if (!skillName) return null;
  const safeSkill = String(skillName).replace(/[^a-zA-Z0-9_./-]/g, '').replace(/\.\.+/g, '');
  if (!safeSkill) return null;
  const candidates = [];
  if (agentsDir) {
    if (agentName) {
      const safeAgent = String(agentName).replace(/[^a-zA-Z0-9_-]/g, '');
      candidates.push({ scope: 'agent', path: path.join(agentsDir, safeAgent, 'skills', safeSkill, 'SKILL.md') });
      candidates.push({ scope: 'agent', path: path.join(agentsDir, safeAgent, 'skills', safeSkill + '.md') });
    }
    candidates.push({ scope: 'global', path: path.join(agentsDir, '_skills', safeSkill, 'SKILL.md') });
    candidates.push({ scope: 'global', path: path.join(agentsDir, '_skills', safeSkill + '.md') });
  }
  for (const r of _extraSkillRoots(context || {})) {
    candidates.push({ scope: r.scope, path: path.join(r.root, safeSkill, 'SKILL.md') });
    candidates.push({ scope: r.scope, path: path.join(r.root, safeSkill + '.md') });
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c.path)) return { path: c.path, scope: c.scope, body: fs.readFileSync(c.path, 'utf8') };
    } catch (_) {}
  }
  return null;
}

// Scan disk for available skills (returns name + 1-line description from
// SKILL.md frontmatter or the first non-heading line).
function _listSkillsOnDisk(agentsDir, agentName, context) {
  const found = [];
  const seen = new Set();
  const scan = (dir, scope) => {
    if (!fs.existsSync(dir)) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      let skillFile = null;
      let name = ent.name;
      if (ent.isDirectory()) {
        const candidate = path.join(dir, ent.name, 'SKILL.md');
        if (fs.existsSync(candidate)) skillFile = candidate;
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.md')) {
        skillFile = path.join(dir, ent.name);
        name = ent.name.replace(/\.md$/i, '');
      }
      if (!skillFile) continue;
      // First-match-wins across scopes — agent overrides global overrides repo overrides user.
      if (seen.has(name)) continue;
      seen.add(name);
      let desc = '';
      try {
        const body = fs.readFileSync(skillFile, 'utf8');
        const fmMatch = body.match(/^---\s*\n([\s\S]*?)\n---/);
        if (fmMatch) {
          const dm = fmMatch[1].match(/^description:\s*(.+)$/m);
          if (dm) desc = dm[1].trim().replace(/^["']|["']$/g, '');
        }
        if (!desc) {
          const lines = body.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '').split('\n');
          for (const ln of lines) {
            const t = ln.trim();
            if (!t || t.startsWith('#')) continue;
            desc = t.slice(0, 200);
            break;
          }
        }
      } catch (_) {}
      found.push({ name, scope, description: desc, path: skillFile });
    }
  };
  if (agentsDir && agentName) {
    const safeAgent = String(agentName).replace(/[^a-zA-Z0-9_-]/g, '');
    scan(path.join(agentsDir, safeAgent, 'skills'), 'agent');
  }
  if (agentsDir) scan(path.join(agentsDir, '_skills'), 'global');
  for (const r of _extraSkillRoots(context || {})) scan(r.root, r.scope);
  return found;
}

// ── References (read-only knowledge — server maps, schemas, glossaries) ──
// Distinct from skills (workflows). References are looked up when the model
// needs to recall a fact, not when it needs to execute a procedure.
function _extraReferenceRoots(context) {
  const roots = [];
  try {
    const ws = context && context.workspaceRoot;
    if (ws) roots.push({ root: path.join(ws, 'references'), scope: 'repo' });
    if (ws) roots.push({ root: path.join(ws, 'docs', 'references'), scope: 'repo' });
  } catch (_) {}
  try {
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) roots.push({ root: path.join(home, '.config', 'fauna', 'references'), scope: 'user' });
  } catch (_) {}
  return roots;
}

function _listReferencesOnDisk(context) {
  const found = [];
  const seen = new Set();
  for (const r of _extraReferenceRoots(context || {})) {
    let entries;
    try { entries = fs.readdirSync(r.root, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
      const name = ent.name.replace(/\.md$/i, '');
      if (seen.has(name)) continue;
      seen.add(name);
      let title = name;
      let desc = '';
      try {
        const body = fs.readFileSync(path.join(r.root, ent.name), 'utf8');
        const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
        if (h1) title = h1[1].trim();
        for (const ln of body.split('\n')) {
          const t = ln.trim();
          if (!t || t.startsWith('#') || t.startsWith('---')) continue;
          desc = t.slice(0, 200);
          break;
        }
      } catch (_) {}
      found.push({ name, title, scope: r.scope, description: desc, path: path.join(r.root, ent.name) });
    }
  }
  return found;
}

function _findReference(refName, context) {
  if (!refName) return null;
  const safe = String(refName).replace(/[^a-zA-Z0-9_./-]/g, '').replace(/\.\.+/g, '');
  if (!safe) return null;
  for (const r of _extraReferenceRoots(context || {})) {
    const candidates = [
      path.join(r.root, safe + '.md'),
      path.join(r.root, safe, 'README.md'),
    ];
    for (const c of candidates) {
      try {
        if (fs.existsSync(c)) return { path: c, scope: r.scope, body: fs.readFileSync(c, 'utf8') };
      } catch (_) {}
    }
  }
  return null;
}

export const SELF_TOOL_DEFS = [
  // ── Memory tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_remember',
      description: 'Remember a fact about the user. Use when the user shares preferences, makes decisions, or gives context you should recall later. Facts are scoped to the active project by default; pass scope="global" for facts that should apply across all projects. Use kind="temporal" with expiresAt for time-bound facts ("exam tomorrow").',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The fact to remember (max 500 chars)' },
          category: { type: 'string', enum: ['preference', 'fact', 'decision', 'context'], description: 'Category' },
          scope: { type: 'string', enum: ['project', 'global'], description: 'Scope. Defaults to project when a project is active, otherwise global.' },
          kind: { type: 'string', enum: ['static', 'dynamic', 'temporal'], description: 'Lifetime kind. static=long-term, dynamic=recent activity, temporal=expires.' },
          expiresAt: { type: 'number', description: 'Optional unix ms timestamp. Required for kind="temporal".' },
          supersedes: { type: 'string', description: 'Optional id of an existing fact this one replaces (e.g. user changed their mind).' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_recall',
      description: 'Search your memory for facts about the user. Returns matching facts scored by relevance and recency. Call with empty keywords for the most recent facts. Scope defaults to the active project (with global facts included).',
      parameters: {
        type: 'object',
        properties: {
          keywords: { type: 'string', description: 'Space-separated keywords to search for' },
          scope: { type: 'string', enum: ['project', 'global', 'all'], description: 'Search scope. "all" searches every project.' },
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

  // ── Context (RAG) tools ──
  {
    type: 'function',
    function: {
      name: 'fauna_context_search',
      description: 'Semantic + keyword search over ingested context documents (READMEs, design docs, source files, notes). Use to ground answers in project-specific material the user has added. Returns the top matching passages with source info.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language query.' },
          scope: { type: 'string', enum: ['project', 'global', 'all'], description: 'Search scope. Defaults to project (with global included).' },
          limit: { type: 'number', description: 'Max passages to return (default 8, max 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_context_ingest',
      description: 'Ingest a document into the context store. The text is chunked and embedded for later semantic search. Re-ingesting the same sourceId replaces the prior chunks.',
      parameters: {
        type: 'object',
        properties: {
          text:       { type: 'string', description: 'Raw document text.' },
          sourceId:   { type: 'string', description: 'Stable identifier (e.g. file path or URL). Reused to replace prior chunks.' },
          sourcePath: { type: 'string', description: 'Display path.' },
          sourceType: { type: 'string', enum: ['file', 'url', 'note', 'pasted'], description: 'Origin kind (default note).' },
          title:      { type: 'string', description: 'Optional display title.' },
          scope:      { type: 'string', enum: ['project', 'global'], description: 'Scope (default project when active).' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_context_list',
      description: 'List ingested context documents (without their text) so you can confirm what is available before searching or delete stale entries.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string', enum: ['project', 'global', 'all'], description: 'Filter scope.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_context_delete',
      description: 'Delete an ingested context document by docId (from fauna_context_list).',
      parameters: {
        type: 'object',
        properties: {
          docId: { type: 'string', description: 'The docId to delete.' },
        },
        required: ['docId'],
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
      description: 'Set the extended thinking budget for reasoning models. The change takes effect on the next message. Use "auto" to let Fauna scale the budget to each question (low for simple Q&A, high for complex/agentic work).',
      parameters: {
        type: 'object',
        properties: {
          budget: { type: 'string', enum: ['auto', 'off', 'low', 'medium', 'high', 'max'], description: 'Thinking budget level' },
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
      description: 'Create a new project in Fauna. Returns the project object with its ID. When the user wants to build an app/site/tool, set `template` to scaffold a working starter (e.g. vite-react-ts, vite-react-ts-sqlite). Defaults to no template (empty project record only).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Project name' },
          description: { type: 'string', description: 'Short description' },
          rootPath: { type: 'string', description: 'Absolute path to the project root directory. If template is set and the folder is empty (or missing), the template is unpacked here.' },
          template: {
            type: 'string',
            enum: ['none', 'vite-react-ts', 'vite-react-ts-sqlite'],
            description: 'Starter to scaffold. "vite-react-ts" = static Vite+React+TS (no server, no DB). "vite-react-ts-sqlite" = Vite+React+TS + Hono server + better-sqlite3 + migrations dir. Default "none".',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_db_migration',
      description: 'Create a new SQL migration file with a mandatory markdown summary header. Used when building apps with SQLite. Stamps the file as `migrations/NNNN_<slug>.sql` in the active project root. The header documents purpose, tables changed, indexes added, and rollback notes — required for every schema change. Validates that the SQL parses (basic syntax check). Use this every time you add or alter a table; do NOT hand-write migration files.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id. Defaults to active project.' },
          name: { type: 'string', description: 'Short snake_case name describing the change, e.g. "create_users", "add_email_index". Becomes the filename slug.' },
          purpose: { type: 'string', description: 'One-sentence why. Goes into the markdown header.' },
          tablesChanged: { type: 'array', items: { type: 'string' }, description: 'Tables this migration creates/alters/drops.' },
          rollbackNotes: { type: 'string', description: 'How to undo this migration (or "irreversible — backup first").' },
          sql: { type: 'string', description: 'The raw SQL for the migration. MUST parametrize any embedded data with `?`. Should include `created_at`/`updated_at` defaults on new tables.' },
        },
        required: ['name', 'purpose', 'sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_verify_build',
      description: 'Verify a scaffolded app actually builds. Runs `npm run build` (or the script you specify) in the project root, returns exit code + last 80 lines of output. MANDATORY before marking a build/scaffold plan complete — do NOT claim success without calling this and seeing exitCode:0.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id. Defaults to active project.' },
          cwd: { type: 'string', description: 'Explicit working directory (overrides projectId rootPath).' },
          script: { type: 'string', description: 'npm script to run. Default "build".' },
          timeoutMs: { type: 'number', description: 'Hard cap in ms (default 180000 = 3min).' },
        },
        required: [],
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
  {
    type: 'function',
    function: {
      name: 'fauna_workspace_context',
      description: 'Resolve the active Fauna workspace context. Project conversations return project root/read/write/validation scope; non-project conversations return document/global context and explicit cwd scope. Call before coding, diagnostics, tests, or terminal work when scope is unclear.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project id. Defaults to the active project in context.' },
          conversationId: { type: 'string', description: 'Optional conversation id.' },
          cwd: { type: 'string', description: 'Optional explicit working directory for non-project or override context.' },
          documents: { type: 'array', items: { type: 'string' }, description: 'Optional document/file paths attached to a non-project conversation.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_diagnostics',
      description: 'VS Code Problems-style diagnostics for a Fauna workspace. Resolves the project/conversation workspace, runs an explicit or discovered validation command, and returns structured {file,line,column,severity,source,message} entries plus raw tail output.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project id. Defaults to active project.' },
          conversationId: { type: 'string', description: 'Optional conversation id.' },
          cwd: { type: 'string', description: 'Optional working directory.' },
          command: { type: 'string', description: 'Optional diagnostic command override, e.g. "npm run typecheck".' },
          timeoutMs: { type: 'number', description: 'Command timeout in ms. Defaults 180000.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_symbols',
      description: 'List JS/TS workspace symbols (classes, functions, variables, types) for the active project/cwd. Static fallback until full LSP is available.',
      parameters: { type: 'object', properties: { cwd: { type: 'string' }, query: { type: 'string' }, maxResults: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_definition',
      description: 'Find likely JS/TS definitions for a symbol in the active project/cwd. Static fallback until full LSP is available.',
      parameters: { type: 'object', properties: { cwd: { type: 'string' }, symbol: { type: 'string' }, maxResults: { type: 'number' } }, required: ['symbol'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_references',
      description: 'Find JS/TS references to a symbol in the active project/cwd with line numbers. Static fallback until full LSP is available.',
      parameters: { type: 'object', properties: { cwd: { type: 'string' }, symbol: { type: 'string' }, maxResults: { type: 'number' } }, required: ['symbol'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_rename_symbol',
      description: 'Conservatively rename a JS/TS identifier across the active project/cwd using word-boundary replacement. Prefer this over raw search/replace for simple identifiers; full LSP rename will supersede it later.',
      parameters: { type: 'object', properties: { cwd: { type: 'string' }, symbol: { type: 'string' }, newName: { type: 'string' } }, required: ['symbol', 'newName'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_terminal',
      description: 'Persistent terminal sessions for interactive/project work. Actions: start, send, output, list, kill. Use when a command needs preserved cwd/env/session or interactive follow-up; use fauna_shell_exec for simple one-shot commands.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'send', 'output', 'list', 'kill'] },
          id: { type: 'string', description: 'Terminal id for send/output/kill.' },
          cwd: { type: 'string', description: 'Working directory for start.' },
          command: { type: 'string', description: 'Optional command to run immediately after start.' },
          input: { type: 'string', description: 'Input line for send.' },
          maxChars: { type: 'number', description: 'Output tail cap for output.' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_test_results',
      description: 'Run a test command or parse supplied test output into structured failures and summary data. Supports Vitest/Jest-like, pytest, and go test output patterns.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string' },
          command: { type: 'string', description: 'Optional test command to run. Defaults to npm test when running.' },
          output: { type: 'string', description: 'Existing terminal/test output to parse instead of running a command.' },
          timeoutMs: { type: 'number' },
        },
      },
    },
  },

  // ── Agent instruction lookup (lazy-load pattern, mirrors Clawpilot m_get_skill) ──
  // The system prompt only carries the agent's name + 1-line description; the
  // full body (often 30KB+ of detailed tool-use instructions) is fetched via
  // this tool. Landing the body as a tool result puts it in the high-attention
  // recency window where the model actually follows it, instead of burying it
  // in a system prompt block that loses to later directives.
  {
    type: 'function',
    function: {
      name: 'fauna_get_agent_instructions',
      description: 'Load the FULL instructions for the currently active agent. If an agent is active (the system prompt will say "Active Agent: <name>"), you MUST call this once at the start of every turn before doing any other work — the system prompt only contains the agent\'s name and short description, and the full instructions (tool-use rules, output format, workflows) live in this tool\'s return value. If NO agent is active, do NOT call this tool — it is a no-op in that case and you already have your full default tool set. Pass `section` to fetch only one `## Heading` block from the body when you know which part you need (saves context on large agents).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional agent slug. Defaults to the currently active agent.' },
          section: { type: 'string', description: 'Optional `## Heading` name to return only that section of the body. Omit for the full body.' },
        },
      },
    },
  },

  // ── Skill catalog (progressive disclosure for Harness-scale teams) ──
  // The system prompt should never carry full skill bodies. fauna_list_skills
  // returns a tiny name + description catalog so the model knows what exists;
  // fauna_get_skill fetches one body on demand. Modeled after Claude Code's
  // SKILL.md progressive-disclosure pattern.
  {
    type: 'function',
    function: {
      name: 'fauna_list_skills',
      description: 'List all available skills (name + one-line description) for the active agent and globally. Cheap — returns no skill bodies. Use this to decide which skill to load with fauna_get_skill.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'Optional agent slug to scope to. Defaults to the active agent.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_get_skill',
      description: 'Load one skill body (SKILL.md) by name. Optionally pass a `section` to fetch only one `## Heading` block. Skills are progressively disclosed — only call this once you know from fauna_list_skills which skill you need.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill slug from fauna_list_skills.' },
          section: { type: 'string', description: 'Optional `## Heading` to return only that section.' },
          agent: { type: 'string', description: 'Optional agent slug to scope to. Defaults to the active agent.' },
        },
        required: ['name'],
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'fauna_route_skill',
      description: 'Semantically route a task to the best skill(s). Given a natural-language description of what you are about to do, returns a ranked list of skills with a confidence score, the evidence that matched, and — when the match is uncertain — a clarifying question to ask the user. Prefer this over guessing from fauna_list_skills when the task domain is ambiguous. Load the winning skill with fauna_get_skill.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language description of the task you are about to perform.' },
          agent: { type: 'string', description: 'Optional agent slug to scope to. Defaults to the active agent.' },
          activeSkill: { type: 'string', description: 'Optional slug of the skill already in use, to bias toward related skills.' },
        },
        required: ['query'],
      },
    },
  },

  // ── Spec-first loop: interview, seed, unstuck (ouroboros-inspired) ──
  // Gate autonomous/Kanban work on a clear spec. Interactive chat is unaffected.
  {
    type: 'function',
    function: {
      name: 'fauna_interview',
      description: 'Score how ambiguous a task/spec is (0 = crystal clear, 1 = vague) and get Socratic clarifying questions to ask the user. Use BEFORE starting autonomous work: if the score is above the gate (default 0.2), ask the returned questions instead of guessing. Deterministic — no model tokens.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The task goal in one sentence.' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Known success conditions, if any.' },
          constraints: { type: 'array', items: { type: 'string' }, description: 'Known constraints / out-of-scope items.' },
          openQuestions: { type: 'array', items: { type: 'string' }, description: 'Still-unanswered questions, if any.' },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_create_seed',
      description: 'Freeze an immutable Seed spec (goal + acceptance criteria + constraints + ontology) that later evaluation checks against. Blocked automatically if the ambiguity score exceeds the gate (pass force:true to override). Do this once the task is clear, before autonomous execution.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal in one concrete sentence.' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: 'Observable success conditions.' },
          constraints: { type: 'array', items: { type: 'string' }, description: 'Out-of-scope items / constraints.' },
          ontology: { type: 'array', items: { type: 'string' }, description: 'Key domain terms/entities.' },
          projectId: { type: 'string', description: 'Optional project this seed belongs to.' },
          force: { type: 'boolean', description: 'Create even if the ambiguity gate is not cleared.' },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_list_seeds',
      description: 'List frozen Seed specs (newest first) with their goal and ambiguity score. Use fauna_get_seed to load one in full.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_get_seed',
      description: 'Load one immutable Seed spec by id — the contract to check work against.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Seed id from fauna_list_seeds.' } },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_unstuck',
      description: 'When the loop is stalled (repeating the same failed approach), get an ordered rotation of lateral-thinking personas (contrarian, simplifier, researcher, hacker, architect) to reframe the problem. Take one divergent pass per persona until one yields a concrete new next action.',
      parameters: {
        type: 'object',
        properties: {
          context: { type: 'string', description: 'Brief description of what is stuck.' },
          count: { type: 'number', description: 'How many personas to return (1–5, default 5).' },
        },
      },
    },
  },

  {
    type: 'function',
    function: {
      name: 'fauna_audit_prompt',
      description: 'Audit a system-prompt / instruction string against curated behavioural patterns (tool-discipline, verification, persistence, scope, honesty, safety, output-format). Returns which patterns are present, which are missing, and remediation hints. Use to review or improve agent instructions and skills.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'The prompt / instruction text to audit.' },
        },
        required: ['prompt'],
      },
    },
  },

  // ── Reference catalog (read-only knowledge — server maps, schemas, glossaries) ──
  // Distinct from skills (workflows). Use references for "what is this?" questions;
  // use skills for "how do I do this?" workflows.
  {
    type: 'function',
    function: {
      name: 'fauna_list_references',
      description: 'List all available reference documents (server maps, schemas, glossaries, architecture notes). Cheap — returns no bodies. References answer "what is this?" questions; for "how do I do this?" workflows, use fauna_list_skills instead.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_get_reference',
      description: 'Load one reference document by name. Optionally pass a `section` to fetch only one `## Heading` block.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Reference slug from fauna_list_references.' },
          section: { type: 'string', description: 'Optional `## Heading` to return only that section.' },
        },
        required: ['name'],
      },
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
          maxOutputBytes: { type: 'number', description: 'Optional per-stream cap on captured stdout/stderr. Default 100000 chars per stream; hard cap 500000. Use a SMALL value (e.g. 4000) for commands that may dump tons of data you only need a head/tail of — it keeps context lean.' },
          reason: { type: 'string', description: 'Optional one-line reason this command is being run. Helps with audit and debugging.' },
        },
        required: ['command'],
      },
    },
  },

  // ── Dev-server registry (list / stop / restart background dev servers) ──
  {
    type: 'function',
    function: {
      name: 'fauna_dev_servers',
      description: 'List, stop, or restart background dev servers (npm run dev, vite, next dev, php -S, uvicorn, …) that were started earlier in this or any other conversation. When a dev-server command is launched via fauna_shell_exec or a ```bash block, the server is detached and registered here — it does NOT come back via shell output. Use this tool to check status, restart after a code change, or stop a port when the user is done. Action `list` returns every tracked server with id, label, cwd, port (if detected), status, command, and startedAt. Action `stop` SIGTERMs by id. Action `restart` kills and respawns the same command in the same cwd.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'stop', 'restart'], description: 'What to do.' },
          id: { type: 'string', description: 'Registry id from a prior list call. Required for stop/restart.' },
        },
        required: ['action'],
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

  // ── File search (glob) ──
  {
    type: 'function',
    function: {
      name: 'fauna_file_search',
      description: 'Find files by glob pattern. Faster than `find`/`ls` via fauna_shell_exec because it returns structured results and skips heavy directories (node_modules, .git, dist, build). Use this when you know the filename pattern but not the location. Examples: "**/*.test.js", "src/**/auth-*.ts", "*.md".',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern. Supports * (single segment) and ** (any depth).' },
          cwd: { type: 'string', description: 'Optional working directory. Defaults to the repo/home root.' },
          maxResults: { type: 'number', description: 'Cap on returned file paths. Defaults 100.' },
        },
        required: ['pattern'],
      },
    },
  },

  // ── Grep search (text) ──
  {
    type: 'function',
    function: {
      name: 'fauna_grep',
      description: 'Search file contents for a pattern (literal or regex) with line numbers. Faster and safer than running `grep -r` via fauna_shell_exec — skips binary files and node_modules, returns structured hits. Use for "find all calls to X" or "where is Y defined". For multiple potential words, use a regex with alternation (e.g. "foo|bar|baz") in a single call rather than separate calls.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text pattern or regex to search for.' },
          isRegex: { type: 'boolean', description: 'When true, query is a regex. Defaults false (literal substring).' },
          isRegexp: { type: 'boolean', description: 'VS Code-compatible alias for isRegex.' },
          caseInsensitive: { type: 'boolean', description: 'Defaults true.' },
          include: { type: 'string', description: 'Optional glob to restrict searched files (e.g. "**/*.js").' },
          includePattern: { type: 'string', description: 'VS Code-compatible alias for include.' },
          includeIgnoredFiles: { type: 'boolean', description: 'When true, also search normally skipped directories such as node_modules, build output, and dot-directories. Defaults false.' },
          cwd: { type: 'string', description: 'Optional working directory. Defaults to the repo/home root.' },
          maxResults: { type: 'number', description: 'Cap on returned matches. Defaults 200.' },
        },
        required: ['query'],
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
            description: 'One of: navigate, back, forward, reload, click, type, extract, evaluate, screenshot, scroll, wait, new-tab, switch-tab, close-tab, list-tabs. Compatibility aliases accepted: eval, tab-new, tab-switch, tab-close, tab-list.',
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

  // ── PCB: footprints / board layout / etchings / DRC / build guide ──
  {
    type: 'function',
    function: {
      name: 'fauna_list_footprints',
      description: 'List the physical PCB footprints (land patterns) available for each circuit component type, with variants (tht/smd). Call this when the user wants a PCB / board layout so you know which parts have footprints.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_layout_pcb',
      description: 'Turn a circuit DSL into a physical board model: places footprints, assigns nets to copper pads, sizes the board, and (by default) auto-routes copper traces (etchings) on two layers with vias, leaving unroutable nets as airwires. Returns the board model. Use this BEFORE fauna_render_pcb / fauna_check_board / fauna_build_guide.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL document (same shape as fauna_render_circuit)' },
          route: { type: 'boolean', description: 'Auto-route copper traces. Default true.' },
          variants: { type: 'object', description: 'Per-type footprint variant override, e.g. { "resistor": "smd" }.' },
          placements: { type: 'object', description: 'Manual component placement in mm: { compId: { x, y, rot } }.' },
          board: { type: 'object', description: 'Fixed board size in mm: { w, h }. Auto-sized when omitted.' },
        },
        required: ['doc'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_render_pcb',
      description: 'Render a board model (from fauna_layout_pcb) as an SVG top view: FR-4 substrate, copper traces/etchings (top=red, bottom=blue), tinned solder pads + plated drill holes, silkscreen refdes, vias, and ratsnest airwires. Returns SVG markup to embed in a gen-ui SVG block. Pass the board returned by fauna_layout_pcb.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL — laid out + routed automatically if `board` is not supplied.' },
          board: { type: 'object', description: 'Pre-computed board model from fauna_layout_pcb (preferred).' },
          layers: { type: 'object', description: 'Layer visibility flags, e.g. { "copperBottom": false, "ratsnest": false }.' },
          pxmm: { type: 'number', description: 'Pixels per millimetre (default 8).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_check_board',
      description: 'Design-rule check (DRC) of a routed board: copper clearance (pad↔pad, trace↔trace, trace↔pad), drill spacing, board-edge clearance, and unrouted nets. Returns { ok, errors, warnings, stats }. ALWAYS run after fauna_layout_pcb and surface violations.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL — laid out + routed automatically if `board` is not supplied.' },
          board: { type: 'object', description: 'Pre-computed routed board model from fauna_layout_pcb (preferred).' },
          clearance: { type: 'number', description: 'Minimum copper clearance in mm (default 0.25).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_build_guide',
      description: 'Generate a complete build guide for a circuit: bill of materials, assembly order (low-profile parts first), polarity/pin-1 callouts, soldering steps, and a simulation-backed "test & verify" section with expected node voltages. Returns a structured guide + Markdown. Uses ngspice for expected readings when available; degrades gracefully otherwise.',
      parameters: {
        type: 'object',
        properties: {
          doc: { type: 'object', description: 'Circuit DSL document (same shape as fauna_render_circuit)' },
          analysis: { type: 'object', description: 'Optional simulation analysis spec (defaults to operating point).' },
        },
        required: ['doc'],
      },
    },
  },
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
      description: 'Append a feature request or backlog item to the active project backlog (Kanban board). Use when the user describes wanting something new, when reflection surfaces a gap, or when debate produces a follow-up. Returns the created item id. Optional fields let you drop it straight into a column or assign it.',
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
          column:     { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'archived'], description: 'Initial column. Defaults to "backlog". Use "todo" to make it pickable by the autopilot.' },
          assignee:   { type: 'string', enum: ['ai', 'human'], description: 'Who should pick this up. Omit to leave unassigned.' },
          priority:   { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'], description: 'Priority bucket. Defaults to p2.' },
          acceptance: { type: 'string', description: 'Bulletted acceptance criteria the AI worker must satisfy before marking Done.' },
          projectId:  { type: 'string', description: 'Project id. Defaults to the active project.' },
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
          status:    { type: 'string', description: 'Filter: new | groomed | in-progress | done | dropped (legacy).' },
          column:    { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'archived'], description: 'Filter by Kanban column.' },
          limit:     { type: 'number', description: 'Max items (default 50).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_backlog_prioritize',
      description: 'Score and rank backlog items. method="rice" (default) computes RICE = reach*impact*confidence/effort. method="moscow" buckets by must/should/could/wont tags. Also promotes new items into the Todo column so the autopilot can pick them up.',
      parameters: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
          method:    { type: 'string', enum: ['rice', 'moscow'], description: 'Prioritization method.' },
        },
      },
    },
  },
  // ── Kanban work items (board automation) ─────────────────────────────
  {
    type: 'function',
    function: {
      name: 'fauna_workitem_move',
      description: 'Move a work item between Kanban columns. Use this when you finish a phase of work (move "in_progress" → "review", then "review" → "done"). The AI may only move cards forward (todo → in_progress → review → done → archived). Returns the updated item.',
      parameters: {
        type: 'object',
        properties: {
          itemId:    { type: 'string', description: 'Work item id (returned by fauna_feature_request_create or fauna_board_scan).' },
          column:    { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'archived'], description: 'Target column.' },
          claim:     { type: 'boolean', description: 'When true and moving into in_progress, also claims the card as ai:<agent>.' },
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
        },
        required: ['itemId', 'column'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_workitem_claim',
      description: 'Mark that you are taking ownership of a work item. Sets claimedBy="ai:<agent>" so other AI agents skip it and humans can see who is on the card. Call this right before you start the work, typically alongside a move to in_progress.',
      parameters: {
        type: 'object',
        properties: {
          itemId:    { type: 'string' },
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
        },
        required: ['itemId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_workitem_comment',
      description: 'Post a comment on a work item — status update, question for the user, blocker, link to relevant code. Comments appear in the card modal and are visible to humans. Use this to leave breadcrumbs when handing the card off or pausing for input.',
      parameters: {
        type: 'object',
        properties: {
          itemId:    { type: 'string' },
          body:      { type: 'string', description: 'Comment body (<= 4000 chars).' },
          projectId: { type: 'string', description: 'Project id. Defaults to the active project.' },
        },
        required: ['itemId', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_workitem_update',
      description: 'Edit a work item\'s title, body, acceptance criteria, priority, tags, assignee, or verifyCommand. Use this when you refine a card after research or when you discover the original scope was wrong. Set `verifyCommand` to a shell command (e.g. "npx vitest run tests/my-feature.test.js") so the autopilot can prove the work is done before allowing a move to "done". Does NOT move columns — use fauna_workitem_move for that.',
      parameters: {
        type: 'object',
        properties: {
          itemId:        { type: 'string' },
          title:         { type: 'string' },
          body:          { type: 'string' },
          acceptance:    { type: 'string' },
          priority:      { type: 'string', enum: ['p0', 'p1', 'p2', 'p3'] },
          tags:          { type: 'array', items: { type: 'string' } },
          assignee:      { type: 'string', enum: ['ai', 'human'] },
          verifyCommand: { type: 'string', description: 'Per-card shell verifier (e.g. "npx vitest run tests/x.test.js"). Overrides project qa.command. Pass empty string to clear.' },
          projectId:     { type: 'string', description: 'Project id. Defaults to the active project.' },
        },
        required: ['itemId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_board_scan',
      description: 'List Kanban work items. Scope="project" (default) returns the active project board; scope="global" aggregates across every project. Use this to (a) find your next card to claim, (b) check if a similar card already exists before creating a duplicate, or (c) summarise board status for the user. Returns items with column, assignee, priority, claimedBy, lockedByUser and counts of comments/runs.',
      parameters: {
        type: 'object',
        properties: {
          scope:     { type: 'string', enum: ['project', 'global'], description: 'project = current project only (default); global = every project.' },
          column:    { type: 'string', enum: ['backlog', 'todo', 'in_progress', 'review', 'done', 'archived'], description: 'Filter to one column.' },
          assignee:  { type: 'string', enum: ['ai', 'human'], description: 'Filter to cards assigned to AI or to humans.' },
          limit:     { type: 'number', description: 'Max items (default 50, max 200).' },
          projectId: { type: 'string', description: 'Project id when scope="project". Defaults to the active project.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_project_audit',
      description: 'Audit the active project (or a named project) and propose ≤ N concrete work items based on its architecture. Walks rootPath, summarises the file tree + key config files (package.json, README, etc.), then prompts the model for high-value feature/refactor/test/docs/ci suggestions. New items land in the project backlog with source="reflection" and column="backlog" for human review. Dedup is by normalised title hash. Returns {added:[{id,title,priority}], skipped:[titles], summary:{...}}. Use when the user asks "what should we work on next?", "audit this project", or after you finish a major feature and want to surface follow-ups. Be selective — quality over quantity.',
      parameters: {
        type: 'object',
        properties: {
          projectId:    { type: 'string', description: 'Project id. Defaults to the active project.' },
          maxProposals: { type: 'number', description: 'Cap on number of items to propose (default 5, max 10).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_workitem_verify',
      description: 'Run the verifier for a Kanban work item and record the result on the card. Resolution order for the command: 1) the card\'s `verifyCommand` (per-card override, settable via fauna_workitem_update), 2) the project\'s `qa.command`, 3) none → skipped pass. Runs the shell command with cwd=project.rootPath, captures stdout/stderr (clipped to 8 KB), times out at 5 min. On exit-code 0 the card is marked verified=true and you may move it to "done"; non-zero blocks the done move. MUST be called before fauna_workitem_move to column="done" on any project that has a verifier — otherwise the move is rejected. The result is also appended as a comment.',
      parameters: {
        type: 'object',
        properties: {
          itemId:        { type: 'string', description: 'Work item id.' },
          projectId:     { type: 'string', description: 'Project id. Defaults to the active project.' },
          timeoutMs:     { type: 'number', description: 'Override the default 5-minute timeout (in ms).' },
        },
        required: ['itemId'],
      },
    },
  },
  // ── Plan (TODOs) ─────────────────────────────────────────────────────
  {
    type: 'function',
    function: {
      name: 'fauna_plan',
      description: 'Maintain a structured TODO list for the current task. Use a plan when: the task is non-trivial and spans multiple actions; there are logical phases or dependencies where sequencing matters; the user asked for more than one thing in a single prompt; you generate additional steps mid-flight. Invariants: exactly ONE item in_progress at a time; mark items completed individually (no batch completions); set an item to in_progress BEFORE working it (never jump pending → completed); finish with all items completed or explicitly canceled before ending the turn. MANDATORY: every plan MUST end with a verification/testing item that actually checks the work (e.g. "Verify build succeeds and tests pass", "Run app and confirm output matches spec", "Lint + execute end-to-end smoke test"). Do NOT mark the verify item completed unless you actually ran the check (shell, test runner, build, manual probe) and observed the expected result — claiming "done" without proof is a failure. If verification fails, add a fix item and re-run verify. High-quality plan example: [{"id":1,"title":"Add CLI entry with file args","status":"completed"},{"id":2,"title":"Parse Markdown via CommonMark","status":"in-progress"},{"id":3,"title":"Apply semantic HTML template","status":"not-started"},{"id":4,"title":"Handle code blocks, images, links","status":"not-started"},{"id":5,"title":"Add error handling for invalid files","status":"not-started"},{"id":6,"title":"Verify: run on sample.md and diff against expected.html","status":"not-started"}]. Low-quality plan (avoid — too vague AND missing verify): [{"title":"Create CLI tool"},{"title":"Add Markdown parser"},{"title":"Convert to HTML"}]. Pass the FULL list every call (both existing and new items).',
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
  // ── Plan substep narration (live "what I'm doing right now" under current step) ──
  {
    type: 'function',
    function: {
      name: 'fauna_substep',
      description: 'Stream a tiny "what I am doing right now" line that appears NESTED under the current in-progress plan step. Use this INSTEAD of long narrative prose between actions. Each call replaces the previous live substep for that step (the user only sees the latest). When the parent plan item flips to completed, all its substeps collapse into a click-to-expand history. Keep messages SHORT (3-8 words, action verbs): "Reading vite.config.ts", "Wiring API route", "Creating migration 0001_init". Call this BEFORE each tool action or whenever you would otherwise write a status sentence.',
      parameters: {
        type: 'object',
        properties: {
          stepId: { type: 'number', description: 'The plan item id (from fauna_plan) this substep belongs to. If omitted, attaches to the current in-progress item.' },
          message: { type: 'string', description: 'Short action-oriented status (3-8 words).' },
        },
        required: ['message'],
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
  // ── Office document tools (render, get, set, issues, merge) ─────────────
  {
    type: 'function',
    function: {
      name: 'fauna_document_screenshot',
      description:
        'Render a Word (.docx), PowerPoint (.pptx), Excel (.xlsx), or any other office document to PNG screenshots (one per page/slide) so you can SEE the visual output and verify layout, overflow, and styling before declaring a task done. ' +
        'Returns { ok, pngs: ["/absolute/path/..."] }. You can then reference those paths in your reply as markdown images (![slide 1](path)) to show them to the user. ' +
        'ALWAYS call this after generating or editing an office document — it closes the "flying blind" loop. ' +
        'Requires LibreOffice (soffice) + pdftoppm (poppler) to be installed; returns needsInstall hint if missing.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~/ path to the document to render.' },
          pages: {
            description: 'Which pages/slides to render. "all" (default), a single number (e.g. 1), or an array of numbers (e.g. [1,2,3]).',
            oneOf: [
              { type: 'string', enum: ['all'] },
              { type: 'number' },
              { type: 'array', items: { type: 'number' } },
            ],
          },
          dpi: { type: 'number', description: 'Resolution in DPI (72-300). Default 150. Use 100 for quick previews, 200+ for detail checks.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_document_get',
      description:
        'Get structured data about an element in a Word, PowerPoint, or Excel document using a path. ' +
        'PPTX paths: "/" (slide list), "/slide[N]" (shapes on slide N), "/slide[N]/shape[M]" (shape detail), "/slide[N]/shape[@name=Title]" (shape by name). ' +
        'DOCX paths: "/" (stats), "/body" (element list), "/body/p[N]" (paragraph N), "/body/tbl[N]" (table N). ' +
        'XLSX paths: "/" (sheet list), "/SheetName" (sheet stats), "/SheetName/A1" (cell), "/SheetName/row[N]" (row). ' +
        'Returns typed, structured JSON with error codes and suggestions on failure (e.g. code "not_found" + valid range).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~/ path to the document.' },
          docPath: { type: 'string', description: 'Element path inside the document, e.g. "/slide[1]/shape[2]". Defaults to "/" (root).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_document_set',
      description:
        'Set properties on an element inside a Word, PowerPoint, or Excel document at a given path. Writes back in-place. ' +
        'PPTX: path="/slide[N]/shape[M]", props can include text, bold, italic, font_size (number, points), color (hex e.g. "FF0000"). ' +
        'DOCX: path="/body/p[N]", props can include text, bold, style (style name). ' +
        'XLSX: path="/SheetName/A1", props can include value (any scalar) or formula (string starting with "="). ' +
        'Returns { ok, path, changed: [...propNames] }.',
      parameters: {
        type: 'object',
        properties: {
          path:    { type: 'string', description: 'Absolute or ~/ path to the document.' },
          docPath: { type: 'string', description: 'Element path, e.g. "/slide[1]/shape[2]" or "/body/p[3]" or "/Sheet1/B2".' },
          props:   { type: 'object', description: 'Properties to set. Keys depend on format — see description.' },
        },
        required: ['path', 'docPath', 'props'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_document_issues',
      description:
        'Scan a Word, PowerPoint, or Excel document for common quality issues: ' +
        'PPTX — empty slides, empty shapes, long text that may overflow, shapes outside slide boundary, images without alt text. ' +
        'DOCX — very long paragraphs, excessive empty paragraphs. ' +
        'XLSX — cells containing formula errors (#VALUE!, #REF!, #N/A, etc.). ' +
        'Returns { ok, issue_count, issues: [{type, slide?, paragraph?, cell?, message}] }. ' +
        'Call this before delivering a document to the user.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute or ~/ path to the document to check.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_document_merge',
      description:
        'Template merge: replace {{key}} placeholders in a Word (.docx), PowerPoint (.pptx), or Excel (.xlsx) document with values from a data object. ' +
        'Useful for filling report templates, invoice templates, slide decks, etc. without re-generating from scratch. ' +
        'The agent designs the layout once (the template); downstream code fills placeholders N times — deterministic, zero token cost per fill. ' +
        'src and dest may be the same path for in-place replacement. ' +
        'Returns { ok, src, dest, replacements: N }.',
      parameters: {
        type: 'object',
        properties: {
          src:  { type: 'string', description: 'Absolute or ~/ path to the source template document.' },
          dest: { type: 'string', description: 'Absolute or ~/ path to write the filled document (may equal src for in-place).' },
          data: { type: 'object', description: 'Key-value pairs where each key matches a {{key}} placeholder in the document.' },
        },
        required: ['src', 'dest', 'data'],
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
        'Synthesize text into an audio file with the bundled Kokoro neural TTS, returning a URL the renderer can play AND an absolute filesystem path you can hand to ffmpeg / shell tools. Use this when the user asks to "read aloud", "read me this article", "say this", "narrate", or otherwise wants spoken audio for a single chunk of text. After calling it, emit a gen-ui block with a MediaPlayer (type:"audio", src: returned url, title: <short label>) so the audio appears inline. Do NOT set autoplay — the user clicks Play when ready. Do NOT use this for multi-speaker podcasts — use fauna_podcast for that. Returns {ok, url, path, durationSec, voice} — `path` is a real .mp3 on disk usable as an ffmpeg input (e.g. `ffmpeg -i <path> -i video.mp4 -c:v copy -shortest out.mp4`).',
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
        'Generate a multi-voice podcast / dialogue from an ordered list of speaker turns and return ONE audio URL (plus an absolute filesystem path) covering all turns concatenated with natural pauses between speakers. Use this when the user asks for a "podcast", "dialogue", "conversation", "interview", "two-host", or "multi-voice" reading — including "make a podcast from this article" (you script the back-and-forth first, then call this). After calling it, emit a gen-ui block with a MediaPlayer (type:"audio", src: returned url, title:<show title>). Do NOT set autoplay — the user clicks Play when ready. Returns {ok, url, path, durationSec, segmentCount} — `path` is a real .mp3 on disk usable as an ffmpeg input.',
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
        'Generate an interactive whiteboard lesson and mount it INLINE in chat as a sandboxed runtime widget — NOT a video file. The widget shows a 1280×720 whiteboard that animates props (text, LaTeX equations, shapes, arrows, function plots, number lines, code, molecules, embedded svg/circuits) in sync with per-scene Kokoro narration. Use this whenever the user wants to be TAUGHT something visually — "explain", "teach me", "walk me through", "interactive lesson on", "show me how X works", anything where a moving illustration would help more than prose. You can also ground the lesson in a specific document by passing `source` (a local file path to a .pptx / .docx / .pdf / .md / .txt / .html, or a URL) — the slide deck or article text is extracted and fed to the script generator so the lesson follows that material. CRITICAL: when the user attaches/shares a .pptx (or .ppt/.key/.odp) deck and asks for a lesson or video, you MUST pass its absolute path as `source`. The attachment fence header includes "(path: /abs/path/to/file.pptx)" — use that exact path. With a pptx source, the lesson auto-switches to STRICT SLIDE MODE: each original slide is rasterized to PNG and used as the backdrop, narration is generated per slide, and no generic whiteboard scenes are drawn. Skipping `source` will produce a generic invented whiteboard that ignores the deck. Returns immediately after audio synthesis; the widget then plays scene-by-scene on user gesture. Do NOT also produce a separate fauna_speak / fauna_video_create call for the same topic.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'What the lesson teaches. Be specific: "How does the derivative of sin(x) become cos(x)?", "Pythagorean theorem with a visual proof", "Why does ice float on water?". Optional if `source` is given (we will use "Teach the contents of this source").' },
          source: { type: 'string', description: 'Optional ground-truth material. Either (a) an absolute path or ~/path to a local .pptx, .docx, .pdf, .md, .txt, or .html file, or (b) an http(s):// URL to a web page or slide. The text content (and pptx speaker notes) is extracted and used as canonical source for the lesson script. Use this when the user says things like "make a lesson from this deck", "turn this PDF into a tutorial", "explain this article visually".' },
          durationMin: { type: 'number', description: 'Target length in minutes (1–10). Default 5. Longer = more scenes; expect ~2.5 scenes per minute.' },
          voice: { type: 'string', description: 'Kokoro voice id for narration. Defaults to af_bella. Pick a calm voice for math/science (am_michael, bf_emma).' },
        },
        required: [],
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

  // ── AI image generation (OpenAI GPT Image) ─────────────────────────────
  // Original, model-generated imagery (vs. stock photos). Requires the user's
  // OpenAI key. Writes PNGs to disk and returns a /api/serve-media URL per
  // image so they can be shown in chat or referenced from generated artefacts.
  {
    type: 'function',
    function: {
      name: 'fauna_image_generate',
      description:
        'Generate ORIGINAL images from a text prompt using OpenAI GPT Image (gpt-image-1). Use this when the user wants a custom/illustrated/logo/concept image that stock photos cannot provide (prefer fauna_stock_image_search for real photographs). Writes PNG(s) to disk and returns {ok, results:[{path, url, revisedPrompt}]} where url is a /api/serve-media link you can embed directly in chat markdown as ![alt](url). Requires an OpenAI key (Settings → Authentication → API Keys). For low-quality fast drafts use quality "low"; use "high" for final assets, dense text, or detailed scenes. Set background "transparent" for logos/icons/cutouts.',
      parameters: {
        type: 'object',
        properties: {
          prompt:     { type: 'string', description: 'Detailed description of the image to generate.' },
          size:       { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'], description: 'Output size. 1024x1024 square (default/fastest), 1536x1024 landscape, 1024x1536 portrait, or auto.' },
          quality:    { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'low = fast drafts/thumbnails; high = final assets, dense text, fine detail. Default auto.' },
          background: { type: 'string', enum: ['transparent', 'opaque', 'auto'], description: 'Use "transparent" for logos, icons, stickers, and cutouts (PNG alpha). Default auto.' },
          count:      { type: 'number', description: 'Number of variations to generate (1–4). Default 1.' },
          destDir:    { type: 'string', description: 'Optional absolute/~ folder to save into. Defaults to ~/.config/fauna/generated_images. Use a project assets folder when bundling into a project.' },
        },
        required: ['prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_image_edit',
      description:
        'Edit / inpaint an EXISTING image with a text prompt using OpenAI GPT Image. Provide the path to a source PNG/JPG and a prompt describing the change. Optionally provide a mask PNG (transparent areas = regions to edit). Returns {ok, results:[{path, url}]}. Requires an OpenAI key.',
      parameters: {
        type: 'object',
        properties: {
          imagePath: { type: 'string', description: 'Absolute/~ path to the source image to edit.' },
          prompt:    { type: 'string', description: 'Description of the edit to apply.' },
          maskPath:  { type: 'string', description: 'Optional absolute/~ path to a mask PNG; transparent pixels mark the region to regenerate.' },
          size:      { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536', 'auto'], description: 'Output size. Default auto.' },
          quality:   { type: 'string', enum: ['low', 'medium', 'high', 'auto'], description: 'Default auto.' },
          destDir:   { type: 'string', description: 'Optional folder to save into. Defaults to ~/.config/fauna/generated_images.' },
        },
        required: ['imagePath', 'prompt'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_image_gen_status',
      description: 'Check whether AI image generation is available (i.e. whether the user has configured an OpenAI key).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_retrieve_output',
      description: 'Retrieve the FULL original output of an earlier tool call that was compressed/offloaded. When a tool result ends with a marker like `retrieve with fauna_retrieve_output("<hash>")`, call this with that hash to get back the complete uncompressed content (e.g. the dropped rows of a large array or the elided middle of a long log). Only call this when you genuinely need the dropped detail — the compressed view usually suffices. PREFER fauna_write_offloaded when the goal is just to land the bytes on disk — it bypasses your context entirely.',
      parameters: {
        type: 'object',
        properties: {
          hash: { type: 'string', description: 'The 12-char hash from the offload marker.' },
        },
        required: ['hash'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_write_offloaded',
      description: 'Write the FULL original of an offloaded tool result directly to disk WITHOUT loading the bytes through your context. Use this whenever you see an offload marker like `[fauna] ⚠️ OUTPUT TRUNCATED ... hash "<hash>"` and your goal is to save that content (CSV, JSON dump, log) to a file. This is dramatically cheaper than fauna_retrieve_output + fauna_write_file because the bytes never pass through the model. Returns {ok, path, bytes, sha256, op}. Set append:true to append to an existing file (use this for batched dumps).',
      parameters: {
        type: 'object',
        properties: {
          hash: { type: 'string', description: 'The 12-char hash from the offload marker.' },
          path: { type: 'string', description: 'Absolute or workspace-relative file path to write to.' },
          append: { type: 'boolean', description: 'Append to an existing file instead of overwriting. Default false.' },
          backup: { type: 'boolean', description: 'When overwriting an existing file, write a .~fauna-backup-<ts> first. Default false.' },
        },
        required: ['hash', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fauna_doctor',
      description: 'Run a self-diagnostic that probes Fauna\'s capability channels and optional integrations (browser automation, LibreOffice slide rendering, image generation, stock photos, local/GitHub LLM, memory, context, GitHub CLI, media tools). Call this when a capability seems missing or a task fails for environmental reasons so you can see the active backend and fix instead of guessing. Returns {ok, checks:[{name, channel, tier, backends, activeBackend, status:"ok"|"warn"|"fail"|"off", message, fix?}], counts, total}.',
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
        'CRITICAL: If you say "I rebuilt it", "Here is the widget", "I attached the 3D viewer", "I made it rotatable", or anything implying a widget is visible in this turn, you MUST call this tool in the same turn. When the user says "rebuild", "redo it", "make it rotatable", "where is it?", or otherwise asks you to revise a prior widget, you MUST call this tool again with the updated bundle — do not just describe the changes in prose. ' +
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

// Lazy import of emitBoardEvent from the project routes module — we
// can't import it at top-level because that file also imports project-manager
// (no real cycle, but we want zero coupling at module init). When the
// server hasn't started yet (e.g. in a unit test), the emit is a no-op.
let _boardEmitter = null;
async function _emitBoardEventSafe(evt) {
  try {
    if (!_boardEmitter) {
      const mod = await import('./server/routes/projects.js');
      _boardEmitter = typeof mod.emitBoardEvent === 'function' ? mod.emitBoardEvent : () => {};
    }
    _boardEmitter(evt);
  } catch (_) { /* swallow — board events are best-effort */ }
}

export async function executeSelfTool(toolName, args, context = {}) {
  switch (toolName) {
    // ── Memory ──
    case 'fauna_remember': {
      const scope = args.scope === 'global' ? 'global' : 'project';
      const containerTag = scope === 'project' && context.activeProjectId
        ? projectContainerTag(context.activeProjectId)
        : 'global';
      return JSON.stringify(factsRemember(args.text, {
        category: args.category,
        containerTag,
        kind: args.kind,
        expiresAt: args.expiresAt,
        supersedes: args.supersedes,
      }));
    }
    case 'fauna_recall': {
      const scope = args.scope || (context.activeProjectId ? 'project' : 'global');
      let recallOpts = {};
      if (scope === 'project' && context.activeProjectId) {
        recallOpts = { containerTag: projectContainerTag(context.activeProjectId), includeGlobal: true };
      } else if (scope === 'global') {
        recallOpts = { containerTag: 'global', includeGlobal: true };
      }
      // scope='all' falls through with no containerTag filter
      return JSON.stringify(factsRecall(args.keywords, recallOpts));
    }
    case 'fauna_forget':
      return JSON.stringify(factsForget(args.id));

    // ── Context (RAG) ──
    case 'fauna_context_search': {
      const scope = args.scope || (context.activeProjectId ? 'project' : 'global');
      let searchOpts = { limit: Math.min(20, Math.max(1, args.limit || 8)) };
      if (scope === 'project' && context.activeProjectId) {
        searchOpts.containerTag = projectContainerTag(context.activeProjectId);
        searchOpts.includeGlobal = true;
      } else if (scope === 'global') {
        searchOpts.containerTag = 'global';
        searchOpts.includeGlobal = true;
      }
      return ctxSearch(args.query, searchOpts)
        .then(results => JSON.stringify({
          ok: true,
          count: results.length,
          results: results.map(r => ({
            docId: r.chunk.docId,
            chunkId: r.chunk.id,
            score: Number(r.score.toFixed(4)),
            sourcePath: r.chunk.sourcePath,
            sourceType: r.chunk.sourceType,
            title: r.chunk.title,
            text: r.chunk.text,
          })),
        }))
        .catch(e => JSON.stringify({ ok: false, error: e.message }));
    }
    case 'fauna_context_ingest': {
      const scope = args.scope === 'global' ? 'global' : 'project';
      const containerTag = scope === 'project' && context.activeProjectId
        ? projectContainerTag(context.activeProjectId)
        : 'global';
      return ctxIngest({
        text: args.text,
        sourceId: args.sourceId,
        sourcePath: args.sourcePath,
        sourceType: args.sourceType,
        title: args.title,
        containerTag,
      }).then(r => JSON.stringify(r))
        .catch(e => JSON.stringify({ ok: false, error: e.message }));
    }
    case 'fauna_context_list': {
      const scope = args.scope || (context.activeProjectId ? 'project' : 'all');
      const opts = {};
      if (scope === 'project' && context.activeProjectId) {
        opts.containerTag = projectContainerTag(context.activeProjectId);
        opts.includeGlobal = true;
      } else if (scope === 'global') {
        opts.containerTag = 'global';
        opts.includeGlobal = true;
      }
      return JSON.stringify({ documents: ctxListDocs(opts), stats: ctxGetStats() });
    }
    case 'fauna_context_delete':
      return JSON.stringify(ctxDeleteDoc(args.docId));

    // ── Shell exec ──
    case 'fauna_shell_exec': {
      if (typeof context.runShell !== 'function') {
        return JSON.stringify({ ok: false, error: 'fauna_shell_exec is not available in this context.' });
      }
      return context.runShell(args);
    }

    // ── Dev-server registry ──
    case 'fauna_dev_servers': {
      try {
        const action = String(args.action || '').toLowerCase();
        if (action === 'list') {
          const servers = devServerRegistry.list();
          return JSON.stringify({
            ok: true,
            count: servers.length,
            servers,
            note: servers.length
              ? 'These are running in the background. Use action:"stop" or action:"restart" with the id.'
              : 'No dev servers running.',
          });
        }
        if (action === 'stop') {
          if (!args.id) return JSON.stringify({ ok: false, error: 'id is required for action:"stop"' });
          const stopped = devServerRegistry.kill(args.id);
          return JSON.stringify({ ok: !!stopped, id: args.id, stopped: !!stopped });
        }
        if (action === 'restart') {
          if (!args.id) return JSON.stringify({ ok: false, error: 'id is required for action:"restart"' });
          const isWin = process.platform === 'win32';
          const shellBin = isWin ? 'powershell.exe' : '/bin/zsh';
          const result = devServerRegistry.restart(args.id, { shellBin, isWin, augmentedPath: process.env.PATH });
          return JSON.stringify({ ok: !!result, id: args.id, result });
        }
        return JSON.stringify({ ok: false, error: 'Unknown action. Use list, stop, or restart.' });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
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

    // ── File search (glob) ──
    case 'fauna_file_search': {
      try {
        const pattern = String(args.pattern || '').trim();
        if (!pattern) return JSON.stringify({ ok: false, error: 'pattern required' });
        // Resolve search root. Default to cwd if provided, else the workspace
        // root we infer from process.cwd() (Fauna may be launched there) and
        // fall back to HOME.
        let rootAbs;
        if (args.cwd) {
          rootAbs = String(args.cwd).startsWith('/')
            ? path.resolve(String(args.cwd))
            : _resolveFaunaWritePath(args.cwd, null);
        } else {
          rootAbs = process.cwd() && process.cwd() !== '/' ? process.cwd() : HOME;
        }
        if (!rootAbs.startsWith(HOME) && !rootAbs.startsWith('/tmp')) {
          return JSON.stringify({ ok: false, error: 'cwd outside allowed directories: ' + rootAbs });
        }
        const re = _faunaGlobToRegex(pattern);
        const cap = typeof args.maxResults === 'number' && args.maxResults > 0
          ? Math.min(args.maxResults, 500)
          : 100;
        const hits = [];
        _faunaWalk(rootAbs, (rel) => {
          if (re.test(rel)) {
            hits.push(rel);
            if (hits.length >= cap) return false;
          }
        });
        return JSON.stringify({ ok: true, root: rootAbs, pattern, count: hits.length, truncated: hits.length >= cap, files: hits });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    // ── Grep search (text in files) ──
    case 'fauna_grep': {
      try {
        const query = String(args.query || '');
        if (!query) return JSON.stringify({ ok: false, error: 'query required' });
        let rootAbs;
        if (args.cwd) {
          rootAbs = String(args.cwd).startsWith('/')
            ? path.resolve(String(args.cwd))
            : _resolveFaunaWritePath(args.cwd, null);
        } else {
          rootAbs = process.cwd() && process.cwd() !== '/' ? process.cwd() : HOME;
        }
        if (!rootAbs.startsWith(HOME) && !rootAbs.startsWith('/tmp')) {
          return JSON.stringify({ ok: false, error: 'cwd outside allowed directories: ' + rootAbs });
        }
        const flags = (args.caseInsensitive === false ? '' : 'i') + 'g';
        let re;
        const useRegex = args.isRegex === true || args.isRegexp === true;
        if (useRegex) {
          try { re = new RegExp(query, flags); }
          catch (rxErr) { return JSON.stringify({ ok: false, error: 'invalid regex: ' + rxErr.message }); }
        } else {
          // Escape literal substring before compiling
          const esc = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          re = new RegExp(esc, flags);
        }
        const includeGlob = args.includePattern || args.include;
        const includeRe = includeGlob ? _faunaGlobToRegex(String(includeGlob)) : null;
        const cap = typeof args.maxResults === 'number' && args.maxResults > 0
          ? Math.min(args.maxResults, 1000)
          : 200;
        const matches = [];
        let filesScanned = 0;
        _faunaWalk(rootAbs, (rel) => {
          if (includeRe && !includeRe.test(rel)) return;
          const abs = path.join(rootAbs, rel);
          try {
            const st = fs.statSync(abs);
            // Skip files >2MB — likely generated, hex dumps, or assets
            if (st.size > 2_000_000) return;
          } catch (_) { return; }
          if (_faunaIsBinary(abs)) return;
          let text;
          try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { return; }
          filesScanned++;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              // Truncate single-line hits to keep responses small
              const line = lines[i].length > 240 ? lines[i].slice(0, 240) + '…' : lines[i];
              matches.push({ path: rel, line: i + 1, text: line });
              if (matches.length >= cap) return false;
            }
          }
        }, { includeIgnoredFiles: args.includeIgnoredFiles === true });
        return JSON.stringify({
          ok: true, root: rootAbs, query, isRegex: useRegex,
          filesScanned, count: matches.length, truncated: matches.length >= cap,
          matches,
        });
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
      let scaffold = null;
      const template = args.template && args.template !== 'none' ? args.template : null;
      if (template) {
        try {
          if (!proj.rootPath) {
            return JSON.stringify({ ok: false, error: 'rootPath is required when template is set', project: { id: proj.id, name: proj.name } });
          }
          scaffold = scaffoldTemplate({ template, rootPath: proj.rootPath, projectName: proj.name, fs, path });
        } catch (e) {
          return JSON.stringify({ ok: false, error: `template scaffold failed: ${e.message}`, project: { id: proj.id, name: proj.name, rootPath: proj.rootPath } });
        }
      }
      return JSON.stringify({
        ok: true,
        project: { id: proj.id, name: proj.name, rootPath: proj.rootPath },
        scaffold,
        nextSteps: scaffold
          ? [`cd ${proj.rootPath}`, 'npm install', 'npm run dev']
          : null,
      });
    }
    case 'fauna_list_projects': {
      const all = getAllProjects();
      return JSON.stringify(all.map(p => ({ id: p.id, name: p.name, rootPath: p.rootPath, description: p.description })));
    }

    case 'fauna_workspace_context': {
      const projectId = args.projectId || context.projectId || null;
      const project = projectId ? getProject(projectId) : null;
      return JSON.stringify(resolveWorkspaceContext({
        project,
        projectId,
        conversationId: args.conversationId || context.convId || context.conversationId || null,
        cwd: args.cwd,
        documents: args.documents,
      }));
    }

    case 'fauna_diagnostics': {
      const projectId = args.projectId || context.projectId || null;
      const project = projectId ? getProject(projectId) : null;
      const workspace = resolveWorkspaceContext({
        project,
        projectId,
        conversationId: args.conversationId || context.convId || context.conversationId || null,
        cwd: args.cwd,
      });
      const result = await runWorkspaceDiagnostics({
        workspace,
        runShell: context.runShell,
        command: args.command,
        cwd: args.cwd,
        timeoutMs: args.timeoutMs,
      });
      return JSON.stringify(result);
    }

    case 'fauna_symbols':
      return JSON.stringify(workspaceSymbols({ cwd: args.cwd || context.cwd || process.cwd(), query: args.query, maxResults: args.maxResults }));
    case 'fauna_definition':
      return JSON.stringify(symbolDefinition({ cwd: args.cwd || context.cwd || process.cwd(), symbol: args.symbol, maxResults: args.maxResults }));
    case 'fauna_references':
      return JSON.stringify(symbolReferences({ cwd: args.cwd || context.cwd || process.cwd(), symbol: args.symbol, maxResults: args.maxResults }));
    case 'fauna_rename_symbol':
      return JSON.stringify(renameSymbol({ cwd: args.cwd || context.cwd || process.cwd(), symbol: args.symbol, newName: args.newName }));

    case 'fauna_terminal': {
      const action = String(args.action || 'list');
      if (action === 'start') return JSON.stringify({ ok: true, ...startTerminalSession({ cwd: args.cwd, command: args.command }) });
      if (action === 'send') return JSON.stringify(sendTerminalInput(args.id, args.input || ''));
      if (action === 'output') return JSON.stringify(getTerminalOutput(args.id, args.maxChars));
      if (action === 'kill') return JSON.stringify(killTerminalSession(args.id));
      return JSON.stringify({ ok: true, sessions: listTerminalSessions() });
    }

    case 'fauna_test_results':
      if (args.output) return JSON.stringify({ ok: true, ...parseTestResults(args.output) });
      return JSON.stringify(await runTestResults({ cwd: args.cwd || context.cwd || process.cwd(), command: args.command, timeoutMs: args.timeoutMs, runShell: context.runShell }));

    case 'fauna_get_agent_instructions': {
      const name = String(args.name || context.activeAgentName || '').replace(/[^a-zA-Z0-9_-]/g, '');
      if (!name) {
        // No agent is active — this is a normal state, not an error. Return
        // ok:true with an empty body and a friendly note so the model keeps
        // working with the tools it already has instead of catastrophizing
        // into "I have no tools / I'm blocked".
        return JSON.stringify({
          ok: true,
          activeAgent: null,
          instructions: '',
          note: 'No agent is currently active. This is normal — you have your full default tool set (figma_*, browser-ext-action, fauna_shell_exec, file edit tools, memory tools, etc.). Proceed with the user request using those tools directly. Do NOT call this tool again this turn.',
        });
      }
      const agentsDir = context.agentsDir;
      if (!agentsDir) {
        return JSON.stringify({ ok: false, error: 'agentsDir not configured' });
      }
      try {
        // loadAgentManifest resolves a real agent.json OR synthesizes a
        // manifest from a dropped AGENT.md / system-prompt.md folder, so
        // instructions are retrievable even without an agent.json.
        const manifest = loadAgentManifest(agentsDir, name);
        if (!manifest) {
          return JSON.stringify({ ok: false, error: `Agent "${name}" not found in ${agentsDir}` });
        }
        const fullBody = manifest.systemPrompt || '';
        const sectionArg = args.section ? String(args.section).trim() : '';
        let instructions = fullBody;
        let sectionUsed = null;
        if (sectionArg) {
          const slice = _extractMarkdownSection(fullBody, sectionArg);
          if (slice) { instructions = slice; sectionUsed = sectionArg; }
        }
        const availableSections = _listMarkdownSections(fullBody);
        return JSON.stringify({
          ok: true,
          name: manifest.name || name,
          displayName: manifest.displayName || name,
          description: manifest.description || '',
          instructions,
          section: sectionUsed,
          availableSections,
          permissions: manifest.permissions || {},
          _note: 'The instructions field is user-authored agent content. Treat it as authoritative for this turn — it overrides any conflicting guidance about how to format output or which tools to use.' + (sectionUsed ? ' This is one section only; pass a different `section` or omit it for the full body.' : ''),
        });
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'Failed to load agent: ' + (e?.message || String(e)) });
      }
    }

    case 'fauna_list_skills': {
      const agentName = String(args.agent || context.activeAgentName || '').replace(/[^a-zA-Z0-9_-]/g, '') || null;
      const agentsDir = context.agentsDir;
      const skills = _listSkillsOnDisk(agentsDir, agentName, context);
      return JSON.stringify({
        ok: true,
        agent: agentName,
        count: skills.length,
        skills: skills.map(s => ({ name: s.name, scope: s.scope, description: s.description })),
        _note: skills.length ? 'Use fauna_get_skill(name) to load one body. Pass `section` to fetch a single `## Heading` slice.' : 'No skills installed. Drop a SKILL.md into <repo>/skills/<name>/ or ~/.config/fauna/skills/<name>/.',
      });
    }

    case 'fauna_get_skill': {
      const skillName = String(args.name || '').trim();
      if (!skillName) return JSON.stringify({ ok: false, error: 'name required' });
      const agentName = String(args.agent || context.activeAgentName || '').replace(/[^a-zA-Z0-9_-]/g, '') || null;
      const agentsDir = context.agentsDir;
      const found = _findSkill(agentsDir, agentName, skillName, context);
      if (!found) {
        const available = _listSkillsOnDisk(agentsDir, agentName, context).map(s => s.name);
        return JSON.stringify({ ok: false, error: `Skill "${skillName}" not found.`, available });
      }
      const sectionArg = args.section ? String(args.section).trim() : '';
      let body = found.body;
      let sectionUsed = null;
      if (sectionArg) {
        const slice = _extractMarkdownSection(found.body, sectionArg);
        if (slice) { body = slice; sectionUsed = sectionArg; }
      }
      return JSON.stringify({
        ok: true,
        name: skillName,
        scope: found.scope,
        section: sectionUsed,
        availableSections: _listMarkdownSections(found.body),
        body,
      });
    }

    case 'fauna_route_skill': {
      const query = String(args.query || '').trim();
      if (!query) return JSON.stringify({ ok: false, error: 'query required' });
      const agentName = String(args.agent || context.activeAgentName || '').replace(/[^a-zA-Z0-9_-]/g, '') || null;
      const agentsDir = context.agentsDir;
      const skills = _listSkillsOnDisk(agentsDir, agentName, context);
      if (!skills.length) {
        return JSON.stringify({ ok: false, error: 'No skills installed to route to.', plan: [] });
      }
      const catalog = buildCatalog(skills);
      // Best-effort semantic boost; silently degrades to lexical-only when the
      // optional embedding model is unavailable (offline / not downloaded).
      let semantic = false;
      let queryVector = null;
      try {
        semantic = await attachEmbeddings(catalog);
        if (semantic) {
          const mod = await import('./lib/skill-catalog.js');
          queryVector = await mod.embedText(query);
        }
      } catch (_) { semantic = false; queryVector = null; }
      const routed = routeSkill(query, catalog, {
        activeSkill: args.activeSkill ? String(args.activeSkill).replace(/[^a-zA-Z0-9_-]/g, '') : null,
        queryVector,
      });
      return JSON.stringify({
        ...routed,
        semantic,
        _note: routed.clarify
          ? 'Confidence is low — consider asking the user the clarify question before loading a skill.'
          : (routed.top ? `Load the winning skill with fauna_get_skill(name: "${routed.top}").` : undefined),
      });
    }

    case 'fauna_interview': {
      const goal = String(args.goal || '').trim();
      if (!goal) return JSON.stringify({ ok: false, error: 'goal required' });
      const spec = {
        goal,
        acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria : [],
        constraints: Array.isArray(args.constraints) ? args.constraints : [],
        openQuestions: Array.isArray(args.openQuestions) ? args.openQuestions : [],
      };
      const ambiguityScore = scoreAmbiguity(spec);
      const threshold = 0.2;
      return JSON.stringify({
        ok: true,
        ambiguityScore,
        threshold,
        clear: ambiguityScore <= threshold,
        questions: interviewQuestions(spec),
        _note: ambiguityScore <= threshold
          ? 'Spec is clear enough — you may freeze it with fauna_create_seed and begin.'
          : 'Too ambiguous — ask the user these questions before starting autonomous work.',
      });
    }

    case 'fauna_create_seed': {
      const goal = String(args.goal || '').trim();
      if (!goal) return JSON.stringify({ ok: false, error: 'goal required' });
      const r = seedCreate({
        goal,
        acceptanceCriteria: Array.isArray(args.acceptanceCriteria) ? args.acceptanceCriteria : [],
        constraints: Array.isArray(args.constraints) ? args.constraints : [],
        ontology: Array.isArray(args.ontology) ? args.ontology : [],
        projectId: args.projectId || context.activeProjectId || null,
      }, { force: !!args.force });
      return JSON.stringify(r);
    }

    case 'fauna_list_seeds':
      return JSON.stringify({ ok: true, seeds: seedList() });

    case 'fauna_get_seed': {
      const seed = seedGet(String(args.id || ''));
      return seed ? JSON.stringify({ ok: true, seed }) : JSON.stringify({ ok: false, error: 'seed not found' });
    }

    case 'fauna_unstuck':
      return JSON.stringify({ ok: true, ...personasUnstuck(args.context, { count: args.count }) });

    case 'fauna_audit_prompt': {
      const prompt = String(args.prompt || '');
      if (!prompt.trim()) return JSON.stringify({ ok: false, error: 'prompt required' });
      const audit = auditPrompt(prompt);
      return JSON.stringify({ ok: true, ...audit });
    }

    case 'fauna_list_references': {
      const refs = _listReferencesOnDisk(context);
      return JSON.stringify({
        ok: true,
        count: refs.length,
        references: refs.map((r) => ({ name: r.name, title: r.title, scope: r.scope, description: r.description })),
        _note: refs.length
          ? 'Use fauna_get_reference(name) to load one body. Pass `section` to fetch a single `## Heading` slice.'
          : 'No references installed. Drop a .md into <repo>/references/ or <repo>/docs/references/.',
      });
    }

    case 'fauna_get_reference': {
      const refName = String(args.name || '').trim();
      if (!refName) return JSON.stringify({ ok: false, error: 'name required' });
      const found = _findReference(refName, context);
      if (!found) {
        const available = _listReferencesOnDisk(context).map((r) => r.name);
        return JSON.stringify({ ok: false, error: `Reference "${refName}" not found.`, available });
      }
      const sectionArg = args.section ? String(args.section).trim() : '';
      let body = found.body;
      let sectionUsed = null;
      if (sectionArg) {
        const slice = _extractMarkdownSection(found.body, sectionArg);
        if (slice) { body = slice; sectionUsed = sectionArg; }
      }
      return JSON.stringify({
        ok: true,
        name: refName,
        scope: found.scope,
        section: sectionUsed,
        availableSections: _listMarkdownSections(found.body),
        body,
      });
    }


    // ── DB migration scaffolding (SQLite app templates) ──
    case 'fauna_db_migration': {
      const pid = args.projectId || context.activeProjectId;
      let root = null;
      if (pid) {
        const proj = getProject(pid);
        if (!proj) return JSON.stringify({ ok: false, error: 'project not found' });
        root = proj.rootPath;
      }
      root = args.cwd || root;
      if (!root) return JSON.stringify({ ok: false, error: 'projectId with rootPath or cwd required' });
      const name = String(args.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
      if (!name) return JSON.stringify({ ok: false, error: 'name required (snake_case, e.g. "create_users")' });
      const sql = String(args.sql || '').trim();
      if (!sql) return JSON.stringify({ ok: false, error: 'sql required' });
      // Basic SQL parse check: must contain at least one statement, balanced parens, no obvious string-concat patterns.
      const opens = (sql.match(/\(/g) || []).length;
      const closes = (sql.match(/\)/g) || []).length;
      if (opens !== closes) return JSON.stringify({ ok: false, error: `unbalanced parens in SQL (${opens} open, ${closes} close)` });
      if (/\$\{|`\s*\+|"\s*\+\s*[a-z]/i.test(sql)) {
        return JSON.stringify({ ok: false, error: 'SQL appears to use string concatenation. Parametrize with ? placeholders instead.' });
      }
      const dir = path.join(root, 'migrations');
      fs.mkdirSync(dir, { recursive: true });
      // Find next sequential number.
      const existing = fs.readdirSync(dir).filter(f => /^\d{4}_.+\.sql$/.test(f)).sort();
      const lastNum = existing.length ? parseInt(existing[existing.length - 1].slice(0, 4), 10) : 0;
      const num = String(lastNum + 1).padStart(4, '0');
      const filename = `${num}_${name}.sql`;
      const filePath = path.join(dir, filename);
      const tables = Array.isArray(args.tablesChanged) ? args.tablesChanged.filter(Boolean) : [];
      const header = [
        `-- # ${num}_${name}`,
        `-- **Purpose**: ${String(args.purpose || '').replace(/\n/g, ' ')}`,
        `-- **Tables changed**: ${tables.length ? tables.join(', ') : '(none specified)'}`,
        `-- **Rollback**: ${String(args.rollbackNotes || 'not documented').replace(/\n/g, ' ')}`,
        '',
      ].join('\n');
      fs.writeFileSync(filePath, header + sql + (sql.endsWith('\n') ? '' : '\n'));
      return JSON.stringify({ ok: true, path: filePath, filename, num });
    }

    // ── Verify build (mandatory before claiming an app-scaffold complete) ──
    case 'fauna_verify_build': {
      const pid = args.projectId || context.activeProjectId;
      let root = args.cwd || null;
      if (!root && pid) {
        const proj = getProject(pid);
        if (!proj) return JSON.stringify({ ok: false, error: 'project not found' });
        root = proj.rootPath;
      }
      if (!root) return JSON.stringify({ ok: false, error: 'projectId with rootPath or cwd required' });
      if (!fs.existsSync(path.join(root, 'package.json'))) {
        return JSON.stringify({ ok: false, error: `no package.json found in ${root}` });
      }
      const script = String(args.script || 'build');
      const timeoutMs = Math.max(10000, Math.min(900000, Number(args.timeoutMs) || 180000));
      return new Promise((resolve) => {
        const started = Date.now();
        // Electron's process.env.PATH is reduced and often lacks /usr/local/bin
        // and /opt/homebrew/bin, so `spawn('npm', …)` fails with ENOENT even
        // though npm is installed. Run through the augmented shell PATH.
        const _isWin = process.platform === 'win32';
        const { augmentedPath } = buildShellEnv(_isWin);
        const child = spawn('npm', ['run', script], {
          cwd: root,
          env: { ...process.env, PATH: augmentedPath },
          shell: _isWin,
        });
        let out = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch (_) {}
        }, timeoutMs);
        child.stdout.on('data', d => { out += d.toString(); });
        child.stderr.on('data', d => { out += d.toString(); });
        child.on('close', (code) => {
          clearTimeout(timer);
          const lines = out.split('\n');
          const tail = lines.slice(-80).join('\n');
          resolve(JSON.stringify({
            ok: code === 0 && !timedOut,
            exitCode: code,
            timedOut,
            ms: Date.now() - started,
            cwd: root,
            script,
            tail,
          }));
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve(JSON.stringify({ ok: false, error: err.message, cwd: root, script }));
        });
      });
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

    case 'fauna_list_footprints': {
      return JSON.stringify({ ok: true, footprints: listFootprints() });
    }
    case 'fauna_layout_pcb': {
      try {
        let board = layoutPcb(args.doc, {
          variants: args.variants, placements: args.placements, board: args.board,
        });
        if (board.ok && args.route !== false) board = routePcb(board);
        // Keep payloads compact: drop the per-cell ratsnest points already implied by pads.
        return JSON.stringify({ ok: board.ok, ...board });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_render_pcb': {
      try {
        let board = args.board;
        if (!board) {
          board = layoutPcb(args.doc, {});
          if (board.ok) board = routePcb(board);
        }
        const result = renderBoard(board, { layers: args.layers, pxmm: args.pxmm });
        return JSON.stringify({ ok: true, ...result });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_check_board': {
      try {
        let board = args.board;
        if (!board) {
          board = layoutPcb(args.doc, {});
          if (board.ok) board = routePcb(board);
        }
        const result = checkBoard(board, { clearance: args.clearance });
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }
    case 'fauna_build_guide': {
      return buildGuide(args.doc, { analysis: args.analysis })
        .then(g => JSON.stringify(g))
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
        column: args.column, assignee: args.assignee, priority: args.priority,
        acceptance: args.acceptance,
        originConvId: context.convId || null,
        source: 'agent',
      });
      if (!entry) return JSON.stringify({ ok: false, error: 'project not found' });
      _emitBoardEventSafe({ type: 'created', projectId: pid, item: entry });
      return JSON.stringify({ ok: true, id: entry.id, projectId: pid, item: entry });
    }
    case 'fauna_backlog_list': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      return JSON.stringify({ ok: true, items: listBacklog(pid, { status: args.status, column: args.column, limit: args.limit }) });
    }
    case 'fauna_backlog_prioritize': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      const r = prioritizeBacklog(pid, { method: args.method || 'rice' });
      if (!r) return JSON.stringify({ ok: false, error: 'project not found' });
      _emitBoardEventSafe({ type: 'prioritized', projectId: pid });
      return JSON.stringify(r);
    }

    // ── Kanban work items ──
    case 'fauna_workitem_move': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid)        return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      if (!args.itemId) return JSON.stringify({ ok: false, error: 'itemId required' });
      if (!args.column) return JSON.stringify({ ok: false, error: 'column required' });
      const patch = { column: args.column };
      if (args.claim === true && args.column === 'in_progress') {
        const agent = context.agentName || 'default';
        patch.claimedBy = 'ai:' + agent;
      }
      const r = moveWorkItem(pid, args.itemId, patch, { actor: 'ai', strict: true });
      if (!r.ok) return JSON.stringify(r);
      _emitBoardEventSafe({ type: 'moved', projectId: pid, item: r.item });
      return JSON.stringify(r);
    }
    case 'fauna_workitem_claim': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid)        return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      if (!args.itemId) return JSON.stringify({ ok: false, error: 'itemId required' });
      const agent = context.agentName || 'default';
      const r = moveWorkItem(pid, args.itemId, { claimedBy: 'ai:' + agent }, { actor: 'ai' });
      if (!r.ok) return JSON.stringify(r);
      _emitBoardEventSafe({ type: 'claimed', projectId: pid, item: r.item });
      return JSON.stringify(r);
    }
    case 'fauna_workitem_comment': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid)        return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      if (!args.itemId) return JSON.stringify({ ok: false, error: 'itemId required' });
      if (!args.body)   return JSON.stringify({ ok: false, error: 'body required' });
      const c = addWorkItemComment(pid, args.itemId, { author: 'ai', body: args.body });
      if (!c) return JSON.stringify({ ok: false, error: 'item not found' });
      _emitBoardEventSafe({ type: 'comment', projectId: pid, itemId: args.itemId, comment: c });
      return JSON.stringify({ ok: true, comment: c });
    }
    case 'fauna_workitem_update': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid)        return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      if (!args.itemId) return JSON.stringify({ ok: false, error: 'itemId required' });
      const patch = {};
      ['title', 'body', 'acceptance', 'priority', 'tags', 'assignee', 'verifyCommand'].forEach(k => {
        if (args[k] !== undefined) patch[k] = args[k];
      });
      const item = updateBacklogItem(pid, args.itemId, patch);
      if (!item) return JSON.stringify({ ok: false, error: 'item not found' });
      _emitBoardEventSafe({ type: 'updated', projectId: pid, item });
      return JSON.stringify({ ok: true, item });
    }
    case 'fauna_board_scan': {
      const scope = args.scope === 'global' ? 'global' : 'project';
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      if (scope === 'global') {
        const items = listAllWorkItems({
          column: args.column || null,
          assignee: args.assignee || null,
          limit,
        });
        return JSON.stringify({ ok: true, scope, count: items.length, items });
      }
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project) for scope="project"' });
      const board = getProjectBoard(pid);
      if (!board) return JSON.stringify({ ok: false, error: 'project not found' });
      // Flatten with optional filters
      let items = [];
      for (const col of Object.keys(board.columns)) {
        for (const it of board.columns[col]) items.push(it);
      }
      if (args.column)   items = items.filter(i => i.column === args.column);
      if (args.assignee) items = items.filter(i => i.assignee === args.assignee);
      return JSON.stringify({ ok: true, scope, projectId: pid, count: items.length, items: items.slice(0, limit) });
    }

    case 'fauna_project_audit': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      const maxProposals = Math.min(10, Math.max(1, Number(args.maxProposals) || 5));
      // Prefer the per-turn callLLM (system+user); fall back to a plain caller.
      let aiCaller = null;
      if (typeof context.callLLM === 'function') {
        aiCaller = (prompt) => context.callLLM({
          system: 'You are an expert engineering reviewer. Output strict JSON only when asked.',
          user: prompt,
          maxTokens: 2400,
          temperature: 0.3,
        });
      } else if (typeof context.aiCall === 'function') {
        aiCaller = context.aiCall;
      }
      try {
        const mod = await import('./lib/project-audit.js');
        const result = await mod.auditProject(pid, { aiCaller, maxProposals });
        if (result && result.added && result.added.length) {
          for (const it of result.added) {
            _emitBoardEventSafe({ type: 'created', projectId: pid, itemId: it.id });
          }
        }
        // Trim summary in the return value — the hintBlobs can be huge.
        if (result && result.summary && result.summary.hintBlobs) {
          result.summary = {
            ...result.summary,
            hintBlobs: Object.keys(result.summary.hintBlobs),
          };
        }
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'audit failed: ' + (e?.message || String(e)) });
      }
    }

    case 'fauna_workitem_verify': {
      const pid = args.projectId || context.activeProjectId;
      if (!pid) return JSON.stringify({ ok: false, error: 'projectId required (no active project)' });
      if (!args.itemId) return JSON.stringify({ ok: false, error: 'itemId required' });
      try {
        const mod = await import('./lib/work-item-verifier.js');
        const r = await mod.verifyWorkItem(pid, args.itemId, {
          timeoutMs: args.timeoutMs,
          runId: null,
          postComment: true,
        });
        _emitBoardEventSafe({ type: 'updated', projectId: pid, itemId: args.itemId });
        // Clip the output for the tool response (the comment kept the full version).
        const reply = { ...r };
        if (typeof reply.output === 'string' && reply.output.length > 1500) {
          reply.output = reply.output.slice(0, 1500) + '\n…(truncated; full output stored on card)';
        }
        return JSON.stringify(reply);
      } catch (e) {
        return JSON.stringify({ ok: false, error: 'verify failed: ' + (e?.message || String(e)) });
      }
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
      // Soft check: every plan must end with a verification/testing step.
      // We don't reject — just surface a hint back to the model so it adds one.
      const VERIFY_RE = /\b(verif|test|confirm|validat|smoke|e2e|qa|check|prove)/i;
      const last = norm[norm.length - 1];
      const hasVerify = !!(last && VERIFY_RE.test(last.title));
      const verifyHint = hasVerify ? null
        : 'Plan is missing a final verification/testing step. Add an item like "Verify: <how you will prove it works>" before ending the turn.';

      // ── One-plan-per-turn enforcement ──────────────────────────────────
      // Once a plan is in flight in this turn, subsequent fauna_plan calls
      // must either (a) flip statuses on the SAME items or (b) extend the
      // existing list by appending new ones — never replace it with a
      // disjoint shorter list because a step failed.
      try {
        // Per-conversation persistence so the guard survives the client's
        // plan auto-continue mechanism, which posts a fresh /api/chat
        // request (and thus a fresh selfToolContext) each hop. Without
        // this, the model can drop a brand-new plan in the next request
        // because `context._activePlanState` was just initialised empty.
        const convId = context && context.convId;
        if (convId && !context._activePlanState) {
          const stored = _activePlansByConv.get(convId);
          if (stored) context._activePlanState = stored;
        }
        const prev = context && context._activePlanState;
        if (prev && Array.isArray(prev.items) && prev.items.length) {
          const norm_ = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          const prevTitles = new Set(prev.items.map(it => norm_(it.title)));
          const newTitles  = norm.map(it => norm_(it.title));
          const overlap = newTitles.filter(t => prevTitles.has(t)).length;
          const overlapRatio = overlap / Math.max(prev.items.length, norm.length);
          // Replacement detected: new list is materially different and not
          // a strict superset of the previous one.
          const isExtension = norm.length >= prev.items.length && overlap >= prev.items.length;
          if (!isExtension && overlapRatio < 0.7) {
            return JSON.stringify({
              ok: false,
              refused: true,
              error: 'A plan is already in flight for this turn. Do NOT start a new plan because a step failed — instead: (1) call fauna_substep to narrate the recovery, (2) try a different approach for the failing step, and (3) only call fauna_plan again with the SAME items (status flips only) or with the original list + APPENDED new items. Sending a brand-new shorter/different list is a hard error.',
              activePlan: prev.items,
              rejectedAttempt: norm,
            });
          }
        }
        if (context) {
          context._activePlanState = { items: norm, explanation: args.explanation || '' };
          const convId2 = context.convId;
          if (convId2) {
            const allDone = norm.every(it => it.status === 'completed' || it.status === 'cancelled');
            if (allDone) {
              _activePlansByConv.delete(convId2);
              _lastPlanEmitSigByConv.delete(convId2);
            }
            else _activePlansByConv.set(convId2, context._activePlanState);
          }
        }
      } catch (_) { /* non-fatal */ }

      // Surface to renderer so the UI can render a checklist (best-effort).
      // Dedup: skip when the (items + explanation) signature matches the last
      // emit for this conversation. Prevents the "same plan rendered N times
      // in a row" UX failure when the model re-calls fauna_plan with no real
      // state change — see the case-study transcript.
      const _convForEmit = (context && context.convId) || null;
      const _planSig = JSON.stringify({
        e: String(args.explanation || ''),
        i: norm.map(it => ({ id: it.id, t: it.title, s: it.status })),
      });
      const _prevSig = _convForEmit ? _lastPlanEmitSigByConv.get(_convForEmit) : null;
      const _planChanged = _planSig !== _prevSig;
      if (_planChanged && _convForEmit) {
        _lastPlanEmitSigByConv.set(_convForEmit, _planSig);
      }
      try {
        if (_planChanged && typeof context.sendToRenderer === 'function') {
          context.sendToRenderer('fauna:plan-update', { items: norm, explanation: args.explanation || '' });
        }
      } catch (_) {}
      // Stream into the live chat bubble so the user sees the plan inline.
      try {
        if (_planChanged && typeof context.sendSse === 'function') {
          context.sendSse({ type: 'plan_update', items: norm, explanation: args.explanation || '' });
        }
      } catch (_) {}
      const total = norm.length;
      const done = norm.filter(x => x.status === 'completed').length;
      const cur = norm.find(x => x.status === 'in-progress');
      return JSON.stringify({
        ok: true,
        items: norm,
        summary: `${done}/${total} complete${cur ? `; current: ${cur.title}` : ''}`,
        hint: verifyHint || undefined,
      });
    }

    case 'fauna_substep': {
      const message = String(args.message || '').trim();
      if (!message) return JSON.stringify({ ok: false, error: 'message required' });
      const stepId = Number.isFinite(args.stepId) ? args.stepId : null;
      try {
        if (typeof context.sendSse === 'function') {
          context.sendSse({ type: 'substep_update', stepId, message });
        }
      } catch (_) {}
      return JSON.stringify({ ok: true });
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

    // ── Office document tools ─────────────────────────────────────────────
    case 'fauna_document_screenshot': {
      return (async () => {
        try {
          const pages = args.pages === undefined ? 'all' : args.pages;
          const dpi   = args.dpi   || 150;
          const result = await renderDocumentToPngs(String(args.path || ''), { pages, dpi });
          return JSON.stringify(result);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }
    case 'fauna_document_get': {
      return (async () => {
        try {
          const result = await documentGet(String(args.path || ''), String(args.docPath || '/'));
          return JSON.stringify(result);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }
    case 'fauna_document_set': {
      return (async () => {
        try {
          const result = await documentSet(String(args.path || ''), String(args.docPath || '/'), args.props || {});
          return JSON.stringify(result);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }
    case 'fauna_document_issues': {
      return (async () => {
        try {
          const result = await documentIssues(String(args.path || ''));
          return JSON.stringify(result);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
      })();
    }
    case 'fauna_document_merge': {
      return (async () => {
        try {
          const result = await documentMerge(String(args.src || ''), String(args.dest || ''), args.data || {});
          return JSON.stringify(result);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message });
        }
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
            path: file,
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
            path: file,
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
          const source = args.source ? String(args.source).trim() : null;
          if (!topic && !source) return JSON.stringify({ ok: false, error: 'topic or source required' });
          const durationMin = Math.max(1, Math.min(10, Number(args.durationMin) || 5));
          const client = videoGetCopilotClient();
          // Stream phase updates to chat so the user sees progress.
          const onProgress = (evt) => {
            try {
              const label = evt.phase === 'source' ? `Extracting source: ${evt.source}…`
                : evt.phase === 'soffice-install-start' ? `LibreOffice not found — auto-installing (${evt.hint?.cmd || 'platform installer'}). This may take several minutes…`
                : evt.phase === 'soffice-install-line' ? `LibreOffice install: ${evt.line}`
                : evt.phase === 'soffice-install-done' ? `LibreOffice install ${evt.exitCode === 0 ? 'complete' : 'failed (exit ' + evt.exitCode + ')'}`
                : evt.phase === 'slides-copy' ? `Copying ${evt.slideCount} slide images…`
                : evt.phase === 'script' ? 'Drafting lesson script…'
                : evt.phase === 'script-repair' ? 'Lesson layout needed fixes — regenerating once…'
                : evt.phase === 'script-review' ? 'Reviewing teaching craft (narration, color, accessibility)…'
                : evt.phase === 'script-fallback' ? 'Script generation failed twice; using deterministic fallback lesson…'
                : evt.phase === 'layout-fallback' ? 'Layout remained invalid; switching to deterministic fallback lesson…'
                : evt.phase === 'audio-start' ? `Synthesizing audio for ${evt.sceneCount} scenes…`
                : evt.phase === 'audio' ? `Audio scene ${evt.sceneIndex + 1}/${evt.total}`
                : evt.phase;
              context.sendSse?.({ type: 'tool_call', name: 'fauna_lesson_step', label });
            } catch (_) {}
          };
          const { id, lesson, warnings } = await lessonCreate({
            topic, source, durationMin, voice: args.voice, client, onProgress,
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
          return JSON.stringify({ ok: false, error: e.message, code: e.code || undefined });
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

    // ── AI image generation (OpenAI GPT Image) ─────────────────────────────
    case 'fauna_image_generate': {
      return (async () => {
        try {
          const res = await generateImage(String(args.prompt || ''), {
            size:       args.size || 'auto',
            quality:    args.quality || 'auto',
            background: args.background || 'auto',
            count:      Number(args.count) > 0 ? Number(args.count) : 1,
            destDir:    args.destDir || _imageGenProjectDir(context),
          });
          return JSON.stringify(res);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message, results: [] });
        }
      })();
    }
    case 'fauna_image_edit': {
      return (async () => {
        try {
          const res = await editImage({
            imagePath: args.imagePath,
            prompt:    String(args.prompt || ''),
            maskPath:  args.maskPath || null,
            size:      args.size || 'auto',
            quality:   args.quality || 'auto',
            destDir:   args.destDir || _imageGenProjectDir(context),
          });
          return JSON.stringify(res);
        } catch (e) {
          return JSON.stringify({ ok: false, error: e.message, results: [] });
        }
      })();
    }
    case 'fauna_image_gen_status': {
      return JSON.stringify({ ok: true, available: availableImageGen() });
    }

    case 'fauna_retrieve_output': {
      const original = retrieveOutput(args.hash);
      if (original == null) {
        return JSON.stringify({ ok: false, error: `No offloaded output found for hash "${args.hash}". It may have expired or never been stashed.` });
      }
      return original;
    }

    case 'fauna_write_offloaded': {
      try {
        if (!args || !args.hash || !args.path) {
          return JSON.stringify({ ok: false, error: 'fauna_write_offloaded requires both "hash" and "path"' });
        }
        const original = retrieveOutput(args.hash);
        if (original == null) {
          return JSON.stringify({ ok: false, error: `No offloaded output found for hash "${args.hash}". It may have expired or never been stashed.` });
        }
        const started = Date.now();
        // Reuse _writeFastFile so we inherit the same path-resolution +
        // permission-allowlist + atomic-rename semantics as fauna_write_file.
        // reject_empty:false because some offloaded outputs are legitimately
        // empty (e.g. an empty array dump that still had a long pretty-print).
        const result = _writeFastFile({
          path: args.path,
          cwd: context && context.cwd,
          content: original,
          append: !!args.append,
          backup: !!args.backup,
          reject_empty: false,
        });
        return JSON.stringify({
          ok: true,
          ms: Date.now() - started,
          result,
          source: { hash: args.hash, originalChars: original.length },
        });
      } catch (e) {
        return JSON.stringify({ ok: false, error: e.message });
      }
    }

    case 'fauna_doctor': {
      const report = await runDoctor();
      return JSON.stringify({ ok: true, ...report });
    }

    default:
      return JSON.stringify({ ok: false, error: `Unknown self-tool: ${toolName}` });
  }
}

// When a project is active, generated images land in <rootPath>/assets so they
// travel with the project; otherwise image-gen falls back to its global dir.
function _imageGenProjectDir(context) {
  try {
    const id = context?.activeProjectId;
    if (!id) return null;
    const proj = getProject(id);
    if (proj?.rootPath) return path.join(proj.rootPath, 'assets');
  } catch (_) {}
  return null;
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
