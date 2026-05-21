// Shell execution environment constants.
//
// `AUGMENTED_PATH` extends PATH with Homebrew + common Unix locations so
// shelled-out commands like `git`, `gh`, `npm`, `node` can find binaries
// installed outside the Electron app's reduced PATH. `SHELL_BIN` picks
// PowerShell on Windows and zsh elsewhere.

export function buildShellEnv(isWin) {
  const augmentedPath = isWin
    ? (process.env.PATH || '')
    : [
        '/opt/homebrew/bin', '/opt/homebrew/sbin',
        '/usr/local/bin', '/usr/local/sbin',
        '/usr/bin', '/usr/sbin', '/bin', '/sbin',
        process.env.PATH || ''
      ].join(':');
  const shellBin = isWin ? 'powershell.exe' : '/bin/zsh';
  return { augmentedPath, shellBin };
}
