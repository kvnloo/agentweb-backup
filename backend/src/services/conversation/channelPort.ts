/**
 * Transport-agnostic conversation channel port (ENG-272).
 *
 * AgentWeb's customer conversation surface was Slack-only: transport, identity
 * resolution, session creation and response delivery all lived inline in
 * `routes/slack.ts`. Supporting Microsoft Teams as a second channel means the
 * product logic (session titling, GTM tracking, iShare links, error recovery)
 * has to stop being Slack-shaped.
 *
 * This is the seam. `sessionResponder.ts` owns the transport-neutral core;
 * each transport supplies an adapter that knows how to address a thread, post
 * into it, and fetch its attachments.
 */

export type ChannelTransport = 'slack' | 'teams';

/**
 * Opaque address of one conversation thread.
 *
 * slack: conversationId = channel id, threadId = the thread ROOT ts (threadTs ?? ts)
 * teams: conversationId = conversation id, threadId = root activity id
 */
export interface ConversationRef {
  transport: ChannelTransport;
  conversationId: string;
  threadId: string;
}

/** A transport-native inbound file descriptor, opaque to the core. */
export type InboundAttachment = any;

/** An attachment after it has been fetched and persisted to our own storage. */
export interface ResolvedAttachment {
  url: string;
  filename: string;
  size?: number;
  mimetype: string;
}

/** Follow-up links offered after a response is delivered. */
export interface ContextLinks {
  ishareLink?: string | null;
  gtmTrackerLink?: string | null;
}

export interface ConversationChannelAdapter {
  readonly transport: ChannelTransport;

  /**
   * Bind the session to this thread so later replies resume it.
   *
   * Implementations own their own persisted shape — Slack keeps its historical
   * `slackThread` field and `slack_thread_*` settings key untouched.
   */
  persistThreadBinding(ref: ConversationRef, sessionId: string, userId: string): Promise<void>;

  /** Post a placeholder while the response is generated. Null when unsupported/failed. */


  /** Post the assistant's reply into the thread. */
  postReply(ref: ConversationRef, text: string): Promise<void>;

  /** Post the follow-up links block. No-op when there is nothing to link. */
  postContextLinks(ref: ConversationRef, links: ContextLinks): Promise<void>;

  /** Fetch inbound files and persist them, skipping any that fail. */
  fetchAttachments(files: InboundAttachment[] | undefined, userId: string): Promise<ResolvedAttachment[]>;

  /** Render an agent response into this transport's text format. */
  renderOutbound(response: any): string;

  /** Build the portal deep link for a GTM work item. */
  gtmTrackerLink(planId: string, phaseId: string, isAdminChannel?: boolean): string;
}
