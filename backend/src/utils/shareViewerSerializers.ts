/**
 * ENG-2645 — what a share-link viewer (someone who is NOT the session owner) receives.
 *
 * Two public views read a session:
 *   - the read-only link `/share/:id` (portal `pages/ShareConversation.tsx`), unauthenticated;
 *   - the conversable link `/ishare/:id?conversable=<token>` (and the `/plan/*` pages), which render
 *     the portal `AgentMode` page and are authorized only by the token in the URL.
 *
 * Both used to receive the session record nearly as stored: the stored system prompt (row 0, ~100 KB),
 * every assistant row's provider fields (`reasoning`, `reasoning_details`, `usage`, `refusal`), the owner's
 * whole authorized skills catalog, the owner's `supportNote` (the admin's internal note about the account,
 * set via PUT /admin/users/:userId/support-note), the Slack thread, and `interactiveShareMetadata` — whose
 * `token` is the conversable credential, so a read-only viewer could upgrade themselves to driving Emma on
 * the owner's account.
 *
 * The rule here: a viewer gets exactly the fields its page reads, nothing else. Everything is an
 * allowlist, so a field added to the stored record later stays private until someone adds it here on
 * purpose. These functions only SHAPE a response: the stored session (system prompt included) is never
 * modified, and generation keeps reading it server-side.
 *
 * Input messages are expected to have gone through `filterMessagesForClient(..., { omitBranchOrigin: true })`
 * first (tool rows, admin-tainted turns and owner-only metadata already removed).
 */

type Row = Record<string, unknown>;

function pickPresent(source: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------
// Read-only share (/share/:id) — portal pages/ShareConversation.tsx
// ---------------------------------------------------------------------------------------------------

/**
 * Message metadata ShareConversation reads: `timestamp` (row key), `toolCalls` (tool badges, task and
 * work-plan cards), `citations` (Sources), `attachments`, `pendingApprovalDeckId` (the live deck card).
 */
export const READ_ONLY_SHARE_MESSAGE_METADATA_KEYS = [
  'timestamp',
  'toolCalls',
  'citations',
  'attachments',
  'pendingApprovalDeckId',
] as const;

/**
 * `role:'user'` rows the SERVER wrote as the next turn's instruction (generateSessionResponse's
 * `userMessageKind`): the media auto-continuation directive and the approval-inbox resume. Nobody typed
 * them; ShareConversation has no notion of `kind` and would render their internal instruction text as a
 * customer bubble, so the read-only view leaves them out.
 */
export const SERVER_AUTHORED_USER_KINDS: readonly string[] = ['auto-continuation', 'approval-inbox-resolution'];

const isServerAuthoredUserRow = (m: Row): boolean =>
  m.role === 'user' && isObject(m.metadata) && typeof m.metadata.kind === 'string' && SERVER_AUTHORED_USER_KINDS.includes(m.metadata.kind);

/**
 * Rows for the read-only share page. The page renders nothing for a `system` row, so system rows (the
 * stored system prompt, internal markers, telemetry records) are dropped outright, as are server-authored
 * user rows (above); the rest keep `role`, `content` and the metadata above.
 */
export function toReadOnlyShareMessages(messages: unknown): Row[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m): m is Row => isObject(m) && (m.role === 'user' || m.role === 'assistant') && !isServerAuthoredUserRow(m))
    .map((m) => {
      const row: Row = { role: m.role, content: m.content };
      if (isObject(m.metadata)) row.metadata = pickPresent(m.metadata, READ_ONLY_SHARE_MESSAGE_METADATA_KEYS);
      return row;
    });
}

/** Session fields ShareConversation reads (`sessionId` is the id already in the link). */
export function buildReadOnlyShareSession(input: {
  sessionId: string;
  title?: string;
  messages: unknown;
  workPlan?: unknown;
  pendingApprovalDeck?: unknown;
}): Row {
  return {
    sessionId: input.sessionId,
    title: input.title,
    messages: toReadOnlyShareMessages(input.messages),
    workPlan: input.workPlan,
    pendingApprovalDeck: input.pendingApprovalDeck,
  };
}

// ---------------------------------------------------------------------------------------------------
// Conversable share (/ishare/:id?conversable=…, /plan/*) — portal pages/AgentMode.tsx
// ---------------------------------------------------------------------------------------------------

/**
 * Top-level message fields the AgentMode chat reads: `llm` + `modelCorrection` (the model footer),
 * `messageIndex` (feedback target, row key), `clientId` (row key; useAgentModeChat's saved-message check).
 * Everything else at this level — `reasoning`, `reasoning_details`, `usage`, `refusal`, `tool_calls`,
 * `name`, the top-level `timestamp` — is provider/internal data no viewer page reads.
 */
export const CONVERSABLE_SHARE_MESSAGE_FIELDS = ['llm', 'modelCorrection', 'messageIndex', 'clientId'] as const;

/**
 * Message metadata the AgentMode chat (ChatMessageItem, AgentMode.tsx, lib/workPlanStepModel.ts) and the
 * landing-page status poll read. Keys it never reads (`ishareSender` — another anonymous visitor's IP and
 * user agent —, `crmEvidence`, `currentUrl`, `systemPromptVersion`, RAG chunk counts, …) are not sent.
 */
export const CONVERSABLE_SHARE_MESSAGE_METADATA_KEYS = [
  'timestamp',
  'toolCalls',
  'attachments',
  'citations',
  'kind',
  'suggestedReplies',
  'feedback',
  'pendingApprovalDeckId',
  'approvalDeckItems',
  'approvalDeckAnswer',
  'approvalDeckCancelled',
  'awaitingUserConfirmation',
  'isErrorMessage',
  'isRunFailureNotice',
  // kind 'work-plan-step-model-unavailable' (lib/workPlanStepModel.ts isStepModelPaused)
  'stepCount',
  'model',
] as const;

/**
 * A system row the chat DOES render: a successful image/video upload (ChatMessageItem's
 * hasUploadedImage / hasUploadedVideo). Every other system row renders nothing.
 */
function isRenderedSystemRow(m: Row): boolean {
  const toolCalls = isObject(m.metadata) ? m.metadata.toolCalls : undefined;
  return Array.isArray(toolCalls) && toolCalls.some((tc: unknown) =>
    isObject(tc) && (tc.name === 'upload_image' || tc.name === 'upload_video') && isObject(tc.result) && !!tc.result.success,
  );
}

/**
 * A system row that renders nothing is kept as an empty placeholder rather than dropped: AgentMode counts
 * rows (`messages.length > 1`, the empty-chat state, the last-message checks) and keys them by
 * `messageIndex`, so removing rows would change what the page shows. The placeholder keeps the row's
 * position and the markers a reader checks — `kind`, and `isErrorMessage`, which the landing-page
 * status poll reads on any row — and drops the content (the system prompt, telemetry text, …).
 */
const SYSTEM_PLACEHOLDER_METADATA_KEYS = ['timestamp', 'kind', 'isErrorMessage'] as const;

/**
 * Content prefix of the "first attempt failed, a retry follows" telemetry row (agentModeController's
 * fire-and-forget retry path writes it as role:'system' with `isErrorMessage: true` for the server-side loop
 * sensor). It is NOT a failure of the run: the landing-page status poll marks a session failed on any row
 * with `isErrorMessage`, so a viewer's placeholder for this row must not carry the flag while the retry runs.
 */
export const FIRST_ATTEMPT_TELEMETRY_PREFIX = '[telemetry] First-attempt agent failure';

const isFirstAttemptTelemetryRow = (m: Row): boolean =>
  typeof m.content === 'string' && m.content.startsWith(FIRST_ATTEMPT_TELEMETRY_PREFIX);

/** MessageFeedbackButtons reads `type` (and the comment/timestamp it shows); `userId` is the rater's id. */
const FEEDBACK_KEYS = ['type', 'comment', 'timestamp'] as const;

function narrowFeedback(feedback: unknown): Row | undefined {
  return isObject(feedback) ? pickPresent(feedback, FEEDBACK_KEYS) : undefined;
}

function toConversableRow(m: Row): Row {
  const row: Row = { role: m.role, content: m.content, ...pickPresent(m, CONVERSABLE_SHARE_MESSAGE_FIELDS) };
  if (isObject(m.metadata)) {
    const metadata = pickPresent(m.metadata, CONVERSABLE_SHARE_MESSAGE_METADATA_KEYS);
    if ('feedback' in metadata) {
      const feedback = narrowFeedback(metadata.feedback);
      if (feedback) metadata.feedback = feedback; else delete metadata.feedback;
    }
    row.metadata = metadata;
  }
  return row;
}

export function toConversableShareMessages(messages: unknown): Row[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter(isObject).map((m) => {
    if (m.role !== 'system' || isRenderedSystemRow(m)) return toConversableRow(m);
    const placeholder: Row = { role: 'system', content: '', ...pickPresent(m, ['messageIndex', 'clientId']) };
    if (isObject(m.metadata)) {
      const metadata = pickPresent(m.metadata, SYSTEM_PLACEHOLDER_METADATA_KEYS);
      if (isFirstAttemptTelemetryRow(m)) delete metadata.isErrorMessage;
      placeholder.metadata = metadata;
    }
    return placeholder;
  });
}

export interface DisplaySkill {
  skillId: string;
  name: string;
  description: string;
  installed: boolean;
  toolNames: string[];
}

/**
 * Skills for the conversable chat's Skills popover: only the skills installed in THIS session (the ones
 * the viewer's chat can actually use), never the owner's wider catalog (every skill the owner's plan
 * allows, their private / org skills, the "Other Skills" tool list when not installed), and never the
 * admin bundle — an interactive-share turn cannot run admin tools at all. Fields: what SkillInfo reads.
 */
export function narrowSkillsForShareViewer(skills: unknown, adminSkillId: string): DisplaySkill[] {
  if (!Array.isArray(skills)) return [];
  return skills
    .filter((s): s is Row => isObject(s) && s.installed === true && s.skillId !== adminSkillId)
    .map((s) => ({
      skillId: s.skillId as string,
      name: s.name as string,
      description: s.description as string,
      installed: true,
      toolNames: Array.isArray(s.toolNames) ? (s.toolNames as string[]) : [],
    }));
}

/**
 * Session fields the conversable AgentMode page (useAgentModeSessions' conversable loaders) and the
 * landing-page status poll read. Not sent: `supportNote` (the admin's internal note about the account; the
 * ishare header falls back to "You're chatting with Emma in a shared conversation" without it),
 * `shareMetadata` / `interactiveShareMetadata` (only the owner's Share dialog reads them, unreachable on
 * these routes) and `isConversable` (never read).
 */
export function buildConversableShareSession(input: {
  sessionId: string;
  title?: string;
  messages: unknown;
  createdAt?: string;
  updatedAt?: string;
  workPlan?: unknown;
  llmModel?: string;
  hasActiveProgress?: boolean;
  slackThread?: unknown;
  skills?: DisplaySkill[];
  pendingWorkPlanInput?: unknown;
  pendingApprovalDeck?: unknown;
}): Row {
  return {
    sessionId: input.sessionId,
    title: input.title,
    messages: toConversableShareMessages(input.messages),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    workPlan: input.workPlan,
    llmModel: input.llmModel,
    hasActiveProgress: input.hasActiveProgress,
    // The ishare header's "View in Slack" link.
    slackThread: input.slackThread,
    skills: input.skills ?? [],
    pendingWorkPlanInput: input.pendingWorkPlanInput,
    pendingApprovalDeck: input.pendingApprovalDeck,
  };
}

/**
 * The ishare feedback endpoint answers with the rated message. The portal (MessageFeedbackButtons) reads
 * only `success` and `message.metadata.feedback`; the raw row would also carry the assistant's reasoning
 * and usage — and the endpoint takes a raw row index, so it could return rows the viewer's chat hides.
 */
export function toIShareFeedbackResponse(updatedMessage: unknown): Row {
  const feedback = isObject(updatedMessage) && isObject(updatedMessage.metadata) ? narrowFeedback(updatedMessage.metadata.feedback) : undefined;
  return { success: true, message: { metadata: feedback === undefined ? {} : { feedback } } };
}
