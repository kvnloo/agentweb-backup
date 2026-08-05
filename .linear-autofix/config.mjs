// .linear-autofix/config.mjs
// Edit these to match your Linear workspace and preferences.

export const config = {
  // --- Linear ---
  bugLabel: 'Bug',                 // label that marks an issue as an auto-fixable bug
  forceLabel: 'autofix',           // an explicit "do it now" label: any not-yet-picked issue carrying it
                                   // is fixed IMMEDIATELY, bypassing the maxOpenBugs cap and the one-per-cycle
                                   // pacing. Already-tracked issues (a state.json entry exists) are ignored,
                                   // so accidentally re-labelling a handled bug never re-triggers it. null = off.
  requireForceLabel: true,         // when true, the poller fixes ONLY issues carrying `forceLabel` ("autofix") —
                                   // it NEVER auto-picks un-labelled Bug issues on its own. Assign the label to
                                   // queue an issue; without it nothing happens. Set false to restore autonomous
                                   // Bug-label pickup (backlog/unstarted) under the maxOpenBugs cap.
  teamKey: null,                   // e.g. 'ENG' to scope to one team; null = whole workspace
  pickupStateTypes: ['backlog', 'unstarted'], // issue state types the poller picks up
  assigneeEmails: [                // the poller ONLY picks up bugs assigned to these Linear users
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
    'mvarma@argusoft.com': 'GH_TOKEN_MVARMA',
    'aseth@argusoft.com':  'GH_TOKEN_ASETH',
  },
  // The GitHub login each person's token MUST authenticate as — used by check-creds.mjs to catch a
  // swapped or expired token (a token in the wrong env var mis-attributes PRs silently otherwise).
  assigneeGithubLogin: {
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
  maxForcedConcurrent: 3,          // how many `forceLabel` ("autofix") bugs run at once. 0 = unlimited (all of
                                   // them in parallel — they're urgent). Each fix is heavy (~4GB tsc + a browser);
                                   // the runner is a t3.2xlarge (8 vCPU / 32GB). CAPPED to 3 after 2026-07-21:
                                   // 5 concurrent forced runs (ENG-177/213/237/240/245), each a full backend +
                                   // customer + partner + headless Chromium + 4GB tsc, saturated the 32GB box and
                                   // stalled sshd (PAM/fork-exec taking 55s+ — same signature as the 2026-07-02
                                   // OOM stall). 0 = unlimited bypasses this safety entirely — keep a small cap.
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
  maxConcurrentPreviews: 4,        // HARD cap on previews running at once. Unlike the evict-based caps
                                   // below, this REFUSES a new bring-up when the cap is hit rather than
                                   // killing someone else's preview: the pipeline skips enabling one, and
                                   // a chat "enable preview" is rejected with "close one first". 0 = off.
  maxLivePreviews: 5,              // normal cap on simultaneously-running previews (pipeline auto-keep and
                                   // a plain chat "enable preview"). Unbounded accumulation (~0.8GB each)
                                   // crept the box into swapping, and swap-on-EBS I/O is what stalled the
                                   // runner (load 26-56 with CPU <50% = disk-wait, not compute).
  maxForcedPreviews: 7,            // a user forcing a preview from the chat may push past maxLivePreviews to
                                   // here. Past this, forcing one more EVICTS the longest-idle preview to
                                   // make room (idle = URL not opened AND no chat activity for the longest).
  maxKeptPreviews: 5,              // deprecated alias of maxLivePreviews (kept so older refs don't break).
  previewIdleHours: 24,            // gc.mjs stops any preview untouched this long — same "last hit" signal
                                   // as the cap eviction (URL last opened, bring-up time, or chat activity),
                                   // so an actively-used preview is never reaped. Set 0 to disable.
  previewMemFloorMB: 3500,         // OOM backstop (gc.mjs): when available memory drops below this, stop the
                                   // longest-idle preview stack(s) NOW — regardless of Linear status or the
                                   // 24h idle age — since a few live stacks exhaust RAM long before 24h.
                                   // Matches the watch loop's memory gate (chat.watch.minMemMB). 0 disables.
  memoryCgroups: [                 // cgroups whose remaining headroom counts as "available memory", alongside
                                   // the host's MemAvailable — see availMemMB() in preview/policy.mjs. Both of
                                   // these carry a MemoryHigh/MemoryMax cap (/etc/systemd/system/*/10-memory.conf),
                                   // and work lands in one or the other depending on WHO started it, so we take
                                   // the tightest of the two. Without this the floor above was unreachable: on
                                   // 2026-08-05 the host showed 16-20GB free while autofix-chat.service was
                                   // killed four times in 56 minutes for hitting its own 12G ceiling.
                                   // [] = host-only reading (correct on an uncapped box).
    'system.slice/autofix-chat.service',  // chat server, every claude turn + MCP server, chat-started previews
    'user.slice/user-1000.slice',         // cron autofix cycles (run.sh → autofix.mjs → tsc), SSH, their previews
  ],
  previewMemKeep: 1,               // never let the memory-pressure reap drop below this many live previews.
  previewMemMinIdleMinutes: 10,    // and never let it stop a preview touched within this window (a human
                                   // actively opening its URL / chatting on it), even under pressure.
  previewMemCriticalMB: 2000,      // below THIS the grace period above shrinks to previewMemCriticalMinIdleMinutes.
                                   // A flat 10m grace made the backstop unfireable exactly when it mattered:
                                   // measured live on 2026-08-05 at 1858MB available (floor 3500) with three
                                   // previews up, all hit 4-9m ago — so every one was protected and nothing was
                                   // reaped. That is the normal shape under load, not bad luck: the previews
                                   // eating the memory belong to the runs being actively chatted. 0 disables the
                                   // escalation (flat grace, pre-2026-08-05 behaviour).
  previewMemCriticalMinIdleMinutes: 2, // the shortened grace. Still a real floor — a preview touched seconds ago
                                   // survives at any pressure, and previewMemKeep still holds.
  previewReconcileDead: true,      // each gc sweep, clear previews recorded as running whose processes are
                                   // actually gone. A chat-server restart or an OOM kill takes the whole
                                   // subtree (KillMode=control-group), but preview-state.json and routes.json
                                   // kept advertising the stack — so its URLs 502 and it still counted against
                                   // maxConcurrentPreviews until a human noticed. Nothing checked liveness
                                   // anywhere before 2026-08-05, when five teardowns in one hour (4 OOM kills
                                   // + 1 restart) left every stack listed-but-dead. It CLEARS rather than
                                   // revives on purpose: post-OOM every preview is dead at once, so reviving
                                   // would fire N concurrent portal builds into a box that just ran out of
                                   // memory. false = leave stale entries alone.
  previewReapOrphans: true,        // each gc sweep, SIGTERM preview servers that state has forgotten — an
                                   // earlier generation left running by a restarted (or half-restarted)
                                   // preview, holding RAM and ports with nothing left to stop it. Live on
                                   // 2026-08-05: ENG-845 had TEN such processes 3.9h old holding 2498MB
                                   // (incl. a 1.7GB worker) serving 31100/52100/51100 while state recorded
                                   // 31102/52102/51101. Matches on preview-server COMMAND SHAPE, never on
                                   // worktree path — a worktree also hosts type-checks, jest, portal builds
                                   // and claude turns, and ENG-845 was locked with 2 live turns at the time.
                                   // false = leave orphans running.
  previewOrphanMinutes: 15,        // how old an unrecorded preview server must be before it counts as an
                                   // orphan. A bring-up spawns its servers well before it records them, and
                                   // bring-ups have been observed taking 15+ minutes on this box, so this is
                                   // the guard against reaping a preview that is still coming up.
  previewAutoRefreshOnHeadChange: true, // a preview is a bring-up-time snapshot (ts-node backend + built-once
                                   // portals); when the branch advances past the commit it was brought up
                                   // from, gc.mjs refreshes it — cheap ts-node restart for a backend-only
                                   // change, full rebuild only if a portal changed. false = leave it stale.

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
  // (no mode toggle) — opening it shows every pipeline step that ran. The first message seeds a
  // fresh session with a CURATED context (issue + fix diff + pipeline verdicts + on-demand access to
  // the code and the raw stage transcripts), rather than reloading the fixer's 300-400k-token
  // transcript on every turn — same knowledge, a fraction of the tokens, less context noise.
  // Capability follows the environment: on the runner (AUTOFIX_RUN_ENABLED=1, pipeline not mid-run,
  // fix branch exists) the chat has FULL access and new commits auto-push to the open PR; anywhere
  // else it is READ-ONLY. Binds localhost only — reach it via `ssh -L 8790:localhost:8790 ec2-user@<ip>`.
  chat: {
    port: process.env.CHAT_PORT ? Number(process.env.CHAT_PORT) : 8790, // env override lets a test/second instance run off 8790
    bind: '127.0.0.1',               // NEVER 0.0.0.0 — no auth layer; SSH tunnel only
    btwModel: 'sonnet',              // /btw side-thread model — a read-only aside doesn't need Opus, so it
                                     // runs on Sonnet (cheaper) while keeping the read-only tool set.
    nlMergeTrigger: true,            // may a natural-language message ("merge it when green") trigger the
                                     // merge-watch, or is merging BUTTON-ONLY? true = NL allowed (still gated
                                     // by the strict isMergeRequest classifier); false = only the Merge button
                                     // counts as a standing merge instruction (ENG-654 merge gate 3a).
    // Skills that must NEVER auto-load into a chat session. A chat turn resumes the WHOLE session every
    // time, so a heavyweight *reference* skill baked into the session is re-billed on every later turn.
    // claude-api is the proven offender: a ~194k-token API/pricing manual that AUTO-triggers on any
    // model/cost-themed issue (e.g. ENG-200) → fires almost every turn, silently defeating /compact (it
    // re-inflates ~30 min later) and burning the 5hr limit ~3x fast. And it's redundant here: this repo's
    // real model IDs + pricing live in code (config.mjs modelPricing, agentModeService.ts llmModels).
    // Each name becomes `--disallowedTools Skill(<name>)` — a SURGICAL deny: the agent keeps Opus, every
    // tool (incl. the WebSearch/WebFetch *tools* — untouched, so it can still look things up on the web),
    // and every other skill (code-review, verify, simplify, …). Not dumbed down; it just can't drag a
    // manual (or a report-writing harness) into a re-billed session.
    // deep-research is here by the owner's choice: it's a heavy multi-agent report-writing harness that's
    // never wanted mid bug-fix, so denying it removes a bloat risk with zero cost (plain web search/fetch
    // remain available as tools). It differs from claude-api in that it only fires when explicitly asked.
    skillDenylist: ['claude-api', 'deep-research'],
    // Persistent capability the agent must KEEP knowing about across the whole conversation — passed via
    // `--append-system-prompt` on every full-access turn (see chatArgs), so it lives in the system prompt,
    // NOT the transcript. That's deliberate: a one-off hint in the conversation would be summarized away by
    // /compact, but this is re-applied on every turn (fresh, resumed, AND post-compact), so no number of
    // compacts can strip it. Self-gating on the env var so it's accurate whether or not a key is present.
    capabilityPrompt:
      'Linear access: on this (full-access) turn you have a shell, and when the issue\'s assignee has a ' +
      'configured key the LINEAR_API_KEY env var is set to THAT assignee\'s key. Whenever it is set you CAN ' +
      'read the live Linear board yourself — never claim you lack Linear access. Query the GraphQL API ' +
      '(POST https://api.linear.app/graphql with header "Authorization: $LINEAR_API_KEY") to fetch an issue ' +
      'and its status/assignee/description and its related & linked issues, or use the repo helpers in ' +
      '.linear-autofix/linear.mjs (e.g. resolveIssue). Only if LINEAR_API_KEY is unset does the assignee ' +
      'have no key configured — then, and only then, say Linear is unavailable.',
    // Hard safety rule, also pinned to the SYSTEM prompt (compaction-proof) on every full turn. A chat/
    // pipeline agent runs inside an isolated git worktree; it once escaped into the MAIN checkout and ran
    // `git checkout`, silently switching the whole repo's branch and breaking the running system. This
    // keeps agents in their lane. (True isolation would need a container; this is the practical guard.)
    safetyPrompt:
      'SAFETY — you are CONFINED to your own assigned repo. You are running inside ONE isolated git ' +
      'worktree (your current working directory), checked out on your own branch. Make ALL of your code ' +
      'and git changes THERE and only there. Inside your own worktree you have FULL git freedom — add, ' +
      'commit, push, `git checkout -- <file>` to discard a file, `git reset` to unstage, and the same in ' +
      'its customer-portal sub-worktree. What you must NEVER do is leave your assigned repo: (1) do NOT cd ' +
      'into — or run any git or file-changing command against — the shared main checkout at ' +
      '/home/ec2-user/agentweb, or any OTHER bug\'s worktree; (2) do NOT switch your worktree to a ' +
      'different branch (`git checkout <branch>` / `git switch`), and never run `git reset --hard`, ' +
      '`git clean`, or `git branch -D` outside your own worktree; (3) do NOT start, kill, or restart shared ' +
      'services (the preview proxy, chat server, poll/gc) — they are managed for you (the proxy hot-reloads ' +
      'its routes, so restarting it only breaks things). If anything OUTSIDE your worktree looks broken, ' +
      'REPORT it and stop — do not try to fix it. Escaping your assigned repo can corrupt the shared repo ' +
      'and take down the whole system for everyone.',
    // Resource rule, also pinned to the SYSTEM prompt (compaction-proof) on every full turn. Added
    // 2026-08-05: autofix-chat.service was OOM-killed FOUR times in 56 minutes, each kill taking every
    // in-flight turn with it. The trigger was an agent running `tsc --noEmit` with a 6GB heap by hand
    // (3.2GB resident) next to another agent's `vite build` (1.3GB), on top of the live preview stacks —
    // all inside ONE capped cgroup. The pipeline's own checks never do this: autofix.mjs already runs
    // tsc under `flock /tmp/aw-heavy-build.lock` with NODE_OPTIONS=--max-old-space-size=4096. Agents
    // typing the command themselves bypassed both, so the discipline has to be stated to them.
    resourcePrompt:
      'RESOURCES — serialize heavy builds. A type-check, bundler build or test run (`tsc --noEmit`, ' +
      '`vite build`, `jest`) each peaks at 1-4GB, and every worktree on this box shares ONE ' +
      'memory-capped cgroup with the chat server and all other in-flight turns. Two of them at once is ' +
      'what OOMs the box and kills everyone\'s work mid-turn (it happened four times on 2026-08-05). So ' +
      'never run one bare: wrap it in the machine-wide build lock with a bounded heap — ' +
      '`NODE_OPTIONS=--max-old-space-size=4096 flock /tmp/aw-heavy-build.lock <command>`. flock simply ' +
      'waits its turn, it does not fail, so this is always safe to add. The autofix pipeline runs its ' +
      'own tsc/jest exactly this way — match it. Also scope the command: type-check or test only the ' +
      'package you actually changed, never the whole repo, and never raise the heap above 4096.',
    // Autonomous background "watch": a chat has NO free-running execution between turns (each `claude -p`
    // exits when the turn ends). So a task that must WAIT for something (CI to finish, a PR to become
    // mergeable) can't be done in one turn. Instead the agent ends a waiting turn with a `[[WATCH: …]]`
    // marker; the server persists it on the entry and an in-process tick re-invokes the agent every
    // `cadenceMs` until it emits `[[WATCH_DONE]]` (or MERGE_BLOCKED, or the `maxMs` cap). This is what
    // lets "merge this PR when it's green" run for hours unattended, surviving laptop-close AND restarts
    // (the watch lives in state.json). Memory-gated + serialized so it can never contribute to an OOM.
    watch: {
      enabled: true,
      cadenceMs: 4 * 60 * 1000,        // recheck a waiting task every ~4 min
      maxMs: 24 * 60 * 60 * 1000,      // safety cap: auto-stop (and notify) a watch after 24h
      minMemMB: 3000,                  // skip a tick entirely if available RAM is below this (never add to OOM pressure)
      tickMs: 60 * 1000,               // how often the server scans state for a due watch (fires at most one/tick)
    },
    // Pinned to the system prompt (compaction-proof) on every full turn — teaches the agent HOW to wait.
    watchPrompt:
      'BACKGROUND WORK — you do NOT keep running between turns (each turn is a fresh process that exits ' +
      'when you stop responding). So NEVER claim you are "polling in the background" or will "wait and get ' +
      'back to you" — you literally cannot. Instead, when a task needs you to WAIT for something and then ' +
      'act (CI to finish, a PR to become mergeable, a review to re-run), do whatever you can check NOW, ' +
      'then end your reply with a line `[[WATCH: <one line — what you are waiting for>]]`. You will be ' +
      'automatically re-invoked in a few minutes, with this entire conversation intact, to check again and ' +
      'act. Repeat that until the goal is fully met, then end with `[[WATCH_DONE]]` to stop the wake-ups. ' +
      'Never sit blocking on `gh ... --watch`, `sleep`, or a poll loop — register a `[[WATCH]]` and END the ' +
      'turn; that is how waiting works here.',
    resumePipelineSession: false,    // default: curated fresh context (above). Set true to instead RESUME
                                     // the fixer's own Claude session on the first turn for raw native
                                     // memory — costs ~380k tokens of low-signal transcript reloaded every
                                     // turn (the reason /compact felt like a no-op). Reversible A/B knob.
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
