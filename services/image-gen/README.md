# @fauna-services/image-gen

Image generation and editing service. Provides a unified API over configurable image model backends for generating, editing, and managing AI-produced images — with project-aware output directories and inline artifact rendering.

---

## What It Does

- **Image generation** — text-to-image via configurable backends (OpenAI GPT Image, local Stable Diffusion, ComfyUI)
- **Image editing** — inpainting and masked edits
- **Background removal** — isolate subjects from generated images
- **Asset management** — index all generated images with prompt metadata; searchable
- **Stock image search** — proxy to configured stock image providers
- **Project-aware output** — saves images to `<projectRoot>/assets/generated/` with a manifest

---

## API

### Generate image

```
POST /api/images/generate
Content-Type: application/json

{
  "prompt": "A minimalist dashboard UI in dark mode, flat design, 4K",
  "model": "gpt-image-1",
  "size": "1536x1024",
  "quality": "high",
  "background": "transparent",
  "projectId": "my-project"
}
→ {
    "id": "img-uuid",
    "url": "/api/images/img-uuid",
    "path": "/Users/.../projects/my-project/assets/generated/img-uuid.png",
    "revisedPrompt": "...",
    "model": "gpt-image-1",
    "size": "1536x1024"
  }
```

### Edit image

```
POST /api/images/edit
Content-Type: multipart/form-data

image: <original.png>
mask: <mask.png>       // white = area to regenerate
prompt: "Replace the background with a mountain landscape"
model: gpt-image-1
→ { "id", "url", "path" }
```

### Get image

```
GET /api/images/:id
→ image/png binary

GET /api/images/:id/meta
→ { "id", "prompt", "model", "size", "createdAt", "projectId", "path" }
```

### List generated images

```
GET /api/images?projectId=my-project&limit=20&offset=0
→ [{ "id", "prompt", "model", "size", "createdAt", "thumbnailUrl" }]
```

### Search generated images

```
GET /api/images/search?q=dashboard+dark+mode&projectId=my-project
```

### Delete image

```
DELETE /api/images/:id
```

### Check generation availability

```
GET /api/images/status
→ {
    "available": true,
    "backends": [
      { "name": "openai", "status": "connected", "models": ["gpt-image-1", "gpt-image-1-mini"] },
      { "name": "stable-diffusion", "status": "disconnected", "url": "http://localhost:7860" }
    ]
  }
```

### Search stock images

```
GET /api/images/stock?q=mountain+landscape&provider=unsplash&limit=10
→ [{ "id", "url", "thumbnail", "author", "license" }]
```

---

## Configuration

```js
import { createImageGenService } from '@fauna-services/image-gen'

const svc = await createImageGenService({
  port: 4023,
  outputDir: '~/.myapp/generated-images',
  backends: {
    openai: {
      apiKey: process.env.OPENAI_KEY,
      defaultModel: 'gpt-image-1'
    },
    stableDiffusion: {
      enabled: true,
      url: 'http://localhost:7860'
    },
    comfyui: {
      enabled: false,
      url: 'http://localhost:8188'
    }
  },
  stock: {
    unsplash: { accessKey: process.env.UNSPLASH_KEY }
  }
})
```

---

## Backend Routing

The service selects the backend based on the `model` parameter:

| Model prefix | Backend |
|---|---|
| `gpt-image-*` | OpenAI API |
| `sd-*`, `flux-*` | Local Stable Diffusion |
| `comfy-*` | ComfyUI |
| `dall-e-*` | OpenAI API (legacy) |

If the selected backend is unavailable, falls back to the next available.

---

## Integration Examples

### AI generates design assets

```ts
import { ImageGenClient } from '@fauna-services/image-gen/client'
const imgGen = new ImageGenClient('http://localhost:4023')

// Check available
const { available } = await imgGen.status()

// Generate
const img = await imgGen.generate({
  prompt: 'Hero image for a SaaS landing page, clean and professional',
  size: '1536x1024',
  quality: 'high'
})

// Render inline
return `<img src="${img.url}" />`
```

### CLI asset generation

```bash
fauna-image generate --prompt "App icon, gradient purple to blue, rounded corners" --size 1024x1024 --out ./assets/icon.png
```

---

## Storage

- `images.db` — SQLite; tables: `images`, `image_fts` (full-text search on prompts)
- Image files stored as PNG in the `outputDir`; thumbnails at `{id}_thumb.jpg`

---

## Dependencies

- `sharp` — image processing (resize, format conversion, thumbnail)
- `form-data` — multipart upload for edit API
- `better-sqlite3` — image index
