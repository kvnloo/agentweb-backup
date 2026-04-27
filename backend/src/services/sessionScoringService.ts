import { chatbotDb, ChatSession, ChatMessage } from "./chatbotService";

const SCORING_MODEL = "gemini-3.1-flash-lite-preview";

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

In addition to the overall score, rate three specific dimensions (1-5 each):
- goalCompletion: Did the assistant fully accomplish what the user asked? Did the user get what they came for?
- dataAccuracy: Did the output contain plausible, consistent, and factually coherent data? Penalize hallucinated facts, made-up numbers, or self-contradictions.
- outputQuality: Was the output well-structured, specific, and actionable? Penalize vague, generic, or poorly formatted responses.

Respond with ONLY valid JSON:
{"score": <1-5>, "reason": "<brief explanation>", "dimensions": {"goalCompletion": <1-5>, "dataAccuracy": <1-5>, "outputQuality": <1-5>}}`;

const MAX_MESSAGES_FOR_SCORING = 50;
const MIN_USER_MESSAGES = 1;
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

export async function scoreSession(
  messages: ChatMessage[],
  currentMessageCount: number
): Promise<ScoringResult> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SCORING);
  const conversationText = serializeMessagesForScoring(recentMessages);

  // Lazy-import to avoid pulling heavy dependencies at module load time
  const { agentModeService } = await import("./agentModeService");
  const systemPrompt = await getDefaultScoringPrompt();

  const llmPromise = agentModeService.callLLM(
    SCORING_MODEL,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Evaluate this conversation:\n\n${conversationText}` },
    ],
    {
      temperature: 0,
      max_completion_tokens: 300,
      response_format: { type: "json_object" },
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
  createdAt: string;
  updatedAt: string;
}

export async function scoreSessionWithJudge(
  messages: ChatMessage[],
  currentMessageCount: number,
  judge: ScoringJudge
): Promise<ScoringResult> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SCORING);
  const conversationText = serializeMessagesForScoring(recentMessages);

  const { agentModeService } = await import("./agentModeService");

  const llmPromise = agentModeService.callLLM(
    SCORING_MODEL,
    [
      { role: "system", content: judge.systemPrompt },
      { role: "user", content: `Evaluate this conversation:\n\n${conversationText}` },
    ],
    {
      temperature: 0,
      max_completion_tokens: 300,
      response_format: { type: "json_object" },
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

  const result = await scoreSessionWithJudge(session.messages || [], messageCount, judge);

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

  const result = await scoreSession(session.messages || [], messageCount);

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
