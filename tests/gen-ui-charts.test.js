import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { GEN_UI_CATALOG_PROMPT, GEN_UI_COMPACT_CATALOG } from '../server/prompts/gen-ui-catalog.js';

const source = fs.readFileSync(new URL('../public/js/gen-ui.js', import.meta.url), 'utf8');
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.dataset = {};
    this.innerHTML = '';
    this.textContent = '';
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  replaceChild(next, previous) {
    const index = this.children.indexOf(previous);
    if (index < 0) throw new Error('Missing child');
    this.children[index] = next;
    next.parentNode = this;
    previous.parentNode = null;
  }
}

function runtime() {
  const context = {
    document: {
      createElement: tag => new Element(tag),
      createTextNode: text => Object.assign(new Element('#text'), { textContent: text }),
    },
    window: {},
    escHtml: escapeHtml,
  };
  vm.runInNewContext(source, context);
  return context;
}

function descendants(node, tag) {
  return node.children.flatMap(child => [
    ...(child.tagName === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}

function content(node) {
  return node.innerHTML + escapeHtml(node.textContent) + node.children.map(content).join('');
}

const radar = { title: 'Exposure', max: 5, data: [{ label: 'Identity', value: 4 }, { label: 'Network', value: 2 }, { label: 'Data', value: 3 }] };
const heatmap = { data: [{ x: 'Mon', y: 'Team A', value: 0 }, { x: 'Tue', y: 'Team A', value: 5 }] };
const sankey = { nodes: ['Open', 'Triage', 'Closed'], links: [{ source: 'Open', target: 'Triage', value: 10 }, { source: 'Triage', target: 'Closed', value: 10 }] };
const scatter = { data: [{ label: 'A', x: -2, y: 3, value: 4 }, { label: 'B', x: 5, y: -1, value: 16 }] };
const fixtures = [
  ['RadarChart', radar, 'gui-radar-series'],
  ['SpiderChart', radar, 'gui-radar-series'],
  ['Heatmap', heatmap, 'gui-heatmap-cell'],
  ['HeatMap', heatmap, 'gui-heatmap-cell'],
  ['Sankey', sankey, 'gui-sankey-link'],
  ['SankeyChart', sankey, 'gui-sankey-link'],
  ['ScatterChart', scatter, 'gui-scatter-point'],
  ['BubbleChart', scatter, 'gui-scatter-point'],
];

function render(context, type, props, store = context._genUiCreateState({})) {
  return context._genUiRenderElement('chart', { chart: { type, props } }, store, 0);
}

describe('GenUI visualizer rendering', () => {
  it.each(['BarChart', 'LineChart', 'AreaChart', 'PieChart', 'DonutChart', 'RadialChart', 'Gauge'])(
    'preserves existing %s rendering',
    type => {
      const chart = render(runtime(), type, { data: radar.data, value: 3, max: 5 });
      expect(chart.className).toContain('gui-chart');
      expect(content(chart)).not.toMatch(/Invalid chart data|No data|NaN|Infinity/);
    },
  );

  it.each(fixtures)('renders %s with SVG geometry and inspectable data, not a placeholder', (type, props, geometry) => {
    const context = runtime();
    const chart = render(context, type, props);
    expect(chart.className).not.toBe('gui-unknown');
    expect(content(chart)).toContain(geometry);
    expect(content(chart)).toContain('role="img"');
    expect(descendants(chart, 'summary')[0].textContent).toBe('View chart data');
    expect(descendants(chart, 'table')).toHaveLength(1);
    expect(descendants(chart, 'th').every(cell => cell.attributes.scope === 'col')).toBe(true);
    expect(content(chart)).not.toMatch(/NaN|Infinity|undefined/);
    expect(context.GEN_UI_CATALOG_PROMPT).toContain('`' + type + '`');
  });

  it.each(fixtures)('updates bound state for %s', (type, props) => {
    const context = runtime();
    const key = type.startsWith('Sankey') ? 'links' : 'data';
    const store = context._genUiCreateState({ chartData: props[key] });
    const chart = render(context, type, { ...props, [key]: { $state: '/chartData' } }, store);
    const parent = new Element('div');
    parent.appendChild(chart);
    store.set('/chartData', []);
    expect(parent.children[0]).not.toBe(chart);
    expect(content(parent)).toContain('No data');
    expect(content(parent)).not.toContain('<svg');
  });

  it.each(fixtures)('shows a real empty state for %s', (type) => {
    expect(content(render(runtime(), type, {}))).toContain('No data');
  });

  it('renders radar axes, scale, and the expected normalized polygon', () => {
    const chart = render(runtime(), 'RadarChart', radar);
    expect(content(chart)).toContain('Scale: 0 - 5');
    expect(content(chart)).toContain('240,87');
    expect(descendants(chart, 'td').map(cell => cell.textContent)).toEqual([
      'Value', 'Identity', '4', 'Value', 'Network', '2', 'Value', 'Data', '3',
    ]);
  });

  it('supports multiple radar series with visible legends', () => {
    const chart = render(runtime(), 'SpiderChart', {
      axes: ['A', 'B', 'C'], min: 0, max: 5,
      series: [{ label: 'Current', values: [4, 3, 5] }, { label: 'Target', values: [1, 1, 2] }],
    });
    expect(content(chart).match(/class="gui-radar-series"/g)).toHaveLength(2);
    expect(chart.children.find(child => child.className === 'gui-chart-legend').children).toHaveLength(2);
    expect(content(chart)).toContain('Current');
    expect(content(chart)).toContain('Target');
  });

  it.each([
    { data: [1, 2] },
    { axes: ['A', 'B', 'C'], series: [{ values: [1, 2] }] },
    { data: [{ value: 1 }, { value: null }, { value: 3 }] },
    { ...radar, max: 0 },
    { ...radar, min: -1e308, max: 1e308 },
    { ...radar, data: [1, Infinity, 3] },
  ])('rejects invalid radar data rather than plotting made-up values', props => {
    expect(content(render(runtime(), 'RadarChart', props))).toContain('Invalid chart data');
  });

  it('honors heatmap order and keeps zero-valued and missing cells distinct', () => {
    const chart = render(runtime(), 'Heatmap', {
      ...heatmap, xLabels: ['Tue', 'Mon', 'Wed'], yLabels: ['Team A'], min: 0, max: 5,
    });
    const html = content(chart);
    expect(html.match(/class="gui-heatmap-cell"/g)).toHaveLength(2);
    expect(html).toContain('fill-opacity="0.12"');
    expect(html).toContain('fill-opacity="1"');
    expect(html).toContain('x="150" y="36"');
    expect(descendants(chart, 'td').map(cell => cell.textContent)).toContain('0');
  });

  it('handles constant and negative heatmap values without invalid geometry', () => {
    const chart = render(runtime(), 'HeatMap', { data: [{ x: 'A', y: 'B', value: -3 }] });
    expect(content(chart)).toContain('gui-heatmap-cell');
    expect(content(chart)).not.toMatch(/NaN|Infinity/);
  });

  it.each([
    { data: [{ x: 'A', y: 'B', value: 'bad' }] },
    { ...heatmap, xLabels: ['Other'] },
    { data: [{ x: 'A', y: 'B', value: 1 }, { x: 'A', y: 'B', value: 2 }] },
    { ...heatmap, min: 5, max: 1 },
    { ...heatmap, min: -1e308, max: 1e308 },
  ])('rejects invalid heatmap cells', props => {
    expect(content(render(runtime(), 'Heatmap', props))).toContain('Invalid chart data');
  });

  it('renders branched Sankey flows with proportional widths and index references', () => {
    const chart = render(runtime(), 'SankeyChart', {
      data: {
        nodes: [{ id: 'a', label: 'Input' }, { id: 'b', label: 'Resolved' }, { id: 'c', label: 'Escalated' }],
        links: [{ source: 0, target: 1, value: 6 }, { source: 0, target: 2, value: 3 }],
      },
    });
    const widths = [...content(chart).matchAll(/class="gui-sankey-link"[^>]+stroke-width="([^"]+)"/g)].map(match => Number(match[1]));
    expect(widths).toHaveLength(2);
    expect(widths[0] / widths[1]).toBeCloseTo(2);
    expect(descendants(chart, 'td').map(cell => cell.textContent)).toEqual([
      'Input', 'Resolved', '6', 'Input', 'Escalated', '3',
    ]);
  });

  it.each([
    { nodes: ['A', 'B'], links: [{ source: 'A', target: 'B', value: 1 }, { source: 'B', target: 'A', value: 1 }] },
    { nodes: ['A'], links: [{ source: 'A', target: 'A', value: 1 }] },
    { nodes: ['A', 'A'], links: [{ source: 0, target: 1, value: 1 }] },
    { nodes: ['A'], links: [{ source: 'A', target: 'Missing', value: 1 }] },
    { nodes: ['A', 'B'], links: [{ source: 0, target: 1, value: -1 }] },
  ])('rejects invalid Sankey flows explicitly', props => {
    expect(content(render(runtime(), 'Sankey', props))).toContain('Invalid chart data');
  });

  it('treats zero Sankey flow as empty, not as a fabricated link', () => {
    const chart = render(runtime(), 'Sankey', { nodes: ['A', 'B'], links: [{ source: 0, target: 1, value: 0 }] });
    expect(content(chart)).toContain('No data');
    expect(content(chart)).not.toContain('gui-sankey-link');
  });

  it('scales bubble area, not radius, by value', () => {
    const chart = render(runtime(), 'BubbleChart', scatter);
    const radii = [...content(chart).matchAll(/class="gui-scatter-point"[^>]+ r="([^"]+)"/g)].map(match => Number(match[1]));
    expect(radii).toEqual([9, 18]);
  });

  it('handles a single scatter point and clips points outside explicit bounds', () => {
    const context = runtime();
    expect(content(render(context, 'ScatterChart', { data: [{ x: 0, y: 0 }] }))).not.toMatch(/NaN|Infinity/);
    const chart = render(context, 'ScatterChart', { ...scatter, minX: 0, maxX: 10, xLabel: 'Cost', yLabel: 'Risk' });
    expect(content(chart).match(/class="gui-scatter-point"/g)).toHaveLength(1);
    expect(content(chart)).toContain('Cost');
    expect(content(chart)).toContain('Risk');
    expect(descendants(chart, 'td')).toHaveLength(6);
  });

  it.each([
    ['ScatterChart', { data: [{ x: null, y: 1 }] }],
    ['ScatterChart', { data: [{ x: 1, y: Infinity }] }],
    ['ScatterChart', { ...scatter, minX: 10, maxX: 0 }],
    ['ScatterChart', { data: [{ x: -1e308, y: 1 }, { x: 1e308, y: 2 }] }],
    ['BubbleChart', { data: [{ x: 1, y: 2, value: -1 }] }],
    ['BubbleChart', { data: [{ x: 1, y: 2 }] }],
  ])('rejects invalid coordinates for %s', (type, props) => {
    expect(content(render(runtime(), type, props))).toContain('Invalid chart data');
  });

  it.each(fixtures)('escapes labels and rejects markup in %s colors', (type, props) => {
    const unsafe = '"><script>alert(1)</script>';
    const next = {
      ...props, title: unsafe, color: unsafe,
      data: props.data?.map(d => ({ ...d, label: unsafe, color: unsafe, ...(d.x === 'Mon' ? { x: unsafe } : {}) })),
      nodes: props.nodes?.map(id => ({ id, label: unsafe, color: unsafe })),
    };
    const chart = render(runtime(), type, next);
    expect(content(chart)).not.toContain('<script>');
    expect(content(chart)).toContain('&lt;script&gt;');
  });

  it('renders the documented radar and Sankey examples through the real tree renderer', () => {
    const context = runtime();
    for (const catalog of [GEN_UI_CATALOG_PROMPT, GEN_UI_COMPACT_CATALOG, context.GEN_UI_CATALOG_PROMPT]) {
      const specs = (catalog.match(/^```gen-ui[ \t]*\r?\n[\s\S]*?^```/gm) || [])
        .filter(block => /"type":\s*"(RadarChart|Sankey)"/.test(block))
        .map(block => JSON.parse(block.replace(/^```gen-ui\s*|\s*```$/g, '')));
      const chartSpecs = specs.filter(spec => Object.values(spec.elements).some(el => ['RadarChart', 'Sankey'].includes(el.type)));
      expect(chartSpecs.length).toBeGreaterThan(0);
      for (const spec of chartSpecs) {
        for (const [id, el] of Object.entries(spec.elements)) {
          if (!['RadarChart', 'Sankey'].includes(el.type)) continue;
          const chart = context._genUiRenderElement(id, spec.elements, context._genUiCreateState({}), 0);
          expect(content(chart)).toContain('<svg');
          expect(content(chart)).not.toContain('Invalid chart data');
        }
      }
    }
  });
});
