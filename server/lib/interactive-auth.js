export function normalizeInteractiveAuthCommand(toolName, args = {}) {
  if (toolName !== 'fauna_shell_exec' && toolName !== 'fauna_terminal') return args;
  const commandKey = typeof args.command === 'string' ? 'command' : typeof args.input === 'string' ? 'input' : null;
  if (!commandKey || !/\bcowork\s+auth\s+login\b/i.test(args[commandKey])) return args;

  const normalized = args[commandKey]
    .replace(/\s+--device-code(?:=(?:"[^"]*"|'[^']*'|\S+))?/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return normalized === args[commandKey] ? args : { ...args, [commandKey]: normalized };
}