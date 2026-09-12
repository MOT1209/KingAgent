// Unpacking an MCP bundle, per platform.
//
// The zip could not be an npm dependency without shipping a native module or
// a wasm blob for something the operating system already does, so each
// platform is asked in its own dialect:
//
//   macOS:  /usr/bin/unzip — ships with every Mac; what main.js always used
//   Windows: PowerShell's Expand-Archive, present on every Windows 10+,
//           via the same login shell every detection probe uses
//   Linux:  /usr/bin/unzip too, when this ever runs there
//
// unzip is not injectable here the way everything else in this file's family
// is — the injected boundary is `command`, which both tests and callers can
// stub to watch what would have run. The execFile timeout is the real
// boundary: a corrupt archive must fail, not hang the connect sheet.

const { execFile } = require('child_process');
const { loginShell, psQuote } = require('./platform.js');

function unzipCommand({ platform = process.platform, file, dir } = {}) {
  if (platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath ${psQuote(file)} -DestinationPath ${psQuote(dir)} -Force`;
    return { file: loginShell('win32').file, args: loginShell('win32').args(ps) };
  }
  return { file: '/usr/bin/unzip', args: ['-o', '-q', file, '-d', dir] };
}

function unzip({ platform = process.platform, file, dir, exec = execFile, timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const { file: bin, args } = unzipCommand({ platform, file, dir });
    exec(bin, args, { timeout: timeoutMs }, (err) => resolve(err ? (err.message.split('\n')[0] || 'unpack failed') : null));
  });
}

module.exports = { unzip, unzipCommand };
