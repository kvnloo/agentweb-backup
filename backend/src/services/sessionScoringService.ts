import { chatbotDb, ChatSession } from "./chatbotService";

const SCORING_MODEL = "gemini-3.1-flash-lite-preview";

const SCORING_SYSTEM_PROMPT = `You are an expert at evaluating user satisfaction in AI chat sessions.
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

Respond with ONLY valid JSON: {"score": <1-5>, "reason": "<brief explanation>"}`;

const MAX_MESSAGES_FOR_SCORING = 50;
const MIN_USER_MESSAGES = 1;
const SCORING_TIMEOUT_MS = 20000; // 20 seconds per session

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

  const llmPromise = agentModeService.callLLM(
    SCORING_MODEL,
    [
      { role: "system", content: SCORING_SYSTEM_PROMPT },
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
