/**
 * Finalize guard — claimed-vs-executed truthfulness check at the loop edge
 * (ENG-143 / ENG-135 / ENG-124; generalizes the shipped ENG-104 single-tool
 * pattern into ONE enforcement seam).
 *
 * Runs AFTER the final assistant message is produced, BEFORE emit/persist.
 * The industry consensus (Anthropic is_error contract, OpenAI output
 * guardrails) is that only a PROGRAMMATIC claimed-vs-executed check bounds
 * action-hallucination — the model's self-diagnosis is unreliable. Emma
 * already owns the parts: the run's tool ledger (core/toolDispatch.ts), the
 * encoded-failure detector (toolResultError), and the asset-vs-pause detector
 * built for the xCures 76×-images incident (mediaGenProducedAsset).
 *
 * Flow (all LLM access via injected ports — this module is PURE):
 *   1. Cheap lexicon prefilter for 7 high-harm completed-action claim classes
 *      (email_sent, task_created_or_updated, post_published, schedule_created,
 *      crm_saved, asset_generated, settings_saved). No hit → zero LLM cost,
 *      text unchanged.
 *   2. ONLY on a hit: one structured-output judge call extracts the concrete
 *      claims the reply makes.
 *   3. Deterministic match of each claim class against SUCCESSFUL ledger
 *      entries (status==='success' && !toolResultError(result); asset claims
 *      additionally require mediaGenProducedAsset — a confirmation-gate pause
 *      is not an asset).
 *   4. Mismatch → ONE corrective turn ("run log shows no successful <X> —
 *      restate the true outcome") → re-check → still mismatched → append a
 *      VISIBLE truthful correction and report claimMismatch=true so the caller
 *      records it as a computeRunVerdict reason (run grades degraded → the
 *      17:30 UTC failure-cluster cron sees the class).
 *
 * NO-FALLBACK compliance: the guard NEVER silently rewrites the message —
 * every text change is either the model's own corrective restatement or a
 * clearly visible appended correction. Judge/correction-call failure on this
 * advisory gate = deliver the text unchanged (or with the visible correction)
 * + a loud claim_check_error telemetry signal via recordClaimCheckError — an
 * explicitly documented best-effort substep, because blocking chat delivery on
 * a judge outage would be failing badly (a new hard dependency).
 *
 * Feature flag: the CALLER gates this behind AGENT_FINALIZE_GUARD (env,
 * default OFF) — an A-or-B migration flag, not an on-error fallback. With the
 * flag off this module is never invoked and the characterization harness is
 * byte-identical.
 */

import { MEDIA_GEN_TOOLS } from './toolDispatch';

/** Tools that actually persist settings/setup across sessions (settings_saved
 * claim class) — confirmed against backend/src/emma/tools.ts. */
const SETTINGS_PERSISTENCE_TOOLS = new Set<string>([
  'save_memory',
  'save_org_memory',
  'update_brand_guidelines',
  'update_market_strategy',
]);

/** The 7 high-harm completed-action claim classes the guard verifies. */
export type ClaimClass =
  | 'email_sent'
  | 'task_created_or_updated'
  | 'post_published'
  | 'schedule_created'
  | 'crm_saved'
  | 'asset_generated'
  | 'settings_saved';

export const CLAIM_CLASSES: readonly ClaimClass[] = [
  'email_sent',
  'task_created_or_updated',
  'post_published',
  'schedule_created',
  'crm_saved',
  'asset_generated',
  'settings_saved',
];

/**
 * Cheap lexicon prefilter — completed-action phrasing near the class noun.
 * Deliberately loose (a false positive costs one judge call; a false negative
 * skips the guard), but anchored on past-tense/completion verbs so option
 * lists and plans ("I can send an email…") do not trigger it.
 */
const CLAIM_LEXICON: Record<ClaimClass, RegExp> = {
  email_sent:
    /\bemailed\b|\b(email|emails)\b[^.!\n]{0,120}\b(sent|delivered|went out)\b|\b(sent|delivered)\b[^.!\n]{0,120}\b(email|emails|inbox)\b/i,
  task_created_or_updated:
    /\btasks?\b[^.!\n]{0,120}\b(created|updated|added|completed|landed|now in)\b|\b(created|updated|added)\b[^.!\n]{0,120}\btasks?\b/i,
  post_published:
    /\b(published|posted)\b[^.!\n]{0,120}\b(post|posts|blog|article|linkedin|social)\b|\b(post|posts|blog|article)\b[^.!\n]{0,120}\b(published|posted|is live|went live)\b/i,
  schedule_created:
    /\bschedule\b[^.!\n]{0,120}\b(created|set up|configured|active|in place)\b|\b(created|set up)\b[^.!\n]{0,120}\bschedule\b|\bscheduled\b[^.!\n]{0,120}\b(chat|report|task|run|email|post)\b/i,
  crm_saved:
    /\b(saved|added|updated|imported)\b[^.!\n]{0,120}\b(crm|leads?|contacts?)\b|\b(crm|leads?|contacts?)\b[^.!\n]{0,120}\b(saved|added|updated|imported)\b/i,
  asset_generated:
    /\b(generated|created|produced)\b[^.!\n]{0,120}\b(image|images|video|videos|voiceover|visuals?|assets?)\b|\b(image|images|video|videos|voiceover)\b[^.!\n]{0,120}\b(generated|created|ready|saved)\b/i,
  // ENG-143's own "saved the setup for future sessions" example — cross-session
  // persistence claims (memory, brand guidelines, market strategy, preferences)
  // had no claim class at all before this.
  settings_saved:
    /\b(saved|remembered|stored)\b[^.!\n]{0,120}\b(setup|settings?|preferences?|configuration|for (future|next) (session|time)|for later)\b|\b(setup|settings?|preferences?|configuration)\b[^.!\n]{0,120}\b(saved|remembered|stored)\b/i,
};

/** Which claim classes the final text plausibly asserts (prefilter only). */
export function prefilterClaimClasses(finalText: string): ClaimClass[] {
  return CLAIM_CLASSES.filter((cls) => CLAIM_LEXICON[cls].test(finalText));
}

/**
 * Deterministic claim-class → tool-name matchers. A claim is BACKED only when
 * a matching tool has a successful ledger entry (see claimBackedByLedger).
 */
const CLAIM_TOOL_MATCHERS: Record<ClaimClass, (toolName: string) => boolean> = {
  email_sent: (n) => n === 'send_email' || (/email/.test(n) && /^(send_|create_and_send_)/.test(n)),
  task_created_or_updated: (n) => /task/.test(n) && /^(create_|update_|manage_|add_|execute_)/.test(n),
  post_published: (n) => n === 'create_social_media_posts' || n === 'post_on_account' || n.startsWith('publish_'),
  schedule_created: (n) => /schedul/.test(n) && /^(create_|manage_|add_|update_)/.test(n),
  crm_saved: (n) => /lead|contact|crm/.test(n) && /^(create_|update_|manage_|add_|save_|import_)/.test(n),
  asset_generated: (n) => MEDIA_GEN_TOOLS.has(n),
  // Grounded in the actual persistence tools Emma has: save_memory,
  // save_org_memory (cross-session "Memory & Lessons"), update_brand_guidelines,
  // update_market_strategy (the "setup" onboarding/brand context tools).
  settings_saved: (n) => SETTINGS_PERSISTENCE_TOOLS.has(n),
};

/**
 * Loose, keyword-only counterpart to CLAIM_TOOL_MATCHERS (no prefix/exact-set
 * requirement) — risk-reduction measure: these regex-based matchers will
 * always have coverage gaps for tools that don't follow the expected naming
 * convention (we've already found and fixed two: ClickUp, settings). Wrongly
 * correcting a TRUE claim because of a matcher miss is worse than the
 * original bug — it visibly contradicts a statement that was actually
 * correct. When the strict matcher misses but this loose one hits a real
 * successful tool call, the guard treats the claim as AMBIGUOUS instead of
 * unbacked: it does not correct the message, only surfaces the gap for
 * review (see FinalizeGuardOutcome.ambiguousClaimClasses).
 */
const CLAIM_TOOL_LOOSE_MATCHERS: Record<ClaimClass, (toolName: string) => boolean> = {
  email_sent: (n) => /email/.test(n),
  task_created_or_updated: (n) => /task/.test(n),
  post_published: (n) => /post|social|blog|article|content/.test(n),
  schedule_created: (n) => /schedul/.test(n),
  crm_saved: (n) => /lead|contact|crm/.test(n),
  // Excludes MEDIA_GEN_TOOLS itself: a KNOWN media-gen tool that fails the
  // strict matcher already failed it for a confident reason (the
  // confirmation-gate-pause check, mediaGenProducedAsset) — that's a deliberate
  // exclusion, not a naming-convention coverage gap, so it must NOT be
  // downgraded to "ambiguous, don't correct" (the xCures 76x-images case
  // depends on this staying a confident, corrected mismatch).
  asset_generated: (n) => !MEDIA_GEN_TOOLS.has(n) && /image|video|voiceover|asset/.test(n),
  settings_saved: (n) => /memory|setting|preference|brand_guideline|market_strategy|config/.test(n),
};

/** A run-ledger entry, normalized from the loop's toolCalls ledger. */
export interface FinalizeLedgerEntry {
  toolName: string;
  status: 'success' | 'error' | 'deferred';
  /** the minimal stored result for successful calls (carries encoded-failure
   * and awaitingUserConfirmation markers) */
  result?: any;
}

/** One concrete claim the judge extracted from the final text. */
export interface JudgedClaim {
  claimClass: ClaimClass;
  /** optional supporting quote/statement from the reply (audit only) */
  statement?: string;
}

export interface FinalizeGuardPorts {
  /** ONE structured-output judge call (existing callLLM machinery). Throws on
   * judge failure — the guard then delivers unchanged + records the error. */
  judgeExtractClaims: (finalText: string, candidateClasses: readonly ClaimClass[]) => Promise<JudgedClaim[]>;
  /** ONE corrective model turn: given the untrue text + the system note,
   * returns the restated (truthful) reply. */
  requestCorrection: (input: { finalText: string; systemNote: string }) => Promise<string>;
  /** canonical encoded-failure detector (utils/toolResultError) */
  toolResultError: (result: any) => any;
  /** asset-vs-confirmation-pause detector (core/toolDispatch) */
  mediaGenProducedAsset: (toolName: string, result: any) => boolean;
  /** LOUD claim_check_error telemetry — called on every judge/correction port
   * failure. Best-effort by contract (must not throw into the guard). */
  recordClaimCheckError: (error: unknown) => void;
}

export interface FinalizeGuardInput {
  finalText: string;
  ledger: FinalizeLedgerEntry[];
  ports: FinalizeGuardPorts;
}

export type FinalizeGuardAction =
  /** prefilter found no completed-action claim — zero LLM cost */
  | 'no_claims'
  /** claims found and every one is backed by the ledger */
  | 'clean'
  /** every unbacked claim was only ambiguous (loose match, no strict match) —
   * left uncorrected, surfaced via ambiguousClaimClasses for review */
  | 'ambiguous_unmatched'
  /** mismatch found; the corrective turn resolved it */
  | 'corrected'
  /** mismatch unresolved; a visible truthful correction was appended */
  | 'appended_correction'
  /** the judge call failed; text delivered unchanged (claim_check_error emitted) */
  | 'judge_error';

export interface FinalizeGuardOutcome {
  finalText: string;
  action: FinalizeGuardAction;
  /** unresolved mismatched classes (non-empty only for appended_correction) */
  mismatchedClaimClasses: ClaimClass[];
  /** claim classes that had NO strict tool-name match but DID have a loose
   * keyword match on a real successful tool call — deliberately excluded from
   * correction (see CLAIM_TOOL_LOOSE_MATCHERS) and reported for review rather
   * than risking a false correction of a claim that may well be true. */
  ambiguousClaimClasses: ClaimClass[];
  /** true only when the mismatch stayed unresolved — the caller records this
   * as the claim_mismatch computeRunVerdict reason (run grades degraded) */
  claimMismatch: boolean;
}

/** Is a claim class backed by a SUCCESSFUL ledger entry (strict match)? */
export function claimBackedByLedger(
  claimClass: ClaimClass,
  ledger: FinalizeLedgerEntry[],
  ports: Pick<FinalizeGuardPorts, 'toolResultError' | 'mediaGenProducedAsset'>,
): boolean {
  const matches = CLAIM_TOOL_MATCHERS[claimClass];
  return ledger.some(
    (entry) =>
      entry.status === 'success'
      && matches(entry.toolName)
      && !ports.toolResultError(entry.result)
      && (claimClass !== 'asset_generated' || ports.mediaGenProducedAsset(entry.toolName, entry.result)),
  );
}

/** Is a claim class loosely (keyword-only) matched by a SUCCESSFUL ledger
 * entry? Used only to downgrade a strict-matcher miss to "ambiguous" instead
 * of "confidently unbacked" — see CLAIM_TOOL_LOOSE_MATCHERS. */
function claimLooselyMatchedByLedger(
  claimClass: ClaimClass,
  ledger: FinalizeLedgerEntry[],
  ports: Pick<FinalizeGuardPorts, 'toolResultError'>,
): boolean {
  const looseMatch = CLAIM_TOOL_LOOSE_MATCHERS[claimClass];
  return ledger.some(
    (entry) => entry.status === 'success' && looseMatch(entry.toolName) && !ports.toolResultError(entry.result),
  );
}

/** The corrective-turn system note ("run log shows no successful <X>…"). */
export function buildCorrectionSystemNote(mismatched: readonly ClaimClass[]): string {
  return (
    `The run log shows no successful ${mismatched.join(', ')} in this session — `
    + 'your previous reply claimed otherwise. Restate the true outcome: only describe actions the run log confirms succeeded, '
    + 'clearly say what was NOT completed, and tell the user what to do next (e.g. ask you to retry).'
  );
}

/** The visible truthful correction appended when the mismatch stays unresolved. */
export function buildVisibleCorrection(mismatched: readonly ClaimClass[]): string {
  return (
    `⚠️ Correction: the run log does not show a successful ${mismatched.join(', ')} in this session. `
    + 'Any statement above claiming that action completed is inaccurate — it did NOT complete. '
    + 'Please ask me to retry, or verify manually before relying on it.'
  );
}

/** Extract-and-dedupe the claim classes the judge asserted, dropping unknowns. */
function judgedClasses(claims: JudgedClaim[]): ClaimClass[] {
  const known = new Set<ClaimClass>(CLAIM_CLASSES);
  const seen = new Set<ClaimClass>();
  for (const claim of claims) {
    if (claim && known.has(claim.claimClass)) seen.add(claim.claimClass);
  }
  return [...seen];
}

/**
 * Split the claim classes among `claims` that no successful ledger entry
 * strictly backs into two confidence tiers: confidentlyUnbacked (no match at
 * all, not even loose) vs ambiguous (a loose keyword match exists — likely a
 * matcher coverage gap, not an actual false claim).
 */
function splitUnbackedClasses(
  claims: JudgedClaim[],
  ledger: FinalizeLedgerEntry[],
  ports: FinalizeGuardPorts,
): { confidentlyUnbacked: ClaimClass[]; ambiguous: ClaimClass[] } {
  const confidentlyUnbacked: ClaimClass[] = [];
  const ambiguous: ClaimClass[] = [];
  for (const cls of judgedClasses(claims)) {
    if (claimBackedByLedger(cls, ledger, ports)) continue;
    if (claimLooselyMatchedByLedger(cls, ledger, ports)) ambiguous.push(cls);
    else confidentlyUnbacked.push(cls);
  }
  return { confidentlyUnbacked, ambiguous };
}

export async function runFinalizeGuard(input: FinalizeGuardInput): Promise<FinalizeGuardOutcome> {
  const { finalText, ledger, ports } = input;
  const unchanged = (action: FinalizeGuardAction, ambiguousClaimClasses: ClaimClass[] = []): FinalizeGuardOutcome => ({
    finalText,
    action,
    mismatchedClaimClasses: [],
    ambiguousClaimClasses,
    claimMismatch: false,
  });

  // 1. Lexicon prefilter — the common case exits here with zero LLM cost.
  const candidates = prefilterClaimClasses(finalText);
  if (candidates.length === 0) return unchanged('no_claims');

  // 2. One judge call. Failure = deliver unchanged + loud claim_check_error
  //    (documented best-effort — never block delivery on the judge).
  let claims: JudgedClaim[];
  try {
    claims = await ports.judgeExtractClaims(finalText, candidates);
  } catch (err) {
    ports.recordClaimCheckError(err);
    return unchanged('judge_error');
  }

  // 3. Deterministic ledger match, split by confidence (risk reduction):
  //    ambiguous (loose-only) matches are never corrected, only reported.
  const { confidentlyUnbacked: mismatched, ambiguous } = splitUnbackedClasses(claims, ledger, ports);
  if (mismatched.length === 0) {
    return unchanged(ambiguous.length > 0 ? 'ambiguous_unmatched' : 'clean', ambiguous);
  }

  // 4. ONE corrective turn — targets only the confidently-unbacked classes.
  //    If the correction call itself fails, fail VISIBLY: append the truthful
  //    correction to the original text (never deliver the unbacked claim
  //    silently) and record the port failure loudly.
  let corrected: string;
  try {
    corrected = (await ports.requestCorrection({
      finalText,
      systemNote: buildCorrectionSystemNote(mismatched),
    }))?.trim();
    if (!corrected) throw new Error('finalize-guard correction returned empty text');
  } catch (err) {
    ports.recordClaimCheckError(err);
    return {
      finalText: `${finalText}\n\n${buildVisibleCorrection(mismatched)}`,
      action: 'appended_correction',
      mismatchedClaimClasses: mismatched,
      ambiguousClaimClasses: ambiguous,
      claimMismatch: true,
    };
  }

  // 5. Re-check the corrected text (prefilter → judge → match). A judge failure
  //    here is treated conservatively as "still mismatched" — we already know
  //    the original claims were unbacked.
  let stillMismatched: ClaimClass[] = [];
  const recheckCandidates = prefilterClaimClasses(corrected);
  if (recheckCandidates.length > 0) {
    try {
      const recheckClaims = await ports.judgeExtractClaims(corrected, recheckCandidates);
      stillMismatched = splitUnbackedClasses(recheckClaims, ledger, ports).confidentlyUnbacked;
    } catch (err) {
      ports.recordClaimCheckError(err);
      stillMismatched = mismatched;
    }
  }

  if (stillMismatched.length === 0) {
    return {
      finalText: corrected,
      action: 'corrected',
      mismatchedClaimClasses: [],
      ambiguousClaimClasses: ambiguous,
      claimMismatch: false,
    };
  }

  return {
    finalText: `${corrected}\n\n${buildVisibleCorrection(stillMismatched)}`,
    action: 'appended_correction',
    mismatchedClaimClasses: stillMismatched,
    ambiguousClaimClasses: ambiguous,
    claimMismatch: true,
  };
}
