import { describe, it, expect } from 'vitest';
import { isDevServerCommand } from '../server/lib/dev-server-registry.js';

// Regression coverage for the transcript where grep/find/curl/`vite build`
// were repeatedly misclassified as dev servers and detached, so the shell
// tool returned immediately with no output.
describe('isDevServerCommand()', () => {
  describe('real dev servers → true', () => {
    const yes = [
      'npm run dev',
      'npm start',
      'pnpm dev',
      'yarn dev -- --port 5173',
      'vite',
      'vite --host',
      'npx vite',
      'next dev -p 3000',
      'php -S 127.0.0.1:8000 -t public',
      'python -m http.server 8000',
      'tsx watch server/index.ts',
      'node server.js',
      'nodemon app.js',
      'docker compose up',
      'cd /tmp/app && npm run dev',
      'pkill -f vite; sleep 1; cd /tmp/app && npm run dev',
      'PORT=4000 npm run dev',
      'npm run preview',
    ];
    for (const cmd of yes) {
      it(`detects: ${cmd}`, () => expect(isDevServerCommand(cmd)).toBe(true));
    }
  });

  describe('one-shot / read-only commands → false', () => {
    const no = [
      // The exact false-positive shapes from the transcript.
      'grep -rn "npm run dev" .',
      'grep -rn "vite" package.json',
      'find . -name "server.ts"',
      'find . -path "*server*" -name "*.ts"',
      'curl -s http://localhost:3000/api/events',
      'curl http://127.0.0.1:5173/ | head',
      'npx vite build',
      'vite build',
      'next build',
      'npm run build',
      'npm test',
      'npm ci',
      'npm install',
      'tsc -b',
      'tsc --noEmit',
      'eslint src',
      'echo "next dev"',
      'cat server.js',
      'ls -la server/',
      'node --check server.js',
      'node -e "fetch(\'http://localhost:3000\')"',
      'git log --oneline',
      'pkill -f vite',
      'curl -s localhost:3000/api/events | grep visibility',
    ];
    for (const cmd of no) {
      it(`ignores: ${cmd}`, () => expect(isDevServerCommand(cmd)).toBe(false));
    }
  });

  it('handles empty / invalid input', () => {
    expect(isDevServerCommand('')).toBe(false);
    expect(isDevServerCommand(null)).toBe(false);
    expect(isDevServerCommand(undefined)).toBe(false);
    expect(isDevServerCommand(42)).toBe(false);
  });
});
