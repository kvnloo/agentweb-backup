// .linear-autofix/config.mjs
// Edit these to match your Linear workspace and preferences.

export const config = {
  // --- Linear ---
  bugLabel: 'Bug',                 // label that marks an issue as an auto-fixable bug
  forceLabel: 'autofix',           // an explicit "do it now" label: any not-yet-picked issue carrying it
                                   // is fixed IMMEDIATELY, bypassing the maxOpenBugs cap and the one-per-cycle
                                   // pacing. Already-tracked issues (a state.json entry exists) are ignored,
                                   // so accidentally re-labelling a handled bug never re-triggers it. null = off.
  teamKey: null,                   // e.g. 'ENG' to scope to one team; null = whole workspace
  pickupStateTypes: ['backlog', 'unstarted'], // issue state types the poller picks up
  assigneeEmails: [                // the poller ONLY picks up bugs assigned to these Linear users
    'hshah@argusoft.com',          // Harshit Shah
    'mvarma@argusoft.com',         // Manan Varma
    'aseth@argusoft.com',          // Anurag Seth
  ],                               // set to null/[] to pick up bugs regardless of assignee
  // Attribute the automated fix's commits to the issue's ASSIGNEE (not the runner box), so git
  // history + the GitHub contribution graph credit the person the bug was assigned to. Author AND
  // committer are set. Identity resolution: an explicit override in `assigneeGitIdentity` (keyed by
  // Linear email) wins; otherwise the assignee's own Linear name + email is used; an unassigned
  // issue keeps the box's default git identity. Set commitAsAssignee: false to always use the box.
  // NOTE: GitHub only links a commit to a profile when the author email is one VERIFIED on that
  // GitHub account — override an entry below with the person's GitHub-verified/noreply email if
  // their Linear email isn't on their GitHub account.
  commitAsAssignee: true,
  assigneeGitIdentity: {
    'hshah@argusoft.com':  { name: 'Harshit Shah', email: 'hshah@argusoft.com' },
    'mvarma@argusoft.com': { name: 'Manan Varma',  email: 'mvarma@argusoft.com' },
    'aseth@argusoft.com':  { name: 'Anurag Seth',  email: 'aseth@argusoft.com' },
  },
  // Open the draft PR AS the assignee too — not just its commits. Commit attribution above is
  // only git metadata; GitHub ties PR authorship to the API token, so this needs a real GitHub
  // token per person. Tokens live in .linear-autofix/.env (gitignored, sourced by run.sh) — the
  // map below references each one BY ENV-VAR NAME, never the literal token (this file is committed).
  // Each token needs classic `repo` scope (fine-grained: Pull requests + Contents, read & write)
  // on BOTH agentweb AND customer-portal, since one fix can span both repos. Used by the pipeline
  // AND the chat UI's full-mode turns (if the agent opens a PR there). If a person has no token
  // configured (env var unset/empty) or prAsAssignee is false, that PR falls back to the runner
  // box's own `gh` account — commits are still attributed to the assignee regardless. So this is a
  // safe no-op until the tokens are added.
  prAsAssignee: true,
  assigneeGhTokenEnv: {
    'hshah@argusoft.com':  'GH_TOKEN_HSHAH',
    'mvarma@argusoft.com': 'GH_TOKEN_MVARMA',
    'aseth@argusoft.com':  'GH_TOKEN_ASETH',
  },
  // The GitHub login each person's token MUST authenticate as — used by check-creds.mjs to catch a
  // swapped or expired token (a token in the wrong env var mis-attributes PRs silently otherwise).
  assigneeGithubLogin: {
    'hshah@argusoft.com':  'harshit-argusoft',
    'mvarma@argusoft.com': 'mananv-argusoft',
    'aseth@argusoft.com':  'anurag-seth',
  },
  // Change the Linear card's STATUS (and post the automation's comments/labels) AS the assignee, using
  // their own Linear API key — mirrors the per-person GitHub tokens above, so the board shows the state
  // change coming from the assignee, not a shared bot. Keys live in .linear-autofix/.env (gitignored,
  // sourced by run.sh); the map references each BY ENV-VAR NAME, never the literal key (this file is
  // committed). Each key is a Linear personal API key for that member. READS always use the default
  // LINEAR_API_KEY (the poller must see every assignee's issues) — only the attributed writes switch.
  // If a person has no key configured (env var unset/empty) or statusAsAssignee is false, their card
  // actions fall back to the default key — a safe no-op until the keys are added. System actions
  // (crash-recovery notes in poll.mjs) always use the default key.
  statusAsAssignee: true,
  assigneeLinearKeyEnv: {
    'hshah@argusoft.com':  'LINEAR_KEY_HSHAH',
    'mvarma@argusoft.com': 'LINEAR_KEY_MVARMA',
    'aseth@argusoft.com':  'LINEAR_KEY_ASETH',
  },

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
  maxOpenBugs: 15,                 // WIP cap: max bugs autofix keeps "in the list" (state.json entries — the
                                   // same list the chat UI shows). At/over this, the poller picks NO new bugs.
                                   // A slot frees when a human marks the issue Done/Canceled and gc.mjs deletes
                                   // its entry. Prevents an unbounded pile of un-merged fixes.
  maxPicksPerCycle: 1,             // when there's room under maxOpenBugs, how many NEW bugs to pick per poll
                                   // cycle (every 5 min). 1 = drain the backlog one-by-one as slots free up.
  maxForcedConcurrent: 0,          // how many `forceLabel` ("autofix") bugs run at once. 0 = unlimited (all of
                                   // them in parallel — they're urgent). Each fix is heavy (~4GB tsc + a browser);
                                   // the runner is now a t3.2xlarge (8 vCPU / 32GB), so a handful in parallel is
                                   // fine — but a big burst can still exhaust RAM. Set a positive number here to
                                   // cap parallel forced runs if the box struggles.
  maxConcurrent: 1,                // NON-forced bugs fixed in parallel per poll cycle. ONE pipeline already fans
                                   // out hard (parallel reviewers, 4GB tsc check, preview builds, verify browser);
                                   // 2 concurrent bugs OOM-stalled the OLD 16GB t3.xlarge on 2026-07-02 (load 57,
                                   // sshd unresponsive). The runner is now a t3.2xlarge (8 vCPU / 32GB), so 2–3 is
                                   // survivable — but normal picking is gated to `maxPicksPerCycle` (1/cycle)
                                   // anyway, so this mostly bounds the crash-recovery/backfill path.
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
  keepPreviewUp: true,             // after browser-verify, LEAVE the bug's full preview running so its
                                   // nip.io URL stays live to open — but ONLY for bugs triaged
                                   // needs-manual-test (the ones a human actually opens); green/rework
                                   // previews tear down right after the run. gc.mjs stops kept ones once
                                   // the issue is Done/Canceled. Set false to always tear down.
  maxLivePreviews: 5,              // normal cap on simultaneously-running previews (pipeline auto-keep and
                                   // a plain chat "enable preview"). Unbounded accumulation (~0.8GB each)
                                   // crept the box into swapping, and swap-on-EBS I/O is what stalled the
                                   // runner (load 26-56 with CPU <50% = disk-wait, not compute).
  maxForcedPreviews: 7,            // a user forcing a preview from the chat may push past maxLivePreviews to
                                   // here. Past this, forcing one more EVICTS the longest-idle preview to
                                   // make room (idle = URL not opened AND no chat activity for the longest).
  maxKeptPreviews: 5,              // deprecated alias of maxLivePreviews (kept so older refs don't break).

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
    parallel: false,               // run the reviewers ONE AT A TIME. Parallel reviewers (+ the rest
                                   // of a single pipeline's fan-out) produced load spikes that starved
                                   // sshd and the human-facing previews on the 16GB runner. Costs a few
                                   // minutes of wall-clock per bug; re-enable only on a bigger box.
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

  // --- Chat UI (chat/server.mjs) ---
  // A local web UI to chat about any issue the machine is handling. ONE conversation per issue
  // (no mode toggle) — opening it shows every pipeline step that ran, and the first message
  // RESUMES the pipeline's own Claude session (per-stage session_ids in state.json), so the
  // agent natively remembers making the fix. Capability follows the environment: on the runner
  // (AUTOFIX_RUN_ENABLED=1, pipeline not mid-run, fix branch exists) the chat has FULL access
  // and new commits auto-push to the open PR; anywhere else it is READ-ONLY. Binds localhost
  // only — reach it via `ssh -L 8790:localhost:8790 ec2-user@<ip>`; SSH is the auth.
  chat: {
    port: 8790,
    bind: '127.0.0.1',               // NEVER 0.0.0.0 — no auth layer; SSH tunnel only
    full: {
      model: 'opus',
      maxTurns: 100,
      timeoutMs: 30 * 60 * 1000,     // mirrors revise — a full-access turn is an interactive revise
    },
    readOnly: {
      model: 'opus',                 // the user-facing chat agent is ALWAYS Opus (full or read-only); it may
                                     // still spawn subagents on cheaper models, but the main conversation is Opus.
      maxTurns: 30,
      timeoutMs: 10 * 60 * 1000,
      // Read-only enforcement: headless -p auto-denies any tool not listed here (and there is
      // deliberately NO --dangerously-skip-permissions). The prompt text is just alignment;
      // this list is the actual guard.
      allowedTools: [
        'Read', 'Grep', 'Glob', 'LS',
        'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
        'Bash(git status:*)', 'Bash(git blame:*)',
      ],
    },
  },
};
