// Unit tests for path-portability — verifies that absolute project paths
// round-trip through portable tokens correctly on both posix and "windows-
// shaped" inputs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'os';
import path from 'path';

import {
  toPortable,
  fromPortable,
  serializeForWire,
  deserializeFromWire,
} from '../server/lib/path-portability.js';

// Force a deterministic "home" so the assertions don't depend on whoever
// runs the tests.
const FAKE_HOME = '/Users/alice';
const ORIG_HOME = process.env.FAUNA_TEST_HOME;

beforeEach(() => {
  process.env.FAUNA_TEST_HOME = FAKE_HOME;
});

afterEach(() => {
  if (ORIG_HOME === undefined) delete process.env.FAUNA_TEST_HOME;
  else process.env.FAUNA_TEST_HOME = ORIG_HOME;
});

describe('toPortable', () => {
  it('rewrites Fauna auto-folder paths to ${FAUNA_HOME}', () => {
    const r = toPortable('/Users/alice/Documents/Fauna/MyProj');
    expect(r.token).toBe('${FAUNA_HOME}/MyProj');
    expect(r.deviceLocal).toBe(false);
  });

  it('rewrites Documents paths to ${USER_DOCS}', () => {
    const r = toPortable('/Users/alice/Documents/Work/Repo');
    expect(r.token).toBe('${USER_DOCS}/Work/Repo');
    expect(r.deviceLocal).toBe(false);
  });

  it('rewrites home paths to ${HOME}', () => {
    const r = toPortable('/Users/alice/code/x');
    expect(r.token).toBe('${HOME}/code/x');
    expect(r.deviceLocal).toBe(false);
  });

  it('marks unknown roots as deviceLocal', () => {
    const r = toPortable('/opt/work/project');
    expect(r.token).toBe('/opt/work/project');
    expect(r.deviceLocal).toBe(true);
  });

  it('handles backslash input (windows-shaped)', () => {
    process.env.FAUNA_TEST_HOME = 'C:/Users/alice';
    const r = toPortable('C:\\Users\\alice\\Documents\\Fauna\\WinProj');
    expect(r.token).toBe('${FAUNA_HOME}/WinProj');
  });
});

describe('fromPortable', () => {
  it('resolves ${FAUNA_HOME} to the local fauna folder', () => {
    const r = fromPortable('${FAUNA_HOME}/MyProj');
    // path.join uses platform separator; on macOS that's '/'.
    expect(r.path).toBe(path.join(FAKE_HOME, 'Documents', 'Fauna', 'MyProj'));
    expect(r.deviceLocal).toBe(false);
  });

  it('resolves ${USER_DOCS}', () => {
    const r = fromPortable('${USER_DOCS}/Work/Repo');
    expect(r.path).toBe(path.join(FAKE_HOME, 'Documents', 'Work', 'Repo'));
  });

  it('resolves ${HOME}', () => {
    const r = fromPortable('${HOME}/code/x');
    expect(r.path).toBe(path.join(FAKE_HOME, 'code', 'x'));
  });

  it('flags raw absolute paths as deviceLocal', () => {
    const r = fromPortable('/opt/work/project');
    expect(r.path).toBe('/opt/work/project');
    expect(r.deviceLocal).toBe(true);
  });
});

describe('round-trip', () => {
  it('preserves Fauna folder paths', () => {
    const orig = '/Users/alice/Documents/Fauna/MyProj';
    const t = toPortable(orig);
    const back = fromPortable(t.token);
    expect(back.path).toBe(orig);
  });
});

describe('serializeForWire / deserializeFromWire', () => {
  it('rewrites rootPath inside a project object', () => {
    const project = {
      id: 'p1',
      name: 'My Project',
      rootPath: '/Users/alice/Documents/Fauna/My Project',
      sources: [
        { id: 's1', type: 'git', url: 'https://example.com/repo.git', clonePath: '/Users/alice/Documents/Fauna/My Project/src' },
      ],
    };
    const wire = serializeForWire(project, ['rootPath', 'clonePath']);
    expect(wire.rootPath).toBe('${FAUNA_HOME}/My Project');
    expect(wire.sources[0].clonePath).toBe('${FAUNA_HOME}/My Project/src');
    // Other fields untouched.
    expect(wire.id).toBe('p1');
    expect(wire.sources[0].url).toBe('https://example.com/repo.git');
  });

  it('annotates device-local paths with a flag', () => {
    const project = { id: 'p2', rootPath: '/opt/work/proj' };
    const wire = serializeForWire(project, ['rootPath']);
    expect(wire.rootPath).toBe('/opt/work/proj');
    expect(wire.rootPath_deviceLocal).toBe(true);
  });

  it('round-trips through both serialize and deserialize', () => {
    const project = {
      id: 'p3',
      rootPath: '/Users/alice/Documents/Fauna/Proj3',
      nested: { rootPath: '/Users/alice/Documents/Fauna/Proj3/sub' },
    };
    const wire = serializeForWire(project, ['rootPath']);
    const back = deserializeFromWire(wire, ['rootPath']);
    expect(back.rootPath).toBe(project.rootPath);
    expect(back.nested.rootPath).toBe(project.nested.rootPath);
  });

  it('preserves the deviceLocal flag through deserialize', () => {
    const wire = { rootPath: '/opt/x', rootPath_deviceLocal: true };
    const back = deserializeFromWire(wire, ['rootPath']);
    expect(back.rootPath).toBe('/opt/x');
    expect(back.rootPath_deviceLocal).toBe(true);
  });
});
