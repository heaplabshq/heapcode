// node-pty's prebuilt spawn-helper is published without its execute bit, and
// on macOS every pty.spawn then fails with "posix_spawnp failed". Put it back.
const fs = require('node:fs');
const path = require('node:path');

let root;
try { root = path.dirname(require.resolve('node-pty/package.json')); } catch { process.exit(0); }
const prebuilds = path.join(root, 'prebuilds');
if (!fs.existsSync(prebuilds)) process.exit(0);
for (const dir of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, dir, 'spawn-helper');
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}
