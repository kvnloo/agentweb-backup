/**
 * Onboarding ad-image → ChatSession mirror.
 *
 * The onboarding ad-image step generates 3 variants via a direct
 * `imageService.generateImage` call. The /images tab and the heart/X
 * favorite-image / archive-image endpoints, however, only know about
 * task-execution shapes and chat-session shapes — they don't read
 * `User.adImageResult.variants[]`. So onboarding-generated images were
 * invisible to /images and Emma had no way to act on them.
 *
 * This module bridges that gap by mirroring each completed ad-image
 * generation into a hidden `portalType: 'agent'` ChatSession owned by
 * the user. We synthesize ONE assistant message whose
 * `metadata.toolCalls` contains 3 entries that look exactly like Emma
 * called `generate_image` 3 times — because to the rest of the system,
 * that's effectively what happened. `scanMessagesForAssets` (in
 * routes/tasks.ts) picks the URLs up automatically, /images renders
 * them, and the existing favorite-image / archive-image endpoints
 * already understand the `<sessionId>-images` executionId pattern, so
 * heart and X writes route to `session.favorites` /
 * `session.archives` with zero changes to the rate / archive code.
 *
 * Idempotency: we store the resolved chat session id on the user row
 * (`adImageChatSessionId`) so re-runs (e.g. user regenerates all
 * variants) re-use the same session. New variants are appended as an
 * additional assistant message — the message scanner naturally
 * deduplicates by URL via its `seenUrls` set.
 */
import { ChatbotDB, ChatMessage } from "./chatbotService";
import { v4 as uuidv4 } from "uuid";

export interface OnboardingAdVariantForMirror {
  id: string;
  imageUrl: string;
  prompt?: string;
}

/**
 * Write the just-generated ad-image variants into the user's mirror
 * chat session. Best-effort — failure here must NOT block the
 * onboarding cascade, so callers should `.catch` and log.
 *
 * Returns the sessionId (existing or newly created). The caller is
 * responsible for persisting the returned sessionId onto the User row
 * (`adImageChatSessionId` field) so subsequent runs can reuse it; we
 * deliberately don't write to userDb here so the caller can fold the
 * sessionId into its existing single-write `adImageReadyPatch`.
 */
export async function mirrorOnboardingAdImagesToChatSession(
  userId: string,
  variants: OnboardingAdVariantForMirror[],
  deps: { chatbotDb?: ChatbotDB; existingSessionId?: string } = {}
): Promise<string> {
  if (!userId || variants.length === 0) {
    throw new Error(
      "mirrorOnboardingAdImagesToChatSession: userId + non-empty variants required"
    );
  }

  const chatbotDb = deps.chatbotDb ?? new ChatbotDB();

  // Resolve the mirror sessionId — reuse if it already exists, else
  // create a fresh hidden agent session.
  let sessionId: string | undefined = deps.existingSessionId;
  if (sessionId) {
    const existing = await chatbotDb.getChatSession(sessionId);
    if (!existing) {
      // Caller-supplied id points at a session that no longer exists
      // (e.g. dev table reset). Drop it and create a fresh one below.
      sessionId = undefined;
    }
  }

  if (!sessionId) {
    const created = await chatbotDb.createChatSession(
      userId,
      undefined,
      "agent",
      "onboarding-ad-image",
      undefined,
      undefined,
      undefined,
      undefined,
      "image-generation"
    );
    sessionId = created.sessionId;
    // NOTE: caller is responsible for persisting adImageChatSessionId
    // back onto the User row. We return the id and let the caller fold
    // it into the same userDb.updateUser call that writes
    // adImageReadyPatch — keeps the success write atomic / single-call.
  }

  const timestamp = new Date().toISOString();
  const toolCalls = variants.map((v) => ({
    id: `onboarding-${v.id}-${uuidv4()}`,
    name: "generate_image" as const,
    arguments: { prompt: v.prompt ?? "" },
    result: {
      success: true,
      imageUrl: v.imageUrl,
      filename: `onboarding-${v.id}.png`,
    },
  }));

  const assistantMessage: ChatMessage = {
    role: "assistant",
    content: `Generated ${variants.length} ad image variant${variants.length === 1 ? "" : "s"} during onboarding.`,
    timestamp,
    tool_calls: toolCalls,
    metadata: {
      timestamp,
      portalType: "agent",
      toolCalls,
    },
  };

  await chatbotDb.addMessageToSession(sessionId, assistantMessage);
  return sessionId;
}
