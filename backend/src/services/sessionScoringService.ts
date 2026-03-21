import { chatbotDb, ChatSession } from "./chatbotService";

const SCORING_MODEL = "gemini-3.1-flash-lite-preview";

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

Respond with ONLY valid JSON: {"score": <1-5>, "reason": "<brief explanation>"}`;

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

export async function scoreSession(
  messages: Array<{ role: string; content: string }>,
  currentMessageCount: number
): Promise<{ score: number; reason: string; evaluatedMessageIndex: number }> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SCORING);
  const conversationText = recentMessages
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n");

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
      max_completion_tokens: 200,
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
  messages: Array<{ role: string; content: string }>,
  currentMessageCount: number,
  judge: ScoringJudge
): Promise<{ score: number; reason: string; evaluatedMessageIndex: number }> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SCORING);
  const conversationText = recentMessages
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n");

  const { agentModeService } = await import("./agentModeService");

  const llmPromise = agentModeService.callLLM(
    SCORING_MODEL,
    [
      { role: "system", content: judge.systemPrompt },
      { role: "user", content: `Evaluate this conversation:\n\n${conversationText}` },
    ],
    {
      temperature: 0,
      max_completion_tokens: 200,
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
  };
}

export async function scoreSessionWithJudgeIfNeeded(
  session: ChatSession,
  judge: ScoringJudge
): Promise<NonNullable<ChatSession["judgeScores"]>[string] | null> {
  const messageCount = session.messageCount ?? session.messages?.length ?? 0;

  // Skip if already scored by this judge and up-to-date
  const existingJudgeScore = session.judgeScores?.[judge.id];
  if (existingJudgeScore && existingJudgeScore.evaluatedMessageIndex >= messageCount) {
    return null;
  }

  const userMessages = (session.messages || []).filter((m: any) => m.role === "user");
  if (userMessages.length < MIN_USER_MESSAGES) {
    return null;
  }

  const simplifiedMessages = (session.messages || [])
    .filter((m: any) => m.role === "user" || m.role === "assistant")
    .map((m: any) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

  const result = await scoreSessionWithJudge(simplifiedMessages, messageCount, judge);

  const judgeScore = {
    score: result.score,
    reason: result.reason,
    evaluatedAt: new Date().toISOString(),
    evaluatedMessageIndex: result.evaluatedMessageIndex,
    judgeName: judge.name,
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

  // Skip if already scored and up-to-date
  if (
    session.satisfactionScore &&
    session.satisfactionScore.evaluatedMessageIndex >= messageCount
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

  // Filter to role + content only
  const simplifiedMessages = (session.messages || [])
    .filter((m: any) => m.role === "user" || m.role === "assistant")
    .map((m: any) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
    }));

  const result = await scoreSession(simplifiedMessages, messageCount);

  const satisfactionScore: ChatSession["satisfactionScore"] = {
    score: result.score,
    reason: result.reason,
    evaluatedAt: new Date().toISOString(),
    evaluatedMessageIndex: result.evaluatedMessageIndex,
  };

  // Persist to DB
  await chatbotDb.updateSessionSatisfactionScore(
    session.sessionId,
    satisfactionScore
  );

  return satisfactionScore;
}
