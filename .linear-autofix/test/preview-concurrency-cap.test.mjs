// Tests for the hard concurrent-preview cap DECISION (atConcurrentPreviewCap / runningPreviewIds).
// The refusal itself is effectful (an exit in preview.mjs up(), a 409 in the chat server); proving the
// decision proves both gates. A preview a task already owns never counts against it (re-up is free),
// and in-flight `starting` placeholders DO count (they hold a slot).
// Run: node test/preview-concurrency-cap.test.mjs
import { atConcurrentPreviewCap, runningPreviewIds } from '../preview/policy.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

// preview-state is keyed lowercase.
const three = { 'eng-1': {}, 'eng-2': {}, 'eng-3': {} };
const two = { 'eng-1': {}, 'eng-2': {} };

console.log('atConcurrentPreviewCap (cap = 3)');
{
  ok(atConcurrentPreviewCap('eng-9', 3, {}) === false, 'nothing running → allowed');
  ok(atConcurrentPreviewCap('eng-9', 3, two) === false, '2 others running → allowed (under cap)');
  ok(atConcurrentPreviewCap('eng-9', 3, three) === true, '3 OTHER previews running → refused (at cap)');
  ok(atConcurrentPreviewCap('ENG-9', 3, three) === true, 'identifier case-insensitive → still refused');
}

console.log('re-enabling an issue that already has a preview');
{
  // eng-2 is one of the three already up; re-upping it isn't a new stack → 2 others → allowed.
  ok(atConcurrentPreviewCap('eng-2', 3, three) === false, 'issue already among the 3 → its own re-up is NOT capped');
  ok(atConcurrentPreviewCap('ENG-2', 3, three) === false, 'same, case-insensitive');
}

console.log('in-flight placeholders hold a slot');
{
  const withStarting = { 'eng-1': {}, 'eng-2': {}, 'eng-3': { starting: true } };
  ok(atConcurrentPreviewCap('eng-9', 3, withStarting) === true, 'a starting placeholder counts toward the cap → refused');
}

console.log('cap disabled / boundaries');
{
  ok(atConcurrentPreviewCap('eng-9', 0, three) === false, 'cap 0 disables the limit → always allowed');
  ok(atConcurrentPreviewCap('eng-9', 1, { 'eng-1': {} }) === true, 'cap 1 with 1 other running → refused');
  ok(atConcurrentPreviewCap('eng-1', 1, { 'eng-1': {} }) === false, 'cap 1 but the only preview is this issue → allowed');
}

console.log('runningPreviewIds excludes self');
{
  ok(JSON.stringify(runningPreviewIds('eng-2', three).sort()) === JSON.stringify(['eng-1', 'eng-3']), 'lists the OTHER running previews only');
  ok(runningPreviewIds('eng-9', three).length === 3, 'a non-running issue sees all 3 as others');
}

console.log(`\n${fail === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
