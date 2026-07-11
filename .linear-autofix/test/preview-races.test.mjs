// Repro attempts for the unproven preview races #13 and #14. Pure/faithful — no real builds, no
// touching real preview state. (#20 was refuted by inspecting a live preview's real process group.)
import net from 'node:net';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// ── #13: freePort releases the probe socket BEFORE the caller binds, so a second allocation before
// the first service actually listens hands out the SAME port (→ vite --strictPort collision). ──
// Faithful copy of preview.mjs freePort.
function freePort(start) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(freePort(start + 1)));
    s.listen(start, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
console.log('#13 freePort hands out a duplicate port across bring-ups');
{
  const base = 52140;
  const a = await freePort(base);           // up#1 picks a port…
  // …and does NOT bind it yet (in real life: a multi-minute vite build runs before `vite preview` binds)
  const b = await freePort(base);           // up#2 picks a port in that window
  ok(a === b, `RACE REPRODUCED: two bring-ups both got port ${a} (freePort didn't hold it → --strictPort would collide)`);
}

// ── #14: evictToMakeRoom reads state fresh; up() writes its own entry only AFTER the (minutes-long)
// build, so two concurrent bring-ups both evaluate the cap against the SAME pre-write state and
// neither evicts → the cap is exceeded. Faithful copy of the decision in policy.evictToMakeRoom. ──
function evictDecision(stateKeys, target, cap) {
  const others = stateKeys.filter((b) => b !== target);
  const limit = Math.max(0, cap - 1);
  if (others.length <= limit) return 0;      // ← evicts nothing
  return others.length - limit;              // number it would evict
}
console.log('#14 concurrent forced bring-ups both skip eviction → cap exceeded');
{
  const CAP = 7;
  const live = ['a', 'b', 'c', 'd', 'e', 'f']; // 6 live previews, cap 7
  // up(X) and up(Y) both run evictToMakeRoom BEFORE either writes its own state entry:
  const evX = evictDecision(live, 'x', CAP);  // X sees 6 others → 6 <= 6 → evict 0
  const evY = evictDecision(live, 'y', CAP);  // Y sees the SAME 6 (neither wrote yet) → evict 0
  ok(evX === 0 && evY === 0, 'both bring-ups evict nothing (each sees the pre-write 6)');
  const finalCount = live.length + 2 - (evX + evY); // both then add themselves
  ok(finalCount > CAP, `RACE REPRODUCED: ends at ${finalCount} live previews, over the cap of ${CAP}`);
}

console.log(`\n${fail === 0 ? '✅ BOTH RACES REPRODUCED' : '❌ could not reproduce'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
