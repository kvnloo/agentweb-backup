// Stand-in for `claude auth login` (ENG-2110 tests). Behaviour chosen by argv[2].
const fs = require('fs'), path = require('path');
const mode = process.argv[2] || 'ok';
const GOOD = 'GOODCODE1#GOODSTATE1';
if (mode === 'nourl') { console.error('boom'); process.exit(1); }
console.log('Opening browser to sign in…');
if (mode === 'otherlink') console.log('Docs: https://example.com/help/login');
console.log('If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=fake&state=fakestate');
if (mode === 'exitsoon') { setTimeout(() => process.exit(0), 100); return; }
if (mode === 'hang') { setInterval(() => {}, 1000); return; }
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  if (!buf.includes('\n')) return;
  const line = buf.split('\n')[0];
  if (mode === 'crash') process.exit(0); // exits 0 but writes nothing
  if (line !== GOOD) { console.log('Login failed: Request failed with status code 400'); process.exit(1); }
  const creds = {
    claudeAiOauth: {
      accessToken: 'SENTINEL-ACCESS-' + process.pid, refreshToken: 'SENTINEL-REFRESH-' + process.pid,
      expiresAt: Date.now() + 8 * 3600e3, refreshTokenExpiresAt: Date.now() + 30 * 86400e3,
      scopes: ['user:inference'], subscriptionType: mode === 'malformed' ? undefined : 'max', rateLimitTier: 'default_claude_max_20x',
    },
    _env: Object.keys(process.env).sort(),
    _cwd: process.cwd(), _config: process.env.CLAUDE_CONFIG_DIR,
  };
  if (mode === 'malformed') delete creds.claudeAiOauth.refreshToken;
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify(creds), { mode: 0o600 });
  console.log('Login successful.');
  process.exit(0);
});
