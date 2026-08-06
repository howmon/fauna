// Jupyter notebook utilities: parse .ipynb files and execute them via nbconvert
import { execSync, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

/** Check if `jupyter` is available in PATH */
export function isJupyterAvailable() {
  try {
    execSync('jupyter --version', { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch (_) {
    return false;
  }
}

/** Return the jupyter binary path, or null */
export function jupyterBin() {
  for (const bin of ['jupyter', 'jupyter-nbconvert']) {
    try {
      const out = execSync(`which ${bin} 2>/dev/null || where ${bin} 2>nul`, { timeout: 3000 }).toString().trim();
      if (out) return out.split('\n')[0].trim();
    } catch (_) {}
  }
  return null;
}

/**
 * Parse a .ipynb file from disk and return a structured object.
 * Does NOT execute; just reads saved outputs.
 */
export function loadNotebook(filePath) {
  const abs = path.resolve(filePath.startsWith('~') ? filePath.replace(/^~/, os.homedir()) : filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  const nb = JSON.parse(raw);
  return {
    path: abs,
    cells: nb.cells || [],
    metadata: nb.metadata || {},
    nbformat: nb.nbformat || 4,
    kernelspec: nb.metadata?.kernelspec || null,
    languageInfo: nb.metadata?.language_info || null,
  };
}

/**
 * Execute a notebook file using `jupyter nbconvert --execute`.
 * Returns cells with outputs attached.
 * Throws if jupyter is not installed or execution fails.
 */
export async function executeNotebook(filePath, opts = {}) {
  const abs = path.resolve(filePath.startsWith('~') ? filePath.replace(/^~/, os.homedir()) : filePath);
  if (!fs.existsSync(abs)) throw new Error(`Notebook not found: ${abs}`);

  const dir = path.dirname(abs);
  const base = path.basename(abs, '.ipynb');
  const tmpOut = path.join(os.tmpdir(), `fauna_nb_${base}_${Date.now()}.ipynb`);
  const timeoutSec = opts.timeoutSec || 120;

  return new Promise((resolve, reject) => {
    const cmd = [
      'jupyter nbconvert',
      '--to notebook',
      '--execute',
      `--ExecutePreprocessor.timeout=${timeoutSec}`,
      `--output "${tmpOut}"`,
      `"${abs}"`,
    ].join(' ');

    exec(cmd, { cwd: dir, timeout: (timeoutSec + 30) * 1000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`jupyter nbconvert failed: ${(stderr || err.message).slice(0, 500)}`));
        return;
      }
      try {
        const raw = fs.readFileSync(tmpOut, 'utf8');
        const executed = JSON.parse(raw);
        try { fs.unlinkSync(tmpOut); } catch (_) {}
        resolve({
          ok: true,
          path: abs,
          cells: executed.cells || [],
          metadata: executed.metadata || {},
        });
      } catch (e) {
        reject(new Error(`Failed to read executed notebook: ${e.message}`));
      }
    });
  });
}

/**
 * Summarize notebook cells and outputs as plain text for the agent.
 */
export function summarizeNotebook(cells, maxCells = 50) {
  const lines = [];
  const limit = Math.min(cells.length, maxCells);
  for (let i = 0; i < limit; i++) {
    const cell = cells[i];
    const src = Array.isArray(cell.source) ? cell.source.join('') : (cell.source || '');
    if (cell.cell_type === 'markdown') {
      lines.push(`[${i + 1}] markdown: ${src.slice(0, 200).replace(/\n/g, ' ')}${src.length > 200 ? '…' : ''}`);
    } else if (cell.cell_type === 'code') {
      const n = cell.execution_count;
      lines.push(`[${i + 1}] code[${n ?? '-'}]: ${src.slice(0, 300).replace(/\n/g, ' ')}${src.length > 300 ? '…' : ''}`);
      for (const out of (cell.outputs || [])) {
        if (out.output_type === 'stream') {
          const text = Array.isArray(out.text) ? out.text.join('') : (out.text || '');
          lines.push(`  → ${out.name}: ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`);
        } else if (out.output_type === 'error') {
          lines.push(`  → ERROR [${out.ename}]: ${out.evalue}`);
        } else if (out.output_type === 'execute_result' || out.output_type === 'display_data') {
          const plain = out.data?.['text/plain'];
          const t = Array.isArray(plain) ? plain.join('') : (plain || '');
          if (t) lines.push(`  → result: ${t.slice(0, 400)}${t.length > 400 ? '…' : ''}`);
          if (out.data?.['image/png']) lines.push(`  → [image/png output]`);
          if (out.data?.['image/svg+xml']) lines.push(`  → [image/svg output]`);
          if (out.data?.['text/html']) lines.push(`  → [HTML output]`);
        }
      }
    }
  }
  if (cells.length > maxCells) lines.push(`… (${cells.length - maxCells} more cells not shown)`);
  return lines.join('\n');
}
