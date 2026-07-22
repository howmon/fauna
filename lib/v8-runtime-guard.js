export const V8_SAFETY_MARKER = '--fauna-v8-safe-mode';

export const V8_SAFETY_FLAGS = [
  '--disable-optimizing-compilers',
  '--no-concurrent-recompilation',
  '--no-concurrent-sparkplug',
  '--no-maglev-build-code-on-background',
  '--no-maglev-deopt-data-on-background',
  '--no-maglev-destroy-on-background',
].join(' ');

export function buildV8SafetyRelaunchArgs(argv = process.argv) {
  const args = Array.isArray(argv) ? argv.slice(1) : [];
  if (args.includes(V8_SAFETY_MARKER)) return null;
  const existingV8Flags = args
    .filter(arg => String(arg).startsWith('--js-flags='))
    .map(arg => String(arg).slice('--js-flags='.length).trim())
    .filter(Boolean);
  return [
    ...args.filter(arg => !String(arg).startsWith('--js-flags=')),
    `--js-flags=${[...existingV8Flags, V8_SAFETY_FLAGS].join(' ')}`,
    V8_SAFETY_MARKER,
  ];
}