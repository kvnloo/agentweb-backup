import { backfillSessionScores } from "../services/scoreBackfill";
import type { ChatSession } from "../services/chatbotService";
import type { ScoringJudge } from "../services/sessionScoringService";

// Minimal session factory — backfillSessionScores only reads sessionId and
// mutates satisfactionScore / judgeScores, so the rest can be sparse.
const makeSession = (id: string): ChatSession =>
  ({ sessionId: id, userId: "u1", messages: [] } as unknown as ChatSession);

const makeSessionWithSize = (id: string, messageCount: number): ChatSession =>
  ({ sessionId: id, userId: "u1", messageCount, messages: [] } as unknown as ChatSession);

const judge = (id: string): ScoringJudge =>
  ({ id, name: `Judge ${id}`, systemPrompt: "p", createdAt: "2024-01-01", updatedAt: "2024-01-01" } as ScoringJudge);

describe("backfillSessionScores", () => {
  it("scores every session and its judges on the happy path (SUCCESS)", async () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const judges = [judge("j1")];
    const scoreSession = jest.fn(async () => ({ score: { score: 4 } } as any));
    const scoreWithJudge = jest.fn(async () => ({ score: 5, judgeName: "Judge j1" } as any));

    const result = await backfillSessionScores(sessions, judges, { scoreSession, scoreWithJudge });

    expect(result).toMatchObject({ scored: 2, skipped: 0, timedOut: false });
    expect(result.outcomes).toEqual([
      { sessionId: "s1", status: "scored" },
      { sessionId: "s2", status: "scored" },
    ]);
    expect(scoreSession).toHaveBeenCalledTimes(2);
    expect(scoreWithJudge).toHaveBeenCalledTimes(2);
  });

  it("applies returned scores onto the in-memory session objects (no re-fetch needed)", async () => {
    const s = makeSession("s1");
    const judges = [judge("j1")];
    const sat = { score: 3, reason: "meh" } as any;
    const js = { score: 5, judgeName: "Judge j1" } as any;

    await backfillSessionScores([s], judges, {
      scoreSession: async () => ({ score: sat }),
      scoreWithJudge: async () => js,
    });

    expect(s.satisfactionScore).toEqual(sat);
    expect(s.judgeScores).toEqual({ j1: js });
  });

  it("does not overwrite existing scores when the scorer returns null (skip case)", async () => {
    const s = makeSession("s1");
    (s as any).satisfactionScore = { score: 2, reason: "cached" };
    (s as any).judgeScores = { j1: { score: 1, judgeName: "old" } };

    const result = await backfillSessionScores([s], [judge("j1")], {
      scoreSession: async () => ({ score: null, skipReason: "already-scored" as const }),
      scoreWithJudge: async () => null,
    });

    // The skip is reported with its reason, not returned as an unexplained null.
    expect(result.outcomes).toEqual([
      { sessionId: "s1", status: "skipped", reason: "already-scored" },
    ]);

    // Unchanged cached values preserved
    expect(s.satisfactionScore).toEqual({ score: 2, reason: "cached" });
    expect(s.judgeScores).toEqual({ j1: { score: 1, judgeName: "old" } });
  });

  it("never runs more scorers concurrently than the concurrency cap (FAIL boundary)", async () => {
    const sessions = Array.from({ length: 8 }, (_, i) => makeSession(`s${i}`));
    let inFlight = 0;
    let maxInFlight = 0;
    const scoreSession = jest.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { score: { score: 4 } } as any;
    });

    const result = await backfillSessionScores(sessions, [], { scoreSession, concurrency: 3 });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(result.scored).toBe(8);
    expect(result.skipped).toBe(0);
  });

  it("stops dispatching once the wall-clock budget is exhausted and reports the remainder (FAIL boundary)", async () => {
    const sessions = Array.from({ length: 10 }, (_, i) => makeSession(`s${i}`));
    // Virtual clock: each scored session advances time by 100ms.
    let t = 0;
    const now = () => t;
    const scoreSession = jest.fn(async () => {
      t += 100;
      return { score: { score: 4 } } as any;
    });

    // budget 250ms, concurrency 1 → sessions start at t=0,100,200 (all <250),
    // the one starting at t=300 is refused. Exactly 3 processed, 7 skipped.
    const result = await backfillSessionScores(sessions, [], {
      scoreSession,
      concurrency: 1,
      budgetMs: 250,
      now,
    });

    expect(result.scored).toBe(3);
    expect(result.skipped).toBe(7);
    expect(result.timedOut).toBe(true);
    expect(scoreSession).toHaveBeenCalledTimes(3);
    // Sessions the budget never reached are reported as such, so the caller can
    // tell "we ran out of time" from "this session has no score by design".
    expect(result.outcomes.filter((o) => o.status === "not-attempted")).toHaveLength(7);
    expect(result.outcomes[9]).toEqual({
      sessionId: "s9",
      status: "not-attempted",
      reason: "scoring budget exhausted",
    });
  });

  // ENG-929 follow-up: a scaled-up per-session timeout (up to 60s for a large
  // transcript, vs. the old flat 20s fail-fast) means a few large sessions can
  // now consume much more of the shared budget than before. Dispatching
  // smallest-first keeps a mixed window from having its budget eaten by a
  // handful of large sessions before the many small ones are ever attempted.
  it("dispatches smaller sessions first so a constrained budget scores more of them (FAIL boundary)", async () => {
    // Listed BIG session first — array order must not determine dispatch order.
    const sessions = [
      makeSessionWithSize("big", 1000),
      makeSessionWithSize("small-a", 1),
      makeSessionWithSize("small-b", 2),
    ];
    let t = 0;
    const now = () => t;
    const scoreSession = jest.fn(async () => {
      t += 100;
      return { score: { score: 4 } } as any;
    });

    // budget 150ms, concurrency 1 → sessions start at t=0 and t=100 (both
    // <150); the one that would start at t=200 is refused. Exactly 2 fit.
    const result = await backfillSessionScores(sessions, [], {
      scoreSession,
      concurrency: 1,
      budgetMs: 150,
      now,
    });

    // The two smallest were scored; the big one — despite being first in the
    // input array — was left for a later run.
    expect(scoreSession).toHaveBeenCalledTimes(2);

    // outcomes stays in the ORIGINAL input order (big, small-a, small-b) —
    // dispatch order changed, the returned order contract did not.
    expect(result.outcomes.map((o) => o.sessionId)).toEqual(["big", "small-a", "small-b"]);
    expect(result.outcomes[0]).toEqual({
      sessionId: "big",
      status: "not-attempted",
      reason: "scoring budget exhausted",
    });
    expect(result.outcomes[1].status).toBe("scored");
    expect(result.outcomes[2].status).toBe("scored");
  });

  it("continues with other sessions when one session's scorer throws (error path)", async () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const scoreSession = jest
      .fn()
      .mockRejectedValueOnce(new Error("LLM timeout"))
      .mockResolvedValueOnce({ score: { score: 4 } } as any);
    const onError = jest.fn();

    const result = await backfillSessionScores(sessions, [], { scoreSession, concurrency: 1, onError });

    // Both sessions attempted despite the first throwing
    expect(scoreSession).toHaveBeenCalledTimes(2);
    expect(result.scored).toBe(2);
    expect(result.skipped).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
    // ENG-929: a failure is reported as a failure — never as an unexplained null.
    expect(result.outcomes).toEqual([
      { sessionId: "s1", status: "failed", reason: "LLM timeout" },
      { sessionId: "s2", status: "scored" },
    ]);
  });

  it("still runs the judges when the satisfaction scorer throws (ENG-929 isolation)", async () => {
    const s = makeSession("s1");
    const scoreWithJudge = jest.fn(async () => ({ score: 5, judgeName: "Judge j1" } as any));

    const result = await backfillSessionScores([s], [judge("j1")], {
      scoreSession: async () => {
        throw new Error("Scoring LLM call timed out after 40000ms");
      },
      scoreWithJudge,
      onError: () => {},
    });

    expect(scoreWithJudge).toHaveBeenCalledTimes(1);
    expect(s.judgeScores).toEqual({ j1: { score: 5, judgeName: "Judge j1" } });
    expect(result.outcomes[0]).toMatchObject({ sessionId: "s1", status: "failed" });
  });

  it("reports a judge failure without losing the satisfaction outcome (ENG-929)", async () => {
    const s = makeSession("s1");

    const result = await backfillSessionScores([s], [judge("j1"), judge("j2")], {
      scoreSession: async () => ({ score: { score: 4 } as any }),
      scoreWithJudge: async (_session, j) => {
        if (j.id === "j1") throw new Error("judge blew up");
        return { score: 5, judgeName: "Judge j2" } as any;
      },
      onError: () => {},
    });

    expect(result.outcomes[0]).toEqual({
      sessionId: "s1",
      status: "scored",
      judgeErrors: { j1: "judge blew up" },
    });
    expect(s.judgeScores).toEqual({ j2: { score: 5, judgeName: "Judge j2" } });
  });

  it("returns a zeroed result for an empty session list", async () => {
    const scoreSession = jest.fn();
    const result = await backfillSessionScores([], [judge("j1")], { scoreSession });
    expect(result).toEqual({ scored: 0, skipped: 0, timedOut: false, outcomes: [] });
    expect(scoreSession).not.toHaveBeenCalled();
  });
});
