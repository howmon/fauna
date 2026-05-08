# FaunaMCP

FaunaMCP is a standalone tray utility that exposes browser and Figma automation as MCP servers. It lets MCP-capable tools connect to the same browser extension and Figma plugin bridges without running the full Fauna desktop app.

## What It Runs

- Browser relay on `ws://localhost:3340` for the browser extension
- Browser MCP endpoint on `http://localhost:3341/mcp`
- Figma plugin relay on `ws://localhost:3335`
- Figma MCP endpoint on `http://localhost:3336/mcp`

## Project Layout

- `main.js` - Electron tray app and relay process manager
- `browser-server/` - browser extension bridge and MCP server
- `extension/` - browser extension files
- `figma-server/` - Figma relay and MCP server
- `figma-plugin/` - Figma plugin UI and manifest
- `assets/` - app icons used by Electron Builder

## Setup

```bash
npm install
npm start
```

The tray menu can start and stop each relay, copy MCP URLs, copy stdio MCP configuration, and open the browser extension or Figma plugin folders.

## Build

```bash
npm run dist:mac
npm run dist:win
```

Build artifacts are written to `dist/` and are intentionally ignored by git.

## In-App Updates

FaunaMCP can check the `main` branch for updates from the tray popup. The Updates row compares GitHub's latest `main` commit SHA with the locally recorded installed SHA. When an update is available, click `Install` to let FaunaMCP download the source zip, extract it into app data, run `npm install`, build the platform package, and launch the installer/relauncher.

- macOS builds with `npm run dist:mac`, stages `FaunaMCP.app`, then relaunches from `/Applications/FaunaMCP.app`.
- Windows builds with `npm run dist:win`, then launches the generated `.exe` installer.
- Linux builds are staged in the app data source folder until a package/install target is added.

## Using With Fauna

Start FaunaMCP first, then start Fauna. Fauna detects `http://localhost:3341/mcp` and routes browser and Figma tool calls through the standalone relay instead of spawning its bundled fallback.

## MCP Client URLs

Browser MCP:

```json
{
  "fauna-browser-mcp": {
    "url": "http://localhost:3341/mcp"
  }
}
```

Figma MCP:

```json
{
  "figma-fauna": {
    "url": "http://localhost:3336/mcp"
  }
}
```
