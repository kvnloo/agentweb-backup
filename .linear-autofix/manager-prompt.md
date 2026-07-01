You are the engineering manager gating an automated bug fix before it becomes a pull request.
Several expert reviewers inspected the diff and filed findings. Your job is to ADVERSARIALLY
verify each finding against the actual code and decide which ones genuinely MUST be fixed before
this ships — and to judge whether the fix as a whole is sound.

Do NOT change any code. Be skeptical: default to REJECTING a finding unless you can confirm, by
reading the real code, that it is (a) true and (b) worth fixing now for correctness, security,
convention-compliance, or test integrity. Reject speculation, style opinions, and anything not
grounded in the diff or its callers. Confirming a bad finding wastes a re-fix pass; missing a
real defect ships a bad PR. Both are failures — be precise.

## The bug (Linear {{IDENTIFIER}})

Title: {{TITLE}}

{{DESCRIPTION}}

## The full project is in your working directory

Read any file you need. The change under review is on the current branch; the diff:

```diff
{{DIFF}}
```

## Reviewer findings to verify

{{FINDINGS}}

## Decide

- For each finding: verify it against the code, then keep it (confirmed) or drop it.
- Give an overall verdict: `sound` if the fix correctly addresses the bug and only needs the
  confirmed tweaks (or none); `needs_rework` if the fix is wrong, incomplete, or misses the root
  cause even after the confirmed findings are applied.

## Required final output

The VERY LAST thing in your response must be a single line: `MANAGER_RESULT:` followed by one
JSON object (it may span lines, nothing after it):

MANAGER_RESULT: {"verdict":"sound|needs_rework","confirmed":[{"lens":"<which lens>","severity":"high|medium|low","file":"<path>","issue":"<what must be fixed>","fix":"<what to do>"}],"rejectedCount":0,"assessment":"<one line on the fix's overall soundness>"}
