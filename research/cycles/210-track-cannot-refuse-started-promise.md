# Cycle 210 — `track()` cannot refuse: callers pass an already-started promise

**Date:** 2026-09-12T03:45:00Z
**Question:** Cycle 209 put A-019 next after
#2. Can the refuse gate live *inside*
`cronJobRegistry.track()` (and
`tryClaim` returning false), the way the
first slice currently reads?

**Answer:** No. `track()` is given a Promise
that has **already started**. Worker refuse
works because the check is *inside*
`runInWorker` before work. `/generate`
maps `tryClaim` false to **409
SESSION_BUSY**, not 503. Q-014
`generate_image` never `tryClaim`s — the
CallTool handler is the billed-image
gate. Copy the existing source-scan
test, do not wrap `mcpToolRegistry.execute`.

## Evidence

`track` takes a Promise. Chat already
evaluates the work as the argument:

```295:301:backend/src/server.ts
  socket.on('message', (data: {
    sessionId: string;
    message: string;
    currentUrl?: string;
    pageContent?: string;
    portal?: 'customer' | 'partner';
  }) => cronJobRegistry.track('chatbotTurn', handleSocketChatMessage(socket, data)));
```

```38:48:backend/src/utils/cronJobRegistry.ts
  track<T>(jobName: string, promise: Promise<T>): Promise<T> {
    const runId = `${jobName}_${++this.counter}_${Date.now()}`;
    this.inFlight.set(runId, jobName);
    // inserts the already-running promise — cannot un-start it
```

Worker refuse is a different shape — check
**before** enqueue:

```443:445:backend/src/services/generateMarketingResponseWorkerService.ts
    if (this.draining) {
      throw new Error('Worker is draining — no new requests accepted');
    }
```

`tryClaim` false is busy, not drain.
`/generate` 409s it:

```9016:9027:backend/src/controllers/agentModeController.ts
      if (!tryClaimSessionGeneration(sessionId) && !(await preemptAutoContinuationAndWait(sessionId))) {
        // ...
        return res.status(409).json({
          error: 'Session is busy',
          message: 'A response is already being generated for this session. Please wait.',
          code: 'SESSION_BUSY',
        });
```

Scheduled chats already 503 on
`!isCronEnabled()` (the copy target):

```13029:13032:backend/src/controllers/agentModeController.ts
    if (!isCronEnabled()) {
      return res.status(503).json({ message: 'Instance draining — retry on new instance' });
    }
```

Production `mcpToolRegistry.execute` is
**one** call site (`mcpServerCore.ts`
L120). Tests call `execute` directly
(`mcp.apiTools.test.ts` and siblings).
Wrapping the registry would fire drain
refuse in those tests. Wrap the CallTool
handler, like chatbotTurn.

`gracefulShutdown.test.ts` already
source-scans the wrap (L249–255) and
pattern-verifies the 503 without
importing the 14k controller (L131–151).
**Zero** `mcpServerCore` hits in that
file. A-019 characterization is a
sibling: slice the CallTool handler,
match `isCronEnabled` then
`track('mcpCallTool'`.

CallTool has no HTTP status. Refuse
returns `isError: true` in the existing
catch shape (L164–173), then Hermes on
this session sees the error while `/mcp`
stays 200 until `server.close`.

Q-014 `generate_image` is mcpFetch
`/api/emma/generate-image` with no
`tryClaim` (cycle 80). Overloading
`tryClaim` would not stop billed MCP
images. Handler-entry refuse is the
image gate.

## First-slice correction (A-019 stays ready)

After kvnloo#2, not instead of Q-014:

1. **CallTool handler** (`mcpServerCore.ts`
   L88): `if (!isCronEnabled())` return
   `isError` draining; **else**
   `track('mcpCallTool', …)` around the
   existing execute body. Do not wrap
   `registry.execute`. Sibling source-scan
   next to `gracefulShutdown.test.ts`
   L249–255.
2. **`generateResponse`:** 503 like
   `runScheduledChats` L13031 **before**
   `tryClaim`. `tryClaim` stays busy-only.
   Auto-continuation L1350: skip if
   `!isCronEnabled`.
3. Do not make `track()` skip-insert as
   the refuse. That leaves the work
   running untracked (worse than today).
4. Do not edit `slack.ts` (#2393). Do not
   HTTP-split. Do not add A-021.

## Relation to A-002 / A-007 / A-008

A-019 is still the architecture item after
#2+#3. This cycle only sharpens the
slice. Not A-006. Q-001 / Q-014 / Q-003
stay ready.

## Next cycle candidate

`ListTools` (`mcpServerCore.ts` L81–83)
has no drain check — Hermes can still
*see* `generate_image` during overlap;
CallTool `isError` is enough. File-level
only if we need to decide whether listing
should shrink. Do not add A-021.
