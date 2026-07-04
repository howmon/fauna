// ── Parakeet (sherpa-onnx) model catalogue helpers ───────────────────────
//
// Cross-platform counterpart to whisper-models.js. Where Whisper ships a
// single ggml-<alias>.bin, a sherpa-onnx NeMo transducer is FOUR files that
// live together in one folder:
//
//   ~/.config/fauna/parakeet/<alias>/
//     ├── encoder.int8.onnx
//     ├── decoder.int8.onnx
//     ├── joiner.int8.onnx
//     └── tokens.txt
//
// Files are downloaded directly from HuggingFace (resolve/main/<file>), the
// same direct-file strategy whisper-models.js uses — no tar/bzip2 archive to
// unpack, so it works identically on macOS, Windows, and Linux.
//
// These models run through onnxruntime (bundled with sherpa-onnx-node's
// platform binary), so nothing here is macOS-specific: the exact same .onnx
// weights load on win32-x64 and linux-x64.

import fs from 'fs';
import os from 'os';
import path from 'path';

export const MODEL_DIR = path.join(os.homedir(), '.config', 'fauna', 'parakeet');

// The four files that make up a NeMo transducer export, in the order the
// download UI reports progress. tokens.txt is tiny; the encoder dominates.
export const MODEL_FILES = Object.freeze([
  'encoder.int8.onnx',
  'decoder.int8.onnx',
  'joiner.int8.onnx',
  'tokens.txt',
]);

// Whitelisted Parakeet aliases → their HuggingFace repo (all int8 quantized,
// exported for sherpa-onnx by csukuangfj). modelType is always the NeMo
// transducer variant. Order is meaningful: the settings UI renders in order.
export const MODEL_INFO = Object.freeze({
  'parakeet-tdt-0.6b-v2': {
    label:    'Parakeet TDT 0.6B v2 (English) \u2014 default',
    repo:     'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    sizeMB:   660,
    langs:    'English',
    speed:    'fastest',
  },
  'parakeet-tdt-0.6b-v3': {
    label:    'Parakeet TDT 0.6B v3 (25 languages)',
    repo:     'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    sizeMB:   680,
    langs:    'Multilingual (25)',
    speed:    'fast',
  },
});

export const PARAKEET_MODELS = Object.freeze(Object.keys(MODEL_INFO));

export function isParakeetAlias(alias) {
  return typeof alias === 'string' && Object.prototype.hasOwnProperty.call(MODEL_INFO, alias);
}

/** Absolute folder where the given model's files live. */
export function modelDirFor(alias) {
  if (!isParakeetAlias(alias)) return null;
  return path.join(MODEL_DIR, alias);
}

/** Absolute path to a single file within a model's folder. */
export function modelFilePath(alias, file) {
  const dir = modelDirFor(alias);
  return dir ? path.join(dir, file) : null;
}

/**
 * Resolved on-disk paths sherpa-onnx needs to construct a recognizer.
 * @returns {{encoder,decoder,joiner,tokens}|null}
 */
export function modelPathsFor(alias) {
  if (!isParakeetAlias(alias)) return null;
  return {
    encoder: modelFilePath(alias, 'encoder.int8.onnx'),
    decoder: modelFilePath(alias, 'decoder.int8.onnx'),
    joiner:  modelFilePath(alias, 'joiner.int8.onnx'),
    tokens:  modelFilePath(alias, 'tokens.txt'),
  };
}

/** Direct HuggingFace download URL for a single file of a model. */
export function downloadUrlFor(alias, file) {
  if (!isParakeetAlias(alias)) return null;
  const repo = MODEL_INFO[alias].repo;
  return `https://huggingface.co/${repo}/resolve/main/${file}`;
}

/** A model is installed only when all four files are present and non-empty. */
export function isInstalled(alias) {
  if (!isParakeetAlias(alias)) return false;
  return MODEL_FILES.every((f) => {
    try {
      const st = fs.statSync(modelFilePath(alias, f));
      return st.isFile() && st.size > 0;
    } catch (_) {
      return false;
    }
  });
}

/**
 * Resolve which alias to actually use. Prefers `preferred` when installed,
 * otherwise falls back to the first installed model, otherwise null.
 */
export function resolveActiveModel(preferred) {
  if (isParakeetAlias(preferred) && isInstalled(preferred)) return preferred;
  for (const alias of PARAKEET_MODELS) {
    if (isInstalled(alias)) return alias;
  }
  return null;
}

/** Catalogue with install state, for the settings picker. */
export function listModels() {
  return PARAKEET_MODELS.map((alias) => ({
    alias,
    ...MODEL_INFO[alias],
    installed: isInstalled(alias),
  }));
}
