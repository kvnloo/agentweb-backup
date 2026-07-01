// .linear-autofix/config.mjs
// Edit these to match your Linear workspace and preferences.

export const config = {
  // --- Linear ---
  bugLabel: 'Bug',                 // label that marks an issue as an auto-fixable bug
  teamKey: null,                   // e.g. 'ENG' to scope to one team; null = whole workspace
  pickupStateTypes: ['backlog', 'unstarted'], // issue state types the poller picks up
  assigneeEmails: [                // the poller ONLY picks up bugs assigned to these Linear users
    'hshah@argusoft.com',          // Harshit Shah
    'mvarma@argusoft.com',         // Manan Varma
    'aseth@argusoft.com',          // Anurag Seth
  ],                               // set to null/[] to pick up bugs regardless of assignee
  inProgressState: 'In Progress',  // moved here on pickup (guards against re-processing)
  reviewState: 'In Review',        // moved here ONLY when triage is green (see triageLabels)
  gcDoneStateTypes: ['completed', 'canceled'], // gc.mjs removes a kept worktree once its issue reaches one of these state types

  // Triage labels set on the issue after each run, so the board answers "what do I do with
  // this?" at a glance. Only `green` advances the issue to In Review.
  //   green  → review sound + fix verified in a REAL browser + deterministic checks pass:
  //            skim the PR and merge; no manual testing needed.
  //   manual → fix committed but NOT browser-verified (env down / inconclusive / api-only):
  //            run the manual steps from the comment before merging. Stays In Progress.
  //   rework → a gate failed (manager needs_rework, browser not_fixed, or a deterministic
  //            check failed): needs human rework. Stays In Progress.
  triageLabels: {
    green: 'autofix:green',
    manual: 'autofix:needs-manual-test',
    rework: 'autofix:needs-rework',
    cannotFix: 'autofix:cannot-fix',
  },

  // --- Fixability gate (BEFORE the issue is touched) ---
  // A cheap triage pass reads the issue text and decides: fixable by a code change now, or
  // blocked on an external action (disconnected third-party account, pending credentials, a
  // named person's to-do)? Blocked bugs get `blockedLabel` + an explanatory comment and are
  // LEFT IN THEIR CURRENT STATE (never moved to In Progress, no 2h fixer run burned). The
  // poller skips issues carrying the label; remove the label once the blocker is resolved
  // and the next cycle picks the bug up fresh. `--force` bypasses the gate on manual runs.
  fixabilityGate: {
    enabled: true,
    model: 'sonnet',
    blockedLabel: 'autofix:blocked',
    maxTurns: 8,
    timeoutMs: 5 * 60 * 1000,
  },

  // --- Poller ---
  maxConcurrent: 2,                // bugs fixed in parallel per poll cycle (worktrees, branches, and
                                   // preview ports are isolated per bug; 1 = old sequential behavior)
  staleInProgressHours: 6,         // an issue autofix STARTED (recorded in state.json) still In Progress
                                   // this long with no final outcome = a crashed run; poll.mjs resets it for
                                   // ONE retry, then flags it for a human. Issues moved to In Progress by
                                   // humans are never touched. Keep this above the worst-case pipeline
                                   // duration (fix 2h + review + verify ≈ 3.5h). 0 = off.

  // --- Repositories ---
  // All repos are assembled into ONE project workspace per bug, mirroring your local layout,
  // so Claude sees the FULL project for context and fixes/PRs whichever repo(s) the bug touches.
  // The FIRST entry is the workspace root; later entries are nested at their `mount` path.
  // Each is its own git repo with its own GitHub remote, so each PR lands in the right place.
  repos: [
    {
      key: 'main', root: '.', base: 'main', mount: '.',
      description: 'backend/ (Node/TypeScript Express API, DynamoDB, webhooks, agent-mode) + partner-portal/ (admin/partner React UI)',
    },
    {
      key: 'customer-portal', root: './customer-portal', base: 'main', mount: 'customer-portal',
      description: 'end-user React/TypeScript app (separate repo, nested at ./customer-portal): tasks, chat, marketing hub, settings, billing, etc.',
    },
  ],

  // --- Git / GitHub ---
  branchPrefix: 'autofix/',        // branch = <prefix><identifier>-<slug>, used in every changed repo
  worktreesDir: '../autofix-worktrees', // relative to the agentweb repo root; OUTSIDE the repos
  cleanupWorktreeOnSuccess: false, // keep the workspace after a PR so you can preview/test it; remove it yourself when done (see README "Testing a fix")

  // --- Preview proxy ---
  // The proxy listens on one fixed port per portal; the bug-id host picks the bug, the port
  // picks the portal. So `<bug>.<ip>.nip.io:5173` = that bug's partner portal, `:5174` = its
  // customer portal, `:3001` = its API — and many bugs coexist (host differentiates them).
  // Matches the project's conventional dev ports. Open all three in the EC2 security group.
  previewPorts: { partner: 5173, customer: 5174, api: 3001 },
  keepPreviewUp: true,             // after browser-verify, LEAVE each bug's full preview running so its
                                   // nip.io URL stays live to open. Only applies when the worktree is kept
                                   // (cleanupWorktreeOnSuccess: false); gc.mjs stops it once the issue is
                                   // Done/Canceled. Previews are watcher-free static builds (see
                                   // preview.mjs), so kept previews are cheap on RAM and inotify.
                                   // Set false to tear the preview down immediately after verify.

  // --- Claude ---
  defaultModel: 'opus',            // the fixer model
  opusModel: 'opus',
  opusLabels: ['opus', 'hard', 'complex'], // any of these labels on the issue → use Opus for it
  escalateToOpus: true,            // if the default model finishes with no committed change (the "heavy bug"
                                   // signal — e.g. it ran out of budget mid-fix), automatically re-run the
                                   // SAME workspace with Opus to finish the job. Skipped if already on Opus —
                                   // so this is DORMANT while defaultModel === 'opus'; it re-activates
                                   // automatically if defaultModel is lowered (e.g. back to 'sonnet').
  skipPermissions: true,           // required for unattended runs; the fix is confined to an isolated
                                   // workspace and PRs are draft-only (human review is the safety net)
  maxTurns: 400,                   // raised alongside the 2h timeout below so wall-clock, not turns, is the cap
  timeoutMs: 2 * 60 * 60 * 1000,   // hard cap per bug (2h) — SIGKILLs claude; also the cap for the Opus retry

  // --- Deterministic post-fix checks (run by the ORCHESTRATOR, not the agents) ---
  // After the last code-modifying stage, autofix.mjs itself runs the typecheck in every changed
  // package and jest on the CHANGED TEST FILES in backend, and uses THOSE results in the test
  // report and the triage gate — an agent's self-reported "pass" is never trusted on its own.
  // A failed check forces triage to `rework`. (tsc gets a 4GB heap; --findRelatedTests was
  // dropped after ENG-129: hub-file blast radius pulls in pre-existing unrelated failures.)
  checks: {
    enabled: true,
    tscTimeoutMs: 5 * 60 * 1000,   // per-package `npx tsc --noEmit`
    jestTimeoutMs: 10 * 60 * 1000, // backend `npx jest <changed test files>`
  },

  // --- Code review gate (multi-agent) ---
  // After the fixer commits (but BEFORE the PR opens and BEFORE browser verify), N expert
  // reviewers inspect the diff in parallel, a manager adversarially verifies their findings
  // (real & must-fix vs noise), and a re-fix pass applies the confirmed ones — then the final
  // browser test runs and the draft PR opens on the reviewed code.
  review: {
    enabled: true,
    model: 'sonnet',               // the expert lens reviewers — the Opus manager filters their noise,
                                   // so a cheaper model here saves ~4 Opus runs per bug at little cost
    managerModel: 'opus',          // the verifier that gates which findings get fixed
    refixModel: 'opus',            // the pass that MODIFIES code (applies confirmed findings / rework)
    lenses: ['correctness', 'conventions', 'security', 'tests'], // which expert lenses to run (de-duped)
    autoScaleLenses: true,         // skip lenses that cannot apply to the diff: security on docs/styles-only
                                   // diffs; tests when neither backend logic nor test files changed
    recheckAfterRework: true,      // a needs_rework verdict triggers a rework pass, then the manager
                                   // re-checks the result ONCE (bounded) before the verdict is final
    parallel: true,                // run the reviewers concurrently; set false to run them one at a
                                   // time (slower, but avoids concurrent claude processes sharing the
                                   // one worktree — note true isolation isn't possible while the
                                   // subscription login lives in the shared claude config dir)
    maxTurns: 60,                  // per reviewer / manager / re-fix pass
    timeoutMs: 20 * 60 * 1000,     // per reviewer / manager / re-fix pass
    maxDiffChars: 60000,           // truncate a huge per-repo diff injected into reviewer prompts
  },

  // --- Browser verification (Playwright) ---
  // After the code-review gate and BEFORE the PR opens, bring up a full preview and drive a real
  // browser to confirm the bug is gone; the verdict + screenshots are attached to the draft PR and
  // Linear. A deterministic HTTP preflight runs first — if the preview isn't healthy the agent run
  // is skipped entirely (verdict `env_down`, triage `manual`) instead of burning a long run against
  // a dead environment. The PR opens regardless of the verdict; the verdict drives triage.
  verify: {
    enabled: true,
    model: 'opus',
    retryNotFixed: true,             // a not_fixed verdict triggers ONE re-fix (fed the verify failure
                                     // report as the finding) followed by ONE re-verify, then it's final
    testEmail: 'test@example.com',
    testPassword: 'Test123!',
    postCredsInComment: false,       // false: the manual-test comment references the shared test
                                     // account by email only (password left to the team vault /
                                     // CLAUDE.md) — avoids posting a plaintext password on
                                     // customer-reported issues. Set true to inline the password.
    maxTurns: 40,
    timeoutMs: 12 * 60 * 1000,
  },

  // --- Human revision loop ---
  // A Linear comment starting with the trigger (e.g. "revise: also cover the empty-cart case")
  // on an already-fixed issue asks the automation to apply that feedback to the existing
  // branch/PR. poll.mjs detects it each cycle and runs revise.mjs, which rebuilds the workspace
  // from the pushed branch if needed, applies the change, pushes to the open PR(s), re-runs the
  // deterministic checks, and comments back. Full review/verify gates are NOT re-run.
  revise: {
    enabled: true,
    trigger: 'revise:',
    model: 'opus',
    maxTurns: 100,
    timeoutMs: 30 * 60 * 1000,
  },
};
