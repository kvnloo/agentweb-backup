import { backfillSessionScores } from "../services/scoreBackfill";
import type { ChatSession } from "../services/chatbotService";
import type { ScoringJudge } from "../services/sessionScoringService";

// Minimal session factory — backfillSessionScores only reads sessionId and
// mutates satisfactionScore / judgeScores, so the rest can be sparse.
const makeSession = (id: string): ChatSession =>
  ({ sessionId: id, userId: "u1", messages: [] } as unknown as ChatSession);

const judge = (id: string): ScoringJudge =>
  ({ id, name: `Judge ${id}`, systemPrompt: "p", createdAt: "2024-01-01", updatedAt: "2024-01-01" } as ScoringJudge);

describe("backfillSessionScores", () => {
  it("scores every session and its judges on the happy path (SUCCESS)", async () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const judges = [judge("j1")];
    const scoreSession = jest.fn(async () => ({ score: 4 } as any));
    const scoreWithJudge = jest.fn(async () => ({ score: 5, judgeName: "Judge j1" } as any));

    const result = await backfillSessionScores(sessions, judges, { scoreSession, scoreWithJudge });

    expect(result).toEqual({ scored: 2, skipped: 0, timedOut: false });
    expect(scoreSession).toHaveBeenCalledTimes(2);
    expect(scoreWithJudge).toHaveBeenCalledTimes(2);
  });

  it("applies returned scores onto the in-memory session objects (no re-fetch needed)", async () => {
    const s = makeSession("s1");
    const judges = [judge("j1")];
    const sat = { score: 3, reason: "meh" } as any;
    const js = { score: 5, judgeName: "Judge j1" } as any;

    await backfillSessionScores([s], judges, {
      scoreSession: async () => sat,
      scoreWithJudge: async () => js,
    });

    expect(s.satisfactionScore).toEqual(sat);
    expect(s.judgeScores).toEqual({ j1: js });
  });

  it("does not overwrite existing scores when the scorer returns null (skip case)", async () => {
    const s = makeSession("s1");
    (s as any).satisfactionScore = { score: 2, reason: "cached" };
    (s as any).judgeScores = { j1: { score: 1, judgeName: "old" } };

    await backfillSessionScores([s], [judge("j1")], {
      scoreSession: async () => null,
      scoreWithJudge: async () => null,
    });

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
      return { score: 4 } as any;
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
      return { score: 4 } as any;
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
  });

  it("continues with other sessions when one session's scorer throws (error path)", async () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const scoreSession = jest
      .fn()
      .mockRejectedValueOnce(new Error("LLM timeout"))
      .mockResolvedValueOnce({ score: 4 } as any);
    const onError = jest.fn();

    const result = await backfillSessionScores(sessions, [], { scoreSession, concurrency: 1, onError });

    // Both sessions attempted despite the first throwing
    expect(scoreSession).toHaveBeenCalledTimes(2);
    expect(result.scored).toBe(2);
    expect(result.skipped).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("returns a zeroed result for an empty session list", async () => {
    const scoreSession = jest.fn();
    const result = await backfillSessionScores([], [judge("j1")], { scoreSession });
    expect(result).toEqual({ scored: 0, skipped: 0, timedOut: false });
    expect(scoreSession).not.toHaveBeenCalled();
  });
});
