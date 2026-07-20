# @fauna-services/theming

CSS variable theme management service. Stores, serves, and exports design token themes — enabling consistent, switchable visual styling across any web-based tool, Electron app, or documentation site.

---

## What It Does

- **Theme CRUD** — create, read, update, delete named theme presets
- **CSS variable generation** — produces a `:root { --var: value }` stylesheet for any theme
- **Token export** — exports themes as CSS, SCSS variables, Tailwind config, Figma token JSON, or raw JSON
- **Active theme management** — tracks which theme is active; emits change events
- **Custom font management** — registers and serves custom web fonts
- **Preset library** — ships built-in presets (Dark, Light, Forest, Ocean) ready to use or fork

---

## Theme Schema

```ts
interface Theme {
  id: string
  name: string
  description?: string
  mode: 'dark' | 'light'
  tokens: {
    // Backgrounds
    bgBase: string           // e.g., '#0D1117'
    bgSurface: string
    bgSurfaceAlt: string
    bgSurfaceHover: string

    // Text
    textPrimary: string
    textSecondary: string
    textMuted: string
    textInverse: string

    // Borders
    borderDefault: string
    borderSubtle: string
    borderStrong: string

    // Accent / Brand
    accentPrimary: string
    accentHover: string
    accentText: string

    // Semantic
    colorSuccess: string
    colorWarning: string
    colorError: string
    colorInfo: string

    // Radius & Spacing
    radiusSmall: string      // e.g., '4px'
    radiusMedium: string
    radiusLarge: string
    spacingUnit: string      // e.g., '8px'

    // Typography
    fontFamily: string
    fontFamilyMono: string
    fontSizeBase: string
    lineHeight: string
  }
  customProperties?: Record<string, string>  // Any extra CSS variables
}
```

---

## API

### List themes

```
GET /api/themes
→ [{ "id", "name", "mode", "isActive", "isBuiltIn" }]
```

### Get theme

```
GET /api/themes/:id
```

### Create theme

```
POST /api/themes
{ ...theme }
```

### Update theme

```
PUT /api/themes/:id
{ "tokens": { "accentPrimary": "#FF6B35" } }  // partial update merges tokens
```

### Delete theme

```
DELETE /api/themes/:id  // cannot delete built-in presets
```

### Get active theme

```
GET /api/themes/active
→ { ...theme }
```

### Set active theme

```
POST /api/themes/active
{ "themeId": "my-custom-theme" }
```

### Get CSS for a theme

```
GET /api/themes/:id/css
→ text/css

:root {
  --bg-base: #0D1117;
  --bg-surface: #161B22;
  --text-primary: #E6EDF3;
  --accent-primary: #1A73E8;
  ...
}
```

### Export theme as various formats

```
GET /api/themes/:id/export?format=css
GET /api/themes/:id/export?format=scss
GET /api/themes/:id/export?format=tailwind
GET /api/themes/:id/export?format=figma-tokens
GET /api/themes/:id/export?format=json
```

**Tailwind export example:**

```js
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        'bg-base': '#0D1117',
        'accent': '#1A73E8',
        ...
      }
    }
  }
}
```

**Figma token export example:**

```json
{
  "color": {
    "bg-base": { "value": "#0D1117", "type": "color" },
    "accent-primary": { "value": "#1A73E8", "type": "color" }
  }
}
```

### Subscribe to active theme changes (SSE)

```
GET /api/themes/events
→ SSE stream: { type: 'theme_changed', theme: { ...tokens } }
```

### Register a custom font

```
POST /api/themes/fonts
Content-Type: multipart/form-data

file: <MyFont-Regular.woff2>
name: "My Font"
weight: 400
style: "normal"
```

### List registered fonts

```
GET /api/themes/fonts
→ [{ "name", "weights", "url": "/api/themes/fonts/my-font/regular" }]
```

---

## Built-In Presets

| ID | Name | Mode | Primary |
|---|---|---|---|
| `fauna-dark` | Fauna Dark | dark | #1A73E8 |
| `fauna-light` | Fauna Light | light | #1A73E8 |
| `forest` | Forest | dark | #4CAF50 |
| `ocean` | Ocean | dark | #00BCD4 |

---

## Configuration

```js
import { createThemingService } from '@fauna-services/theming'

const svc = await createThemingService({
  port: 4032,
  dataDir: '~/.myapp/themes',
  fontsDir: '~/.myapp/themes/fonts',
  defaultThemeId: 'fauna-dark',
  serveBuiltInPresets: true
})
```

---

## Integration Examples

### Any web app: live theme switching

```html
<!-- Load active theme CSS dynamically -->
<link id="theme-css" rel="stylesheet" href="http://localhost:4032/api/themes/active/css">

<script>
// Subscribe to theme changes
const evtSource = new EventSource('http://localhost:4032/api/themes/events')
evtSource.onmessage = (e) => {
  const { theme } = JSON.parse(e.data)
  document.getElementById('theme-css').href = `http://localhost:4032/api/themes/${theme.id}/css`
}
</script>
```

### VS Code extension: export theme to Tailwind

```ts
import { ThemingClient } from '@fauna-services/theming/client'
const theming = new ThemingClient('http://localhost:4032')

const tailwindConfig = await theming.export('fauna-dark', 'tailwind')
fs.writeFileSync('tailwind.config.js', tailwindConfig)
```

### Generate a theme from a description

```ts
// Use AI to generate token values, then save
const tokens = await llm.generateThemeTokens('A cyberpunk neon theme with purple accents')
await theming.createTheme({ name: 'Cyberpunk', mode: 'dark', tokens })
```

---

## Storage

- `themes.db` — SQLite; tables: `themes`, `fonts`
- Font files stored in `fontsDir`

---

## Dependencies

- `better-sqlite3` — theme store
- `multer` — font file upload
