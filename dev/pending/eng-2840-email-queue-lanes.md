## ENG-2840: Two lanes in the shared email queue (2026-11-24)

All platform email (about 30 call sites in 12 source files: support, webhooks, admin, intake, roadmap, hot-lead notices, send-as-sender, Emma, ...) funnels through ONE in-memory queue in `services/resendService.ts`, paced at 500 ms a send. It had no priority and no bound, and a Resend retry sleeps inside the worker. Production runs one backend instance (EB `Agentweb-backend-env-prod-3`, MinSize=MaxSize=1), so a burst of automated mail (a GTM status report to many contacts, sent by Emma or by an outside agent over MCP) made a password reset or a support reply wait behind all of it, and an unbounded queue is also unbounded memory.

**What changed**
- `EmailLane = 'transactional' | 'bulk'` and an optional `lane` on `sendEmail` / `sendSystemEmail`. **An email that names no lane is transactional, exactly as before**, so none of the existing callers change.
- Two queues. The transactional one is the old one (unbounded, as before). The bulk one is bounded at 100 waiting.
- The worker serves transactional mail first. While bulk mail waits, every eleventh send is a bulk one, so bulk mail is never starved by a steady stream of transactional mail.
- A full bulk lane refuses at once with `EmailQueueFullError` (`code: 'EMAIL_QUEUE_FULL'`, "Nothing was sent. Try again in a minute."). Nothing is queued, so nothing waits and memory stays bounded. The GTM report code already counts a refused send as a failed recipient, so a report says so honestly instead of throwing.
- The three GTM emails (work item update notification, phase status report, plan status report) now use the bulk lane. Nothing else changed lane.
- The non-production email guard keeps the lane when it drops some recipients and queues the rest. `lane` never reaches Resend.
- Queue log lines now carry `lane=` and the depth of both lanes.

**What this does and does not guarantee**
- A transactional email waits behind at most the one send already in flight, including that send's retries (about 3 seconds in the worst case, the retry sleep still happens inside the worker), plus one bulk slot per eleven transactional sends while bulk mail waits.
- The ~30 existing callers all stay in the transactional lane, so they still share a lane with each other. Moving a heavy existing sender (a drip or sequence send) to the bulk lane is a one-word change per call site; it is not done here because it changes when those emails go out.
- Sender reputation is not separated by this change: both lanes send from the same Resend domain. A separate sending domain for bulk mail is an infrastructure step; code for it cannot be proven live without it, so it is not added.
- Per-process: the bound and the counters live in memory. Exact on today's single instance; revisit if the backend ever scales out.

**Next, in their own PRs:** an opt-in `gtm:email` key scope that lets MCP agents send these emails, with a recipient cap per call, an hourly budget per key and an audit line.

Tests: `src/__tests__/resendService.lanes.test.ts` (15), additions in `gtmPlanNotificationService.test.ts`; the existing queue, retry, error and guard tests pass unchanged.
