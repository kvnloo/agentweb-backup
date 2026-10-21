/**
 * Eval registry (ENG-2134, ENG-2128 slice 1).
 *
 * One place that lists every grader AgentWeb uses to judge quality — LLM judges, code
 * graders, human review and outcome signals — with what it grades, which model family runs it,
 * and whether it has been validated against human labels.
 *
 * ENG-2128 principle 2: "Unvalidated judges cannot gate or alert." A grader may gate only once a
 * validation run (ENG-2136 agreement harness) records Cohen's kappa >= MIN_KAPPA on at least
 * MIN_VALIDATION_N labelled cases, with an http(s) link to the run as evidence. As of 2026-09-25 no grader meets that bar, so `mayGate` is
 * false for all of them. Record a validation here (with its evidence link) to change that.
 *
 * Human-readable audit, including evidence for every entry: backend/docs/evals/EVAL_REGISTRY.md.
 */

export type EvalSurface = 'agent' | 'creative' | 'account_health';

export type GraderType = 'llm_judge' | 'code' | 'human' | 'outcome';

export type ModelFamily = 'gemini' | 'claude' | 'openai' | 'none' | 'unknown';

export interface GraderValidation {
  kappa: number;
  n: number;
  /** ISO date of the validation run. */
  date: string;
  /** Link to the run output (Linear comment, PR, report). */
  evidence: string;
  /**
   * Who wrote the labels the run was scored against. Only `human` qualifies: an AI labelling the set that validates
   * an AI judge is circular, and a model of the same family as the judge shares its blind spots (ENG-2135).
   */
  labelSource?: 'human';
}

export interface GraderEntry {
  id: string;
  surface: EvalSurface;
  graderType: GraderType;
  /** What the grader decides, in one line. */
  measures: string;
  /** Where it lives: code path, or the AW-Settings key / external system holding its config. */
  source: string;
  /**
   * Version of the grading logic this entry describes (ENG-2196). A trend that spans two versions
   * compares two graders. One of:
   *  - the grader's own version constant in code (e.g. `1`, `2026-09-25.1`); a test keeps it in sync;
   *  - `prompt-sha256:<12 hex>` for a judge whose prompt lives in AW-Settings (read 2026-09-28);
   *  - `untracked@<date>` when neither code nor config versions it: the date the entry was checked.
   */
  version: string;
  /** Model that runs it in production; `none` for code/human/outcome graders. */
  model: string;
  modelFamily: ModelFamily;
  /** Where its output goes today. */
  consumers: string[];
  /** Linear issues recording false positives/negatives for this grader. */
  knownIssues: string[];
  validation?: GraderValidation;
  notes?: string;
}

export const MIN_KAPPA = 0.6;
export const MIN_VALIDATION_N = 30;

export const EVAL_REGISTRY: readonly GraderEntry[] = [
  {
    id: 'session-judge-general',
    surface: 'agent',
    graderType: 'llm_judge',
    measures: 'Session satisfaction 1-5 with goalCompletion/dataAccuracy/outputQuality, concision, instructionCompliance, unnecessaryPermissionRequest',
    source: 'services/sessionScoringService.ts; prompt AW-Settings default-scoring-prompt (10,633 chars, 2026-08-11)',
    version: 'prompt-sha256:4507a38770f1',
    model: 'gemini-3.5-flash (AW-Settings default-scoring-model; code fallback gemini-3.1-flash-lite)',
    modelFamily: 'gemini',
    consumers: ['AW-ChatSessions.satisfactionScore', 'partner-portal AdminDashboard badges (secondary, labelled unvalidated since ENG-2144)', 'reliability snapshot dims', 'get_chat_history'],
    knownIssues: ['ENG-47', 'ENG-168', 'ENG-392', 'ENG-830', 'ENG-930', 'ENG-972', 'ENG-995', 'ENG-1165', 'ENG-1190', 'ENG-1223', 'ENG-1245', 'ENG-1296', 'ENG-1312', 'ENG-1714'],
    notes: 'ENG-1710/1714: AUC 0.67 vs relaxed completion, 83.6% of scores = 5. Same family as the agent default (gemini-3.8-flash). Scoring is lazy (dashboard / get_chat_history backfill): 8,462 of 19,293 sessions scored.',
  },
  {
    id: 'session-judge-fangfang',
    surface: 'agent',
    graderType: 'llm_judge',
    measures: 'Session score 1-5 from an LLM persona of Fangfang\'s review criteria',
    source: 'AW-Settings scoring-judges (judge_1774188403681_idctslwzu, 8,075-char prompt)',
    version: 'prompt-sha256:293bd6a129c7',
    model: 'gemini-3.5-flash',
    modelFamily: 'gemini',
    consumers: ['AW-ChatSessions.judgeScores'],
    knownIssues: ['ENG-972', 'ENG-995', 'ENG-1223'],
    notes: 'Never compared with Fangfang\'s own labels. Prompt is 84% similar to the general judge.',
  },
  {
    id: 'session-judge-matt',
    surface: 'agent',
    graderType: 'llm_judge',
    measures: 'Session score 1-5, labelled as Matt\'s criteria',
    source: 'AW-Settings scoring-judges (judge_1779822633705_027n0uoio)',
    version: 'prompt-sha256:4507a38770f1',
    model: 'gemini-3.5-flash',
    modelFamily: 'gemini',
    consumers: ['AW-ChatSessions.judgeScores'],
    knownIssues: ['ENG-972'],
    notes: 'Its prompt is byte-identical to default-scoring-prompt on the same model (sha256 4507a38770f1, 2026-09-25), so it is not an independent judge: agreement between it and the general judge carries no signal.',
  },
  {
    id: 'session-judge-outcome-b-shadow',
    surface: 'agent',
    graderType: 'llm_judge',
    measures: 'Session outcome 1-5 (was the requested task delivered, with evidence) with goalCompletion/dataAccuracy/outputQuality and binary arguedWithInstruction/escalatedWhenNotRequired/failedToEscalate (ENG-2189); rationale before score; ENG-1714 rubric B (reconstructed text)',
    source: 'services/outcomeJudge.ts (rubric, sampling, model guard) via services/sessionScoringService.ts custom-judge path; AW-Settings scoring-judges row outcome-judge-b-shadow (OPS-1, ENG-2146); offline scripts/evalOutcomeJudge.ts',
    version: '2026-10-09.reconstructed-3',
    model: 'anthropic.claude-sonnet-4-6 via OpenRouter (row llmModel; Google models refused)',
    modelFamily: 'claude',
    consumers: ['AW-ChatSessions.judgeScores[outcome-judge-b-shadow] (shadow: true, sampled)', 'scripts/evalOutcomeJudge.ts (offline, read-only)'],
    knownIssues: ['ENG-1710', 'ENG-1714', 'ENG-2138', 'ENG-2189', 'ENG-2356'],
    notes: 'Shadow (D1): never writes satisfactionScore, runs only on its sampleRate share of sessions, metered as system spend (outcome_judge_shadow). Off until OPS-1 appends the row. ENG-1710 measured the original rubric B at AUC 0.79 vs relaxed completion with 2.6% at 5. ENG-2356 (2026-10-08) measured reconstructed-2 at AUC 0.58, 28.6% at 5, and 0 of 77 scored sessions at 1-2 despite 22 labelled failures — a leniency problem traced to holistic scoring. reconstructed-3 (2026-10-09) makes the score a mechanical function of an itemised deliverable checklist; not yet re-measured. ENG-2138 (2026-10-12): the ENG-1710 0.79 / 2.6% came from the original rubric B, which asks for a one-decimal score (a 5 counted at >= 4.95); reconstructed-3 asks for whole numbers. Prod rounded every judge score until the shadow judge began keeping one decimal, so integer-scale replays (ENG-2356, ENG-2380) are not comparable to it. On the ENG-1710 corpus (ENG-2410, rebuilt labels) the cached scores read AUC 0.76 / 3.4% at 5 raw and 0.72 / 46% rounded.',
  },
  {
    id: 'finalize-guard',
    surface: 'agent',
    graderType: 'llm_judge',
    measures: 'Completion claims in the final reply vs successful tool calls (7 claim classes)',
    source: 'services/agentMode/core/finalizeGuard.ts',
    version: 'untracked@2026-09-28',
    model: 'gemini-3.1-flash-lite',
    modelFamily: 'gemini',
    consumers: ['run verdict claim_mismatch', 'Dev-AW-LoopEvents'],
    knownIssues: ['ENG-185', 'ENG-2029'],
    notes: 'OFF in prod (no AGENT_FINALIZE_GUARD* env). Matches claims to tool status, not external read-back. Shadow evidence: ENG-2150.',
  },
  {
    id: 'agent-run-verdict',
    surface: 'agent',
    graderType: 'code',
    measures: 'ok | degraded | failed per run from tool-failure heuristics and claim_mismatch',
    source: 'loops/instances/agent-mode/runRecorder.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['Dev-AW-LoopEvents', 'reliability snapshot degradedRunRate/failedRunRate', 'burn-in closure gate'],
    knownIssues: ['ENG-1246'],
    notes: 'Heuristic: does not verify that the requested task happened.',
  },
  {
    id: 'agent-task-success',
    surface: 'agent',
    graderType: 'code',
    measures: 'success | failure | excluded per session from work-plan steps (ENG-1710 relaxed rule), with tool evidence for each completed step',
    source: 'loops/eval/agentGraders.ts (gradeTaskSuccess); report scripts/evalAgentGraders.ts',
    version: '1',
    model: 'none',
    modelFamily: 'none',
    consumers: ['scripts/evalAgentGraders.ts (offline, read-only)', 'online eval sampler cron/evalV2SamplerCron.ts (Dev-AW-LoopEvents eval_v2_scored, off until EVAL_V2_SAMPLER_ENABLED)', 'partner-portal Eval v2 tab (labelled unvalidated)'],
    knownIssues: ['ENG-1710', 'ENG-2137'],
    notes: 'Deterministic; offline only. Completion is still the plan\'s own step status, cross-checked against successful required tool calls; not yet compared with human labels (ENG-2135/2136).',
  },
  {
    id: 'agent-task-success-judge',
    surface: 'agent',
    graderType: 'llm_judge',
    measures: 'task_success pass | fail | na per session with the human labelling rubric: every requested deliverable delivered with tool or content evidence, explicit constraints respected; checklist before verdict',
    source: 'services/taskSuccessJudge.ts (prompt, trace rendering, model guard) over services/agentRunTrace.ts; golden-case adapter loops/eval/runValidation.ts (taskSuccessJudgeGrader); trial scripts/runTaskSuccessJudgeTrial.ts',
    version: 'prompt-sha256:17fef09dc816',
    model: 'anthropic.claude-sonnet-5 via OpenRouter (Google and OpenAI models refused: the agent runs on Gemini)',
    modelFamily: 'claude',
    consumers: ['scripts/runTaskSuccessJudgeTrial.ts (offline, read-only)', 'scripts/runGraderValidation.ts agent-task-success-judge'],
    knownIssues: ['ENG-2591'],
    notes: 'ENG-2591: replaces reading the plan\'s own step checkmarks (agent-task-success measured kappa 0.20 vs blind labels on the 40 test work-plan cases, 2026-10-20). Trial 2026-10-21 on the test split: kappa 0.88 vs blind GPT-5.4 labels (n=39), 0.93 where GPT and Claude labels agree (n=34), 0.77 vs Claude labels (n=38); evidence https://linear.app/emmabyaw/issue/ENG-2591/agent-task-success-grader-stop-trusting-step-checkmarks-kappa-020-in#comment-ea8be576. AI labels, not human, so no validation is recorded and it cannot gate: advisory only. Offline only.',
  },
  {
    id: 'agent-tool-correctness',
    surface: 'agent',
    graderType: 'code',
    measures: 'pass | fail per session: invalid args, policy blocks, uninstalled tools, repeated failures, writes never read back (ad platforms, CRM leads, landing-page publish, email send, social publish), repeated identical writes',
    source: 'loops/eval/agentGraders.ts (gradeToolCorrectness)',
    version: '2',
    model: 'none',
    modelFamily: 'none',
    consumers: ['scripts/evalAgentGraders.ts (offline, read-only)', 'online eval sampler cron/evalV2SamplerCron.ts (Dev-AW-LoopEvents eval_v2_scored, off until EVAL_V2_SAMPLER_ENABLED)', 'partner-portal Eval v2 tab (labelled unvalidated)'],
    knownIssues: ['ENG-286', 'ENG-592', 'ENG-2137', 'ENG-2190'],
    notes: 'Grader-side half of ENG-592: flags a write that reported success with no read-back. Ad platforms (Google/Meta/LinkedIn) and CRM leads confirm via a later read of the same account/object; email send and social publish confirm via the provider id their own response carries (no separate read-back tool exists); landing-page publish (ENG-2190) reuses the existing post-deploy smoke test (landingPageSmokeTest.ts) surfaced on the ledger as launchReadiness, rather than a follow-up read. Tools are unchanged.',
  },
  {
    id: 'agent-groundedness-offline',
    surface: 'agent',
    graderType: 'code',
    measures: 'Completion claims in the final reply (finalize-guard lexicon, 7 classes) vs successful tool calls in the session',
    source: 'loops/eval/agentGraders.ts (gradeGroundedness) reusing services/agentMode/core/finalizeGuard.ts matchers',
    version: '1',
    model: 'none',
    modelFamily: 'none',
    consumers: ['scripts/evalAgentGraders.ts (offline, read-only)', 'online eval sampler cron/evalV2SamplerCron.ts (Dev-AW-LoopEvents eval_v2_scored, off until EVAL_V2_SAMPLER_ENABLED)', 'partner-portal Eval v2 tab (labelled unvalidated)'],
    knownIssues: ['ENG-185', 'ENG-2137', 'ENG-2150'],
    notes: 'No LLM: every lexicon hit counts as a claim, so it over-reports against the runtime guard (which asks a judge). Checks tool status, not external state.',
  },
  {
    id: 'agent-reply-length-adherence',
    surface: 'agent',
    graderType: 'code',
    measures: 'pass | fail | not applicable per session: reply length vs an explicit length the user asked for (N words / sentences / paragraphs / pages), with 1.5x tolerance',
    source: 'loops/eval/agentGraders.ts (gradeLengthAdherence)',
    version: '1',
    model: 'none',
    modelFamily: 'none',
    consumers: ['scripts/evalAgentGraders.ts (offline, read-only)', 'online eval sampler cron/evalV2SamplerCron.ts (Dev-AW-LoopEvents eval_v2_scored)', 'partner-portal Eval v2 tab (labelled unvalidated)'],
    knownIssues: ['ENG-1309', 'ENG-1312', 'ENG-2189'],
    notes: 'Deterministic, on real turns. Only numeric limits count; "keep it short" and per-item limits ("each under 100 words") are not applicable. Checks the chat reply, so content delivered through a tool is not measured.',
  },
  {
    id: 'agent-format-adherence',
    surface: 'agent',
    graderType: 'code',
    measures: 'pass | fail | not applicable per session: a table or bulleted list asked for in chat is present in the reply',
    source: 'loops/eval/agentGraders.ts (gradeFormatAdherence)',
    version: '1',
    model: 'none',
    modelFamily: 'none',
    consumers: ['scripts/evalAgentGraders.ts (offline, read-only)', 'online eval sampler cron/evalV2SamplerCron.ts (Dev-AW-LoopEvents eval_v2_scored)', 'partner-portal Eval v2 tab (labelled unvalidated)'],
    knownIssues: ['ENG-1312', 'ENG-2189'],
    notes: 'Deterministic. Not applicable when the request names a sheet, doc, deck or other target, or the turn ran a content-producing tool (the format is in the tool output).',
  },
  {
    id: 'agent-act-without-asking',
    surface: 'agent',
    graderType: 'code',
    measures: 'pass | fail | not applicable per session: told to act ("go ahead", "don\'t ask"), the agent ran no work tool that turn and asked permission instead',
    source: 'loops/eval/agentGraders.ts (gradePermissionAdherence)',
    version: '1',
    model: 'none',
    modelFamily: 'none',
    consumers: ['scripts/evalAgentGraders.ts (offline, read-only)', 'online eval sampler cron/evalV2SamplerCron.ts (Dev-AW-LoopEvents eval_v2_scored)', 'partner-portal Eval v2 tab (labelled unvalidated)'],
    knownIssues: ['ENG-1311', 'ENG-1312', 'ENG-2189'],
    notes: 'Deterministic counterpart of the judge\'s unnecessaryPermissionRequest. Confirming a spend, publish, send or irreversible step passes (ENG-1312 rule); a which/what clarifying question is not a permission request.',
  },
  {
    id: 'agent-reply-length-fixtures',
    surface: 'agent',
    graderType: 'code',
    measures: 'pass | fail per ENG-1312 replay fixture: assistant reply within the ENG-1309 char/word threshold',
    source: 'loops/eval/agentModeReplayFixtures.ts (checkReplayFixture); run by loops/eval/offlineSuiteSources.ts',
    version: '1',
    model: 'none',
    modelFamily: 'none',
    consumers: ['offline eval suite (loops/scripts/runOfflineEvalSuite.ts, report-only)'],
    knownIssues: ['ENG-1309', 'ENG-1312', 'ENG-1314'],
    notes: 'Deterministic threshold check. Fixture turns are synthetic placeholders until the golden-set store links real sessions (ENG-2135, OPS-2), and a placeholder metric never blocks.',
  },
  {
    id: 'okareo-no-hallucinated-capabilities-v2',
    surface: 'agent',
    graderType: 'llm_judge',
    measures: 'pass/fail: real capability over-claims vs appropriate restraint',
    source: 'Okareo check b2c81d35-3f07-489f-bf23-0405f66962e8 (project 0d5558f2-…); calibration set 52dd3d81-…',
    version: 'v2',
    model: 'unknown (Okareo-hosted)',
    modelFamily: 'unknown',
    consumers: ['manual Okareo runs (e.g. docs/verification/ENG-502-evidence)'],
    knownIssues: ['ENG-142'],
    notes: '11/11 on its calibration set (ENG-142) — a calibration check, not human-agreement kappa. Not referenced from code or CI.',
  },
  {
    id: 'enrichment-golden-set',
    surface: 'agent',
    graderType: 'code',
    measures: 'CRM enrichment field accuracy vs a fixed golden set',
    source: '__tests__/enrichmentEval.test.ts + __tests__/fixtures/enrichmentGoldenSet.json',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['jest (on demand)'],
    knownIssues: [],
    notes: 'Only golden set in the repo; CRM enrichment only.',
  },
  {
    id: 'human-eval-queue',
    surface: 'creative',
    graderType: 'human',
    measures: 'Free-text Slack feedback on generated images, landing pages and lead-enrichment runs',
    source: 'services/humanEvalService.ts (AW-HumanEvalQueue, #eval-queue)',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['session learning notes', 'auto-actions (image revision, LP iteration, enrichment rerun)'],
    knownIssues: ['ENG-90', 'ENG-343', 'ENG-1687', 'ENG-1853', 'ENG-1854'],
    notes: 'Single hardcoded reviewer per type; no scale or pairwise choice. No grader scores each generated creative; the only automated creative comparison is the offline onboarding-quality-pairwise judge below.',
  },
  {
    id: 'onboarding-quality-pairwise',
    surface: 'creative',
    graderType: 'llm_judge',
    measures: 'Pairwise better/equal/worse per onboarding layer (brand DNA, ICPs, competitor, creative direction, ad images, ad copy) between two pipeline versions',
    source: 'agentweb-customer-portal: scripts/eval-onboarding-quality.ts + scripts/evalOnboardingQualityPrompt.ts',
    version: 'untracked@2026-09-28',
    model: 'claude-sonnet-4-6',
    modelFamily: 'claude',
    consumers: ['manual offline runs (Eager DAG KPI 2)'],
    knownIssues: [],
    notes: 'Offline, run by hand on fixture pairs to compare pipeline versions; it does not score individual generated creatives in production.',
  },
  {
    id: 'image-prompt-like-rate',
    surface: 'creative',
    graderType: 'human',
    measures: 'Like-rate per onboarding image archetype from "Ads Tinder" likes/rejects',
    source: 'services/imagePromptQualityService.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['admin analytics (report-only)'],
    knownIssues: ['ENG-421'],
  },
  {
    id: 'landing-page-smoke-test',
    surface: 'creative',
    graderType: 'code',
    measures: 'Deployed LP loads, form submits a lead to the CRM, Meta pixel Lead fires',
    source: 'services/landingPageSmokeTest.ts; utils/landingPageLaunchReadiness.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['AW-LandingPages.smokeTestResult', 'launch readiness', 'Slack alert on failure'],
    knownIssues: [],
  },
  {
    id: 'creative-deterministic-gates',
    surface: 'creative',
    graderType: 'code',
    measures: 'Per generated image: decodes, not a blank/near-uniform render, aspect and minimum size vs the requested placement (or the Meta placement assumed from a bare ratio), file size vs platform limit, silent size-to-aspect substitution',
    source: 'services/creativeGates.ts; placement table services/creativePlacementSpecs.ts',
    version: '2026-09-29.1',
    model: 'none',
    modelFamily: 'none',
    consumers: ['imageGeneration result .gates', 'AW-HumanEvalQueue.creativeGates (agent-mode generate_image)', 'AW-Users.adImageResult.variants[].gates (onboarding; stored since ENG-2187 — rows written before it have none)', 'console.warn on failure'],
    knownIssues: ['ENG-421'],
    notes: 'Advisory (ENG-2139): never blocks generation. No OCR text-ratio/spelling check yet. A bare ratio request is held against the matching Meta placement (placementSource "ratio"); ratios no Meta placement uses (16:9, 3:2, …) still skip dimensions/file_size. A remote-URL result (Runway) is gated after a bounded download, else recorded as notChecked (ENG-2187).',
  },
  {
    id: 'creative-rubric-judge',
    surface: 'creative',
    graderType: 'llm_judge',
    measures: 'ENG-421 launch-ready floor as 7 binary checks with rationale (hook clarity, offer specificity, proof integrity, brand fidelity, format readiness, policy/compliance risk, media-buyer usefulness); pairwise preference vs a prior creative for the same account and placement',
    source: 'services/creativeRubricJudge.ts; prompts services/creativeRubricJudgePrompt.ts; runtime hook services/creativeRubricJudgeRuntime.ts; offline scripts/scoreCreativeRubric.ts',
    version: '2026-09-25.1',
    model: 'anthropic.claude-sonnet-5 (CREATIVE_RUBRIC_JUDGE_MODEL; Google/OpenAI models refused)',
    modelFamily: 'claude',
    consumers: [
      'AW-HumanEvalQueue.creativeRubric + .creativePairwise (agent-mode generate_image ads; organic/uncategorized images; deployed landing pages)',
      'AW-Users.adImageResult.variants[].creativeRubric + .creativePairwise, adCopyResult.variants[].creativeRubric (onboarding)',
      'scripts/scoreCreativeRubric.ts (offline, read-only)',
    ],
    knownIssues: ['ENG-421'],
    notes: 'Advisory (ENG-2140, ENG-2192): never blocks generation. Off unless CREATIVE_RUBRIC_JUDGE_ENABLED=true with CREATIVE_RUBRIC_JUDGE_SAMPLE_RATE > 0. Prod: on at sample rate 0.25 (Agentweb-backend-env-prod-3, checked 2026-10-19); verdicts are stored and reported in the eval-v2 creative snapshot (report-only); nothing gates or alerts on them. Images are judged only after the deterministic gates pass. Surfaces: ad_image (7 criteria), organic_image, ad_copy, landing_page (ENG-421 criteria that apply). Runtime pairwise vs the prior best for ad images. Not yet validated against human labels (ENG-2136 harness, per-criterion kappa).',
  },
  {
    id: 'creative-performance-correlation',
    surface: 'creative',
    graderType: 'outcome',
    measures: 'Spearman rho (n, 95% bootstrap CI) between the rubric judge\'s passed-criteria count and settled Meta ad CTR, CVR and hook rate, and CPA and CRM CPL per currency, for generated creatives linked to their live ads',
    source: 'loops/eval/creativePerformance.ts; report scripts/creativePerformanceCorrelation.ts; lineage services/creativeLineage.ts; ad rows cron/metaMetricsSnapshotCron.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['scripts/creativePerformanceCorrelation.ts (printed report, read-only)'],
    knownIssues: [],
    notes: 'ENG-2141. No data until OPS-3 (ENG-2148) creates AW-Creatives and sets CREATIVE_LINEAGE_ENABLED + CREATIVE_LINEAGE_TABLE + META_AD_LEVEL_SNAPSHOTS_ENABLED, and linked ads pass Meta\'s 28-day settling window. CPA uses Meta-reported leads; CPL uses CRM leads joined by utm_content={{ad.id}} (ENG-2194). Validates the rubric judge against outcomes; it is not itself a human-agreement validation.',
  },
  {
    id: 'client-health-assessment',
    surface: 'account_health',
    graderType: 'code',
    measures: 'healthy | mediocre | needs-attention | blocked | onboarding from ads/lander/CRM layers (never at-risk: no behavioural evidence)',
    source: 'services/clientHealthService.ts (assess_client_health, list_all_clients); partner-portal ClientHealth page',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['Emma/MCP admin tools', 'partner-portal Client Health', 'ENG-502 fatigue capture'],
    knownIssues: ['CS-77', 'ENG-1767', 'ENG-2133', 'ENG-2188'],
    notes: 'Until ENG-2133 a never-connected ad account read as blocked / At Risk; until ENG-2188 an expired Meta token or more than two setup gaps did.',
  },
  {
    id: 'renewal-integration-health',
    surface: 'account_health',
    graderType: 'code',
    measures: '"Renewal reconnect needed" when paid-ads intent + every ad integration expired (never-connected is excluded, ENG-2188) + renewal within 14 days',
    source: 'cron/renewalIntegrationHealthCron.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['oncall email + auto-filed Linear issue'],
    knownIssues: ['ENG-1541', 'ENG-1827', 'ENG-1928', 'ENG-1959', 'ENG-2016'],
    notes: 'Disabled unless RENEWAL_HEALTH_ALERTS_ENABLED=true (unset in prod since 7f9f916ca). Redesign: ENG-2143.',
  },
  {
    id: 'account-health-evaluators',
    surface: 'account_health',
    graderType: 'code',
    measures: 'Pixel health, budget variance, ad connectivity flags',
    source: 'services/accountHealthService.ts via cron/metaTrackingMonitorCron.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['console.warn only on live runs'],
    knownIssues: ['ENG-1266', 'ENG-1342', 'ENG-1913'],
    notes: 'Budget inputs are stubbed to 0 in the live sweep.',
  },
  {
    id: 'account-health-classifier',
    surface: 'account_health',
    graderType: 'code',
    measures: 'activation_incomplete | at_risk | healthy | insufficient_evidence per paying account, with evidence and confidence',
    source: 'services/accountHealthClassifier.ts via cron/accountHealthClassifierCron.ts; backtest scripts/eng2143-account-health-backtest.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['needs-review log (at_risk; oncall alert only once mayGate is true) and CS nudge email digest to AW-Settings account_health_cs_emails (activation_incomplete), only when ACCOUNT_HEALTH_ALERTS_ENABLED=true'],
    knownIssues: ['ENG-2016', 'ENG-1342', 'ENG-1913', 'ENG-2149'],
    notes: 'Replaces renewal-integration-health. Not validated: the 2026-09-29 backtest (93 pairs, 8 churned, 5 cutoffs) predicted 1 at-risk, which did not churn: precision 0/1, recall 0/8 [0.00, 0.32]. Behavioural signals (spend drop, results drop, negative feedback) fire rarely because ad snapshots mostly start 2026-08-15; see EVAL_REGISTRY.md. Current-requirement fields arrive with OPS-4 (ENG-2149); no live campaign-delivery source yet, so zero delivery is not evaluated live.',
  },
  {
    id: 'crm-contact-lifecycle',
    surface: 'account_health',
    graderType: 'code',
    measures: 'CRM contact lifecycle (churned / at_risk / …) and 0-100 health score',
    source: 'services/lifecycleService.ts; services/healthScoreService.ts',
    version: 'untracked@2026-09-28',
    model: 'none',
    modelFamily: 'none',
    consumers: ['AW-Leads contacts', 'ask_crm', 'CRM saved view "At-risk Customers"'],
    knownIssues: [],
    notes: 'Classifies a customer\'s own CRM contacts, not AgentWeb accounts.',
  },
];

export function getGrader(id: string): GraderEntry | undefined {
  return EVAL_REGISTRY.find((g) => g.id === id);
}

/**
 * True only for a grader with a recorded validation meeting the ENG-2128 bar. Anything that
 * blocks a change or raises an alert from a grader's output must check this first.
 */
export function mayGate(id: string): boolean {
  return isQualifyingValidation(getGrader(id)?.validation);
}

/** kappa >= MIN_KAPPA on n >= MIN_VALIDATION_N cases scored against HUMAN labels, with an http(s) link to the run. */
export function isQualifyingValidation(v: GraderValidation | undefined): boolean {
  return !!v && v.labelSource === 'human' && v.kappa >= MIN_KAPPA && v.n >= MIN_VALIDATION_N && hasEvidenceLink(v.evidence);
}

function hasEvidenceLink(evidence: string): boolean {
  try {
    const url = new URL(evidence);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}
