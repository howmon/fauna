# @fauna-services/artifacts

Artifact lifecycle service. Manages the creation, storage, versioning, rendering, and export of AI-generated output artifacts — HTML dashboards, code files, PDFs, data tables, 3D scenes, and more.

---

## What It Does

- **Type registry** for 14+ artifact types: `html`, `code`, `markdown`, `csv`, `pdf`, `lesson`, `video`, `model3d`, `sheet`, `genui`, `pcb`, `image`, `audio`, `diff`
- **Sandboxed HTML rendering** — serves artifacts in a sandboxed iframe with CSP headers
- **PDF export** — headless Chromium renders any HTML artifact to PDF with print styles
- **Version history** — every artifact mutation saved as an immutable version
- **Artifact search** — full-text + type-filter search across all stored artifacts
- **Embeddable** — generates self-contained HTML files or `<iframe>` embed codes

---

## API

### Create artifact

```
POST /api/artifacts
Content-Type: application/json

{
  "type": "html",
  "title": "Sales Dashboard",
  "content": "<html>...</html>",
  "conversationId": "uuid",
  "projectId": "uuid"
}
```

Response: `{ "id": "uuid", "version": 1, "url": "/artifacts/uuid/render" }`

### Get artifact

```
GET /api/artifacts/:id
GET /api/artifacts/:id?version=3
```

### Update artifact (creates new version)

```
PUT /api/artifacts/:id
{ "content": "..." }
→ { "id": "...", "version": 4 }
```

### List artifact versions

```
GET /api/artifacts/:id/versions
```

### Render artifact (sandboxed)

```
GET /api/artifacts/:id/render
→ HTML (served with sandbox CSP headers)
```

### Export to PDF

```
POST /api/artifacts/:id/export/pdf
→ application/pdf
```

### Export as self-contained HTML

```
POST /api/artifacts/:id/export/html
→ text/html (single file, all assets inlined)
```

### Search artifacts

```
GET /api/artifacts?type=html&q=dashboard&projectId=uuid&limit=20
```

### Delete artifact

```
DELETE /api/artifacts/:id
```

---

## Artifact Types

| Type | Description | Content Format |
|---|---|---|
| `html` | Interactive HTML artifact | Raw HTML string |
| `code` | Source code file | `{ lang, code }` |
| `markdown` | Rendered document | Markdown string |
| `csv` | Data table | CSV string |
| `pdf` | PDF document | Base64 or URL |
| `genui` | GenUI JSON component tree | GenUI JSON |
| `image` | Generated image | Base64 or file path |
| `diff` | File diff | Unified diff string |
| `sheet` | Spreadsheet (Univer) | Workbook JSON |
| `model3d` | 3D scene | GLTF / Three.js scene JSON |
| `pcb` | PCB layout | PCB JSON |
| `lesson` | Interactive lesson | Lesson JSON |
| `audio` | Audio file | File path |
| `video` | Video file | File path |

---

## Configuration

```js
import { createArtifactsService } from '@fauna-services/artifacts'

const svc = await createArtifactsService({
  port: 4013,
  storageDir: '~/.myapp/artifacts',
  pdfEngine: 'chromium', // 'chromium' | 'wkhtmltopdf'
  maxVersionsPerArtifact: 50,
  sandboxCsp: "default-src 'self'; script-src 'unsafe-inline'"
})
```

---

## Integration Examples

### Embed artifact viewer in a web app

```html
<iframe
  src="http://localhost:4013/api/artifacts/uuid/render"
  sandbox="allow-scripts"
  style="width:100%; height:600px; border:none"
></iframe>
```

### Programmatic artifact creation

```ts
import { ArtifactsClient } from '@fauna-services/artifacts/client'
const client = new ArtifactsClient('http://localhost:4013')

const artifact = await client.create({
  type: 'html',
  title: 'My Dashboard',
  content: generatedHtml
})

const pdf = await client.exportPdf(artifact.id)
fs.writeFileSync('report.pdf', pdf)
```

---

## Storage

- `artifacts.db` — SQLite; tables: `artifacts`, `artifact_versions`, `artifact_fts`
- Binary content (images, audio, video) stored as files; metadata in DB

---

## Dependencies

- `better-sqlite3` — artifact store
- `puppeteer` / `playwright` — PDF export
- `archiver` — bundle export
