import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  commandWithPackageScript,
  commandWorkingDirectory,
  electronDevServerTarget,
  isDevServerCommand,
  isTcpPortListening,
  maybeRegister,
  requestedDevServerPort,
  sameServerCwd,
  waitForStartup,
} from '../server/lib/dev-server-registry.js';

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 1234;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  return child;
}

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

  it('extracts explicit dev-server ports', () => {
    expect(requestedDevServerPort('npx vite --port 5173')).toBe(5173);
    expect(requestedDevServerPort('PORT=4000 npm run dev')).toBe(4000);
    expect(requestedDevServerPort('php -S 127.0.0.1:8080')).toBe(8080);
    expect(requestedDevServerPort('wait-on tcp:5173 && electron .')).toBe(5173);
    expect(requestedDevServerPort('npm run dev')).toBeNull();
  });

  it('inspects the selected package script before launching', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fauna-dev-script-'));
    try {
      fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({
        scripts: { dev: 'concurrently -k "vite" "wait-on tcp:5173 && electron ."' },
      }));
      const inspected = commandWithPackageScript('npm run dev', cwd);
      expect(inspected).toContain('wait-on tcp:5173');
      expect(requestedDevServerPort(inspected)).toBe(5173);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('uses an explicit command cd as the launch project directory', () => {
    expect(commandWorkingDirectory('cd /tmp/bible-study && npm run dev', '/tmp/other'))
      .toBe('/tmp/bible-study');
    expect(commandWorkingDirectory('cd "./Bible Study" && npm run dev', '/tmp'))
      .toBe('/tmp/Bible Study');
  });

  it('extracts local Electron dev-server targets', () => {
    expect(electronDevServerTarget('VITE_DEV_SERVER_URL=http://localhost:5173 npx electron .'))
      .toEqual({ url: 'http://localhost:5173', port: 5173 });
    expect(electronDevServerTarget('npx electron .')).toBeNull();
  });

  it('compares normalized project working directories', () => {
    expect(sameServerCwd('/tmp/app', '/tmp/app/.')).toBe(true);
    expect(sameServerCwd('/tmp/app-a', '/tmp/app-b')).toBe(false);
  });

  it('detects an occupied TCP port', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    expect(await isTcpPortListening(address.port)).toBe(true);
    await new Promise((resolve) => server.close(resolve));
    expect(await isTcpPortListening(address.port)).toBe(false);
  });
});

describe('waitForStartup()', () => {
  it('reports running only after the registry observes a listening URL', async () => {
    const child = fakeChild();
    const id = maybeRegister(child, { command: 'npm run dev', cwd: '/tmp/app' });
    const pending = waitForStartup(id, { timeoutMs: 200 });

    child.stdout.write('Local: http://localhost:5173/\n');

    await expect(pending).resolves.toMatchObject({ status: 'running', port: 5173 });
  });

  it('reports an early process exit instead of startup success', async () => {
    const child = fakeChild();
    const id = maybeRegister(child, { command: 'npm run dev', cwd: '/tmp/app' });
    const pending = waitForStartup(id, { timeoutMs: 200 });

    child.emit('exit', 1, null);

    await expect(pending).resolves.toMatchObject({ status: 'exited', exitCode: 1 });
  });

  it('leaves readiness explicitly unverified when startup times out', async () => {
    const child = fakeChild();
    const id = maybeRegister(child, { command: 'npm run dev', cwd: '/tmp/app' });

    await expect(waitForStartup(id, { timeoutMs: 5 })).resolves.toMatchObject({ status: 'starting' });
    child.emit('exit', 0, null);
  });
});
