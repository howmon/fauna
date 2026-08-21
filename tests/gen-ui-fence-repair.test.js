import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { marked } from 'marked';

const source = fs.readFileSync(path.join(process.cwd(), 'public/js/markdown.js'), 'utf8');
const start = source.indexOf('function repairOrphanedGenUiFences');
const end = source.indexOf('\nfunction renderMarkdown', start);
const context = {};

vm.runInNewContext(
  source.slice(start, end) + '\n;globalThis.repairOrphanedGenUiFences = repairOrphanedGenUiFences;',
  context
);

const repairOrphanedGenUiFences = context.repairOrphanedGenUiFences;

describe('gen-ui fence recovery', () => {
  const json = '{"root":"card","elements":{"card":{"type":"Card","props":{},"children":[]}}}';

  it('repairs an orphaned gen-ui label into a fenced code block', () => {
    const repaired = repairOrphanedGenUiFences(`gen-ui\n${json}\n\`\`\``);
    const tokens = marked.lexer(repaired);

    expect(repaired).toBe(`\`\`\`gen-ui\n${json}\n\`\`\``);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ type: 'code', lang: 'gen-ui', text: json });
  });

  it('leaves valid and non-widget text unchanged', () => {
    const valid = `\`\`\`gen-ui\n${json}\n\`\`\``;
    const prose = 'gen-ui\nis a feature';
    const unclosed = `gen-ui\n${json}`;

    expect(repairOrphanedGenUiFences(valid)).toBe(valid);
    expect(repairOrphanedGenUiFences(prose)).toBe(prose);
    expect(repairOrphanedGenUiFences(unclosed)).toBe(unclosed);
  });
});
