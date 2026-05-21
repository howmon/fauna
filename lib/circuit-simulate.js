// ── ngspice runtime ─────────────────────────────────────────────────────
// Phase 7. Compiles the DSL → netlist, shells out to ngspice -b, parses the
// ASCII rawfile back into plottable arrays. Degrades gracefully when ngspice
// isn't installed (returns the netlist + a helpful install hint).

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { compileToSpice } from './circuit-spice.js';

const exec = promisify(execFile);
const NG_BIN = process.env.FAUNA_NGSPICE || 'ngspice';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_POINTS = 50000;  // sanity cap to keep payloads small

export async function simulateCircuit(doc, analysis, opts = {}) {
  const compiled = compileToSpice(doc, analysis);
  if (!compiled.ok) return { ...compiled, available: null, results: null };

  const installed = await ngspiceAvailable();
  if (!installed) {
    return {
      ok: true,
      errors: [],
      warnings: [
        ...compiled.warnings,
        {
          code: 'NGSPICE_NOT_INSTALLED',
          message: 'ngspice binary not found on PATH. Install with `brew install ngspice` (macOS) or `apt install ngspice` (Linux). Returning netlist only.',
        },
      ],
      netlist: compiled.netlist,
      nets: compiled.nets,
      available: false,
      results: null,
    };
  }

  // Augment netlist with a control block that runs + writes an ASCII rawfile.
  // ngspice batch mode ignores .control when .OP/.TRAN/etc. are also present, so
  // strip them from the deck and convert to control commands (op / tran / ac / dc).
  const tmp = await mkdtemp(path.join(tmpdir(), 'fauna-spice-'));
  const netPath = path.join(tmp, 'sim.cir');
  const rawPath = path.join(tmp, 'sim.raw');
  const controlCmds = [];
  const stripped = compiled.netlist
    .split('\n')
    .filter(line => {
      const m = line.match(/^\.(OP|TRAN|AC|DC|SAVE)\b(.*)$/i);
      if (!m) return true;
      const verb = m[1].toLowerCase();
      const args = m[2].trim();
      if (verb !== 'save') controlCmds.push(args ? `${verb} ${args}` : verb);
      return false;
    })
    .filter(line => line !== '.END')
    .join('\n');
  if (controlCmds.length === 0) controlCmds.push('op');
  const ctrl = [
    '.control',
    'set filetype=ascii',
    ...controlCmds,
    `write ${rawPath} all`,
    'quit',
    '.endc',
    '.END',
    '',
  ].join('\n');
  const augmented = stripped + '\n' + ctrl;
  await writeFile(netPath, augmented, 'utf8');

  let stdout = '', stderr = '';
  try {
    const r = await exec(NG_BIN, ['-b', netPath], {
      timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    stdout = r.stdout || ''; stderr = r.stderr || '';
  } catch (err) {
    return {
      ok: false,
      errors: [{ code: 'NGSPICE_FAILED', message: err.message, stderr: (err.stderr || '').slice(0, 4000) }],
      warnings: compiled.warnings,
      netlist: compiled.netlist,
      available: true,
      results: null,
    };
  } finally {
    // Best-effort: schedule cleanup but don't block on it.
    rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  let parsed;
  try {
    const raw = await readFile(rawPath, 'utf8').catch(() => null);
    if (!raw) {
      return {
        ok: false,
        errors: [{ code: 'NGSPICE_NO_OUTPUT', message: 'ngspice ran but produced no rawfile', stderr: stderr.slice(0, 4000) }],
        warnings: compiled.warnings,
        netlist: compiled.netlist,
        available: true,
        results: null,
      };
    }
    parsed = parseAsciiRawfile(raw);
  } catch (err) {
    return {
      ok: false,
      errors: [{ code: 'RAWFILE_PARSE_FAILED', message: err.message }],
      warnings: compiled.warnings,
      netlist: compiled.netlist,
      available: true,
      results: null,
    };
  }

  // Extract structured summary
  const results = summariseResults(parsed);

  return {
    ok: true,
    errors: [],
    warnings: [
      ...compiled.warnings,
      ...extractNgspiceWarnings(stdout, stderr),
    ],
    netlist: compiled.netlist,
    nets: compiled.nets,
    available: true,
    results,
  };
}

// ── ngspice presence cache ──────────────────────────────────────────────
let _availability = null;
async function ngspiceAvailable() {
  if (_availability !== null) return _availability;
  try {
    await exec(NG_BIN, ['-v'], { timeout: 3000 });
    _availability = true;
  } catch {
    _availability = false;
  }
  return _availability;
}

// ── ASCII rawfile parser ────────────────────────────────────────────────
// Handles one or more concatenated plots. Format:
//   Title: ...
//   Date: ...
//   Plotname: <name>
//   Flags: real|complex
//   No. Variables: N
//   No. Points: P
//   Variables:
//        0 <name> <type>
//        ...
//   Values:
//    0  v0  v1 ...
//    1  v0  v1 ...
//   <blank line, then next plot or EOF>
export function parseAsciiRawfile(text) {
  const lines = text.split(/\r?\n/);
  const plots = [];
  let i = 0;
  while (i < lines.length) {
    // Find next "Plotname:" header
    while (i < lines.length && !/^Plotname:/i.test(lines[i])) i++;
    if (i >= lines.length) break;
    const header = {};
    let plotname = null;
    // Read header lines until "Variables:"
    while (i < lines.length && !/^Variables:/i.test(lines[i])) {
      const m = lines[i].match(/^([A-Za-z. ]+):\s*(.+)$/);
      if (m) {
        const key = m[1].trim().toLowerCase();
        header[key] = m[2].trim();
        if (key === 'plotname') plotname = m[2].trim();
      }
      i++;
    }
    if (i >= lines.length) break;
    i++; // skip "Variables:"
    const nvars = parseInt(header['no. variables'] || '0', 10);
    const npts  = Math.min(parseInt(header['no. points'] || '0', 10), MAX_POINTS);
    const flags = (header['flags'] || 'real').toLowerCase();
    const complex = /complex/.test(flags);
    const variables = [];
    for (let v = 0; v < nvars && i < lines.length; v++, i++) {
      const parts = lines[i].trim().split(/\s+/);
      variables.push({ index: parseInt(parts[0], 10), name: parts[1] || `v${v}`, type: parts[2] || 'unknown' });
    }
    // Skip "Values:"
    while (i < lines.length && !/^Values:/i.test(lines[i])) i++;
    i++;

    // Each point: nvars values. Real → 1 number, complex → "a,b".
    // ngspice format: first column of first line of each point starts with the point index.
    const data = Object.fromEntries(variables.map(v => [v.name, []]));
    for (let p = 0; p < npts; p++) {
      const collected = [];
      while (collected.length < nvars && i < lines.length) {
        const raw = lines[i].trim();
        i++;
        if (!raw) continue;
        // The first token on the first row of a point is the point index — skip if numeric and matches.
        const toks = raw.split(/\s+/);
        if (collected.length === 0 && toks.length > 0 && /^\d+$/.test(toks[0])) {
          toks.shift();
        }
        for (const t of toks) {
          if (!t) continue;
          if (complex && t.includes(',')) {
            const [re, im] = t.split(',').map(Number);
            collected.push({ re, im });
          } else {
            collected.push(parseFloat(t));
          }
        }
      }
      for (let v = 0; v < nvars; v++) {
        data[variables[v].name].push(collected[v]);
      }
    }
    plots.push({ plotname, flags, complex, variables, points: npts, data });
  }
  return { plots };
}

function summariseResults(parsed) {
  const out = { plots: [] };
  for (const p of parsed.plots) {
    const summary = {
      plotname: p.plotname,
      variables: p.variables.map(v => v.name),
      points: p.points,
      data: p.data,
    };
    // Convenience: for operating point, also expose a flat node → voltage map.
    if (p.points === 1 && !p.complex) {
      const nodeVoltages = {};
      for (const v of p.variables) {
        const m = v.name.match(/^v\((.+)\)$/i);
        if (m) nodeVoltages[m[1]] = p.data[v.name][0];
      }
      if (Object.keys(nodeVoltages).length) summary.nodeVoltages = nodeVoltages;
    }
    out.plots.push(summary);
  }
  return out;
}

function extractNgspiceWarnings(stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const out = [];
  for (const line of text.split('\n')) {
    if (/^Warning:/i.test(line) || /^Note:/i.test(line)) {
      out.push({ code: 'NGSPICE_NOTICE', message: line.trim() });
    }
  }
  return out;
}
