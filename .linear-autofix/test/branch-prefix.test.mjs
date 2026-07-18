// Tests for assigneeBranchPrefix — a fix's branch is prefixed with the assignee's FIRST NAME so it reads
// as their work (matching the commits/PR already attributed to them). Run: node test/branch-prefix.test.mjs
import { assigneeBranchPrefix } from '../autofix.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log('assigneeBranchPrefix');
{
  ok(assigneeBranchPrefix({ name: 'Manan Varma', email: 'mvarma@argusoft.com' }, 'autofix/') === 'manan/', 'first name only, lowercased → "manan/"');
  ok(assigneeBranchPrefix({ name: 'Anurag Seth' }, 'autofix/') === 'anurag/', 'multi-word name → first word only');
  ok(assigneeBranchPrefix({ name: 'Harshit' }, 'autofix/') === 'harshit/', 'single-word name works');

  // fallbacks — no resolvable assignee name → the provided fallback (config.branchPrefix)
  ok(assigneeBranchPrefix(null, 'autofix/') === 'autofix/', 'null identity → fallback');
  ok(assigneeBranchPrefix({ name: '' }, 'autofix/') === 'autofix/', 'empty name → fallback');
  ok(assigneeBranchPrefix({ email: 'x@y.com' }, 'autofix/') === 'autofix/', 'name missing → fallback');
  ok(assigneeBranchPrefix({ name: '   ' }, 'autofix/') === 'autofix/', 'whitespace-only name → fallback');

  // kebab-safety: never emit a name that would make an invalid/odd branch segment
  ok(assigneeBranchPrefix({ name: "O'Brien Pat" }, 'autofix/') === 'o-brien/', "apostrophe → kebab-safe 'o-brien/'");
  ok(assigneeBranchPrefix({ name: 'José Díaz' }, 'autofix/') === 'jos/', 'accented chars stripped (kebab)');
}

console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed, ${fail} failed` : `\n✅ ALL PASSED — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
