/**
 * Compare scoring-judge LLM models on a sample of real dev sessions.
 *
 * Usage:
 *   NODE_ENV=development npx ts-node src/scripts/compareJudgeModels.ts [limit]
 *
 * For each sampled session it scores the conversation with every model in
 * MODELS, then reports per-model latency, JSON-parse failures, and how closely
 * the models agree with each other (mean absolute difference of overall score).
 */
import { chatbotDb } from "../services/chatbotService";
import { DEFAULT_SCORING_SYSTEM_PROMPT, scoreSessionWithJudge, ScoringJudge } from "../services/sessionScoringService";

const MODELS = ["gemini-3.1-flash-lite", "gemini-3.5-flash"];

const SAMPLE_SIZE = Number(process.argv[2] || 20);

function makeJudge(model: string): ScoringJudge {
  const now = new Date().toISOString();
  return {
    id: `cmp_${model}`,
    name: model,
    systemPrompt: DEFAULT_SCORING_SYSTEM_PROMPT,
    llmModel: model,
    createdAt: now,
    updatedAt: now,
  };
}

type Row = {
  sessionId: string;
  scores: Record<string, number | null>;
  latencyMs: Record<string, number>;
  reasons: Record<string, string>;
};

async function main() {
  console.log(`Loading sessions from ${process.env.NODE_ENV === "development" ? "Dev-" : ""}AW-ChatSessions ...`);
  const all = await chatbotDb.getAllSessions();
  const candidates = all
    .filter((s) => (s.messageCount ?? s.messages?.length ?? 0) >= 4)
    .filter((s) => (s.messages || []).some((m: any) => m.role === "user"));

  // Deterministic sample: sort by messageCount desc, take a spread.
  candidates.sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0));
  const step = Math.max(1, Math.floor(candidates.length / SAMPLE_SIZE));
  const sample = candidates.filter((_, i) => i % step === 0).slice(0, SAMPLE_SIZE);

  console.log(`Candidates: ${candidates.length}, sampling ${sample.length} sessions.\n`);

  const judges = MODELS.map(makeJudge);
  const rows: Row[] = [];
  const latencyTotals: Record<string, number[]> = {};
  const failTotals: Record<string, number> = {};
  MODELS.forEach((m) => { latencyTotals[m] = []; failTotals[m] = 0; });

  for (const session of sample) {
    const row: Row = { sessionId: session.sessionId, scores: {}, latencyMs: {}, reasons: {} };
    for (const judge of judges) {
      const t0 = Date.now();
      try {
        const result = await scoreSessionWithJudge(
          session.messages || [],
          session.messageCount ?? session.messages?.length ?? 0,
          judge,
          session.sessionType
        );
        const dt = Date.now() - t0;
        row.scores[judge.llmModel!] = result.score;
        row.latencyMs[judge.llmModel!] = dt;
        row.reasons[judge.llmModel!] = result.reason;
        latencyTotals[judge.llmModel!].push(dt);
      } catch (err: any) {
        row.scores[judge.llmModel!] = null;
        row.latencyMs[judge.llmModel!] = Date.now() - t0;
        row.reasons[judge.llmModel!] = `ERROR: ${err?.message || err}`;
        failTotals[judge.llmModel!] += 1;
      }
    }
    rows.push(row);
    const scoreStr = MODELS.map((m) => `${m}=${row.scores[m] ?? "X"}`).join("  ");
    console.log(`${session.sessionId.slice(0, 8)}  msgs=${session.messageCount}  ${scoreStr}`);
  }

  console.log("\n===== SUMMARY =====");
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const median = (xs: number[]) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };

  for (const m of MODELS) {
    const lat = latencyTotals[m];
    const validScores = rows.map((r) => r.scores[m]).filter((s): s is number => s != null);
    console.log(
      `\n${m}\n  valid: ${validScores.length}/${rows.length}  parse/err failures: ${failTotals[m]}` +
      `\n  latency mean=${mean(lat).toFixed(0)}ms median=${median(lat).toFixed(0)}ms max=${Math.max(...lat, 0)}ms` +
      `\n  mean score=${mean(validScores).toFixed(2)}  score dist=${dist(validScores)}`
    );
  }

  // Pairwise agreement between the two models
  if (MODELS.length === 2) {
    const [a, b] = MODELS;
    const diffs: number[] = [];
    let exact = 0, within1 = 0, both = 0;
    for (const r of rows) {
      const sa = r.scores[a], sb = r.scores[b];
      if (sa != null && sb != null) {
        both++;
        const d = Math.abs(sa - sb);
        diffs.push(d);
        if (d === 0) exact++;
        if (d <= 1) within1++;
      }
    }
    console.log(
      `\n===== AGREEMENT (${a} vs ${b}) =====\n  comparable sessions: ${both}` +
      `\n  exact match: ${exact} (${pct(exact, both)})  within ±1: ${within1} (${pct(within1, both)})` +
      `\n  mean abs diff: ${mean(diffs).toFixed(2)}`
    );
    // Show the biggest disagreements
    const disagreements = rows
      .filter((r) => r.scores[a] != null && r.scores[b] != null && Math.abs((r.scores[a] as number) - (r.scores[b] as number)) >= 2)
      .sort((x, y) => Math.abs((y.scores[a]! - y.scores[b]!)) - Math.abs((x.scores[a]! - x.scores[b]!)));
    if (disagreements.length) {
      console.log(`\n  Largest disagreements (|diff|>=2):`);
      for (const r of disagreements.slice(0, 5)) {
        console.log(`   ${r.sessionId.slice(0, 8)}  ${a}=${r.scores[a]} ${b}=${r.scores[b]}`);
        console.log(`     ${a}: ${r.reasons[a].slice(0, 140)}`);
        console.log(`     ${b}: ${r.reasons[b].slice(0, 140)}`);
      }
    }
  }
}

function dist(xs: number[]): string {
  const c: Record<number, number> = {};
  xs.forEach((x) => { c[x] = (c[x] || 0) + 1; });
  return [1, 2, 3, 4, 5].map((k) => `${k}:${c[k] || 0}`).join(" ");
}
function pct(n: number, d: number): string {
  return d ? `${((n / d) * 100).toFixed(0)}%` : "—";
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
