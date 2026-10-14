import { createHash } from 'node:crypto';
import { resolveModelForUser } from './modelRoles';
import { OUTCOME_JUDGE_SHADOW_FEATURE, assertOutcomeJudgeModelAllowed, DEFAULT_OUTCOME_JUDGE_MODEL, isInShadowSample } from './outcomeJudge';
import { chatbotDb, ChatSession, ChatMessage } from "./chatbotService";
import { summarizeAiStyleTells } from "./aiStyleGuard";
import {
  appendConfirmedPublishNotice,
  ledgerFromSucceededFunctions,
} from "../utils/falseFailureReport";

export const SCORING_MODEL = "gemini-3.1-flash-lite";

// Token budget for the JSON scoring response. Must be generous enough for
// "thinking" models (e.g. gemini-3.5-flash) whose internal reasoning consumes
// the completion budget before the JSON is emitted — too low a cap causes
// finish_reason=length with truncated/empty JSON. Non-thinking models still
// stop after ~80 tokens, so a high cap adds no cost for them.
//
// ENG-1669: 2000 was still not enough in practice — confirmed against
// production (2026-09-01): two real custom-judge scoring calls truncated
// mid-JSON ("Unterminated string in JSON...", "Expected ',' or '}' after
// property value...") on judges with long (8k-10k char) system prompts that
// encourage detailed reasoning. Doubled; non-thinking models are unaffected
// per the note above.
export const SCORING_MAX_COMPLETION_TOKENS = 4000;

const MAX_TOOL_CONTENT_FOR_SCORING = 500; // chars per tool result in scoring context

/**
 * Serialize session messages into a readable conversation transcript for scoring.
 * Includes user, assistant, and tool messages. For assistant messages that only
 * contain tool calls (empty content), synthesizes a "[called tools: ...]" line so
 * the judge can see that tools were actually invoked rather than treating the turn
 * as a silent/empty response.
 */
/**
 * Message content as plain text. `null`/`undefined` (a tool-calls-only turn persists with the
 * field absent) is empty text, NOT a JSON value: `JSON.stringify(undefined ?? "")` is the
 * two-character string `""`, which is truthy, so it would print a literal `""` into the judge's
 * transcript and stop empty assistant turns being skipped.
 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  return JSON.stringify(content);
}

function serializeMessagesForScoring(messages: ChatMessage[]): string {
  const lines: string[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      const text = textOf(m.content);
      lines.push(`user: ${text}`);

    } else if (m.role === "assistant") {
      // A harness-written run-failure placeholder (crash/abandon note) is NOT model
      // output — it stands in for a turn the model never produced. Never surface it
      // to the LLM judge: if a placeholder coexists with a later real turn (e.g. an
      // interactive run that crashed and the user retried in the same session), the
      // judge would otherwise read the note verbatim and score against it (ENG-479).
      if (isRunFailurePlaceholder(m)) continue;
      const text = textOf(m.content).trim();
      const toolCalls: Array<{ name: string; arguments?: any }> = (m as any).metadata?.toolCalls || [];

      if (text && toolCalls.length > 0) {
        const toolNames = toolCalls.map((tc) => tc.name).join(", ");
        lines.push(`assistant: ${text}\n[called tools: ${toolNames}]`);
      } else if (text) {
        lines.push(`assistant: ${text}`);
      } else if (toolCalls.length > 0) {
        // No text content — only tool calls. Make them visible to the judge.
        const toolNames = toolCalls.map((tc) => tc.name).join(", ");
        lines.push(`assistant: [called tools: ${toolNames}]`);
      }
      // Completely empty assistant message (no text, no tool calls) — skip

    } else if (m.role === "tool") {
      const name = (m as any).name || "tool";
      const raw = textOf(m.content);
      const preview = raw.length > MAX_TOOL_CONTENT_FOR_SCORING
        ? raw.slice(0, MAX_TOOL_CONTENT_FOR_SCORING) + "…"
        : raw;
      lines.push(`tool result (${name}): ${preview}`);
    }
  }

  return lines.join("\n");
}

/** Best-effort success/failure classification of a tool result payload. */
function describeToolOutcome(content: unknown): "success" | "failed" | "unknown" {
  const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (parsed.success === false || parsed.error) return "failed";
      if (parsed.success === true) return "success";
    }
  } catch {
    // Not JSON — no structured outcome to read, fall through to unknown.
  }
  return "unknown";
}

/**
 * A tool call as persisted on an assistant message shows up in one of two
 * shapes depending on which write path produced it — normalize both to
 * `{id, name}`.
 *
 * `metadata.toolCalls` (agent-mode's own bookkeeping, `{id, name, arguments,
 * result?, error?}`) and top-level `tool_calls` (raw OpenAI/Anthropic wire
 * format, `{id, type, function: {name, arguments}}`) are NOT duplicates of
 * each other in practice — verified against real production data (session
 * 368a96ac-c8ca-46db-af04-d4f629856e3e): every genuine tool call on that
 * session is stored as top-level `tool_calls` with metadata.toolCalls absent
 * entirely (CodeRabbit review, ENG-1223 PR #2548). A manifest that only read
 * metadata.toolCalls would report "0 tool calls" for a session that made
 * several real ones — actively misleading the judge in the wrong direction,
 * and, combined with applyFabricationGuard's assertsToolDerivedData trigger,
 * capable of forcing dataAccuracy to 1 on a legitimate, accurate, tool-backed
 * response.
 */
function normalizeToolCallEntries(
  m: ChatMessage
): Array<{ id?: string; name: string; result?: any; error?: string }> {
  const metaCalls: Array<{ id?: string; name: string; result?: any; error?: string }> =
    (m as any).metadata?.toolCalls || [];
  const topCalls: Array<{ id?: string; name?: string; function?: { name?: string } }> =
    (m as any).tool_calls || [];
  const normalizedTop = topCalls
    .map((tc) => ({ id: tc.id, name: tc.function?.name || tc.name || "" }))
    .filter((tc) => tc.name);

  // A single call could in principle be represented in both fields on the same
  // message — de-dupe by id so it is never double-counted. metadata.toolCalls
  // entries come first so their inline result/error (top-level tool_calls has
  // neither — the result always lives in a separate tool-role message) wins.
  const seen = new Set<string>();
  const combined: Array<{ id?: string; name: string; result?: any; error?: string }> = [];
  for (const tc of [...metaCalls, ...normalizedTop]) {
    const key = tc.id || `${tc.name}:${combined.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(tc);
  }
  return combined;
}

/**
 * Ground-truth tool-call manifest for a session: the real count of tool calls
 * the assistant actually made, their names, and (best-effort) outcomes.
 *
 * ENG-1223: a judge reading only the prose transcript can be talked into
 * crediting a well-written simulation as if a tool had actually run. Computing
 * this in code — rather than asking the judge to infer it from the transcript
 * — gives the judge a fact it cannot be argued out of. Zero tool calls in the
 * WHOLE session is called out explicitly, since that is exactly the shape of
 * this bug's repro (attributionBasis 'selection-only', zero tool calls, but a
 * response presenting invented account/query data as if retrieved live).
 */
function buildToolCallManifest(messages: ChatMessage[]): { count: number; text: string } {
  const entries: string[] = [];

  for (const m of messages) {
    if (m.role !== "assistant" || isRunFailurePlaceholder(m)) continue;
    const toolCalls = normalizeToolCallEntries(m);
    for (const tc of toolCalls) {
      const resultMsg = tc.id
        ? messages.find((mm: any) => mm.role === "tool" && mm.tool_call_id === tc.id)
        : undefined;
      // A separate tool-role message is the primary source (it's how agent-mode's
      // top-level tool_calls always report their result). When none exists, fall
      // back to result/error already inline on a metadata.toolCalls entry rather
      // than reporting a known outcome as "unknown".
      const outcome: "success" | "failed" | "unknown" = resultMsg
        ? describeToolOutcome((resultMsg as any).content)
        : tc.error
        ? "failed"
        : tc.result !== undefined
        ? "success"
        : "unknown";
      entries.push(outcome === "unknown" ? tc.name : `${tc.name} (${outcome})`);
    }
  }

  if (entries.length === 0) {
    return {
      count: 0,
      text: "[TOOL CALL MANIFEST: 0 tool calls were made anywhere in this session. Any specific data the assistant's responses present as retrieved, queried, fetched, or executed via a tool (account names, IDs, numbers, query rows, etc.) was NOT obtained from a real tool call — treat it as fabricated/simulated, not verified data.]",
    };
  }

  return {
    count: entries.length,
    text: `[TOOL CALL MANIFEST: ${entries.length} tool call(s) made in this session: ${entries.join(", ")}. Only data actually returned by these calls (see "tool result" lines) is verified — anything else the assistant presents as tool-derived is not.]`,
  };
}

/**
 * Matches "simulat..." language only when it's crediting the simulation as if
 * it were a completed/successful action (e.g. "successfully simulated",
 * "simulated/executed", "simulation succeeded") — not bare mentions of
 * "simulate" in a genuine, tool-free simulation/roleplay request the judge
 * correctly scored well (e.g. "the user asked the assistant to simulate a
 * role-play scenario, which it did well").
 */
const CREDITS_SIMULATION_AS_SUCCESS_RE =
  /successfully simulat|simulat(?:ed|ion)[\s\S]{0,20}(?:execut|success|complet)/i;

/**
 * Structural backstop for ENG-1223: a judge that still credits a fabricated
 * simulation as success despite FABRICATION_GROUNDING_CLAUSE and the tool-call
 * manifest — the exact way Fangfang Judge scored dataAccuracy 5 while its own
 * "reason" said "successfully simulated/executed" — is overridden rather than
 * trusted.
 *
 * Two independent triggers, either is sufficient, both require ZERO tool
 * calls in the session:
 *   1. `assertsToolDerivedData === true` — the judge's own structured factual
 *      field (see FABRICATION_GROUNDING_CLAUSE) saying the response presented
 *      data as if tool-retrieved. With zero tool calls in the session, that
 *      claim is fabricated by definition, regardless of what words the
 *      judge's free-text "reason" happens to use. This closes the gap the
 *      original (reason-text-only) version of this guard had: a judge that
 *      fabricates a high score WITHOUT ever writing "simulat" anywhere.
 *   2. CREDITS_SIMULATION_AS_SUCCESS_RE on the reason text — kept as a
 *      fallback for a judge/prompt that predates `assertsToolDerivedData`
 *      (field omitted, so trigger 1 doesn't fire) but still confesses to
 *      crediting a simulation in prose, exactly Fangfang's original wording.
 *
 * `assertsToolDerivedData` is deliberately NOT defaulted to `true` when
 * missing/malformed (unlike NO_TASK_JUDGMENT_CLAUSE's taskRequested, which
 * fails open toward the rare case). The base rates are opposite: the vast
 * majority of zero-tool-call sessions are ordinary, correct, tool-free chat
 * replies, so defaulting a missing field to `true` here would systematically
 * cap dataAccuracy on normal good sessions any time a judge simply omits the
 * field — the same "never fake a default that would masquerade as a real
 * judge answer" reasoning parseDimensions already applies to the ENG-1312
 * fields. A missing field just falls back to trigger 2 above.
 *
 * A normal, accurate, tool-free chat reply (dataAccuracy 5 is correct,
 * assertsToolDerivedData false/omitted, "simulat" never appears), AND a
 * genuine tool-free simulation/roleplay request the judge scored correctly,
 * are both left untouched.
 */
function applyFabricationGuard(
  toolCallCount: number,
  reason: string,
  score: number,
  dimensions: ScoringResult["dimensions"],
  assertsToolDerivedData?: boolean
): { score: number; dimensions: ScoringResult["dimensions"] } {
  const credited = assertsToolDerivedData === true || CREDITS_SIMULATION_AS_SUCCESS_RE.test(reason);
  if (toolCallCount > 0 || !credited) {
    return { score, dimensions };
  }

  const guardedDimensions = dimensions
    ? { ...dimensions, dataAccuracy: 1, goalCompletion: Math.min(dimensions.goalCompletion, 2) }
    : dimensions;

  return { score: Math.min(score, 2), dimensions: guardedDimensions };
}

/**
 * Assistant-directed criticism markers. Deliberately plain substring keywords
 * (not a single dense regex) so the list stays easy to extend and audit.
 * Matched case-insensitively, but only within a clause that also names the
 * assistant as its subject (see reasonCriticizesAssistant) — matching
 * anywhere in the full reason would also catch these words describing the
 * USER's request ("the user's message was vague") as if they criticized the
 * assistant.
 */
const ASSISTANT_CRITICISM_KEYWORDS = [
  "fail", "incorrect", "inaccura", "hallucinat", "fabricat", "mistake",
  "error", "wrong", "misunderstood", "misread", "misinterpret",
  "did not", "didn't", "never", "could not", "couldn't", "neglect",
  "overlook", "ignor", "unhelpful", "inadequate", "insufficient",
  "inappropriate", "should have", "too verbose", "too long",
  "repeated itself", "confusing", "poorly", "vague", "unnecessary",
];

/** Matches a clause whose subject is the assistant, not the user or the request. */
const ASSISTANT_SUBJECT_RE = /\b(?:the\s+assistant|assistant|it)\b/i;

/**
 * ENG-1296 follow-up: a criticism keyword only counts when it appears in the
 * same clause as an assistant-subject reference. Splitting on sentence
 * boundaries and comma+contrast conjunctions ("but"/"however"/...) keeps
 * "the user's message was vague, but the assistant correctly declined to
 * guess" from being misread as the assistant being criticized for vagueness.
 */
function reasonCriticizesAssistant(reason: string): boolean {
  const clauses = reason.split(/(?<=[.!?;])\s+|,\s*(?:but|however|though|yet|while)\s+/i);
  return clauses.some((clause) => {
    if (!ASSISTANT_SUBJECT_RE.test(clause)) return false;
    const lower = clause.toLowerCase();
    return ASSISTANT_CRITICISM_KEYWORDS.some((kw) => lower.includes(kw));
  });
}

/**
 * Positive-detection signal that the judge's stated rationale is specifically
 * "the conversation ended / the user hasn't replied yet", the exact ENG-1296
 * pattern — as opposed to any other reason a goalCompletion score might be
 * low. Matched against the raw reason text.
 */
const AWAITING_REPLY_RATIONALE_RE =
  /\bconversation ended\b|\bended before\b|\bawaiting\s+(?:a\s+)?(?:user\s+)?response\b|\bhas\s+not\s+yet\s+responded\b/i;

/**
 * ENG-1296: the Fangfang Judge scored three sessions goalCompletion 3 where
 * the user's request was a genuinely ambiguous fragment and the assistant's
 * ONLY move was to decline to guess and ask one focused clarifying question —
 * textbook-correct handling per the Drafting Direction Guard. Each reason
 * PRAISED that handling in full ("handled it excellently", "handled this
 * gracefully") and docked goalCompletion purely because the conversation
 * ended before the user replied — something entirely outside the assistant's
 * control. The general satisfaction judge and Matt Judge scored the same
 * three sessions 5/5/5, proving 3 was a judge-specific artifact, not a real
 * defect.
 *
 * This is a narrow, code-level sanity check, same shape as
 * applyFabricationGuard, but detection is POSITIVE, not the absence of a
 * blocklist match: it only raises the score when the reason affirmatively
 * states the awaiting-reply/ended-before-response rationale
 * (AWAITING_REPLY_RATIONALE_RE) AND contains no criticism of the assistant.
 * An earlier version fired whenever ~24 fixed criticism keywords failed to
 * match anywhere in the reason, which meant a genuine goalCompletion failure
 * phrased without any of those words (e.g. "the assistant asked an
 * unnecessary clarifying question instead of completing the task") was
 * silently force-raised to a passing score whenever dataAccuracy/
 * outputQuality were already high — masking real failures, the mirror image
 * of the bug this guard exists to fix. Requiring the affirmative rationale
 * first means a criticism phrased in unlisted words is left alone rather
 * than being treated as "no criticism found".
 */
function applyAwaitingReplyGuard(
  reason: string,
  score: number,
  dimensions: ScoringResult["dimensions"]
): { score: number; dimensions: ScoringResult["dimensions"] } {
  if (!dimensions) return { score, dimensions };
  if (dimensions.goalCompletion > 3) return { score, dimensions };
  if (dimensions.dataAccuracy < 4 || dimensions.outputQuality < 4) return { score, dimensions };
  if (!AWAITING_REPLY_RATIONALE_RE.test(reason)) return { score, dimensions };
  if (reasonCriticizesAssistant(reason)) return { score, dimensions };

  return {
    score: Math.max(score, 4),
    dimensions: { ...dimensions, goalCompletion: Math.max(dimensions.goalCompletion, 4) },
  };
}

/**
 * ENG-1296: goalCompletion must not be scored on whether the user has replied
 * yet — that is outside the assistant's control. Appended at call time, same
 * reasoning as NO_TASK_JUDGMENT_CLAUSE: both the default prompt and a custom
 * `ScoringJudge.systemPrompt` (Fangfang Judge, Matt Judge) are AW-Settings
 * data that predates this rule, so writing it only into
 * DEFAULT_SCORING_SYSTEM_PROMPT would leave whatever prompt is actually
 * configured blind to it (ENG-392).
 */
const JUDGE_STRICT_JSON_CLAUSE = `

Your previous reply was not valid JSON. Return ONLY one JSON object. Inside every string value, escape double quotes as \\" and write newlines as \\n, never as raw line breaks.`;

export const AWAITING_USER_REPLY_CLAUSE = `

IMPORTANT: A conversation that ends on the assistant's own well-formed clarifying question:
- If the user's request was genuinely ambiguous or a bare fragment, and the assistant's LAST turn correctly identified the ambiguity, avoided guessing or taking any irreversible action, and asked ONE focused question to resolve it, that is complete, correct handling — even if the conversation ends there with no user reply yet.
- Score goalCompletion on the QUALITY of that clarifying question (was it focused and correct, and did it avoid guessing?), NOT on whether the user has replied. Whether or when the user replies is outside the assistant's control and must never be treated as a goal-completion failure.
- Example: the user pastes an ambiguous third-party message fragment with no explicit instruction; the assistant flags the ambiguity, declines to guess, and asks a single clear clarifying question; the conversation ends there. This is goalCompletion 5 — do not write a reason like "the conversation ended before the user could respond, so the goal is not yet complete" and do not score it 3 as a "neutral" placeholder.
- Sanity check before finalizing: if your own "reason" text contains no criticism of the assistant's handling, goalCompletion (and the overall score) must not be 3 or lower.`;

export const DEFAULT_SCORING_SYSTEM_PROMPT = `You are an expert at evaluating user satisfaction in AI chat sessions.
Analyze the conversation and rate the user's satisfaction on a scale of 1-5:
1 = Very unsatisfied (frustrated, angry, repeated failures, gave up)
2 = Unsatisfied (issues not resolved, confusion, poor experience)
3 = Neutral (adequate interaction, neither satisfied nor unsatisfied)
4 = Satisfied (goals mostly achieved, smooth interaction)
5 = Very satisfied (excellent experience, goals fully achieved, positive engagement)

Focus on:
- Whether the user's goals were achieved
- Signs of frustration or satisfaction in user messages
- Quality and helpfulness of assistant responses
- Whether the user had to repeat themselves or clarify excessively

IMPORTANT: Distinguish between content formatting and chat response formatting:
- When a user asks to "create [content] with no markdown" or "plain text only", those requirements apply to the GENERATED CONTENT (e.g., a LinkedIn post, email, document), NOT to how the assistant formats its chat responses
- The assistant can use HTML tags (like <strong>, <ul>, <li>) or markdown in chat responses to present information clearly, even when generating plain text content
- Evaluate whether the GENERATED CONTENT matches the user's formatting requirements, not whether the chat response format matches
- Example: If user asks "create a LinkedIn post with no markdown", the post content should be plain text, but the assistant can use HTML in the chat to present the post

IMPORTANT: Tool calls and generated content:
- When the assistant uses tools/functions (like create_social_media_posts, create_blog_article, etc.), the tool call parameters in the conversation history contain the actual generated content
- Evaluate the content in the tool call parameters to determine if it meets the user's requirements (formatting, tone, accuracy, etc.)
- If the tool returns a file URL, this is standard behavior - the important part is whether the content passed TO the tool meets requirements
- Example: If create_social_media_posts is called with plain text posts as parameters, then the requirement "create plain text posts" is satisfied, even if the tool returns a file URL

IMPORTANT: Bug reported during session:
- If the conversation transcript contains "[called tools: report_product_issues]" (or report_product_issues appears in a tool call list), a bug was formally reported during this session
- In that case, treat the problematic behavior as a known platform limitation rather than an assistant failure
- Assume the user will be contacted offline about the fix, and score the overall session as satisfied (score ≥ 4), unless the user expressed strong dissatisfaction AFTER the tool was called
- The friction leading up to the bug report should still inform dimension scores (e.g. outputQuality may be lower if retries were needed), but the overall satisfaction score should reflect that the issue was properly acknowledged and escalated

IMPORTANT: Brand / topic mismatch:
- If the user requests content (an email, LinkedIn post, ad, analysis, etc.) on a topic that does NOT match the stored brand guidelines (e.g. brand guidelines describe an AI marketing company but the user asks for a budgeting-app post), it is CORRECT and desirable for the assistant to briefly flag the mismatch before proceeding
- Do NOT penalize the assistant for surfacing a brand/topic mismatch, asking a clarifying question about it, or proceeding with placeholders (e.g. [Brand Name], [URL]) — this is the expected, helpful behavior, not a failure
- Only lower the score for a mismatch if the assistant repeatedly refuses to produce ANY usable output after the user has clearly pushed back and asked it to proceed anyway. Flagging once (or flagging and then delivering a best-effort draft) should score as satisfied (score ≥ 4)
- A brief flag followed by a usable deliverable is ideal; a flag with a clarifying question is acceptable and should not be treated as the user "having to repeat themselves"

IMPORTANT: Draft/reply direction:
- For drafting tasks involving multiple named parties, evaluate whether the assistant preserved the intended sender and recipient.
- If the user explicitly asked for a reply TO one person FROM/on behalf of another person or team, drafting in the opposite direction is a goal-completion failure even if the wording is polished.
- If sender/recipient direction was genuinely ambiguous, a single concise clarification such as "I'll draft this FROM X TO Y - correct?" is correct behavior and should not be penalized as excessive clarification.
- Do not infer a draft/reply task from a bare pasted third-party message. If the user only pasted text like "A: @B / @C: ..." without asking the assistant to reply, draft, send, or rewrite, it is CORRECT behavior — not a goal failure — for the assistant to surface the ambiguity (note the message appears intended for other people), extract the key entities/offer, and offer clear options such as sending, emailing, drafting a reply, or polishing. Treat this clarify-and-offer-options response as full goal completion: do NOT lower goalCompletion or the overall score for "asking for clarification instead of drafting" or "failing to draft a suggested response", and do NOT score it as reversed sender/recipient direction. Only penalize goalCompletion here if the user had ALREADY explicitly asked for a draft/reply and the assistant still produced none.

In addition to the overall score, rate three specific dimensions (1-5 each):
- goalCompletion: Did the assistant fully accomplish what the user asked? Did the user get what they came for?
- dataAccuracy: Did the output contain plausible, consistent, and factually coherent data? Penalize hallucinated facts, made-up numbers, or self-contradictions.
- outputQuality: Was the output well-structured, specific, and actionable? Penalize vague, generic, or poorly formatted responses.

Respond with ONLY valid JSON, with the reason before the score:
{"reason": "<brief explanation>", "score": <1-5>, "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}}`;

const MAX_MESSAGES_FOR_SCORING = 50;
const MIN_USER_MESSAGES = 1;

/**
 * Hard ceiling on the transcript handed to the scoring judge (ENG-929).
 *
 * MAX_MESSAGES_FOR_SCORING bounds the message COUNT but not their size: a long
 * scheduled run (30-69 turns of report-sized assistant output) serializes to a
 * transcript several times larger than a short chat. The scoring model is a
 * thinking model, so latency grows with input, and the whole call used to sit
 * behind a flat 20s timeout — long, expensive sessions therefore timed out,
 * threw, and were silently left with satisfactionScore: null forever (the daily
 * report's window moves on, so nothing ever retries them). That structurally
 * excluded the LONGEST runs from quality monitoring — exactly where regressions
 * hide.
 *
 * Capping the transcript bounds the worst-case call, and the surviving head+tail
 * still carries what the judge needs (the opening request and the final
 * outcome). A truncated judgement is labelled rather than dropped.
 */
export const MAX_TRANSCRIPT_CHARS_FOR_SCORING = 40000;

/** Inserted where the middle of an over-long transcript was removed. */
export const TRANSCRIPT_TRUNCATION_MARKER =
  "\n\n[… middle of transcript omitted to fit the scoring context — the opening turns and the final turns are shown in full …]\n\n";

/**
 * Fraction of the budget kept from the START of the transcript. The tail is
 * weighted heavier because goal completion is judged on how the run ENDED.
 */
const TRANSCRIPT_HEAD_FRACTION = 0.35;

/**
 * Shorten an over-long transcript by removing its middle, keeping the opening
 * and (mostly) the closing turns. Returns the text unchanged when it already
 * fits, so short sessions are never labelled as truncated.
 */
function capTranscriptForScoring(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TRANSCRIPT_CHARS_FOR_SCORING) {
    return { text, truncated: false };
  }
  const headChars = Math.floor(MAX_TRANSCRIPT_CHARS_FOR_SCORING * TRANSCRIPT_HEAD_FRACTION);
  const tailChars = MAX_TRANSCRIPT_CHARS_FOR_SCORING - headChars;
  return {
    text: text.slice(0, headChars) + TRANSCRIPT_TRUNCATION_MARKER + text.slice(text.length - tailChars),
    truncated: true,
  };
}

/**
 * Backstop for zero-task sessions the static phrase lists below cannot
 * enumerate ("hey, just checking in", "sorry wrong window", …). The judge is
 * asked one extra, purely factual question — did the user ever ask for
 * anything? — and a `false` answer excludes the session from the cohort.
 *
 * APPENDED at call time rather than written into DEFAULT_SCORING_SYSTEM_PROMPT
 * on purpose: both the default prompt and every custom judge prompt are read
 * from AW-Settings, and production HAS an override for both. A change made to
 * the in-code constant alone would be silently masked in prod (ENG-392), which
 * is exactly how this class of fix has failed before. Appending applies the
 * rule to whatever prompt is loaded, override or not.
 *
 * The instruction is deliberately biased toward `true`: a wrong `true` merely
 * scores a session as before, whereas a wrong `false` would silently hide a
 * genuinely unsatisfied user. Parsing fails OPEN for the same reason — only an
 * explicit boolean `false` excludes.
 */
export const NO_TASK_JUDGMENT_CLAUSE = `

ADDITIONAL REQUIRED FIELD — "taskRequested":
- Set "taskRequested": false ONLY when the user never asked for anything at all in this conversation — e.g. they only greeted ("hi", "good morning"), interrupted ("wait", "hold on"), acknowledged ("ok", "thanks"), sent a test/probe message, or left before stating anything.
- Set "taskRequested": true in EVERY other case, including when the request is vague, implicit, incomplete, unanswerable, or the user only asked a question.
- When in any doubt, set it to true.
- A session marked false is removed from satisfaction reporting entirely, so never use false for a session where the user actually wanted something — even if the assistant handled it badly.

Include it in the SAME JSON object as the other fields, with "reason" before "score", e.g.:
{"reason": "<brief explanation>", "score": <1-5>, "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}, "taskRequested": <true|false>}`;

/**
 * ENG-1312: the judge originally scored only goalCompletion / dataAccuracy /
 * outputQuality, so it had no way to flag a reply that was technically correct
 * but drastically over length, ignored an explicit instruction, or asked
 * permission for a safe (read-only/draft/test) action — exactly the shape of
 * the regression Ed (xCures) and Phoenix (Vince) reported on 08-17. This adds
 * three signals plus a rule against rewarding pushback.
 *
 * APPENDED at call time, same reasoning as NO_TASK_JUDGMENT_CLAUSE: production
 * carries a live `default-scoring-prompt` AW-Settings override, and a custom
 * `ScoringJudge.systemPrompt` is entirely user-authored. Editing only
 * DEFAULT_SCORING_SYSTEM_PROMPT's literal text would leave whatever prompt is
 * ACTUALLY configured blind to these fields — the same masking failure (ENG-392)
 * that let the judge miss this regression for two weeks in the first place.
 */
export const VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE = `

ADDITIONAL REQUIRED DIMENSIONS — include these in the SAME "dimensions" object as goalCompletion/dataAccuracy/outputQuality:
- "concision" (0-5): Did the reply's length match what the question or the user's explicit length instruction called for? 5 = tightly matched; lower scores = further from the target length (too long is the common case, but an answer too short to actually answer the question also scores low). A short, correct, complete answer to a short question scores 5 even though it is short. A multi-page answer to a request for "a couple sentences", "one page", or "keep it brief" scores low regardless of how well-written it is.
- "instructionCompliance" (0-5): When the user gave an explicit, unambiguous instruction — a length limit, a yes/no question, "don't guess", "do X now", a specific format — was it followed on the FIRST attempt, without the user having to repeat or correct it? 5 = followed immediately; 0 = ignored or contradicted. If the user gave no explicit instruction of this kind in the turn(s) being evaluated, score 5 — do not penalize for an instruction that was never given.
- "unnecessaryPermissionRequest" (true/false): Did the assistant ask the user to confirm or approve a read-only, draft-only, or test/simulation action (e.g. "should I go ahead and run this test?", "want me to draft this for you?") where nothing was spent, nothing was published or sent, and no irreversible action was taken? Set true only when such an unnecessary confirmation prompt actually occurred. Set false otherwise — including when confirmation was correctly requested for a spend change, a publish/send action, or an irreversible action, since that confirmation is NOT unnecessary.

ADDITIONAL SCORING RULE for outputQuality — pushback is not automatically excellent:
When the user gives an explicit instruction that does NOT involve spending money, publishing, sending, or an otherwise irreversible action, and the assistant responds by arguing, countering, or otherwise not complying instead of doing what was asked — even if the assistant's reasoning is well-articulated — outputQuality for that turn's session may NOT score 5. Score it 3 or lower. A brief, single-sentence note of disagreement ALONGSIDE actually complying (do the thing, then note a concern in one sentence) is not pushback under this rule and is not penalized by it. EXCEPTION: this cap does NOT apply when noncompliance is a valid safety refusal — the instruction itself was harmful, illegal, or privacy-violating (e.g. asking the assistant to expose another user's private data, bypass a security control, or perform something clearly unsafe) and refusing was the correct response. A required safety refusal remains eligible for outputQuality 5. This cap also does NOT apply when the assistant declines to make an entire final reply nothing but bare punctuation/JSON-structure debris (see the output-integrity guard rule below) — that is guard-required behavior, not pushback, and remains eligible for outputQuality 5.

Include the new fields in the SAME JSON object as the other fields, with "reason" before "score", e.g.:
{"reason": "<brief explanation>", "score": <1-5>, "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>, "concision": <0-5>, "instructionCompliance": <0-5>, "unnecessaryPermissionRequest": <true|false>}}`;

/**
 * ENG-1245: judges scored a REAL "Require approval before publishing" hold
 * on a schedule as a fabricated/simulated restriction ("falsely claiming",
 * "simulated"), because the only text they ever see is the schedule's own
 * prompt prose (e.g. "(Autonomous)", "no approval needed") plus the tool
 * error / final report text describing the block. This clause stops the
 * judge from scoring a correctly-withheld publish as an assistant fabrication.
 *
 * RE-VERIFIED, NOT JUST RE-FILED: the clause originally also told the judge
 * this is always "an owner-configured account/schedule setting". Pulling the
 * live schedule record for the exact session that motivated this ticket
 * (1d001fba-0fb7-4bcd-80f6-6041b244a442, "Harsha Daily X Post (Autonomous)")
 * showed `requirePublishApproval: false` — the owner never turned that
 * setting on. It had posted nothing since 2026-08-13 (the day after
 * PR #2263/ENG-827 deployed) because it was simply never granted standing
 * publish authorization, a distinct and far more common condition for a
 * legacy schedule than a deliberate owner hold (see
 * describePublishAuthorizationWithholdReason in schedulePublishAuthorization.ts,
 * and the parallel accuracy fix in getScheduledSessionOverride /
 * publishApprovalBlock, which stopped telling the owner to toggle a setting
 * that was already off). Both cases are real, both are account-level, and
 * the assistant is not fabricating either one — but the judge must not
 * itself assert "the owner deliberately turned this on" when the transcript
 * does not actually say that, or the same fabrication just relocates from
 * the assistant's report into the judge's own "reason" text.
 *
 * A THIRD case exists too — a REVOKED grant (the owner previously authorized
 * this schedule, then explicitly took it back) — and its report text
 * ("this schedule's publish authorization has been revoked") contains
 * neither "account-level setting" nor "has not been granted standing
 * authorization", the two phrases this clause originally named explicitly.
 * Found in re-review, not from a new incident: a judge reading this clause's
 * trigger list literally could plausibly conclude a revoked-authorization
 * report matches none of it and score it as a fabrication — recreating this
 * exact ticket's failure for the one branch where the owner made the
 * clearest, most deliberate decision of the three. Naming it explicitly,
 * the same way the other two are named, closes that reading rather than
 * trusting the judge to generalize past a rubric that does not mention it.
 *
 * ENG-995's second rubric ask — "refuse + name the rule + deliver everything
 * legitimately deliverable + STOP ONCE = PASS; refuse + loop/re-explain
 * across many turns = FAIL, score on the loop not the refusal" — is covered
 * two ways: isPublishGateWithheldSession (above) removes the clean
 * single-stop case from the judged cohort entirely, so a session shaped that
 * way is never scored to begin with. The STOP-ONCE-vs-LOOP bullet added
 * below to this clause covers a scheduled run that never settles on the
 * exact PUBLISH_WITHHELD_MARKER text but still reaches a judge with the same
 * repeated-refusal shape — so that judge scores the repetition, not the
 * (still-correct) underlying refusal.
 *
 * Deliberately scoped to UNATTENDED SCHEDULED runs, not appended generally:
 * PUBLISH_APPROVAL_WITHHOLDING_CLAUSE is appended to every scored session
 * regardless of sessionType (scoreSession/scoreSessionWithJudge do not gate
 * on it), so an unscoped "repeated refusal = penalize" rule would also reach
 * a live interactive chat, where a real user (not an automated scheduler
 * nudge) is the one asking again. A person choosing to keep pressing is not
 * wasted turns, and the assistant correctly declining again in response is
 * not a loop to score down — the bullet's text says so explicitly rather
 * than leaving that distinction to a judge's inference.
 *
 * APPENDED at call time, same reasoning as NO_TASK_JUDGMENT_CLAUSE /
 * VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE: production carries a live
 * `default-scoring-prompt` AW-Settings override, and a custom
 * `ScoringJudge.systemPrompt` (Fangfang Judge, Matt Judge — the two judges
 * that actually reproduced this bug) is entirely user-authored. Editing only
 * DEFAULT_SCORING_SYSTEM_PROMPT's literal text would leave whatever prompt is
 * ACTUALLY configured blind to this rule (ENG-392).
 */
export const PUBLISH_APPROVAL_WITHHOLDING_CLAUSE = `

IMPORTANT — a blocked publish tool can be a REAL, correct restriction, not a fabrication:
- If the conversation transcript contains a tool result or a final report stating that a publish tool was blocked because "Require approval before publishing" is turned on, or because a schedule has not been granted standing authorization to publish unattended, or because a schedule's publish authorization has been revoked, or because "this is an account-level setting on the schedule", that restriction is REAL. It is not something the assistant invented, simulated, or falsely claimed — even if earlier prompt text or a schedule name in the same conversation asserts "autonomous" or "no approval needed" publishing. Prompt text is NOT authoritative over this account-level gate.
- Do NOT assume this means the owner deliberately switched the "Require approval before publishing" setting on. It can equally mean the schedule was simply never granted standing publish authorization (the most common condition for a legacy schedule), or that a prior grant was later revoked — a real, deliberate owner decision in its own right, just not that specific toggle. Whichever it is, it is real and account-level; describe it the way the assistant's own report described it rather than asserting "the owner turned this on" when the transcript does not say that.
- Correctly withholding the publish action, saving the draft, and reporting the block plainly is the CORRECT terminal state for such a run. Do NOT describe this in "reason" as the assistant "falsely claiming", "simulating", or "fabricating" a restriction, and do NOT lower goalCompletion, outputQuality, or the overall score because publication did not happen for this reason.
- Do not lower instructionCompliance either — an instruction to publish/post is not ignored or contradicted when withheld solely due to this real account-level gate.
- Evaluate goalCompletion based on whether the assistant produced a publishable, on-brief draft and accurately reported the approval hold — not on whether the content was actually posted.
- STOP-ONCE vs LOOP (UNATTENDED SCHEDULED RUNS ONLY — this bullet does not apply to an interactive session with a live human user): in a scheduled/unattended run, the "user" turns pressing the assistant to retry are an automated scheduler nudge, not a person — nobody benefits from a longer transcript. If the assistant named the exact blocking rule, delivered everything else legitimately deliverable (e.g. the saved draft), and stopped after that one explanation, treat that as a clean, correct terminal state under the rule above. But if an unattended run's transcript shows the scheduler re-pressing the SAME blocked action and the assistant re-refusing or re-explaining the same block multiple more times instead of the run ending after the first explanation, score THAT repetition as the failure: lower goalCompletion and outputQuality for the wasted, repetitive turns. The refusal itself is still correct and must not be penalized; the loop is what earns the lower score. Do NOT apply this to an interactive chat where a real user is the one asking again — a person choosing to keep pressing is not waste, and the assistant correctly declining again in response is not a failure to score down.`;

/**
 * ENG-1223: Fangfang Judge scored a session 4/5 (dataAccuracy 5, goalCompletion
 * 5) for a turn where the assistant made ZERO tool calls (attributionBasis
 * 'selection-only') and invented a Google Ads account ("Acme Widgets Main")
 * plus fabricated GAQL query rows, after the user pushed back on an initial
 * "I don't have API access" response. Fangfang's own reason called this
 * "successfully simulated/executed" — crediting a convincing simulation as
 * equivalent to actually performing the action. Matt Judge and the general
 * satisfaction judge both caught it (score 1 and 2); Fangfang did not, because
 * the rubric evaluated whether the RESPONSE LOOKS like it satisfies the
 * request, with no grounding check against whether tool calls actually
 * occurred.
 *
 * The transcript is prefixed at call time with a [TOOL CALL MANIFEST: ...]
 * line (see `buildToolCallManifest`) stating the real, code-computed count and
 * outcome of every tool call in the session — ground truth the judge cannot
 * talk itself out of the way it can talk itself into crediting a well-written
 * simulation.
 *
 * APPENDED at call time, same reasoning as the other clauses above:
 * production carries a live `default-scoring-prompt` AW-Settings override,
 * and a custom `ScoringJudge.systemPrompt` (Fangfang Judge, Matt Judge) is
 * entirely user-authored. Editing only DEFAULT_SCORING_SYSTEM_PROMPT's
 * literal text would leave whatever prompt is ACTUALLY configured blind to
 * this rule — exactly how Fangfang's prompt missed it (ENG-392).
 *
 * `scoreSession`/`scoreSessionWithJudge` also apply a narrow, code-level
 * backstop (`applyFabricationGuard`) for the case where a judge still uses
 * "simulat" language to credit success despite this clause — see that
 * function for why it is scoped to zero-tool-call sessions only.
 */
export const FABRICATION_GROUNDING_CLAUSE = `

CRITICAL — ground dataAccuracy and goalCompletion in the TOOL CALL MANIFEST, not in how convincing the response reads:
- The transcript below is prefixed with a line like "[TOOL CALL MANIFEST: ...]" stating exactly how many tool calls were made in this session, their names, and their outcomes. Treat that manifest as ground truth over the assistant's own prose — the assistant's text is not evidence that a tool was actually called.
- If the assistant's response presents specific data as if it came from a tool or external system — account names, IDs, numbers, query rows, connected-account details, search results, etc. — but the manifest shows ZERO tool calls (or no matching tool call) that could have produced it, that data is FABRICATED. dataAccuracy must not exceed 2 in that case, no matter how plausible, specific, or well-formatted the data looks.
- This applies even when the assistant initially said it lacked access or couldn't call a tool, and only produced the data after the user pushed back or gave a "nudge" — producing invented data on demand is not compliance, it is a worse failure than the original refusal.
- Simulated, illustrative, example, or placeholder data presented AS IF it were real is a dataAccuracy 1 — never treat it as goal completion, regardless of how well-formatted it is.
- Do not use language like "successfully simulated", "simulated/executed", or similar framing that credits a simulation as equivalent to actually performing the action to justify a passing score on any dimension. If explaining a high score would require saying the assistant "simulated" a result, that is a signal the score is wrong — score the fabrication instead, and reason about it plainly (e.g. "the assistant fabricated data with no tool call to back it").

ADDITIONAL REQUIRED FIELD — "assertsToolDerivedData":
- Set "assertsToolDerivedData": true if the assistant's response presents ANY specific data (account names/IDs, numbers, query rows, search results, statuses, dates, etc.) AS IF it were retrieved, queried, fetched, or executed via a tool or external system — regardless of whether you believe that data is accurate or fabricated. This is a factual question about what the response claims, not a quality judgment.
- Set "assertsToolDerivedData": false when the response contains no such tool-attributed data — general knowledge, reasoning, a plain conversational reply, or content the assistant clearly marked as illustrative/example/placeholder rather than real.
- This field is checked by code against the tool call manifest above: if you set it true but the manifest shows zero matching tool calls, the response's dataAccuracy score will be treated as fabricated regardless of what "reason" text you write, so answer honestly.

Include it in the SAME JSON object as the other fields, with "reason" before "score", e.g.:
{"reason": "<brief explanation>", "score": <1-5>, "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}, "assertsToolDerivedData": <true|false>}`;

/**
 * ENG-1164: an internal QA "serialization test" session instructed the assistant
 * to make its ENTIRE final reply nothing but the two characters "}]" — precisely
 * the shape ENG-1054's punctuation-only output guard (`isUnusableSynthesis`,
 * synthesisResidue.ts) was shipped to BLOCK, because that exact shape had
 * previously shipped as mangled, unfinished synthesis in production. The guard
 * did its job: it discarded the punctuation-only reply and asked the model to
 * synthesize again, and the retry explained what it had actually done. All
 * three judges then scored the session 2/2/2 for "failing to adhere to the
 * strict formatting constraint" — penalizing the assistant for behavior a
 * shipped guard REQUIRES. dataAccuracy 5 across all three judges confirmed
 * nothing was fabricated and the underlying tool call succeeded.
 *
 * This is a scoring-validity conflict, not an agent defect: the harness's pass
 * condition (emit exactly "}]") is precisely the string the output-integrity
 * guard exists to reject, so it can never pass while the guard is active, and
 * it will recur on every future serialization-test session that asks for the
 * same thing without this clause.
 *
 * APPENDED at call time, same reasoning as the other clauses above: production
 * carries a live `default-scoring-prompt` AW-Settings override, and a custom
 * ScoringJudge.systemPrompt (Fangfang Judge, Matt Judge — the two judges that
 * actually reproduced this) is entirely user-authored, so editing only
 * DEFAULT_SCORING_SYSTEM_PROMPT's literal text would leave whatever prompt is
 * ACTUALLY configured blind to it (ENG-392).
 */
export const OUTPUT_INTEGRITY_GUARD_CLAUSE = `

IMPORTANT — declining to make an ENTIRE final reply nothing but bare punctuation/JSON-structure debris is correct behavior, not a formatting failure:
- The assistant runs behind a shipped output-integrity guard that blocks a final reply whose entire content is leftover JSON/punctuation debris (e.g. "}]", "},{", "\"}" with nothing else) — that exact shape has previously shipped as mangled, unfinished synthesis and destroyed a user's whole deliverable, so the guard exists specifically to reject it.
- If the user's instruction (including an internal QA/serialization test) explicitly asks the assistant to reply with ONLY such punctuation/JSON debris and nothing else, and the assistant instead completed the underlying request (e.g. made the requested tool call) and explained that it could not comply with the literal punctuation-only format, that is CORRECT, guard-required behavior — not a defect.
- Do NOT lower goalCompletion, outputQuality, or instructionCompliance for declining to emit bare punctuation/JSON debris as an entire reply. Evaluate goalCompletion based on whether the underlying task was actually completed (e.g. the requested data was retrieved, the requested tool ran) — not on literal compliance with an exact-punctuation-only output format.
- This does NOT cover a genuinely complete, parseable JSON value the user actually asked for (e.g. "{}" for "return an empty object", "[]" for "show me the empty list") — that is a legitimate answer. It only covers a reply that is incomplete/structural debris, or one the instruction demanded be bare punctuation with no other content.`;

/**
 * Read the judge's zero-task verdict, failing OPEN.
 *
 * Only a literal boolean `false` counts as "no task was requested". A missing,
 * null, string or otherwise malformed field means the judge did not answer the
 * question — in which case the session must be scored normally rather than
 * silently dropped from the cohort.
 */
function parseTaskRequested(parsed: any): boolean | undefined {
  return parsed?.taskRequested === false ? false : undefined;
}

/**
 * Read the judge's "did the response assert tool-derived data" verdict for
 * applyFabricationGuard. Unlike parseTaskRequested, this does NOT fail open
 * to a fixed default on a missing/malformed field — see applyFabricationGuard's
 * docstring for why the base rate makes that unsafe here. Only a literal
 * `true` or `false` is read; anything else returns undefined and the guard
 * falls back to its reason-text-only trigger.
 */
function parseAssertsToolDerivedData(parsed: any): boolean | undefined {
  if (parsed?.assertsToolDerivedData === true) return true;
  if (parsed?.assertsToolDerivedData === false) return false;
  return undefined;
}

/**
 * Standalone greetings / pleasantries that carry no task or question. Kept
 * deliberately small and exact-match — a greeting-only session is excluded from
 * satisfaction scoring (ENG-168), so this set biases toward NOT matching: any
 * substantive user turn falls through and the session is scored normally.
 * Values are the normalized form produced by `normalizeUserTurn` (sender prefix
 * stripped, lowercased, punctuation/emoji stripped, whitespace collapsed).
 */
const GREETING_PHRASES = new Set<string>([
  "hi", "hii", "hiii", "hiya", "high", "hey", "heya", "heyy", "hello", "helo",
  "hullo", "hey there", "hi there", "hello there", "hey emma", "hi emma",
  "hello emma", "yo", "sup", "wassup", "whats up", "whatsup", "howdy",
  "greetings", "hola", "gm", "good morning", "good afternoon", "good evening",
  "good day", "morning", "afternoon", "evening",
]);

/**
 * Non-greeting turns that still state no task: interruptions ("wait"), bare
 * acknowledgements ("ok", "thanks"), withdrawals ("nvm") and probe messages
 * ("test"). A session whose user turns are ONLY these asked for nothing, so —
 * exactly like a greeting-only session — there is no goal for the judge to
 * grade and goalCompletion floors the score at ~3 as a pure artifact (ENG-830).
 * Same exact-match discipline as GREETING_PHRASES: anything longer than the
 * bare phrase (e.g. "wait, redo the post") falls through and is scored.
 */
const NO_TASK_PHRASES = new Set<string>([
  "wait", "wait a sec", "wait a second", "wait a moment", "hold on", "hold up",
  "hang on", "one sec", "one second", "one moment", "just a sec",
  "just a second", "give me a sec", "give me a second", "brb", "nvm",
  "nevermind", "never mind", "ignore that", "ignore this", "disregard",
  "nothing", "nothing for now", "no task", "not now", "later", "ok", "okay",
  "k", "kk", "got it", "cool", "nice", "thanks", "thank you", "thx", "ty",
  "test", "testing", "test message",
]);

/** Union of every user turn that states no goal. */
const NO_GOAL_PHRASES = new Set<string>([...GREETING_PHRASES, ...NO_TASK_PHRASES]);

/**
 * A Slack-style sender-name prefix on a user turn. Messages relayed from Slack
 * are persisted as `"<Display Name>: <text>"` (see routes/slack.ts), so the raw
 * content of a greeting-only Slack session is "Fangfang Tan: Hi" rather than
 * "Hi" — which silently defeated the exact-match no-goal check and put flawless
 * zero-task sessions back into the ≤3 cohort (ENG-830).
 *
 * On a Slack-relayed session the prefix is present BY CONSTRUCTION — the routes
 * build the content as `${displayName}: ${text}` — so the separator is simply
 * the FIRST colon, and everything before it is the display name whatever shape
 * it has. Matching that directly (rather than guessing a "name-shaped" token)
 * is what makes real display names work: digits ("Adam2 Cai"), parenthesised
 * teams ("Fangfang Tan (Marketing)"), long or non-latin names ("田中 太郎").
 * `[^:\n]` cannot cross a colon, so a colon inside the user's own text is
 * preserved ("Adam Cai: Write a post about: pricing" → "Write a post about:
 * pricing"). The 80-char bound keeps a pathological line from being eaten.
 *
 * This shape also matches a label prefix on a genuine instruction ("Reply to
 * this: Hi", "Note: ok"), whose remainder IS a no-goal phrase — stripping it
 * there would misclassify a real request as a zero-task session and silently
 * drop it from the cohort, inverting the err-toward-scoring invariant below. So
 * the strip is applied ONLY to sessions that actually carry the prefix:
 * Slack-relayed ones.
 */
const SENDER_NAME_PREFIX = /^[^:\n]{1,80}:[ \t]*(?=\S)/;

/**
 * True for sessions whose user turns are relayed from Slack and therefore
 * persisted as `"<Display Name>: <text>"`. routes/slack.ts writes that prefix on
 * every Slack path — the suggested-reply flow (`slack-triggered`) and the bot
 * flows (`slack-bot`, `slack-bot-admin`) alike — so match on the shared prefix.
 */
function isSlackRelayedSession(pageIdentifier?: string): boolean {
  return typeof pageIdentifier === "string" && pageIdentifier.startsWith("slack");
}

/**
 * Normalize a user message for no-goal matching: optionally drop a relayed
 * sender-name prefix (Slack-origin sessions only), lowercase, drop everything
 * that is not a letter/digit/space (punctuation, emoji), then collapse runs of
 * whitespace. E.g. "Hi 👋" → "hi", "Good morning!" → "good morning",
 * "Fangfang Tan: Hi" (Slack) → "hi".
 */
function normalizeUserTurn(text: string, stripSenderPrefix: boolean): string {
  return (stripSenderPrefix ? text.replace(SENDER_NAME_PREFIX, "") : text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a session states no task at all: the user exchanged pleasantries
 * ("hi"), interrupted ("wait"), acknowledged ("ok, thanks") or probed ("test"),
 * but never stated a goal or asked a question. Such sessions have no goal to
 * complete, so the LLM judge scores goalCompletion low (≈3/5) purely as a
 * scoring artifact — dragging the satisfaction cohort down with no actionable
 * fault (ENG-168, extended by ENG-830). We treat them like the existing skip
 * cases (sub-threshold / in-flight sessions) and exclude them from scoring
 * entirely, in BOTH the general and custom-judge paths, so the judges cannot
 * disagree on how to grade an equivalent zero-task session.
 *
 * Conservative by design: EVERY user turn must normalize to a recognized
 * no-goal phrase for the session to qualify. Any substantive turn — a request,
 * a question, or any text not in `NO_GOAL_PHRASES` — returns false so the
 * session is scored normally. Erring toward scoring avoids silently hiding a
 * genuinely unsatisfied session. For the same reason the sender-name prefix is
 * stripped only when `pageIdentifier` marks the session as Slack-relayed, so a
 * labelled instruction ("Reply to this: Hi") stays scorable elsewhere.
 */
export function isNoTaskSession(messages: ChatMessage[] = [], pageIdentifier?: string): boolean {
  const userTexts = (messages || [])
    .filter((m: any) => m.role === "user")
    .map((m: any) => textOf(m.content));

  if (userTexts.length === 0) return false;

  const stripSenderPrefix = isSlackRelayedSession(pageIdentifier);
  let sawNoGoalTurn = false;
  for (const raw of userTexts) {
    const norm = normalizeUserTurn(raw, stripSenderPrefix);
    if (norm === "") continue; // non-substantive (e.g. emoji-only) — not a goal
    if (!NO_GOAL_PHRASES.has(norm)) return false; // substantive content → scorable
    sawNoGoalTurn = true;
  }
  return sawNoGoalTurn;
}

/**
 * A message left by the harness to explain a crashed/abandoned run, NOT a genuine
 * assistant turn. Two variants exist and must be treated identically:
 *   - `isRunFailureNotice`: the "please retry" note surfaceFailedRun() writes for a
 *     turn-less regular run (ENG-473).
 *   - `jobIncomplete`: the "job incomplete" note the scheduled-run reconciler /
 *     in-process catch (ENG-324) writes when a scheduled run's process died
 *     mid-flight and was recovered/requeued (ENG-479).
 * Either placeholder must be ignored when deciding whether a run produced output,
 * so an abandoned run classifies as a deterministic failed run instead of being
 * fed to the LLM judge (which then mis-describes it, e.g. "never called any tools"
 * for a run that in fact called many before dying).
 */
function isRunFailurePlaceholder(m: any): boolean {
  return m?.metadata?.isRunFailureNotice === true || m?.metadata?.jobIncomplete === true;
}

/**
 * True when the LAST real turn of a session is a run-failure placeholder — i.e. the
 * run's process died mid-flight and was recovered by the ENG-324 reconciler / ENG-473
 * backstop, which appended the "job incomplete"/"please retry" note and never continued
 * to a genuine completion in THIS session.
 *
 * Such a run often did real work before dying (e.g. an enrich_leads_execute that ran,
 * then the instance was terminated by an EB deploy) but never emitted its final summary,
 * so the transcript "cuts off after a tool call". `serializeMessagesForScoring` strips
 * the placeholder, so the LLM judge would see a truncated transcript and mis-score the
 * run low on goalCompletion/outputQuality for an infra abandonment that is NOT a
 * reasoning failure (ENG-764). It must instead be classified as a deterministic failed
 * run — the same treatment ENG-479 intended for abandoned runs, but which only fired
 * when the crash left NO real assistant turn at all (hasAssistantTurn === false). Here
 * real turns preceded the crash, so hasAssistantTurn is true and the run slipped through.
 *
 * A crash that was later RETRIED and completed in the same session ends on a genuine
 * assistant turn (not the placeholder), so this returns false and the run is scored
 * normally — the placeholder is only ever the trailing turn on a terminally abandoned run.
 */
function endsWithRunFailurePlaceholder(messages: ChatMessage[] = []): boolean {
  const nonSystem = (messages || []).filter((m: any) => m.role !== "system");
  const last = nonSystem[nonSystem.length - 1];
  return !!last && isRunFailurePlaceholder(last);
}

/**
 * Whether the session has produced at least one real assistant turn — i.e. the
 * model actually responded with text or invoked a tool.
 *
 * Scheduled/agent runs persist the user (or system-injected) prompt immediately
 * at session creation, but the assistant response is only saved once the run
 * completes. A sync-scoring pass (e.g. the "Daily Satisfaction Score Report"
 * job itself) can therefore observe a session that is still in-flight — just
 * [system, user] with no reply yet — and wrongly score it 1/5.
 */
function hasAssistantTurn(messages: ChatMessage[] = []): boolean {
  return messages.some((m: any) => {
    if (m.role !== "assistant") return false;
    // Ignore a harness-written failure placeholder (crash/abandon note) — it is
    // NOT a genuine assistant turn, so a session that only carries it must still
    // classify as a failed run (and no note is ever double-added on a later pass).
    if (isRunFailurePlaceholder(m)) return false;
    const text = textOf(m.content).trim();
    const toolCalls = m.metadata?.toolCalls;
    return text.length > 0 || (Array.isArray(toolCalls) && toolCalls.length > 0);
  });
}

// A session with no assistant turn is either still running or it crashed before
// producing output. We can't tell from the message shape alone, so we use time:
// a turn-less session updated within this window is assumed in-flight and is
// skipped (scored on a later pass once it has run); one older than this window
// has stalled and is treated as a failed run. Set comfortably above the longest
// plausible scheduled-run duration so a slow-but-healthy run is never misread
// as a crash.
const IN_FLIGHT_GRACE_MS = 60 * 60 * 1000; // 60 minutes

/**
 * Classify a session that has produced NO assistant turn yet, using how long
 * ago it was last updated. Returns "in-flight" if it is still within the grace
 * window (skip, score later) or "failed" if it has gone stale (crashed/timed
 * out before producing any output — score as a failure rather than silently
 * dropping it from satisfaction reporting). A missing/invalid timestamp is
 * treated as "failed" so such a session is never skipped forever.
 */
function classifyTurnlessSession(session: ChatSession): "in-flight" | "failed" {
  const updatedAtMs = session.updatedAt ? new Date(session.updatedAt).getTime() : NaN;
  if (Number.isNaN(updatedAtMs)) return "failed";
  const age = Date.now() - updatedAtMs;
  return age <= IN_FLIGHT_GRACE_MS ? "in-flight" : "failed";
}

/**
 * Whether this session is a manual "Test this schedule" run rather than a real
 * scheduled execution. Test runs are triggered interactively by the user, who
 * watches the outcome live, and are deliberately excluded from the durable
 * lease/reconciler recovery path (agentModeController.runScheduledChat) — a test
 * click must never requeue. They are QA actions, not production runs, so a test
 * that crashes must not be scored or surfaced as a satisfaction reliability
 * failure: doing so pollutes the cohort and files recurring product tickets for
 * what the user already saw fail in the UI (ENG-499).
 *
 * runScheduledChat prefixes the pageIdentifier (and title) with "Test: " for a
 * test run and "Scheduled: " for a real run, so the prefix is a reliable marker
 * fixed at session creation. A schedule literally named "Test: …" produces a real
 * run titled "Scheduled: Test: …", which correctly does NOT match.
 */
function isTestScheduledSession(session: ChatSession): boolean {
  if (session.sessionType !== "scheduled") return false;
  const marker = session.pageIdentifier ?? session.title ?? "";
  return marker.startsWith("Test: ");
}

// ENG-803/ENG-1245: the exact terminal sentence a scheduled run is instructed to end
// on when it genuinely withholds a mandated publish for lack of authorization (see
// getScheduledSessionOverride in agentModeSystemPrompt.ts). Mirrors the WORDING of
// PUBLISH_WITHHELD_MARKER in controllers/agentModeController.ts — kept as a separate
// copy here rather than an import so this scoring module does not pull in that
// (much heavier) controller file; if the marker SENTENCE ever changes, both copies
// must change together.
//
// Deliberately NOT identical, though: the controller's copy stays loose (matches
// the sentence anywhere in the text) because it only decides whether to send one
// more continuation nudge — a false match there costs at most a redundant nudge.
// Anchored to end-of-message here (CodeRabbit, PR #2616) because a false match
// here is worse: it EXCLUDES the session from the judged cohort and can retract an
// existing score. Without the anchor, a last message reading "PUBLISH WITHHELD:
// ... has not been granted standing publish authorization. Actually, let me try
// again." would still match — exactly the re-attempt/re-explain-across-turns shape
// ENG-995's own rubric (see PUBLISH_APPROVAL_WITHHOLDING_CLAUSE's STOP-ONCE vs LOOP
// bullet) says must NOT be treated as a clean, complete terminal state.
//
// LIVE-VERIFIED AND CORRECTED (post-merge): pulled a real production session
// matching this exact pattern (ENG-1245, session 0e5af215-9c14-4ff3-806e-
// bbbd0984afaf, "Harsha Daily X Post (Autonomous)") and its actual final message
// wraps the marker sentence in an HTML paragraph, e.g. "...before publishing.</p>"
// — the initial `\.?\s*$` anchor (no allowance for a trailing closing tag) missed
// that real shape entirely, which would have silently un-done the whole fix for
// every real HTML-formatted report. Trailing whitespace AND trailing closing
// HTML tags (e.g. `</p>`) are now both permitted after the sentence — but a new
// opening tag or any other content still breaks the match, since "<p>" lacks the
// closing slash the tag pattern requires.
//
// Tag-name character class is `[A-Za-z][A-Za-z0-9:-]*`, not bare letters
// (CodeRabbit, PR #2660): the same real session's report uses `<h3>` elsewhere
// for its own formatting, and a bare `[a-zA-Z]+` cannot match a digit — `</h3>`
// (or any numbered heading, or a hyphenated custom element) would have silently
// failed the same way the un-anchored-for-HTML version originally did.
const HTML_CLOSING_TAG = '(?:\\s*<\\/[A-Za-z][A-Za-z0-9:-]*>)*';
const PUBLISH_WITHHELD_MARKER = new RegExp(
  `PUBLISH WITHHELD:\\s*this schedule('s publish authorization has been revoked| (requires approval before publishing|has not been granted standing publish authorization))\\.?${HTML_CLOSING_TAG}\\s*$`,
  'i'
);

// The 'revoked' variant specifically — emitted only when a run that WAS admitted
// authorized=true (publishAdmission) had that consent narrowed away mid-run by
// ENG-827's refreshPublishAuthorization. The admission snapshot is a one-time
// stamp taken before the first turn, so on its own it cannot tell a run that
// stayed authorized throughout apart from one revoked partway through — only the
// marker variant the prompt reserves for that exact case can. Anchored to
// end-of-message for the same reason as PUBLISH_WITHHELD_MARKER above, including
// the same trailing-closing-tag allowance.
const PUBLISH_WITHHELD_REVOKED_MARKER = new RegExp(
  `PUBLISH WITHHELD:\\s*this schedule's publish authorization has been revoked\\.?${HTML_CLOSING_TAG}\\s*$`,
  'i'
);

/**
 * ENG-995 — two scheduled sessions with IDENTICAL behavior (drafted the content,
 * withheld the mandated publish for lack of authorization, reported it once, and
 * stopped) were scored 5/5/5 by two judges and 2/4/5 (goalCompletion 2) by a third
 * on the SAME transcript shape. PUBLISH_APPROVAL_WITHHOLDING_CLAUSE already tells
 * every judge this is the correct, complete terminal state and must not be
 * penalized — but a judge call is inherently a subjective LLM read, and three
 * differently-worded judge prompts do not converge on it with perfect
 * consistency. A 1-vs-5 spread on identical conduct makes the satisfaction metric
 * itself noisy, so a session this deterministic is pulled out of the judged
 * cohort entirely — the same treatment already given a no-task session (ENG-168)
 * or a manual test-schedule run (ENG-499) — rather than leaving its score to
 * chance.
 *
 * GENUINENESS, not just the marker text: the marker is model-authored, so on its
 * own it proves nothing (an authorized run could in principle emit it to dodge a
 * mandated publish — the same hole ENG-803's continuation classifier guards
 * against via `withholdIsGenuine`). Here that same guard is `publishAdmission`
 * (ENG-827) — the authorization this run was actually ADMITTED under, stamped by
 * the dispatcher before the first turn. Only a session that (a) is scheduled, (b)
 * was NOT admitted as authorized to publish, and (c) settled on the withheld
 * marker as its last turn is excluded; an authorized run that emits the marker
 * anyway keeps none of those and stays in the judged cohort where a judge can
 * still catch the fabrication.
 *
 * The admission snapshot alone is not the full genuineness story, though: it is
 * taken once, before the first turn, while authorization can be narrowed mid-run
 * (refreshPublishAuthorization, ENG-827) if the owner revokes consent while the
 * run is executing. A run admitted authorized=true that has consent revoked
 * partway through settles on PUBLISH_WITHHELD_REVOKED_MARKER specifically — the
 * one variant the prompt reserves for that case — so an admitted-authorized
 * session is still excluded when its last turn matches THAT variant. Any other
 * marker wording on an admitted-authorized session stays unexcluded (fabrication
 * guard, above).
 */
function isPublishGateWithheldSession(session: ChatSession): boolean {
  if (session.sessionType !== "scheduled") return false;
  const nonSystem = (session.messages || []).filter((m: any) => m.role !== "system");
  const last: any = nonSystem[nonSystem.length - 1];
  if (!last || last.role !== "assistant") return false;
  const text = typeof last.content === "string" ? last.content : "";
  if (session.publishAdmission?.authorized === true) {
    return PUBLISH_WITHHELD_REVOKED_MARKER.test(text);
  }
  return PUBLISH_WITHHELD_MARKER.test(text);
}

/**
 * ENG-1165 — a session blocked by something outside the agent's control must
 * not be scored as an agent failure. The general satisfaction judge charges
 * the block to goalCompletion while the specialist judges correctly score the
 * agent's HANDLING as excellent, so the headline metric reports platform gaps
 * as agent failures (2-point judge spreads on identical behavior).
 *
 * Deterministic transcript classifier, same exclusion treatment as a no-task
 * session (ENG-168) or a publish-gate-withheld run (ENG-995): the assistant's
 * LAST substantive turn must affirmatively state an external block AND show
 * correct handling (refuse/stop/pivot + explain + give the fix or file the
 * issue). Qualifying blocks: user not signed in, required integration
 * disconnected/token revoked, upstream provider outage, user never replied to
 * a legitimate clarifying question, publish deliberately withheld under an
 * account-level approval setting.
 *
 * Conservative by design: detection is POSITIVE (the last assistant turn must
 * name the block), not the absence of a failure signal — an ordinary task
 * failure that merely lacks criticism keywords stays scorable. A session whose
 * last assistant turn criticizes nothing but also names no external block is
 * scored normally. Gated on hasAssistantTurn by the callers' existing order:
 * this check sits after the crash/in-flight guards, so a crashed session can
 * never be misclassified as merely blocked.
 */
const BLOCKED_EXTERNAL_PATTERNS: RegExp[] = [
  // Not signed in / not authenticated.
  /not signed in|not authenticated|please sign in|sign in (first|to continue|required)/i,
  // Integration disconnected, token revoked/expired/invalidated.
  /token (was |has been )?(revoked|expired|invalidated)|access token.{0,40}(revoked|expired|invalid)|reconnect (in|your)|integration.{0,40}(disconnected|revoked|expired)/i,
  // Upstream provider outage / unavailable. Block signal only — remediation
  // phrases ("pivoted to", "filed as a product issue") live exclusively in
  // the HANDLING patterns below, so a turn that pivots without naming an
  // explicit outage stays scorable (CodeRabbit local review).
  /(currently down|outage|unavailable right now|service (is |was )?down|provider (outage|error))/i,
  // Asked a legitimate clarifying question, user never replied. Narrow: the
  // assistant must ALSO show it declined to guess or take an irreversible
  // action on the fragment (the ENG-1296 correct-handling shape). A bare
  // "could you clarify" after an ordinary partial answer is not enough — that
  // over-matches incomplete work that must stay scorable. Kept separate from
  // the patterns above: clarification blocks additionally require validating
  // the PRECEDING user request (CodeRabbit PR review on #2983) — an
  // unnecessary "I decline to guess; could you clarify?" punt after a
  // fully-specified request is an agent failure, not an external block.
  // See CLARIFICATION_BLOCK_PATTERNS + matchesClarificationBlock below.
];
const CLARIFICATION_BLOCK_PATTERNS: RegExp[] = [
  /could you clarify.{0,120}(declin|avoid.{0,10}guess|without guess|no action|instead of guessing)|declin.{0,40}guess.{0,120}could you clarify/i,
];
// A focused, applicable question — not just a bare "could you clarify?".
const FOCUSED_QUESTION_PATTERN: RegExp =
  /which [a-z']+|what [a-z']+( [a-z']+)?|whether/i;
// POSITIVE allowlist of genuinely ambiguous fragment shapes (CodeRabbit local
// review on #2983): an exclusion-list on the user text ("not a link, not a
// name") still admits complete requests like "Write a haiku about winter".
// Only these shapes qualify — a bare noun, a pronoun-only fragment, or an
// explicit deferral ("you choose", "whatever works").
const AMBIGUOUS_FRAGMENT_PATTERNS: RegExp[] = [
  /^(post|send|share|publish|do|run|start|go|do it|post it|send it|share it|run it)\s*[.!?]?\s*$/i,
  /^(it|that|this|those|them)\s+[a-z']{0,20}$/i,
  // Standalone pronoun ("it", "that") — the other half of the pronoun-only
  // fragment shape (CodeRabbit PR review on #2983).
  /^(it|that|this|those|them)\s*[.!?]?\s*$/i,
  // Bare noun ("LinkedIn") — a single capitalized token with no verb and no
  // sentence structure (CodeRabbit PR review on #2983). Kept narrow: common
  // single-word imperative commands ("Cancel", "Stop", ...) are complete
  // requests, not ambiguous fragments, so they are denied via lookahead; a
  // multi-word or lowercase-leading fragment only qualifies via the shapes
  // above, so complete requests like "Write a haiku about winter" stay
  // scorable.
  /^(?!(?:Cancel|Stop|Delete|Remove|Pause|Resume|Retry|Refresh|Save|Submit|Confirm|Continue|Quit|Exit|Help|Approve|Reject|Archive|Undo|Unsubscribe|Subscribe)(?:[.!?]\s*)?$)[A-Z][a-zA-Z']*$/,
  /^(you (choose|decide|pick)|whatever( works| you (want|think))?|your call)\s*[.!?]?\s*$/i,
];
// Account-level publish-authorization hold for a NON-scheduled (interactive)
// session (CodeRabbit local review on #2983): the genuine terminal
// PUBLISH WITHHELD: marker path (isPublishGateWithheldSession) is scoped to
// scheduled runs, so an interactive session where the assistant saved the
// draft and reported an approval hold would fall through to the judges and be
// scored as an agent failure. Session-aware by construction — the caller
// passes the session, and this requires sessionType !== 'scheduled' so a
// scheduled run can never reach it (scheduled holds keep their marker +
// admission safeguards, never a message-only match).
const INTERACTIVE_PUBLISH_HOLD_PATTERNS: RegExp[] = [
  /require approval before publishing|requires approval to (publish|post)|standing publish authorization|publish authorization has been revoked|account-level (publish )?setting/i,
];
const INTERACTIVE_PUBLISH_HANDLING_PATTERNS: RegExp[] = [
  // Draft saved + explicit hold (no PUBLISH WITHHELD: terminal marker — that
  // scheduled path keeps its own marker test; a marker-bearing turn on a
  // regular session stays with isPublishGateWithheldSession's scope rule).
  /saved the draft(?![\s\S]*PUBLISH WITHHELD:)|draft saved(?![\s\S]*PUBLISH WITHHELD:)|will not (publish|post)|holding (the|this) (draft|post)/i,
];

/**
 * A terminal block report, not generated content (CodeRabbit local review on
 * #2983): the block + handling evidence must live in a SHORT last turn
 * (<= 600 chars) — a completed incident-notice draft or long deliverable
 * that merely mentions "service is currently down" + "next steps" in passing
 * stays scorable. The clarification path (matchesClarificationBlock) keeps
 * its own longer allowance via the fragment shapes above; this cap applies
 * to the outage/auth/token patterns matched against the full final turn.
 */
// A block REPORT, not a passing mention inside generated content (CodeRabbit
// local review on #2983): the final assistant turn must READ as a terminal
// block report — it must OPEN by naming the block or OPEN/CLOSE with the
// handling (stopped/refused/withheld + fix/next step). A draft or explainer
// that mentions "provider error" mid-body and "next steps" at the end stays
// scorable: neither the opening nor the closing is the block report.
const BLOCK_REPORT_OPEN_PATTERN: RegExp =
  /^(i (can't|cannot|won't|am unable)|unable to|sorry,? i (can't|cannot|won't|am unable)|stopped|holding|saved the draft|draft saved|please sign in|sign in|once signed in|your .* was revoked|reconnect|linked(in)? search is (currently down|down)|service is (currently down|down)|.*\boutage, so i stopped\b|.*could you clarify|.*could you let me know|.*publish.*(approval|authorization|withheld))/i;
const BLOCK_REPORT_CLOSE_PATTERN: RegExp =
  /(say retry|once (signed in|reconnected)|takes ~?60 seconds|settings → integrations|filed .* (as )?a product issue|reported via the appropriate tool|which [a-z']+\?|what [a-z']+.*\?|whether .*\.?\s*$|please sign in|will not (publish|post|proceed|make)|stopped (before|that path)|saved the draft|draft saved)\s*(<[^>]+>\s*)*$/i;

const BLOCKED_EXTERNAL_HANDLING_PATTERNS: RegExp[] = [
  // Stopped before acting without authority + explained.
  /stopped before|will not (proceed|post|make)|saved the draft|draft saved/i,
  // Gave the fix / next step.
  /reconnect|takes ~?60 seconds|once (signed in|reconnected)|say retry|settings → integrations|next steps/i,
  // Asked a focused question instead of guessing. Narrow: "let me know" alone
  // is a generic closing, not handling evidence (CodeRabbit PR review) — it
  // only counts paired with the clarification decline above.
  /could you clarify|which (one|option)|let me know.{0,80}(which|what|whether|clarify|details?)|(which|what|whether|clarify).{0,80}let me know/i,
  // Filed the platform issue.
  /filed .* (product issue|as a product issue)|reported via the appropriate tool/i,
  // Asked to sign in.
  /please sign in|sign in (first|so I can)/i,
];

function lastAssistantText(messages: ChatMessage[] = []): string {
  // The FINAL non-system turn must be the assistant's block report. Filtering
  // to assistant turns first would misclassify a session where the assistant
  // reported the block and the transcript then continued (user retry, tool
  // result, mid-loop state) — those are handled by the in-flight/mid-loop
  // guards elsewhere, not by this exclusion (CodeRabbit local review).
  const nonSystem = (messages || []).filter((m: any) => m.role !== "system");
  const last: any = nonSystem[nonSystem.length - 1];
  if (!last || last.role !== "assistant" || isRunFailurePlaceholder(last)) return "";
  return textOf(last.content);
}

export function isBlockedExternalSession(messages: ChatMessage[] = []): boolean {
  const text = lastAssistantText(messages);
  if (!text) return false;
  // Clarification blocks bind the handling to the SPECIFIC unresolved block
  // (CodeRabbit PR review on #2983): the decline-to-guess must pair with a
  // focused question, and the PRECEDING user request must be a genuinely
  // ambiguous fragment from the positive allowlist.
  if (matchesClarificationBlock(messages ?? [], text)) return true;
  // Non-clarification blocks: the final turn must READ as a terminal block
  // report (CodeRabbit local review on #2983) — it must open on the block
  // (or the handling) and close on the handling. A draft/explainer that
  // merely mentions an outage mid-body stays scorable even when short.
  const trimmed = text.trim();
  // Length guard (CodeRabbit PR review on #2983): the documented <= 600-char
  // cap applies to the non-clarification terminal-report path — a long
  // deliverable that merely mentions the block stays scorable. Placed after
  // the clarification branch so valid clarification handling is unchanged.
  if (trimmed.length > 600) return false;
  const opensOnBlock = BLOCK_REPORT_OPEN_PATTERN.test(trimmed);
  const closesOnHandling = BLOCK_REPORT_CLOSE_PATTERN.test(trimmed);
  // Either edge must carry the report shape: a turn that neither opens on
  // the block/handling nor closes on the handling is generated content with
  // a passing mention, not a terminal block report.
  if (!opensOnBlock && !closesOnHandling) return false;
  const namesBlock = BLOCKED_EXTERNAL_PATTERNS.some((re) => re.test(text));
  if (!namesBlock) return false;
  return BLOCKED_EXTERNAL_HANDLING_PATTERNS.some((re) => re.test(text));
}

/**
 * Session-aware entry point: also recognizes a correctly-handled
 * account-level publish-authorization hold on a NON-scheduled session. The
 * scheduled-run marker path (isPublishGateWithheldSession) keeps its own
 * marker + admission safeguards — this never reaches scheduled runs.
 */
export function isBlockedExternalSessionForSession(session: {
  sessionType?: string;
  messages?: ChatMessage[];
}): boolean {
  if (isBlockedExternalSession(session?.messages)) return true;
  if (session?.sessionType === 'scheduled') return false;
  const text = lastAssistantText(session?.messages ?? []);
  if (!text) return false;
  const trimmed = text.trim();
  // Length guard (CodeRabbit PR review on #2983): the documented <= 600-char
  // cap applies to the interactive publish-hold path too — a long deliverable
  // that mentions the approval hold stays scorable.
  if (trimmed.length > 600) return false;
  if (
    !BLOCK_REPORT_OPEN_PATTERN.test(trimmed) &&
    !BLOCK_REPORT_CLOSE_PATTERN.test(trimmed)
  )
    return false;
  return (
    INTERACTIVE_PUBLISH_HOLD_PATTERNS.some((re) => re.test(text)) &&
    INTERACTIVE_PUBLISH_HANDLING_PATTERNS.some((re) => re.test(text))
  );
}

/**
 * True when the final assistant turn declines to guess AND asks a focused,
 * applicable question, AND the preceding user request is an ambiguous
 * fragment (short, no concrete noun: no quoted text, no URL, no named entity
 * the assistant could have acted on). An unnecessary
 * "I decline to guess; could you clarify?" after a fully-specified request
 * ("Review my LinkedIn profile: <url>") scores normally — that punt is an
 * agent failure, not an external block.
 */
function matchesClarificationBlock(messages: ChatMessage[], text: string): boolean {
  if (!CLARIFICATION_BLOCK_PATTERNS.some((re) => re.test(text))) return false;
  if (!FOCUSED_QUESTION_PATTERN.test(text)) return false;
  const nonSystem = (messages || []).filter((m: any) => m.role !== 'system');
  const prev: any = nonSystem.length >= 2 ? nonSystem[nonSystem.length - 2] : null;
  const prevText =
    prev && prev.role === 'user' && typeof prev.content === 'string'
      ? prev.content.trim()
      : '';
  // POSITIVE allowlist (CodeRabbit local review on #2983): only known
  // ambiguous-fragment shapes qualify. "Write a haiku about winter" matches
  // none of these and stays scorable.
  if (!prevText) return false;
  return AMBIGUOUS_FRAGMENT_PATTERNS.some((re) => re.test(prevText));
}

/**
 * Returns true when the transcript ends in a state an agent tool loop cannot
 * terminate on — the run is still mid-flight even though hasAssistantTurn()
 * would return true (a partial tool-call step was persisted).
 *
 * Mid-loop states:
 *   - Last non-system message is a tool result  (agent hasn't replied yet)
 *   - Last non-system message is an unanswered user prompt
 *   - Last assistant message is a pure tool-call turn with no text
 *
 * Settled state (NOT mid-loop, score normally):
 *   - Last assistant message has text content, even if it also carries toolCalls.
 *     Completed scheduled runs aggregate tool calls into the final reply and still
 *     include the natural-language summary as text, so they must not be deferred.
 */
function transcriptEndsMidToolLoop(messages: ChatMessage[]): boolean {
  const nonSystem = (messages || []).filter((m: any) => m.role !== "system");
  if (nonSystem.length === 0) return false;

  const last: any = nonSystem[nonSystem.length - 1];

  // Trailing tool result → agent hasn't responded yet
  if (last.role === "tool") return true;

  // Unanswered user/injected prompt → agent hasn't started this step
  if (last.role === "user") return true;

  // Pure tool-call assistant turn with no text → mid-loop
  if (last.role === "assistant") {
    const text = textOf(last.content).trim();
    const toolCalls = last.metadata?.toolCalls;
    if (!text && Array.isArray(toolCalls) && toolCalls.length > 0) return true;
  }

  return false;
}

const FAILED_RUN_REASON =
  "Session produced no assistant response — it appears to have crashed or timed out before completing. Flagged as a failed run.";

// User-facing note left in the transcript of a run that crashed/timed out before
// producing any assistant turn. Without it the session is a silent dead chat —
// [system, user] with no reply and no explanation. Flagged isRunFailureNotice so
// hasAssistantTurn() ignores it (the run is still a failure) and it is added at
// most once.
const RUN_FAILED_USER_MESSAGE =
  "This run didn't finish — it looks like it stopped before producing a response. Please send your message again to retry.";

function hasRunFailureNotice(messages: ChatMessage[] = []): boolean {
  // Also treat the scheduled reconciler's jobIncomplete note as "already surfaced"
  // (ENG-479): that run was recovered/requeued and already carries a user-facing
  // explanation + diagnostic error, so surfaceFailedRun() must not add a second note.
  return (messages || []).some(isRunFailurePlaceholder);
}

/**
 * Turn a silent dead session (crashed/timed out before any assistant turn) into a
 * visible failed run: record the failure on the session's diagnostic `error`
 * field AND leave a single user-facing "please retry" note in the transcript.
 *
 * The scheduled-run reconciler (ENG-324) already does this for scheduled runs via
 * a durable lease; regular interactive runs have no such lease, so a hard process
 * death (OOM/SIGKILL) leaves them silent. This backstop — driven by the same
 * satisfaction sweep that already DETECTS the failure — closes that gap for every
 * turn-less stale session, scheduled or not.
 *
 * Idempotent: a session already carrying the notice is left untouched, so
 * repeated scoring passes never duplicate it. Best-effort: a persistence failure
 * only logs and never blocks scoring.
 */
async function surfaceFailedRun(session: ChatSession): Promise<void> {
  if (hasRunFailureNotice(session.messages)) return;
  const nowIso = new Date().toISOString();
  // ENG-971: "please send your message again to retry" is blanket advice, and a
  // turn-less death does NOT mean nothing happened — see the note above about a run
  // whose side-effecting tool call landed before the instance was terminated. If the
  // ledger confirms a publish, name it, so the retry does not become a second
  // production deploy. Append-only and idempotent; the isRunFailureNotice marker the
  // dedup check keys off is metadata, so it survives untouched.
  const notice: ChatMessage = {
    role: "assistant",
    content: appendConfirmedPublishNotice(
      RUN_FAILED_USER_MESSAGE,
      ledgerFromSucceededFunctions(session.calledFunctions),
    ),
    timestamp: nowIso,
    metadata: { timestamp: nowIso, isErrorMessage: true, isRunFailureNotice: true },
  } as any;
  try {
    // Write the diagnostic error FIRST and add the transcript notice LAST. The
    // notice is the idempotency marker (the early return above + hasAssistantTurn
    // both key off it), so it must only land once BOTH writes have succeeded.
    // Otherwise a notice persisted while updateSessionError threw would suppress
    // the error write forever on every later pass. With this ordering a partial
    // failure leaves no notice, so the whole annotation is retried next pass
    // (updateSessionError just overwrites the same reason — idempotent).
    await chatbotDb.updateSessionError(session.sessionId, FAILED_RUN_REASON);
    await chatbotDb.addMessageToSession(session.sessionId, notice);
    // Keep the in-memory snapshot consistent so a second scoring call on the same
    // object in the same pass sees the notice and skips re-adding it.
    if (Array.isArray(session.messages)) session.messages.push(notice);
  } catch (err) {
    console.error(`surfaceFailedRun: failed to annotate session ${session.sessionId}:`, err);
  }
}

/**
 * Deterministic failure score for a session that stalled before producing any
 * assistant output. There is nothing to send to the LLM judge, so we score it
 * 1/5 across all dimensions directly with an explanatory reason.
 */
export function buildFailedRunResult(messageCount: number): ScoringResult {
  return {
    score: 1,
    reason: FAILED_RUN_REASON,
    evaluatedMessageIndex: messageCount,
    dimensions: { goalCompletion: 1, dataAccuracy: 1, outputQuality: 1 },
  };
}
/**
 * Wall-clock allowance for ONE scoring call.
 *
 * It used to be a flat 20s, which is generous for a short chat and far too tight
 * for a 30-70 turn scheduled run: the configured scoring model is a *thinking*
 * model, so its latency scales with the size of the transcript. Long sessions
 * therefore lost the race, `scoreSession` threw, and the session was left
 * unscored — permanently, since nothing re-attempts a window that has passed
 * (ENG-929). Scale the allowance with the transcript instead, bounded at both
 * ends: the baseline keeps short sessions snappy and the ceiling keeps one huge
 * session from eating the sync-scoring budget on its own. The transcript itself
 * is capped (MAX_TRANSCRIPT_CHARS_FOR_SCORING), so the ceiling is reachable but
 * never exceeded by an unbounded input.
 */
export const SCORING_TIMEOUT_BASE_MS = 20000; // short transcript
const SCORING_TIMEOUT_PER_10K_CHARS_MS = 10000;
export const SCORING_TIMEOUT_MAX_MS = 60000;

export function scoringTimeoutMs(conversationText: string): number {
  const extra = Math.floor((conversationText?.length ?? 0) / 10000) * SCORING_TIMEOUT_PER_10K_CHARS_MS;
  return Math.min(SCORING_TIMEOUT_MAX_MS, SCORING_TIMEOUT_BASE_MS + extra);
}

/**
 * Race an LLM call against a transcript-sized timeout. The timer is always
 * cleared, so a fast call never leaves a pending handle behind (a per-session
 * leak at sync-scoring volumes).
 */
async function raceWithScoringTimeout<T>(call: Promise<T>, conversationText: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutMs = scoringTimeoutMs(conversationText);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Scoring LLM call timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });
  try {
    return await Promise.race([call, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getDefaultScoringPrompt(): Promise<string> {
  try {
    const { settingsService } = await import("./settingsService");
    const setting = await settingsService.getSetting("default-scoring-prompt");
    if (setting?.settingValue) return setting.settingValue;
  } catch (err) {
    console.error("Failed to load custom default scoring prompt, using hardcoded:", err);
  }
  return DEFAULT_SCORING_SYSTEM_PROMPT;
}

export async function getDefaultScoringModel(): Promise<string> {
  try {
    const { settingsService } = await import("./settingsService");
    const setting = await settingsService.getSetting("default-scoring-model");
    if (setting?.settingValue) return setting.settingValue;
  } catch (err) {
    console.error("Failed to load custom default scoring model, using hardcoded:", err);
  }
  return SCORING_MODEL;
}

/**
 * Map a persisted scoring-model id onto one that is actually served.
 *
 * Scoring reads its model from config written WITHOUT registry validation —
 * the `default-scoring-model` setting and each judge's `llmModel`. When a model
 * is retired the stale id survives in the database, and both scoring paths used
 * to hand it straight to `callLLM`, which throws `Invalid model '<id>'`. Because
 * admin.ts scores sessions inside a `Promise.allSettled`, that throw is caught
 * and the visible symptom is "sessions quietly stopped being scored" — no error
 * surfaces to anyone. ENG-744 exposed this by retiring `gemini-3-pro-preview`
 * (which had in fact been failing at Google with a 404 since 2026-03-09, so the
 * stale-config hazard predates that removal).
 *
 * The chat path already solves this with `resolveGenerationModel` (ENG-46), so
 * reuse it for validation + legacy aliasing rather than re-implementing the
 * allow-list check. The one thing we deliberately do NOT reuse is its fallback
 * target: that is the chat default, which in production is an Opus-tier model.
 * Silently rerouting every scoring call there would turn a retired-model bug
 * into a cost incident. Fall back to the scoring default instead, and only use
 * the chat fallback if the scoring default is itself unserved (otherwise this
 * function would just relocate the `Invalid model` throw rather than remove it).
 */
export async function resolveScoringModel(requested: string | undefined): Promise<string> {
  const { agentModeService } = await import("./agentModeService");

  if (requested) {
    const { model, fellBack } = agentModeService.resolveGenerationModel(requested);
    // Not a fallback => the id was served (possibly after legacy aliasing).
    if (!fellBack) return model;
    console.warn(
      `SessionScoring: configured model '${requested}' is no longer served; ` +
        `falling back to the scoring default '${SCORING_MODEL}'.`
    );
  }

  const scoringDefault = agentModeService.resolveGenerationModel(SCORING_MODEL);
  if (!scoringDefault.fellBack) return scoringDefault.model;

  console.warn(
    `SessionScoring: scoring default '${SCORING_MODEL}' is not served either; ` +
      `using '${scoringDefault.model}'.`
  );
  return scoringDefault.model;
}

type ScoringResult = {
  score: number;
  reason: string;
  evaluatedMessageIndex: number;
  dimensions?: {
    goalCompletion: number;
    dataAccuracy: number;
    outputQuality: number;
    /**
     * ENG-1312 additions. Optional and parsed independently of the base three:
     * a stale custom judge prompt (predating this change) will never populate
     * them, and that must not invalidate goalCompletion/dataAccuracy/outputQuality.
     */
    concision?: number; // 0-5: did reply length match the question/instruction?
    instructionCompliance?: number; // 0-5: explicit instruction followed on first attempt?
    unnecessaryPermissionRequest?: boolean; // asked to confirm a safe (read-only/draft/test) action?
    /** ENG-2189: binary criteria only the outcome rubric (outcomeJudge.ts) asks for; absent otherwise. */
    arguedWithInstruction?: boolean;
    escalatedWhenNotRequired?: boolean;
    failedToEscalate?: boolean;
  };
  /**
   * `false` when the judge reported that the user never requested anything, so
   * the session belongs outside the satisfaction cohort. `undefined` means the
   * judge gave no usable answer — score normally (fail open). See
   * NO_TASK_JUDGMENT_CLAUSE.
   */
  taskRequested?: boolean;
  /**
   * True when the transcript handed to the judge was shortened to fit
   * MAX_TRANSCRIPT_CHARS_FOR_SCORING. Surfaced on the persisted score so a
   * partial-context judgement is never mistaken for a full-context one (ENG-929).
   */
  transcriptTruncated?: boolean;
  /** Set for a shadow judge (ENG-2138): the model that produced the score, kept on the stored score. */
  model?: string;
};

/** A finite number in `raw`, or undefined if missing/non-numeric. Distinguishes
 * "the judge didn't answer" (leave undefined, fail open) from "the judge
 * answered 0" (a real, in-range score). */
function finiteNumber(v: any): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * ENG-2216: Bedrock-routed models don't always strictly honor
 * `response_format: json_object` — leading text (e.g. "Here is my
 * evaluation:") or trailing text (e.g. "Hope that helps!") around the JSON
 * object makes a bare `JSON.parse(raw)` throw, and that throw was previously
 * swallowed silently by the judge-score route's `Promise.allSettled`. Slice the
 * first balanced `{...}` object — this covers a bare JSON object (slicing is a
 * no-op), a leading preamble, trailing text, a trailing second object, or any
 * mix. Falls back to the original `raw` when no `{` is present, so
 * `JSON.parse` still throws with a meaningful message.
 */
function extractJsonObject(raw: string): string {
  const start = raw.indexOf("{");
  if (start === -1) return raw;
  // ENG-2138: return the first balanced top-level object, so text (or a second object) after the
  // JSON no longer ends up inside the slice. String-aware: braces inside string values don't
  // count, and a backslash escapes the next character (so \" doesn't end a string).
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}" && --depth === 0) {
      return raw.slice(start, i + 1);
    }
  }
  // Never balanced (truncated or malformed): keep the pre-ENG-2138 slice so the failure,
  // and the control-character repair that follows, behave exactly as before.
  const end = raw.lastIndexOf("}");
  return end < start ? raw : raw.slice(start, end + 1);
}

/**
 * Models sometimes emit a raw newline or tab inside a JSON string (typically a multi-line
 * "reason"), which strict JSON.parse rejects. Escape only those control characters, and only
 * inside string literals, then parse strictly again. Anything still malformed still throws.
 */
function escapeControlCharsInJsonStrings(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === undefined || next.charCodeAt(0) < 0x20) {
        out += "\\\\";
      } else {
        out += ch + next;
        i++;
      }
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
    } else if (ch.charCodeAt(0) < 0x20) {
      out += ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : ch === "\t" ? "\\t" : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function parseJudgeJson(raw: string): any {
  const candidate = extractJsonObject(raw);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    const repaired = escapeControlCharsInJsonStrings(candidate);
    if (repaired === candidate) throw error;
    return JSON.parse(repaired);
  }
}

function parseDimensions(raw: any): ScoringResult["dimensions"] | undefined {
  const d = raw?.dimensions;
  if (!d || typeof d !== "object") return undefined;
  const clamp1to5 = (v: any) => Math.max(1, Math.min(5, Math.round(Number(v))));
  if (!d.goalCompletion || !d.dataAccuracy || !d.outputQuality) return undefined;

  const dimensions: NonNullable<ScoringResult["dimensions"]> = {
    goalCompletion: clamp1to5(d.goalCompletion),
    dataAccuracy: clamp1to5(d.dataAccuracy),
    outputQuality: clamp1to5(d.outputQuality),
  };

  // ENG-1312: each new field is optional and parsed independently — a missing
  // or malformed one is simply omitted, never falls back to a default value
  // that would masquerade as a real judge answer, and never invalidates the
  // base three dimensions parsed above.
  const clamp0to5 = (v: number) => Math.max(0, Math.min(5, Math.round(v)));
  const concision = finiteNumber(d.concision);
  if (concision !== undefined) dimensions.concision = clamp0to5(concision);
  const instructionCompliance = finiteNumber(d.instructionCompliance);
  if (instructionCompliance !== undefined) {
    dimensions.instructionCompliance = clamp0to5(instructionCompliance);
  }
  if (typeof d.unnecessaryPermissionRequest === "boolean") {
    dimensions.unnecessaryPermissionRequest = d.unnecessaryPermissionRequest;
  }
  // ENG-2189: same rule, only a real boolean is kept.
  for (const key of ["arguedWithInstruction", "escalatedWhenNotRequired", "failedToEscalate"] as const) {
    if (typeof d[key] === "boolean") dimensions[key] = d[key];
  }

  return dimensions;
}

const SESSION_TYPE_HEADERS: Record<string, string> = {
  "slack-triggered": "[Session context: Emma is drafting a suggested response to an inbound Slack message on behalf of the team. She is NOT directly serving an end user. Evaluate goalCompletion based on whether she produced an appropriate draft — not whether the Slack contact's underlying request was fulfilled.]",
  "scheduled": "[Session context: This is a fully automated scheduled run — NO human user was present. Every message labeled 'user' in the transcript was automatically injected by the scheduling system to trigger the next step of the task, NOT typed by a real person. Therefore: (1) DO NOT interpret repeated 'user' messages as user frustration or the user having to repeat themselves — they are automated prompts driving a multi-step workflow. (2) DO NOT penalize the score for high message volume or for the user 'repeating instructions'. (3) Evaluate ONLY whether the assistant ultimately completed the scheduled task successfully. Signs of a good run: task goals were achieved, relevant tools were called, outputs were produced. Signs of a bad run: the assistant failed to call required tools, produced no output, or errored out without completing the task.]",
};

function getSessionTypeHeader(pageIdentifier?: string, sessionType?: string): string {
  // Check exact pageIdentifier match first (e.g. "slack-triggered")
  if (pageIdentifier && SESSION_TYPE_HEADERS[pageIdentifier]) {
    return SESSION_TYPE_HEADERS[pageIdentifier];
  }
  // Fall back to sessionType (e.g. "scheduled" sessions have dynamic pageIdentifiers)
  if (sessionType && SESSION_TYPE_HEADERS[sessionType]) {
    return SESSION_TYPE_HEADERS[sessionType];
  }
  return "";
}

export async function scoreSession(
  messages: ChatMessage[],
  currentMessageCount: number,
  pageIdentifier?: string,
  sessionType?: string,
  usageContext?: { userId?: string; feature?: string; sessionId?: string }
): Promise<ScoringResult> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SCORING);
  const capped = capTranscriptForScoring(serializeMessagesForScoring(recentMessages));
  const header = getSessionTypeHeader(pageIdentifier, sessionType);
  // ENG-1223: computed from the FULL session, not recentMessages — a session
  // with >MAX_MESSAGES_FOR_SCORING messages that made tool calls earlier would
  // otherwise get a manifest falsely claiming zero calls "anywhere in this
  // session", which both misleads the judge and wrongly triggers
  // applyFabricationGuard's zero-call cap below.
  const manifest = buildToolCallManifest(messages);
  const conversationText = header
    ? `${header}\n${manifest.text}\n\n${capped.text}`
    : `${manifest.text}\n\n${capped.text}`;

  // Lazy-import to avoid pulling heavy dependencies at module load time
  const { agentModeService } = await import("./agentModeService");
  // Append the zero-task clause, the ENG-1312 verbosity/permission clause, the
  // ENG-1245 publish-approval-withholding clause, the ENG-1223
  // fabrication-grounding clause, the ENG-1164 output-integrity-guard clause,
  // and the ENG-1296 awaiting-user-reply clause to whatever prompt is
  // configured — the stored override, if any, would otherwise mask them
  // entirely (ENG-392/ENG-830).
  const systemPrompt =
    (await getDefaultScoringPrompt()) +
    NO_TASK_JUDGMENT_CLAUSE +
    VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE +
    PUBLISH_APPROVAL_WITHHOLDING_CLAUSE +
    FABRICATION_GROUNDING_CLAUSE +
    OUTPUT_INTEGRITY_GUARD_CLAUSE +
    AWAITING_USER_REPLY_CLAUSE;
  // Persisted setting — validate before calling, or a retired id throws
  // `Invalid model` and the session silently goes unscored (ENG-744).
  const model = await resolveModelForUser(usageContext?.userId, 'scoring_judge');

  const llmPromise = agentModeService.callLLM(
    model,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Evaluate this conversation:\n\n${conversationText}` },
    ],
    {
      temperature: 0,
      max_completion_tokens: SCORING_MAX_COMPLETION_TOKENS,
      response_format: { type: "json_object" },
      usageContext: { ...usageContext, feature: usageContext?.feature || "agent_task" },
      taskClass: 'nonstandard_consumer',
    }
  );

  const res = await raceWithScoringTimeout(llmPromise, conversationText);

  const raw = res.choices?.[0]?.message?.content ?? "{}";
  // ENG-2216: Bedrock doesn't always honor response_format: json_object strictly.
  const parsed = parseJudgeJson(raw);
  // ENG-1669: a missing/non-numeric "score" field used to flow straight through
  // Math.round/Math.max/Math.min as NaN — no code path checked for it — and the
  // resulting NaN only surfaced when DynamoDB's SDK rejected it at the point of
  // persisting, as an opaque "cannot be converted to a numeric value: NaN"
  // error far removed from the actual cause. Fail at the source instead, with a
  // message that says what actually went wrong.
  const rawScore = finiteNumber(parsed.score);
  if (rawScore === undefined) {
    throw new Error(
      `Judge response missing or non-numeric "score" field (got ${JSON.stringify(parsed.score)})`
    );
  }
  const score = Math.max(1, Math.min(5, Math.round(rawScore)));
  const reason = parsed.reason || "No reason provided";
  const fabricationGuarded = applyFabricationGuard(
    manifest.count,
    reason,
    score,
    parseDimensions(parsed),
    parseAssertsToolDerivedData(parsed)
  );
  const guarded = applyAwaitingReplyGuard(reason, fabricationGuarded.score, fabricationGuarded.dimensions);

  return {
    score: guarded.score,
    reason,
    evaluatedMessageIndex: currentMessageCount,
    dimensions: guarded.dimensions,
    taskRequested: parseTaskRequested(parsed),
    ...(capped.truncated ? { transcriptTruncated: true } : {}),
  };
}

export interface ScoringJudge {
  id: string;
  name: string;
  systemPrompt: string;
  llmModel?: string;
  /**
   * ENG-2138: a shadow judge scores only its sample (`sampleRate`, 0..1; missing = never), on
   * its own non-Gemini model, metered as system spend. It writes judgeScores[id] like any
   * judge and never the primary score. See outcomeJudge.ts.
   */
  shadow?: boolean;
  sampleRate?: number;
  /**
   * ENG-2484: which generic ENG-* clauses a SHADOW judge's prompt gets appended. 'all' (or
   * absent) is the pre-ENG-2484 behaviour; 'none' sends the rubric alone (its own outcome
   * dimensions replace the generic satisfaction clauses). Ignored on non-shadow judges, so an
   * ordinary satisfaction judge always keeps every clause. Deterministic code guards (cohort
   * exclusion, no-task retraction, fabrication/integrity caps) run regardless of this value.
   */
  clausePolicy?: JudgeClausePolicy;
  createdAt: string;
  updatedAt: string;
}

/**
 * ENG-2483: offline-replay switch. ENG-2481's bisect found the appended clauses, not the
 * serializer, cost the outcome judge its discrimination (AUC 0.83 serializer-only vs 0.70
 * with clauses). `appendClauses: false` lets a replay score serializer-only. Default (absent
 * or true) is the production prompt, byte-identical to before.
 */
export interface JudgePromptOptions {
  appendClauses?: boolean;
}

export type JudgeClausePolicy = 'all' | 'none';

/** ENG-2484: the effective clause policy — only a shadow judge may opt out of the clauses. */
export function effectiveClausePolicy(judge: Pick<ScoringJudge, 'shadow' | 'clausePolicy'>): JudgeClausePolicy {
  return judge.shadow && judge.clausePolicy === 'none' ? 'none' : 'all';
}

export function buildJudgeSystemPrompt(basePrompt: string, options?: JudgePromptOptions): string {
  if (options?.appendClauses === false) return basePrompt;
  return (
    basePrompt +
    NO_TASK_JUDGMENT_CLAUSE +
    VERBOSITY_PERMISSION_DIMENSIONS_CLAUSE +
    PUBLISH_APPROVAL_WITHHOLDING_CLAUSE +
    FABRICATION_GROUNDING_CLAUSE +
    OUTPUT_INTEGRITY_GUARD_CLAUSE +
    AWAITING_USER_REPLY_CLAUSE
  );
}

/** The one LLM call a judge makes; injectable so offline replays can call the model unmetered. */
export type ScoringLlmCall = (
  model: string,
  messages: Array<{ role: "system" | "user"; content: string }>,
  options: {
    temperature: number;
    max_completion_tokens: number;
    response_format: { type: "json_object" };
    taskClass: "nonstandard_consumer";
    usageContext: { userId?: string; feature?: string; sessionId?: string };
  }
) => Promise<{ choices?: Array<{ message?: { content?: string | null } }> }>;

/**
 * The model a judge runs on. A shadow judge uses its own model (default Sonnet 4.6), validated
 * but never the per-org scoring_judge role, and refuses the agent's family — including when a
 * retired id would fall back to the Gemini scoring default.
 */
async function resolveJudgeModel(judge: ScoringJudge, userId: string | undefined): Promise<string> {
  if (judge.shadow) {
    const model = await resolveScoringModel(judge.llmModel || DEFAULT_OUTCOME_JUDGE_MODEL);
    assertOutcomeJudgeModelAllowed(model);
    return model;
  }
  return judge.llmModel ? resolveScoringModel(judge.llmModel) : resolveModelForUser(userId, 'scoring_judge');
}

const roundToTenth = (n: number): number => Math.round(n * 10) / 10;

export async function scoreSessionWithJudge(
  messages: ChatMessage[],
  currentMessageCount: number,
  judge: ScoringJudge,
  sessionType?: string,
  usageContext?: { userId?: string; feature?: string; sessionId?: string },
  callLLM?: ScoringLlmCall,
  judgeOptions?: JudgePromptOptions
): Promise<ScoringResult> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SCORING);
  const capped = capTranscriptForScoring(serializeMessagesForScoring(recentMessages));
  const header = getSessionTypeHeader(undefined, sessionType);
  // ENG-1223: see scoreSession — computed from the full session, not
  // recentMessages, so the manifest's "anywhere in this session" claim is
  // actually true and applyFabricationGuard isn't fooled by an out-of-window
  // tool call.
  // ENG-2429: eval-only telemetry for AI-tell phrasing in Emma's output.
  // Logged, never persisted; never affects the score or throws.
  try {
    const styleTells = summarizeAiStyleTells(messages);
    if (styleTells.total > 0) {
      console.log(
        JSON.stringify({ event: "ai_style_tells", sessionId: usageContext?.sessionId, ...styleTells })
      );
    }
  } catch {
    // telemetry must not break scoring
  }
  const manifest = buildToolCallManifest(messages);
  const conversationText = header
    ? `${header}\n${manifest.text}\n\n${capped.text}`
    : `${manifest.text}\n\n${capped.text}`;

  const llm: ScoringLlmCall =
    callLLM ?? (async (...args) => (await import("./agentModeService")).agentModeService.callLLM(...args));

  // Per-judge model is persisted without registry validation — same retired-id
  // hazard as the default scoring model above (ENG-744).
  const judgeModel = await resolveJudgeModel(judge, usageContext?.userId);
  // A shadow judge is our own evaluation spend: metered per session, never to the customer.
  const judgeUsage = judge.shadow
    ? { sessionId: usageContext?.sessionId, feature: OUTCOME_JUDGE_SHADOW_FEATURE }
    : { ...usageContext, feature: usageContext?.feature || "agent_task" };

  const judgeSystemPrompt = buildJudgeSystemPrompt(judge.systemPrompt, judgeOptions);
  const requestJudge = (strictJson: boolean) =>
    raceWithScoringTimeout(
      llm(
        judgeModel,
        [
          {
            role: "system",
            content: strictJson ? judgeSystemPrompt + JUDGE_STRICT_JSON_CLAUSE : judgeSystemPrompt,
          },
          { role: "user", content: `Evaluate this conversation:\n\n${conversationText}` },
        ],
        {
          temperature: 0,
          max_completion_tokens: SCORING_MAX_COMPLETION_TOKENS,
          response_format: { type: "json_object" },
          taskClass: 'nonstandard_consumer',
          usageContext: judgeUsage,
        }
      ),
      conversationText
    );

  // Bedrock Claude ignores response_format (agentModeService.ts), so a reply can be malformed
  // JSON. One stricter retry recovers it; a second malformed reply still throws with its reason.
  let res = await requestJudge(false);
  let parsed: any;
  try {
    parsed = parseJudgeJson(res.choices?.[0]?.message?.content ?? "{}");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn(`[judge] malformed JSON reply, retrying once: ${error.message}`);
    res = await requestJudge(true);
    parsed = parseJudgeJson(res.choices?.[0]?.message?.content ?? "{}");
  }
  const rawScore = finiteNumber(parsed.score);
  if (rawScore === undefined) {
    throw new Error(
      `Judge response missing or non-numeric "score" field (got ${JSON.stringify(parsed.score)})`
    );
  }
  // ENG-2138: a shadow judge keeps the reply's one-decimal score. The original ENG-1710 rubric B asks for a
  // decimal and was measured on it; rounding discards that signal. A rubric that asks for whole numbers is
  // unaffected, and customer-facing judges stay whole numbers.
  const boundedScore = Math.max(1, Math.min(5, rawScore));
  const score = judge.shadow ? roundToTenth(boundedScore) : Math.round(boundedScore);
  const reason = parsed.reason || "No reason provided";
  const fabricationGuarded = applyFabricationGuard(
    manifest.count,
    reason,
    score,
    parseDimensions(parsed),
    parseAssertsToolDerivedData(parsed)
  );
  const guarded = applyAwaitingReplyGuard(reason, fabricationGuarded.score, fabricationGuarded.dimensions);

  return {
    score: guarded.score,
    reason,
    evaluatedMessageIndex: currentMessageCount,
    dimensions: guarded.dimensions,
    taskRequested: parseTaskRequested(parsed),
    ...(capped.truncated ? { transcriptTruncated: true } : {}),
    ...(judge.shadow ? { model: judgeModel } : {}),
  };
}

/**
 * Drop a stale satisfaction score from a session that is no longer in the
 * cohort. Without this the ENG-830 exclusion would only ever apply going
 * forward: a zero-task session scored 3 before the exclusion existed keeps that
 * 3 forever, because scoring now skips it and therefore never overwrites it.
 *
 * Best-effort and idempotent: nothing to clear → no write at all (so repeated
 * sweeps are free), and a persistence failure is logged rather than thrown so
 * one bad session cannot abort the whole scoring pass. An admin-overridden
 * score is human judgement and is never retracted.
 */
/**
 * Whether retraction may WRITE to production.
 *
 * The forward half of ENG-830 (never score a zero-task session again) is pure
 * logic and needs no data change. Retracting scores persisted BEFORE the fix is
 * a bulk mutation of production data, which CLAUDE.md puts behind the
 * database/data-plane approval gate. Gating it on an env var decouples the two:
 * the code merges and ships the forward fix immediately, and the historical
 * cleanup is switched on separately once approved — by flipping an Elastic
 * Beanstalk env var, with no redeploy, and reversible the same way.
 *
 * Read per call (not cached at module load) so the flag takes effect on the
 * next sweep rather than requiring a process restart.
 */
function retractionEnabled(): boolean {
  return process.env.SCORING_RETRACT_STALE_SCORES === "true";
}

async function retractSatisfactionScore(session: ChatSession): Promise<void> {
  if (!session.satisfactionScore || session.satisfactionScore.adminOverride) return;
  if (!retractionEnabled()) return;
  const previous = session.satisfactionScore;
  try {
    // The write is conditional on `previous` still being the persisted score; a
    // false return means it was not, so the row keeps a score and the in-memory
    // copy must keep it too.
    if (!(await chatbotDb.clearSessionSatisfactionScore(session.sessionId, previous))) return;
    // Keep the in-memory copy consistent: the sync sweep applies scores onto
    // these objects and serialises them straight back to the caller.
    delete (session as any).satisfactionScore;
  } catch (err) {
    console.error(`retractSatisfactionScore: session ${session.sessionId}:`, err);
  }
}

/** Judge-score counterpart of retractSatisfactionScore. */
async function retractJudgeScore(session: ChatSession, judgeId: string): Promise<void> {
  if (!session.judgeScores?.[judgeId]) return;
  if (!retractionEnabled()) return;
  const previous = session.judgeScores[judgeId];
  try {
    if (!(await chatbotDb.clearSessionJudgeScore(session.sessionId, judgeId, previous))) return;
    delete session.judgeScores[judgeId];
  } catch (err) {
    console.error(`retractJudgeScore: session ${session.sessionId}/${judgeId}:`, err);
  }
}

/** Why a session is outside every judge's cohort; `retract` = drop a score it already carries. */
export interface JudgeCohortExclusion {
  reason: Extract<ScoringSkipReason, "no-user-message" | "no-task-session" | "publish-gate-withheld" | "test-run" | "blocked-external">;
  retract: boolean;
}

/**
 * The custom-judge cohort rules of scoreSessionWithJudgeIfNeeded, as a pure function so offline
 * replays (scripts/evalOutcomeJudge.ts) judge exactly the population production does (ENG-2138).
 * Null means the session is in the cohort. Order matters and matches the original checks.
 */
export function judgeCohortExclusion(session: ChatSession): JudgeCohortExclusion | null {
  const userMessages = (session.messages || []).filter((m: any) => m.role === "user");
  if (userMessages.length < MIN_USER_MESSAGES) {
    return { reason: "no-user-message", retract: false };
  }

  // No-task session (greeting-only, interruption, bare acknowledgement): no goal
  // to complete, so the judge scores it low on goalCompletion as a pure scoring
  // artifact. Exclude it from the satisfaction cohort (ENG-168, ENG-830) — same
  // skip-and-return-null treatment as sub-threshold and in-flight sessions.
  //
  // Gated on hasAssistantTurn: a no-task session that produced NO assistant turn
  // crashed, and a crash is a genuine reliability failure that must still be
  // flagged below — the cohort exclusion must never swallow it.
  //
  // Placed BEFORE the already-scored early return so a session scored back when
  // it was still in the cohort gets that stale score retracted rather than
  // keeping it forever (scoring skips it from now on, so nothing would ever
  // overwrite it).
  if (isNoTaskSession(session.messages, session.pageIdentifier) && hasAssistantTurn(session.messages)) {
    return { reason: "no-task-session", retract: true };
  }

  // A genuinely-withheld scheduled publish gate (ENG-995): pull it out of the
  // judged cohort rather than leave a divergent judge score on it — see
  // isPublishGateWithheldSession. Placed BEFORE the already-scored early return,
  // same reasoning as isNoTaskSession above, so an existing divergent score is
  // retracted rather than kept forever.
  if (isPublishGateWithheldSession(session)) {
    return { reason: "publish-gate-withheld", retract: true };
  }

  // Manual "Test this schedule" runs sort before blocked-external (CodeRabbit
  // local review on #2983): a Test: QA run that ends in a block report is a
  // test run, not a platform gap.
  if (isTestScheduledSession(session)) {
    return { reason: "test-run", retract: false };
  }

  // ENG-1165: blocked by something outside the agent's control (unsigned-in
  // gate, revoked integration, upstream outage, unanswered legitimate
  // question, approval-held publish) with correct handling — a neutral
  // EXCLUDED state, not an agent failure. Same skip-and-retract treatment as
  // the publish-gate hold above, so all judges agree and the platform gap
  // stays countable via the skip reason instead of hiding in goalCompletion.
  if (isBlockedExternalSessionForSession(session) && hasAssistantTurn(session.messages)) {
    return { reason: "blocked-external", retract: true };
  }

  return null;
}

/**
 * How an in-cohort session is scored: "in-flight" (skip for now, score later), "failed-run"
 * (deterministic score 1, no model call) or "judge". Pure; shared with offline replays.
 *
 * Abandoned run recovered by the reconciler/backstop (ENG-764): the transcript ends
 * on a run-failure placeholder, so the process died mid-flight and never emitted its
 * final summary. The real work may have been correct, but this is an infra failure —
 * score it as a deterministic failed run rather than feeding the (placeholder-stripped)
 * truncated transcript to the LLM judge, which would mis-score it low for a "transcript
 * that cuts off after a tool call". The reconciler already left the placeholder note.
 * Still deferred within the grace window in case the reconciler's resume/retry is
 * racing to continue the same session (ENG-479).
 */
export function judgeScoringPath(session: ChatSession): "in-flight" | "failed-run" | "judge" {
  if (endsWithRunFailurePlaceholder(session.messages)) {
    return classifyTurnlessSession(session) === "in-flight" ? "in-flight" : "failed-run";
  }
  if (!hasAssistantTurn(session.messages)) {
    // No assistant turn yet: skip if still in-flight, flag as failed if stale.
    return classifyTurnlessSession(session) === "in-flight" ? "in-flight" : "failed-run";
  }
  if (transcriptEndsMidToolLoop(session.messages)) {
    return classifyTurnlessSession(session) === "in-flight" ? "in-flight" : "judge";
  }
  return "judge";
}

/**
 * ENG-2138: short stable digest of a judge's system prompt, stored on a shadow score so scores
 * produced by different prompt revisions can be told apart after the prompt is swapped.
 */
export function judgePromptVersion(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt).digest("hex").slice(0, 12);
}

/**
 * ENG-2484: promptVersion recorded on a shadow score. Under the default 'all' policy it keeps
 * its existing meaning (sha256[:12] of the stored rubric), so historical rows are not
 * reinterpreted. Under 'none' it gets a `+clauses-none` suffix, so a score from the
 * rubric-only prompt can never be mistaken for one from the clause-bearing prompt.
 */
export function shadowPromptVersion(judge: Pick<ScoringJudge, 'systemPrompt' | 'shadow' | 'clausePolicy'>): string {
  const base = judgePromptVersion(judge.systemPrompt);
  return effectiveClausePolicy(judge) === 'none' ? `${base}+clauses-none` : base;
}

export async function scoreSessionWithJudgeIfNeeded(
  session: ChatSession,
  judge: ScoringJudge,
  opts?: { force?: boolean }
): Promise<NonNullable<ChatSession["judgeScores"]>[string] | null> {
  const messageCount = session.messageCount ?? session.messages?.length ?? 0;

  // ENG-2138: a shadow judge touches only its fixed sample — no model call, no write, no
  // retraction outside it. `force` (one admin-chosen session) bypasses the sample.
  if (judge.shadow && !opts?.force && !isInShadowSample(judge, session.sessionId)) {
    return null;
  }

  const exclusion = judgeCohortExclusion(session);
  if (exclusion) {
    if (exclusion.retract) await retractJudgeScore(session, judge.id);
    return null;
  }

  // Skip if already scored by this judge, up-to-date, and has dimensional scores.
  // ENG-1296: this guard means a rubric/prompt fix NEVER self-heals a session
  // already scored under the old rules — evaluatedMessageIndex never regresses,
  // so it stays "up to date" forever. opts.force is the explicit admin escape
  // hatch (POST /chat-sessions/judge-score) for re-running a specific session
  // through the current judge after a scoring-rule change, without weakening
  // the default skip that makes routine sync/backfill cheap.
  const existingJudgeScore = session.judgeScores?.[judge.id];
  if (
    !opts?.force &&
    existingJudgeScore &&
    existingJudgeScore.evaluatedMessageIndex >= messageCount &&
    existingJudgeScore.dimensions
  ) {
    return null;
  }

  // Manual "Test this schedule" runs are interactive QA actions, not production
  // scheduled executions — the user triggers them and watches the outcome live,
  // and they are excluded from durable recovery/requeue by design. A crashed test
  // must not be scored/reported as a satisfaction reliability failure (ENG-499),
  // so drop it from the cohort like greeting-only sessions.
  if (isTestScheduledSession(session)) {
    return null;
  }

  const path = judgeScoringPath(session);
  if (path === "in-flight") return null;
  const result: ScoringResult =
    path === "failed-run"
      ? buildFailedRunResult(messageCount)
      : await scoreSessionWithJudge(
          session.messages || [],
          messageCount,
          judge,
          session.sessionType,
          { userId: session.userId, sessionId: session.sessionId },
          undefined,
          effectiveClausePolicy(judge) === 'none' ? { appendClauses: false } : undefined,
        );

  // Backstop for zero-task phrasings the static lists cannot enumerate: the
  // judge itself reported that the user never asked for anything, so the
  // session is outside the cohort. Fails open — only an explicit `false`
  // reaches here (see NO_TASK_JUDGMENT_CLAUSE).
  if (result.taskRequested === false) {
    await retractJudgeScore(session, judge.id);
    return null;
  }

  const judgeScore = {
    score: result.score,
    reason: result.reason,
    evaluatedAt: new Date().toISOString(),
    evaluatedMessageIndex: result.evaluatedMessageIndex,
    judgeName: judge.name,
    ...(result.dimensions ? { dimensions: result.dimensions } : {}),
    ...(judge.shadow
      ? {
          shadow: true,
          ...(result.model ? { model: result.model } : {}),
          ...(judge.systemPrompt ? { promptVersion: shadowPromptVersion(judge) } : {}),
        }
      : {}),
  };

  await chatbotDb.updateSessionJudgeScore(session.sessionId, judge.id, judgeScore);

  return judgeScore;
}

/**
 * Why a session was deliberately NOT scored. Every one of these is a legitimate
 * skip — the session is outside the cohort, already covered, or not finished yet.
 * A scoring FAILURE is not in this union: it throws, so a caller can tell
 * "correctly skipped" apart from "we tried and could not" (ENG-929). Before this,
 * both surfaced identically as `satisfactionScore: null`, which is how four
 * completed, expensive sessions dropped out of the daily report unnoticed.
 */
export type ScoringSkipReason =
  | "admin-override"
  | "no-user-message"
  | "no-task-session"
  | "already-scored"
  | "test-run"
  | "in-flight"
  | "publish-gate-withheld"
  | "blocked-external";

export interface SessionScoringAttempt {
  /** The newly-written score, or null when the session was skipped. */
  score: ChatSession["satisfactionScore"] | null;
  /** Present exactly when `score` is null. */
  skipReason?: ScoringSkipReason;
}

const skip = (skipReason: ScoringSkipReason): SessionScoringAttempt => ({ score: null, skipReason });

/**
 * Score a session if it needs it, reporting WHY when it does not.
 * `scoreSessionIfNeeded` is the score-only view of this for callers that do not
 * care about the reason.
 */
export async function attemptSessionScore(
  session: ChatSession,
  opts?: { force?: boolean }
): Promise<SessionScoringAttempt> {
  // Skip if admin has overridden the score
  if (session.satisfactionScore?.adminOverride) {
    return skip("admin-override");
  }

  const messageCount = session.messageCount ?? session.messages?.length ?? 0;

  // Count user messages
  const userMessages = (session.messages || []).filter(
    (m: any) => m.role === "user"
  );
  if (userMessages.length < MIN_USER_MESSAGES) {
    return skip("no-user-message");
  }

  // No-task session (greeting-only, interruption, bare acknowledgement): no goal
  // to complete, so the judge scores it low on goalCompletion as a pure scoring
  // artifact. Exclude it from the satisfaction cohort (ENG-168, ENG-830) — same
  // skip-and-return-null treatment as sub-threshold and in-flight sessions.
  //
  // Gated on hasAssistantTurn: a no-task session that produced NO assistant turn
  // crashed, and a crash is a genuine reliability failure that must still be
  // flagged below — the cohort exclusion must never swallow it.
  //
  // Placed BEFORE the already-scored early return so a session scored back when
  // it was still in the cohort gets that stale score retracted rather than
  // keeping it forever (scoring skips it from now on, so nothing would ever
  // overwrite it).
  if (isNoTaskSession(session.messages, session.pageIdentifier) && hasAssistantTurn(session.messages)) {
    await retractSatisfactionScore(session);
    return skip("no-task-session");
  }

  // A genuinely-withheld scheduled publish gate (ENG-995): pull it out of the
  // judged cohort rather than leave a divergent satisfaction score on it — see
  // isPublishGateWithheldSession. Placed BEFORE the already-scored early return,
  // same reasoning as isNoTaskSession above, so an existing divergent score is
  // retracted rather than kept forever.
  if (isPublishGateWithheldSession(session)) {
    await retractSatisfactionScore(session);
    return skip("publish-gate-withheld");
  }

  // ENG-1165: same neutral EXCLUDED state for the general satisfaction score.
  // The skip reason keeps the platform-gap cohort countable in reporting
  // without charging it to the agent's headline metric. Test-run ordering:
  // the isTestScheduledSession check below (ENG-499) already sits above the
  // already-scored return but below this block — move the test-run check
  // above so a Test: QA block report counts as a test run, not a gap.
  if (isTestScheduledSession(session)) {
    return skip("test-run");
  }
  if (isBlockedExternalSessionForSession(session) && hasAssistantTurn(session.messages)) {
    await retractSatisfactionScore(session);
    return skip("blocked-external");
  }

  // Skip if already scored, up-to-date, and has dimensional scores.
  // ENG-1296: same force escape hatch as scoreSessionWithJudgeIfNeeded above —
  // without it, a session already scored under a pre-fix rubric never
  // regresses evaluatedMessageIndex, so it stays "up to date" and skipped
  // forever, and a rubric/prompt fix can never retroactively correct it.
  if (
    !opts?.force &&
    session.satisfactionScore &&
    session.satisfactionScore.evaluatedMessageIndex >= messageCount &&
    session.satisfactionScore.dimensions
  ) {
    return skip("already-scored");
  }

  // Manual "Test this schedule" runs are interactive QA actions, not production
  // scheduled executions — the user triggers them and watches the outcome live,
  // and they are excluded from durable recovery/requeue by design. A crashed test
  // must not be scored/surfaced as a satisfaction reliability failure (ENG-499),
  // so drop it from the cohort like greeting-only sessions.
  if (isTestScheduledSession(session)) {
    return skip("test-run");
  }

  // Abandoned run recovered by the reconciler/backstop (ENG-764): the transcript ends
  // on a run-failure placeholder, so the process died mid-flight and never emitted its
  // final summary. Score it as a deterministic failed run rather than feeding the
  // (placeholder-stripped) truncated transcript to the LLM judge, which would mis-score
  // it low for a "transcript that cuts off after a tool call". The reconciler already
  // left the placeholder note, so surfaceFailedRun would be a no-op — skip it. Still
  // deferred within the grace window in case the reconciler's resume/retry is racing
  // to continue the same session (ENG-479).
  let result: ScoringResult;
  if (endsWithRunFailurePlaceholder(session.messages)) {
    if (classifyTurnlessSession(session) === "in-flight") {
      return skip("in-flight");
    }
    result = buildFailedRunResult(messageCount);
  } else if (!hasAssistantTurn(session.messages)) {
    // No assistant turn yet: skip if still in-flight, flag as failed if stale.
    if (classifyTurnlessSession(session) === "in-flight") {
      return skip("in-flight");
    }
    // Convert the silent dead session into a visible failed run (user-facing
    // retry note + diagnostic error) before recording the deterministic score.
    await surfaceFailedRun(session);
    result = buildFailedRunResult(messageCount);
  } else if (transcriptEndsMidToolLoop(session.messages)) {
    // Partial tool-loop persisted (tool result or pure tool-call turn is last).
    // Defer if still within the grace window; score the partial transcript if stale.
    if (classifyTurnlessSession(session) === "in-flight") {
      return skip("in-flight");
    }
    result = await scoreSession(session.messages || [], messageCount, session.pageIdentifier, session.sessionType, {
      userId: session.userId,
      sessionId: session.sessionId,
    });
  } else {
    result = await scoreSession(session.messages || [], messageCount, session.pageIdentifier, session.sessionType, {
      userId: session.userId,
      sessionId: session.sessionId,
    });
  }

  // Backstop for zero-task phrasings the static lists cannot enumerate: the
  // judge itself reported that the user never asked for anything, so the
  // session is outside the cohort. Fails open — only an explicit `false`
  // reaches here (see NO_TASK_JUDGMENT_CLAUSE).
  if (result.taskRequested === false) {
    await retractSatisfactionScore(session);
    return skip("no-task-session");
  }

  const satisfactionScore: ChatSession["satisfactionScore"] = {
    score: result.score,
    reason: result.reason,
    evaluatedAt: new Date().toISOString(),
    evaluatedMessageIndex: result.evaluatedMessageIndex,
    ...(result.dimensions ? { dimensions: result.dimensions } : {}),
    ...(result.transcriptTruncated ? { transcriptTruncated: true } : {}),
  };

  // Persist to DB. A null return means an admin override landed on this row
  // between the read above and this write (ENG-1332) — nothing was persisted,
  // so report no score rather than claiming one that isn't actually stored.
  const persisted = await chatbotDb.updateSessionSatisfactionScore(
    session.sessionId,
    satisfactionScore
  );
  if (!persisted) {
    return skip("admin-override");
  }

  return { score: satisfactionScore };
}

/**
 * Score-only view of {@link attemptSessionScore} for callers that do not need
 * the skip reason.
 */
export async function scoreSessionIfNeeded(
  session: ChatSession,
  opts?: { force?: boolean }
): Promise<ChatSession["satisfactionScore"] | null> {
  return (await attemptSessionScore(session, opts)).score;
}
