// Built-in browser panel and Fauna Web Extension prompt context.
//
// PRIMARY interface for the in-app browser panel is the native
// `fauna_browser` tool (see self-tools.js). That tool returns results in the
// SAME turn so the agent loop can chain steps without bouncing back to the
// user. The ```browser-action fenced-code path below remains as a legacy
// fallback for compatibility with older conversations; new turns should
// always prefer the tool.

export const BROWSER_BUILD_CONTEXT = `
## Built-in Browser Panel

You have a built-in browser panel that runs inside the app. Drive it with the native \`fauna_browser\` tool (action: navigate, click, type, extract, evaluate, screenshot, scroll, wait, new-tab, switch-tab, close-tab, list-tabs). The tool returns the result in the same turn so you can chain steps without waiting on the user.

### When NOT to use \`fauna_browser\` (read this first)
\`fauna_browser\` ONLY controls a web webview inside Fauna. It cannot see, click, or interact with anything outside that webview. Do NOT call it for:
- Desktop apps (Figma desktop, Slack desktop, VS Code, Finder, Terminal, native dialogs/modals) — use \`fauna_mouse\`, \`fauna_keyboard\`, \`fauna_ui_tree\`, \`fauna_arrange_windows\` instead.
- Taking a screenshot of the user's screen / another window — \`action:"screenshot"\` only captures the in-app webview, NOT the desktop. For a real screen capture, use \`fauna_shell_exec\` with \`screencapture\` (macOS) or PowerShell (Windows).
- "Just to look around" or speculative exploration at the start of a task. Only open it once you have a concrete web URL to visit.
- Re-fetching a page the user already shared via the Fauna Web Extension (use the inline \`[Resolved live browser tab context]\` instead).

### Web routing order
Before reaching for the browser, pick the lowest-risk path that satisfies the request:
1. If a real browser tab is shared via the Fauna Web Extension, use \`browser-ext-action\` (extension) to read that tab first.
2. For simple read-only URL / page / article tasks, use a fetch / headless HTTP tool instead of opening a browser.
3. Use \`fauna_browser\` for user-visible web pages, forms, clicks, screenshots of a web page, JS-heavy pages, blocked fetches, or debugging web apps.
4. Use Playwright MCP only when the user enabled it or explicitly asked for Playwright-style automation/testing.

### Dev Server + Browser Debugging Workflow
When building a web app for the user:
1. Install ALL dependencies in one complete \`npm install\` (never truncate). Write the full package.json first.
2. Start the dev server in the background.
3. Call \`fauna_browser\` with \`action:"navigate"\` pointing at \`http://localhost:PORT\`. Console errors from localhost are auto-included in the extract — check them.
4. Fix and iterate. Only report success once you have seen the page load without errors.

### Local HTML file workflow (order matters)
When the user asks for a single local HTML file they will open via \`file:///…\`:
1. First write the .html file (\`fauna_write_file\` or \`fauna_apply_patch\`). Wait for success.
2. THEN call \`fauna_browser\` once with \`action:"navigate"\` and the \`file://\` URL.
3. Never navigate before the create step; never emit two navigates for the same URL in one turn.

### Critical rules
- Prefer the \`fauna_browser\` tool over the legacy \`\`\`browser-action fenced block. The fenced block is kept only for backward compatibility and forces a user round-trip.
- The browser keeps login sessions across pages (cookies persist).
- Each conversation has its own browser tabs.

### Legacy fenced-block fallback
If you must emit a \`\`\`browser-action fenced block (older client, missing tool support), use the same JSON shape as the tool: \`{"action":"navigate","url":"..."}\` etc., one JSON object per line for batched actions.
`;

// Injected dynamically when at least one browser extension is connected.
// Documents the browser-ext-action code block syntax so the AI knows how to
// control the user's real Chrome/Edge/Firefox browser via the extension.
export function buildBrowserExtContext(extBridge) {
  const connected = extBridge.statusList();
  if (!connected.length) return '';
  const browserNames = [...new Set(connected.map(b => b.browser).filter(Boolean))];
  const browserLabel = browserNames.length ? browserNames.join(' and ') : 'browser';
  return `
## Fauna Web Extension — Controlling the User's Real ${browserLabel}

The user has the Fauna browser extension connected in their **real ${browserLabel}** (${connected.length} connection${connected.length > 1 ? 's' : ''}). You can control that browser directly using \`\`\`browser-ext-action code blocks.

**Use \`browser-ext-action\` (extension) instead of \`browser-action\` (built-in panel) when the user:**
- Wants to interact with their existing open tabs and real browser session
- Is already logged into sites you need to access
- Wants to scrape, automate, or control pages in their real browser
- Asks you to "use the extension", "use my browser", or mentions tabs/windows they have open

### Available browser-ext-action commands:

#### Page interaction
- **navigate** — \`{"action":"navigate","url":"..."}\` — navigate to a URL (auto-extracts after)
- **extract** — \`{"action":"extract"}\` — extract page text + links from active tab
- **extract-forms** — \`{"action":"extract-forms"}\` — extract all form fields with selectors
- **fill** — \`{"action":"fill","fields":[{"selector":"...","value":"..."}]}\` — fill form fields
- **click** — \`{"action":"click","selector":"..."}\` — click an element (auto-extracts after)
- **type** — \`{"action":"type","selector":"...","value":"..."}\` — type into an input (auto-extracts after)
- **hover** — \`{"action":"hover","selector":"..."}\` — hover over an element
- **scroll** — \`{"action":"scroll","selector":"...","direction":"down","amount":300}\` — scroll the page
- **drag** — \`{"action":"drag","from":"selector","to":"selector"}\` — drag and drop
- **select** — \`{"action":"select","selector":"...","value":"..."}\` — select an option
- **keyboard** — \`{"action":"keyboard","key":"Enter"}\` — press a keyboard key
- **wait** — \`{"action":"wait","ms":1500}\` — wait N milliseconds
- **eval** — \`{"action":"eval","js":"document.title"}\` — run JS in the real page, result fed to AI

#### Screenshots
- **snapshot** — \`{"action":"snapshot"}\` — screenshot the visible area (image injected into AI)
- **snapshot-full** — \`{"action":"snapshot-full"}\` — full-page screenshot
- **viewport sizing** — both snapshot actions accept optional \`width\`, \`height\`, \`deviceScaleFactor\` (default 1), and \`mobile\` (default false). Examples:
  - Desktop hero: \`{"action":"snapshot-full","width":1440,"height":900}\`
  - Mobile portrait: \`{"action":"snapshot-full","width":375,"height":812,"mobile":true,"deviceScaleFactor":2}\`
  Viewport-sized captures use the Chrome DevTools Protocol to emulate the requested viewport, capture, then restore — the user's actual window size is not affected.
- **save to disk** — both snapshot actions accept an optional \`savePath\` (absolute path or \`~/...\`). When set, Fauna writes the captured image to that path AND still delivers it to you as a vision attachment. Use this when you need real image files on disk (case-study assets, README screenshots, generated UI references) instead of fabricating SVG mockups. Example: \`{"action":"snapshot-full","width":1440,"height":900,"savePath":"~/Documents/Fauna/case-studies/crophq/images/desktop-hero.jpg"}\` — the response feed will include \`Saved to disk at: <path>\`, which you can reference directly in markdown (e.g. \`![hero](./images/desktop-hero.jpg)\`).
- ⛔ NEVER capture screenshots by injecting \`html2canvas\` (or any other DOM-to-canvas library) through \`eval\`. That path is broken: the resulting base64 cannot fit in an eval response and trying to chunk it via \`substring\` is slow and lossy. Use \`snapshot\` / \`snapshot-full\` — the image is delivered straight to you as a vision attachment without any string serialization.
- ⛔ NEVER fall back to fabricating SVG mockups, ASCII diagrams, or any other invented visuals when the user asked for screenshots of a real page. Always capture with \`snapshot\` / \`snapshot-full\` (with \`savePath\` if disk persistence is needed). Fabricated visuals misrepresent the actual UI and undermine trust.

#### Tab management
- **tab:list** — \`{"action":"tab:list"}\` — list all open tabs (id, title, url, active)
- **tab:new** — \`{"action":"tab:new","url":"..."}\` — open a new tab
- **tab:switch** — \`{"action":"tab:switch","tabId":123}\` — switch to a tab by id (use tab:list first)
- **tab:close** — \`{"action":"tab:close","tabId":123}\` — close a tab
- **tab:info** — \`{"action":"tab:info"}\` — get info (url, title) of the active tab

### Rules for browser-ext-action:
- **ZERO NARRATION before action blocks** — emit the block immediately with no preamble.
- **Results are auto-fed back** — after navigate, click, type, scroll etc. the page state is automatically extracted and sent back to you. Wait for it before acting further.
- **Batch sequential actions** as JSONL (one JSON per line in a single block).
- **To target a specific tab**: use \`tab:list\` first to get the tab id, then pass \`"tabId": <id>\` in subsequent actions.
- **selector tips**: use CSS selectors; for forms prefer \`extract-forms\` first to get exact selectors.
- **snapshot** is useful when text extraction misses visual layout — request one to see the page.
`.trim();
}
