## ENG-2840: Two lanes in the shared email queue (2026-11-24)

All platform email (about 30 call sites in 12 source files: support, webhooks, admin, intake, roadmap, hot-lead notices, send-as-sender, Emma, ...) funnels through ONE in-memory queue in `services/resendService.ts`, paced at 500 ms a send. It had no priority and no bound, and a Resend retry sleeps inside the worker. Production runs one backend instance (EB `Agentweb-backend-env-prod-3`, MinSize=MaxSize=1), so when several senders overlapped (several GTM reports at once, or later several outside agents over MCP, each emailing many contacts) a password reset or a support reply could wait behind all of their mail, and an unbounded queue is also unbounded memory. One report sends one email at a time, so a single report holds one slot only: the lanes matter when senders overlap, and they cap how much automated mail can wait at once.

**What changed**
- `EmailLane = 'transactional' | 'bulk'` and an optional `lane` on `sendEmail` / `sendSystemEmail`. **An email that names no lane is transactional, exactly as before**, so none of the existing callers change.
- Two queues. The transactional one is the old one (unbounded, as before). The bulk one is bounded: at most 100 bulk emails waiting. The count is bulk mail only, so a backlog of transactional mail never makes bulk mail fail.
- The worker serves transactional mail first. While bulk mail waits, every eleventh send is a bulk one, so bulk mail is never starved by a steady stream of transactional mail. The worker now chooses the next email AFTER the 500 ms pacing gap (it used to choose before it), so mail that arrives during the gap is considered.
- A full bulk lane refuses at once with `EmailQueueFullError` (`code: 'EMAIL_QUEUE_FULL'`, "Nothing was sent. Try again in a minute."). Nothing is queued, so nothing waits and memory stays bounded. The GTM report code already counts a refused send as a failed recipient, so a report says so honestly instead of throwing.
- The three GTM emails (work item update notification, phase status report, plan status report) now use the bulk lane. Nothing else changed lane.
- The non-production email guard keeps the lane when it drops some recipients and queues the rest. `lane` never reaches Resend.
- Queue log lines now carry `lane=` and the depth of both lanes.

**What this does and does not guarantee**
- A transactional email waits behind at most the one send already in flight and the 500 ms pacing gap that follows it, plus one bulk slot per eleven transactional sends while bulk mail waits. "In flight" includes that send's retries: the retry sleeps are 1 s then 2 s, plus up to three Resend calls, and a Resend call has no timeout, so a hung call holds the worker for as long as the network allows (as it did before this change).
- The cost for bulk mail: once a bulk email is first in its lane it waits for at most ten more transactional sends (about 5 seconds under a sustained transactional stream). The GTM report routes hold the HTTP request open while their emails send, so a report can take that much longer in that case; a single report to N recipients still takes about N x 0.5 s, as before.
- The ~30 existing callers all stay in the transactional lane, so they still share a lane with each other. Moving a heavy existing sender (a drip or sequence send) to the bulk lane is a one-word change per call site; it is not done here because it changes when those emails go out.
- Sender reputation is not separated by this change: both lanes send from the same Resend domain. A separate sending domain for bulk mail is an infrastructure step; code for it cannot be proven live without it, so it is not added.
- Per-process: the bound and the counters live in memory. Exact on today's single instance; revisit if the backend ever scales out.

**Next, in their own PRs:** an opt-in `gtm:email` key scope that lets MCP agents send these emails, with a recipient cap per call, an hourly budget per key and an audit line.

Tests: `src/__tests__/resendService.lanes.test.ts` (20), additions in `gtmPlanNotificationService.test.ts`; the existing queue, retry, error and guard tests pass unchanged.
