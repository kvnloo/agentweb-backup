import { chatbotDb, ChatSession, ChatMessage } from "./chatbotService";

const SCORING_MODEL = "gemini-3.1-flash-lite";

// Token budget for the JSON scoring response. Must be generous enough for
// "thinking" models (e.g. gemini-3.5-flash) whose internal reasoning consumes
// the completion budget before the JSON is emitted — too low a cap causes
// finish_reason=length with truncated/empty JSON. Non-thinking models still
// stop after ~80 tokens, so a high cap adds no cost for them.
const SCORING_MAX_COMPLETION_TOKENS = 2000;

const MAX_TOOL_CONTENT_FOR_SCORING = 500; // chars per tool result in scoring context

/**
 * Serialize session messages into a readable conversation transcript for scoring.
 * Includes user, assistant, and tool messages. For assistant messages that only
 * contain tool calls (empty content), synthesizes a "[called tools: ...]" line so
 * the judge can see that tools were actually invoked rather than treating the turn
 * as a silent/empty response.
 */
function serializeMessagesForScoring(messages: ChatMessage[]): string {
  const lines: string[] = [];

  for (const m of messages) {
    if (m.role === "system") continue;

    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      lines.push(`user: ${text}`);

    } else if (m.role === "assistant") {
      const text = (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).trim();
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
      const raw = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      const preview = raw.length > MAX_TOOL_CONTENT_FOR_SCORING
        ? raw.slice(0, MAX_TOOL_CONTENT_FOR_SCORING) + "…"
        : raw;
      lines.push(`tool result (${name}): ${preview}`);
    }
  }

  return lines.join("\n");
}

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

Respond with ONLY valid JSON:
{"score": <1-5>, "reason": "<brief explanation>", "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}}`;

const MAX_MESSAGES_FOR_SCORING = 50;
const MIN_USER_MESSAGES = 1;

/**
 * Standalone greetings / pleasantries that carry no task or question. Kept
 * deliberately small and exact-match — a greeting-only session is excluded from
 * satisfaction scoring (ENG-168), so this set biases toward NOT matching: any
 * substantive user turn falls through and the session is scored normally.
 * Values are the normalized form produced by `normalizeForGreeting` (lowercased,
 * punctuation/emoji stripped, whitespace collapsed).
 */
const GREETING_PHRASES = new Set<string>([
  "hi", "hii", "hiii", "hiya", "high", "hey", "heya", "heyy", "hello", "helo",
  "hullo", "hey there", "hi there", "hello there", "hey emma", "hi emma",
  "hello emma", "yo", "sup", "wassup", "whats up", "whatsup", "howdy",
  "greetings", "hola", "gm", "good morning", "good afternoon", "good evening",
  "good day", "morning", "afternoon", "evening",
]);

/**
 * Normalize a user message for greeting matching: lowercase, drop everything
 * that is not a letter/digit/space (punctuation, emoji), then collapse runs of
 * whitespace. E.g. "Hi 👋" → "hi", "Good morning!" → "good morning".
 */
function normalizeForGreeting(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a session is greeting-only / no-goal-stated: the user exchanged
 * pleasantries but never stated a task or asked a question. Such sessions have
 * no goal to complete, so the LLM judge scores goalCompletion low (≈3/5) purely
 * as a scoring artifact — dragging the satisfaction cohort down with no
 * actionable fault (ENG-168). We treat them like the existing skip cases
 * (sub-threshold / in-flight sessions) and exclude them from scoring.
 *
 * Conservative by design: EVERY user turn must normalize to a recognized
 * greeting for the session to qualify. Any substantive turn — a request, a
 * question, or any text not in `GREETING_PHRASES` — returns false so the
 * session is scored normally. Erring toward scoring avoids silently hiding a
 * genuinely unsatisfied session.
 */
export function isGreetingOnlySession(messages: ChatMessage[] = []): boolean {
  const userTexts = (messages || [])
    .filter((m: any) => m.role === "user")
    .map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")));

  if (userTexts.length === 0) return false;

  let sawGreeting = false;
  for (const raw of userTexts) {
    const norm = normalizeForGreeting(raw);
    if (norm === "") continue; // non-substantive (e.g. emoji-only) — not a goal
    if (!GREETING_PHRASES.has(norm)) return false; // substantive content → scorable
    sawGreeting = true;
  }
  return sawGreeting;
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
    const text = (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")).trim();
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
    const text = (typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "")).trim();
    const toolCalls = last.metadata?.toolCalls;
    if (!text && Array.isArray(toolCalls) && toolCalls.length > 0) return true;
  }

  return false;
}

const FAILED_RUN_REASON =
  "Session produced no assistant response — it appears to have crashed or timed out before completing. Flagged as a failed run.";

/**
 * Deterministic failure score for a session that stalled before producing any
 * assistant output. There is nothing to send to the LLM judge, so we score it
 * 1/5 across all dimensions directly with an explanatory reason.
 */
function buildFailedRunResult(messageCount: number): ScoringResult {
  return {
    score: 1,
    reason: FAILED_RUN_REASON,
    evaluatedMessageIndex: messageCount,
    dimensions: { goalCompletion: 1, dataAccuracy: 1, outputQuality: 1 },
  };
}
const SCORING_TIMEOUT_MS = 20000; // 20 seconds per session

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

type ScoringResult = {
  score: number;
  reason: string;
  evaluatedMessageIndex: number;
  dimensions?: { goalCompletion: number; dataAccuracy: number; outputQuality: number };
};

function parseDimensions(raw: any): ScoringResult["dimensions"] | undefined {
  const d = raw?.dimensions;
  if (!d || typeof d !== "object") return undefined;
  const clamp = (v: any) => Math.max(1, Math.min(5, Math.round(Number(v))));
  if (!d.goalCompletion || !d.dataAccuracy || !d.outputQuality) return undefined;
  return {
    goalCompletion: clamp(d.goalCompletion),
    dataAccuracy: clamp(d.dataAccuracy),
    outputQuality: clamp(d.outputQuality),
  };
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
  const baseConversationText = serializeMessagesForScoring(recentMessages);
  const header = getSessionTypeHeader(pageIdentifier, sessionType);
  const conversationText = header
    ? `${header}\n\n${baseConversationText}`
    : baseConversationText;

  // Lazy-import to avoid pulling heavy dependencies at module load time
  const { agentModeService } = await import("./agentModeService");
  const systemPrompt = await getDefaultScoringPrompt();
  const model = await getDefaultScoringModel();

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
    }
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Scoring LLM call timed out")), SCORING_TIMEOUT_MS)
  );

  const res = await Promise.race([llmPromise, timeoutPromise]);

  const raw = res.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  const score = Math.max(1, Math.min(5, Math.round(parsed.score)));

  return {
    score,
    reason: parsed.reason || "No reason provided",
    evaluatedMessageIndex: currentMessageCount,
    dimensions: parseDimensions(parsed),
  };
}

export interface ScoringJudge {
  id: string;
  name: string;
  systemPrompt: string;
  llmModel?: string;
  createdAt: string;
  updatedAt: string;
}

export async function scoreSessionWithJudge(
  messages: ChatMessage[],
  currentMessageCount: number,
  judge: ScoringJudge,
  sessionType?: string,
  usageContext?: { userId?: string; feature?: string; sessionId?: string }
): Promise<ScoringResult> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SCORING);
  const baseConversationText = serializeMessagesForScoring(recentMessages);
  const header = getSessionTypeHeader(undefined, sessionType);
  const conversationText = header
    ? `${header}\n\n${baseConversationText}`
    : baseConversationText;

  const { agentModeService } = await import("./agentModeService");

  const llmPromise = agentModeService.callLLM(
    judge.llmModel || SCORING_MODEL,
    [
      { role: "system", content: judge.systemPrompt },
      { role: "user", content: `Evaluate this conversation:\n\n${conversationText}` },
    ],
    {
      temperature: 0,
      max_completion_tokens: SCORING_MAX_COMPLETION_TOKENS,
      response_format: { type: "json_object" },
      usageContext: { ...usageContext, feature: usageContext?.feature || "agent_task" },
    }
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Scoring LLM call timed out")), SCORING_TIMEOUT_MS)
  );

  const res = await Promise.race([llmPromise, timeoutPromise]);

  const raw = res.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);
  const score = Math.max(1, Math.min(5, Math.round(parsed.score)));

  return {
    score,
    reason: parsed.reason || "No reason provided",
    evaluatedMessageIndex: currentMessageCount,
    dimensions: parseDimensions(parsed),
  };
}

export async function scoreSessionWithJudgeIfNeeded(
  session: ChatSession,
  judge: ScoringJudge
): Promise<NonNullable<ChatSession["judgeScores"]>[string] | null> {
  const messageCount = session.messageCount ?? session.messages?.length ?? 0;

  // Skip if already scored by this judge, up-to-date, and has dimensional scores
  const existingJudgeScore = session.judgeScores?.[judge.id];
  if (existingJudgeScore && existingJudgeScore.evaluatedMessageIndex >= messageCount && existingJudgeScore.dimensions) {
    return null;
  }

  const userMessages = (session.messages || []).filter((m: any) => m.role === "user");
  if (userMessages.length < MIN_USER_MESSAGES) {
    return null;
  }

  // Greeting-only / no-goal-stated session: no goal to complete, so the judge
  // scores it low on goalCompletion as a pure scoring artifact. Exclude it from
  // the satisfaction cohort (ENG-168) — same skip-and-return-null treatment as
  // sub-threshold and in-flight sessions.
  if (isGreetingOnlySession(session.messages)) {
    return null;
  }

  // No assistant turn yet: skip if still in-flight, flag as failed if stale.
  let result: ScoringResult;
  if (!hasAssistantTurn(session.messages)) {
    if (classifyTurnlessSession(session) === "in-flight") {
      return null;
    }
    result = buildFailedRunResult(messageCount);
  } else if (transcriptEndsMidToolLoop(session.messages)) {
    if (classifyTurnlessSession(session) === "in-flight") {
      return null;
    }
    result = await scoreSessionWithJudge(session.messages || [], messageCount, judge, session.sessionType, {
      userId: session.userId,
      sessionId: session.sessionId,
    });
  } else {
    result = await scoreSessionWithJudge(session.messages || [], messageCount, judge, session.sessionType, {
      userId: session.userId,
      sessionId: session.sessionId,
    });
  }

  const judgeScore = {
    score: result.score,
    reason: result.reason,
    evaluatedAt: new Date().toISOString(),
    evaluatedMessageIndex: result.evaluatedMessageIndex,
    judgeName: judge.name,
    ...(result.dimensions ? { dimensions: result.dimensions } : {}),
  };

  await chatbotDb.updateSessionJudgeScore(session.sessionId, judge.id, judgeScore);

  return judgeScore;
}

export async function scoreSessionIfNeeded(
  session: ChatSession
): Promise<ChatSession["satisfactionScore"] | null> {
  // Skip if admin has overridden the score
  if (session.satisfactionScore?.adminOverride) {
    return null;
  }

  const messageCount = session.messageCount ?? session.messages?.length ?? 0;

  // Skip if already scored, up-to-date, and has dimensional scores
  if (
    session.satisfactionScore &&
    session.satisfactionScore.evaluatedMessageIndex >= messageCount &&
    session.satisfactionScore.dimensions
  ) {
    return null;
  }

  // Count user messages
  const userMessages = (session.messages || []).filter(
    (m: any) => m.role === "user"
  );
  if (userMessages.length < MIN_USER_MESSAGES) {
    return null;
  }

  // Greeting-only / no-goal-stated session: no goal to complete, so the judge
  // scores it low on goalCompletion as a pure scoring artifact. Exclude it from
  // the satisfaction cohort (ENG-168) — same skip-and-return-null treatment as
  // sub-threshold and in-flight sessions.
  if (isGreetingOnlySession(session.messages)) {
    return null;
  }

  // No assistant turn yet: skip if still in-flight, flag as failed if stale.
  let result: ScoringResult;
  if (!hasAssistantTurn(session.messages)) {
    if (classifyTurnlessSession(session) === "in-flight") {
      return null;
    }
    result = buildFailedRunResult(messageCount);
  } else if (transcriptEndsMidToolLoop(session.messages)) {
    // Partial tool-loop persisted (tool result or pure tool-call turn is last).
    // Defer if still within the grace window; score the partial transcript if stale.
    if (classifyTurnlessSession(session) === "in-flight") {
      return null;
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

  const satisfactionScore: ChatSession["satisfactionScore"] = {
    score: result.score,
    reason: result.reason,
    evaluatedAt: new Date().toISOString(),
    evaluatedMessageIndex: result.evaluatedMessageIndex,
    ...(result.dimensions ? { dimensions: result.dimensions } : {}),
  };

  // Persist to DB
  await chatbotDb.updateSessionSatisfactionScore(
    session.sessionId,
    satisfactionScore
  );

  return satisfactionScore;
}
