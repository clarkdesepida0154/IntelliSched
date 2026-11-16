// Phase 12.2 (decision 3): whether this process runs elevated (as administrator) and as whom.
// On Windows the token's integrity level decides: High (S-1-16-12288) or System (S-1-16-16384) is
// elevated, Medium (S-1-16-8192) is a normal user. Read once from `whoami /groups` (about 50 ms)
// and kept. Elsewhere: root is elevated.
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let cached;
const processIdentity = () => {
  if (cached) return cached;
  let user = null;
  try { user = os.userInfo().username; } catch { /* no account name */ }
  const domain = process.env.USERDOMAIN || null;
  let elevated = null;
  let integrity = null;
  if (process.platform === 'win32') {
    const whoami = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe');
    const r = spawnSync(whoami, ['/groups', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const out = r.stdout || '';
    if (/S-1-16-16384/.test(out)) integrity = 'system';
    else if (/S-1-16-12288/.test(out)) integrity = 'high';
    else if (/S-1-16-8192/.test(out)) integrity = 'medium';
    else if (/S-1-16-4096/.test(out)) integrity = 'low';
    elevated = integrity ? integrity === 'high' || integrity === 'system' : null;
  } else if (typeof process.getuid === 'function') {
    elevated = process.getuid() === 0;
  }
  cached = { user, domain, elevated, integrity, pid: process.pid };
  return cached;
};

const isElevated = () => processIdentity().elevated === true;

module.exports = { processIdentity, isElevated };
