import { chatbotDb, ChatSession } from "./chatbotService";

const SUMMARY_MODEL = "gemini-3.1-flash-lite";
const MAX_MESSAGES_FOR_SUMMARY = 50;
const MIN_USER_MESSAGES = 1;
const SUMMARY_TIMEOUT_MS = 20000;

const SUMMARY_SYSTEM_PROMPT = `You are an expert at summarizing what was accomplished in AI-assisted work sessions.
Analyze the conversation and write a concise 1-2 sentence summary of what was achieved or attempted.

Focus on:
- Concrete outputs produced (e.g. blog posts written, social media posts created, emails sent, reports generated)
- Actions taken on behalf of the user (e.g. leads researched, content published, outreach performed)
- Goals that were successfully completed vs attempted but not completed

Be specific and factual. Use past tense. Do not mention the AI or assistant — describe outcomes from the user's perspective.
Example: "Created 3 LinkedIn posts for a product launch campaign and published them to the company profile."
Example: "Generated a market research report on SaaS pricing trends and exported it as a PDF."

Respond with ONLY valid JSON: {"summary": "<1-2 sentence summary>"}`;

export async function summarizeSession(
  messages: Array<{ role: string; content: string }>,
  currentMessageCount: number
): Promise<{ summary: string; evaluatedMessageIndex: number }> {
  const recentMessages = messages.slice(-MAX_MESSAGES_FOR_SUMMARY);
  const conversationText = recentMessages
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`)
    .join("\n");

  const { agentModeService } = await import("./agentModeService");

  const llmPromise = agentModeService.callLLM(
    SUMMARY_MODEL,
    [
      { role: "system", content: SUMMARY_SYSTEM_PROMPT },
      { role: "user", content: `Summarize what was achieved in this session:\n\n${conversationText}` },
    ],
    {
      temperature: 0,
      max_completion_tokens: 200,
      response_format: { type: "json_object" },
      taskClass: 'nonstandard_consumer',
    }
  );

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Summary LLM call timed out")), SUMMARY_TIMEOUT_MS)
  );

  const res = await Promise.race([llmPromise, timeoutPromise]);

  const raw = res.choices?.[0]?.message?.content ?? "{}";
  const parsed = JSON.parse(raw);

  return {
    summary: parsed.summary || "Session completed.",
    evaluatedMessageIndex: currentMessageCount,
  };
}

export async function summarizeSessionIfNeeded(
  session: ChatSession
): Promise<NonNullable<ChatSession["sessionSummary"]> | null> {
  const messageCount = session.messageCount ?? session.messages?.length ?? 0;

  // Skip if already summarized and up-to-date
  if (
    session.sessionSummary &&
    session.sessionSummary.evaluatedMessageIndex >= messageCount
  ) {
    return null;
  }

  // Need at least one user message to summarize
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

  const result = await summarizeSession(simplifiedMessages, messageCount);

  const sessionSummary: NonNullable<ChatSession["sessionSummary"]> = {
    summary: result.summary,
    evaluatedAt: new Date().toISOString(),
    evaluatedMessageIndex: result.evaluatedMessageIndex,
  };

  await chatbotDb.updateSessionSummary(session.sessionId, sessionSummary);

  return sessionSummary;
}
