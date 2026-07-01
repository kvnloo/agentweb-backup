// .linear-autofix/config.mjs
// Edit these to match your Linear workspace and preferences.

export const config = {
  // --- Linear ---
  bugLabel: 'Bug',                 // label that marks an issue as an auto-fixable bug
  teamKey: null,                   // e.g. 'ENG' to scope to one team; null = whole workspace
  pickupStateTypes: ['backlog', 'unstarted'], // issue state types the poller picks up
  inProgressState: 'In Progress',  // moved here on pickup (guards against re-processing)
  reviewState: 'In Review',        // moved here after a PR opens (best-effort; falls back to staying In Progress)
  gcDoneStateTypes: ['completed', 'canceled'], // gc.mjs removes a kept worktree once its issue reaches one of these state types

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
                                   // Done/Canceled. Trade-off: each kept bug holds ~1-1.5 GB (backend + 2 dev
                                   // servers) and they accumulate across open bugs. To reach the URL from
                                   // another machine set PREVIEW_IP=<reachable-ip> and open the proxy port.
                                   // Set false to tear the preview down immediately after verify.

  // --- Claude ---
  defaultModel: 'sonnet',          // the fixer model; conserve subscription quota
  opusModel: 'opus',
  opusLabels: ['opus', 'hard', 'complex'], // any of these labels on the issue → use Opus for it
  skipPermissions: true,           // required for unattended runs; the fix is confined to an isolated
                                   // workspace and PRs are draft-only (human review is the safety net)
  maxTurns: 80,
  timeoutMs: 25 * 60 * 1000,       // hard cap per bug

  // --- Browser verification (Playwright) ---
  // After a fix opens a PR, bring up a full preview and drive a real browser to confirm the
  // bug is gone; attach the verdict + screenshots to the draft PR and Linear (PR opens either way).
  verify: {
    enabled: true,
    model: 'sonnet',
    testEmail: 'test@example.com',
    testPassword: 'Test123!',
    maxTurns: 40,
    timeoutMs: 12 * 60 * 1000,
  },
};
