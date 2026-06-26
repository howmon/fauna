#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'server', 'generated', 'capabilities.json');

function categoryFor(name) {
  if (/browser/.test(name)) return 'browser';
  if (/shell|dev_server/.test(name)) return 'shell';
  if (/read_file|write_file|write_files|replace|patch|offloaded|file_search|grep/.test(name)) return 'file';
  if (/remember|recall|forget|context_|memory/.test(name)) return 'memory';
  if (/project|backlog|workitem|board/.test(name)) return 'project';
  if (/window|mouse|keyboard|screen|ui_tree/.test(name)) return 'desktop';
  if (/circuit|pcb|footprint/.test(name)) return 'circuit';
  if (/video|image|stock|lesson|speak|podcast|voice/.test(name)) return 'media';
  if (/model|settings|doctor|retrieve|plan|substep|consult/.test(name)) return 'assistant';
  return 'other';
}

function sideEffectsFor(name) {
  const effects = [];
  if (/write|replace|patch|delete|forget|move|claim|comment|update|create|run|shell|browser|mouse|keyboard|arrange|notification|speak|podcast|image_generate|image_edit/.test(name)) effects.push('mutates-state');
  if (/shell|dev_server/.test(name)) effects.push('executes-process');
  if (/browser|stock|github|http|image|video/.test(name)) effects.push('network-capable');
  if (/read_file|write_file|grep|file_search|context_ingest/.test(name)) effects.push('file-access');
  return effects.length ? effects : ['read-only'];
}

function normalizeTool(def, source) {
  const fn = def && def.function ? def.function : {};
  const name = fn.name || '';
  return {
    name,
    source,
    category: categoryFor(name),
    description: String(fn.description || '').replace(/\s+/g, ' ').trim(),
    required: Array.isArray(fn.parameters?.required) ? fn.parameters.required : [],
    parameters: Object.keys(fn.parameters?.properties || {}),
    sideEffects: sideEffectsFor(name),
  };
}

async function main() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'self-tools.js')).href);
  const selfTools = Array.isArray(mod.SELF_TOOL_DEFS) ? mod.SELF_TOOL_DEFS : [];
  const widgetTools = Array.isArray(mod.DYNAMIC_WIDGET_TOOL_DEFS) ? mod.DYNAMIC_WIDGET_TOOL_DEFS : [];
  const tools = [
    ...selfTools.map(t => normalizeTool(t, 'self')),
    ...widgetTools.map(t => normalizeTool(t, 'dynamic-widget')),
  ].filter(t => t.name).sort((a, b) => a.name.localeCompare(b.name));

  const byCategory = tools.reduce((acc, tool) => {
    acc[tool.category] = (acc[tool.category] || 0) + 1;
    return acc;
  }, {});

  const catalog = {
    generatedAt: new Date().toISOString(),
    source: ['self-tools.js:SELF_TOOL_DEFS', 'self-tools.js:DYNAMIC_WIDGET_TOOL_DEFS'],
    count: tools.length,
    byCategory,
    tools,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`wrote ${path.relative(ROOT, OUT)} (${tools.length} tools)`);
}

main().catch(err => {
  console.error(err && err.stack || err);
  process.exit(1);
});
