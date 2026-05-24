// Persisted local-LLM configuration.
// Stored in FAUNA_CONFIG_DIR/local-llm.json:
//   {
//     providerId: 'openai-compat',
//     baseURL:    'http://localhost:11434/v1',
//     apiKey:     '',
//     defaultModel: 'llama3.1:8b',
//     defaultHeaders: {},
//     overrides: { tools: false, vision: false }  // optional capability flips
//   }
//
// The config is intentionally NOT secret — local-only, plain JSON, same as
// provider-keys.json. Cloud-API keys go in provider-keys.json (existing).

import fs from 'fs';
import path from 'path';
import os from 'os';

function _configDir() {
  return process.env.FAUNA_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'copilot-chat');
}

function _file() {
  return path.join(_configDir(), 'local-llm.json');
}

export function readLocalLLMConfig() {
  try { return JSON.parse(fs.readFileSync(_file(), 'utf8')); }
  catch (_) { return null; }
}

export function writeLocalLLMConfig(cfg) {
  const dir = _configDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  fs.writeFileSync(_file(), JSON.stringify(cfg || {}, null, 2));
}

export function clearLocalLLMConfig() {
  try { fs.unlinkSync(_file()); } catch (_) {}
}
