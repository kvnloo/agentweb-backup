// Tests for the self-healing cross-process lock (lock.mjs). Uses real lock files in chat/locks.
// Run: node test/lock.test.mjs
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, releaseLock, lockActive } from '../lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCKS = path.join(__dirname, '..', 'chat', 'locks');
mkdirSync(LOCKS, { recursive: true });
const ID = 'ZZTEST-99'; // an id no real issue uses
const lp = (s) => path.join(LOCKS, `${ID}${s ? `.${s}` : ''}.lock`);
const cleanup = () => { for (const s of ['', 'preview']) { try { rmSync(lp(s)); } catch {} } };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

cleanup();

console.log('lock.mjs — self-healing cross-process lock');
{
  // acquire → held; second acquire → null (mutual exclusion)
  const a = acquireLock(ID);
  ok(a && existsSync(a), 'acquire creates the lock file');
  ok(lockActive(ID) === true, 'lockActive true while held by this (live) process');
  const b = acquireLock(ID);
  ok(b === null, 'second acquire returns null (mutual exclusion — the holder PID is alive)');

  // release → free again
  releaseLock(a);
  ok(!existsSync(a), 'release removes the lock file');
  ok(lockActive(ID) === false, 'lockActive false after release');
  const c = acquireLock(ID);
  ok(c && existsSync(c), 're-acquire succeeds after release');
  releaseLock(c);
}

{
  // a lock owned by a DEAD pid is reclaimable immediately (crash never wedges the issue)
  writeFileSync(lp(''), JSON.stringify({ pid: 2147483646, at: new Date().toISOString() })); // pid that can't exist
  ok(lockActive(ID) === false, 'lockActive false for a dead-PID holder (crash self-heals)');
  const d = acquireLock(ID);
  ok(d && existsSync(d), 'acquire reclaims a dead-PID lock');
  releaseLock(d);
}

{
  // a lock with NO pid and a stale timestamp is reclaimable; a fresh one is not
  writeFileSync(lp(''), JSON.stringify({ at: new Date(Date.now() - 20 * 60 * 1000).toISOString() })); // 20m old, no pid
  ok(lockActive(ID) === false, 'lockActive false for a stale no-pid lock (>10m)');
  const e = acquireLock(ID);
  ok(e, 'acquire reclaims a stale no-pid lock');
  releaseLock(e);
}

{
  // preview (suffixed) lock is independent of the exclusion lock but still makes the id "active" for gc
  const main = acquireLock(ID);
  const prev = acquireLock(ID, { suffix: 'preview' });
  ok(main && prev, 'exclusion lock and preview lock coexist (different files)');
  releaseLock(main);
  ok(lockActive(ID) === true, 'lockActive still true from the preview lock alone (gc stays away)');
  releaseLock(prev);
  ok(lockActive(ID) === false, 'lockActive false once both are released');
}

cleanup();
console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
