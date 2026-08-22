---
name: watermarks
maturity: promoted
description: Remove AI provenance marks and document watermarks from content you own. Use when stripping invisible Unicode, C2PA metadata, vendor provenance, or visible watermark layers from text and files.
---

# remove-ai-marks skill

Strip multi-vendor AI provenance marks from text and files — for privacy and hygiene on content you own.

**Invoke with:** `/remove-ai-marks`, "strip watermarks", "remove AI marks", "clean invisible unicode", "strip C2PA", "Layer A clean", "remove provenance metadata"

## Overview

Inspect user-owned content for provenance and watermark layers, then remove
only the requested layers while reporting exactly what changed.

## When to Use

Use for invisible Unicode, metadata, C2PA provenance, or visible watermark
layers in user-owned content. Do not use to bypass ownership or licensing.

## Process

Inspect first, select the narrowest supported cleanup path, preserve the
original unless replacement is explicit, and inspect the result again.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "The mark is probably only metadata" | Inspect every relevant layer before mutation. |
| "Removal implies overwriting the original" | Preserve the source unless replacement is explicitly requested. |

## Red Flags

- Unclear ownership or authorization
- Destructive mutation before inspection
- Claiming removal without a post-clean inspection

## Verification

- Confirm the requested layers are absent after cleanup.
- Report the output path and removal statistics.
- Confirm unrelated content remains intact.

---

## What this skill covers

| Layer | What it targets | Approach |
|-------|----------------|----------|
| A | Invisible Unicode: ZWSP, bidi controls, tag chars (U+E0001–U+E007F), variation selectors, space homoglyphs | Deterministic — `fauna_inspect_watermarks` + `fauna_clean_watermarks` |
| B | Statistical token-sampling watermarks (Kirchenbauer-style, SynthID-Text) | Best-effort LLM rewrite — no tool, explain + produce paraphrase |
| File | C2PA/JUMBF (PNG chunks, JPEG APP11), EXIF/XMP, SVG `<metadata>`, HTML AI meta/JSON-LD/data-ai*, Markdown YAML frontmatter AI keys, DOCX docProps/customXml, ODT meta.xml | `fauna_clean_watermarks({ filePath })` |

Vendors covered: Claude, Gemini / SynthID-Text class, OpenAI provenance surfaces, open-LLM Kirchenbauer-style marks.

---

## Tool chain

```
fauna_inspect_watermarks({ text?, filePath?, aggressive? })
  → { ok, format, suspiciousTotal, hits, findings, notes }

fauna_clean_watermarks({ text?, filePath?, outputPath?, aggressive?, nfkc? })
  → { ok, cleanedText?, outputPath?, stats }
```

Both tools run entirely in-process (Layer A, text formats, PNG). For JPEG/PDF they call `exiftool` if installed. For DOCX/ODT they use `adm-zip`.

---

## Required sequence

1. **Inspect first** — call `fauna_inspect_watermarks` and surface findings with confidence levels to the user.
2. **Confirm scope** — distinguish *confirmed* (C2PA manifest, parsed provenance) from *probable* (AI metadata key) from *informational* (CMS generator tag).
3. **Clean** — call `fauna_clean_watermarks`. Report `removedCount`, `replacedCount`, any tool prerequisites missing.
4. **Layer B** — if the user asks about statistical marks, explain the trade-off (every rewrite degrades fidelity; paraphrase attacks token-sampling bias). Offer to produce a rewritten version. Use a non-origin model preference.

---

## Layer B rewrite guidance (no tool)

- Target: token-sampling watermarks hidden in word choices across sentences.
- Method: paraphrase sentence-by-sentence, vary clause order, swap connectors, synonymise key nouns/verbs.
- **Do not** rewrite with the same model family that generated the text (risk of re-stamping).
- Residual risk: no public universal detector exists. Removal is best-effort; the vendor's own detector remains the final authority.
- When to skip: if quality matters more than hygiene, apply Layer A only and keep the original prose.

---

## Optional system tools

| Tool | Purpose | Install |
|------|---------|---------|
| `exiftool` | EXIF/XMP strip for JPEG, PDF | `brew install exiftool` / `apt install libimage-exiftool-perl` |
| `c2patool` | Inspect C2PA manifests | https://github.com/contentauth/c2pa-rs/tree/main/cli |
| `adm-zip` (npm) | DOCX / ODT zip manipulation | `npm i adm-zip` |

All optional — the tools degrade gracefully with a clear install hint when absent.

---

## Supported file formats

| Format | Layer A text | File metadata |
|--------|-------------|---------------|
| Plain text / code | ✅ | — |
| Markdown | ✅ | YAML frontmatter AI keys |
| SVG | ✅ | `<metadata>` block, XMP packet |
| HTML | ✅ | `<meta>` generator/AI, JSON-LD, `data-ai*` |
| PNG | — | C2PA (c2pa/CABX/JUMB chunks), EXIF (eXIf), tEXt/zTXt/iTXt |
| JPEG | — | EXIF/XMP via exiftool |
| PDF | — | Metadata via exiftool |
| DOCX | — | docProps/custom.xml, app.xml AI keys |
| ODT | — | meta.xml generator/AI keys |

---

## Disclaimer

Layer A removals are verifiable (codepoint counts). Layer B rewrites are best-effort — no tool can certify a vendor detector will fail. This skill is for content you own or are authorised to process. See the upstream ethics doc: https://github.com/guillaumemeyer/watermarks-remover/blob/main/skills/remove-ai-marks/references/ethics.md
