import { scheduleDb, userDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { agentModeService } from '../services/agentModeService';
import { meterUsageFromResponse } from '../utils/llmClients';
import { v4 as uuidv4 } from 'uuid';
import { isCronEnabled } from '../utils/instanceState';
import { cronJobRegistry } from '../utils/cronJobRegistry';

const INSTANCE_ID = uuidv4();
// gemini-3.5-flash follows the "no questions / no generic openers" instructions far more
// reliably than the previous flash-lite model, which produced jargon-stuffed, templated comments.
const COMMENT_MODEL = 'gemini-3.5-flash';
// Lowered from 0.9 — high temperature on a weak prompt produced rambling, homogeneous output.
const COMMENT_TEMPERATURE = 0.7;
// Posts whose fetched text is shorter than this are treated as "no content": commenting on them
// makes the model ask for the post text ("Please provide the post content…"), which then got
// posted verbatim. Skip the comment instead.
const MIN_POST_CONTENT_LENGTH = 20;

const POST_COMMENT_SYSTEM_PROMPT = `You are writing a LinkedIn comment on behalf of a real person. Write exactly as a human would — natural, specific, and personal to the post content.

Rules:
- Reference something specific from the post (a number, an idea, a phrase) — do not comment on the post in general terms
- Make a statement, share a reaction, or add a brief related thought — do NOT ask questions. Never end with a question.
- Keep it 1-2 sentences and under 50 words — shorter is almost always better
- Never start with "Great", "Love", "Wow", "Absolutely", "Totally", "Insightful", "Fascinating", "The shift", "Moving beyond", "Transitioning from", "This shift", "The transition", "Scaling", or any generic or templated opener
- Write in plain, conversational language. Do NOT stack corporate buzzwords (e.g. "agentic workflows", "operational debt", "data governance", "scalable infrastructure", "observability", "circuit breakers", "go-to-market", "enterprise ROI"). At most one such term, only if it's truly relevant.
- No hashtags, no emojis unless the post itself is casual
- Do not say "Thanks for sharing" or "This is so important" or anything a bot would say
- Sound like you read the post, not like you scanned it
- NEVER ask for the post text, mention that content is missing, refer to "the post content", reference your persona, or explain what you are doing. If you cannot write a specific comment, the only allowed output is the single word: SKIP
Return ONLY the comment text, no quotes, no preamble, no explanation.`;

const COMMENT_REPLY_SYSTEM_PROMPT = `You are writing a LinkedIn reply on behalf of a real person. Write exactly as a human would — direct, warm, and specific to what was said.

Rules:
- Respond to something specific in the comment — a word, a claim, a question
- Keep it 1-2 sentences, conversational in tone
- Never start with "Absolutely", "Great point", "Totally agree", "So true", "The shift", "Moving beyond", or any filler opener
- No hashtags, no "Thanks for sharing", no "Thank you for the kind words"
- Write in plain language. Do NOT stack corporate buzzwords or sound like a press release.
- It's fine to disagree gently, add nuance, or just connect briefly — whatever fits naturally
- Make a statement or add a thought — do NOT ask questions back. Never end with a question.
- Sound like a colleague continuing a conversation, not an assistant acknowledging a ticket
- NEVER ask for the post or comment text, mention that content is missing, reference your persona, or explain what you are doing. If you cannot write a specific reply, the only allowed output is the single word: SKIP
Return ONLY the reply text, no quotes, no preamble, no explanation.`;

/**
 * Phrases that indicate the LLM returned a refusal / meta-instruction / preamble instead of
 * an actual comment. These were being posted verbatim to LinkedIn (e.g. "Please provide the
 * text of the LinkedIn post so I can tailor the critique…"). Any match means the output is junk.
 */
const REFUSAL_PATTERNS: RegExp[] = [
    /provide (the|your|me with the|specific|more) /i,
    /please (share|provide|paste)/i,
    /share (it|the post|the text|the content)/i,
    /(i will|i'?ll|i can|i'?d) (craft|tailor|write|create|provide|be happy)/i,
    /so (i|that i) can (tailor|craft|respond|write|provide)/i,
    /here('?s| is) (a|my|the) (versatile|professional|generic|general|following)/i,
    /since you (didn'?t|did not|haven'?t|have not) provide/i,
    /you (didn'?t|did not|haven'?t|have not) provided?/i,
    /\bas an? (ai|language model)\b/i,
    /\blanguage model\b/i,
    /\bmy persona\b/i,
    /fits? (my|the) persona/i,
    /aligns? with .{0,60}(perspective|persona)/i,
    /no (post )?content (was )?(provided|available|given)/i,
    /\[no content/i,
    /^skip\.?$/i,
];

/**
 * Cleans and validates an LLM-generated comment/reply before it is posted.
 * - Strips wrapping quotes/backticks.
 * - Salvages the real comment when the model prefixes a meta-preamble ending in a colon
 *   (e.g. "…here is a versatile comment: <actual comment>").
 * - Returns null if the result is empty or still looks like a refusal/meta response, so the
 *   caller can skip posting rather than publish junk to LinkedIn.
 */
export function sanitizeGeneratedComment(raw?: string | null): string | null {
    if (!raw) return null;
    let text = raw.trim().replace(/^["'`“”]+|["'`“”]+$/g, '').trim();

    // Salvage the comment when the model leads with a meta-preamble that introduces it via a colon.
    const colonIdx = text.indexOf(':');
    if (colonIdx > 0 && colonIdx < 240) {
        const prefix = text.slice(0, colonIdx).toLowerCase();
        if (/(provide|versatile|suitable|here is|here'?s|otherwise|professional comment|general comment|following comment)/.test(prefix)
            && /(comment|response|reply|here)/.test(prefix)) {
            const after = text.slice(colonIdx + 1).trim().replace(/^["'`“”]+|["'`“”]+$/g, '').trim();
            if (after.length >= 15) text = after;
        }
    }

    if (text.length < 3) return null;
    for (const re of REFUSAL_PATTERNS) {
        if (re.test(text)) return null;
    }
    return text;
}

const REACTION_SYSTEM_PROMPT = `You are a LinkedIn engagement assistant. Based on the content provided, choose the single most appropriate LinkedIn reaction.
Reply with EXACTLY one of these values (no other text):
- LIKE      → general positive content, news, updates
- PRAISE    → achievements, milestones, congratulations, launches
- EMPATHY   → support, struggles, challenges, mental health, loss
- INTEREST  → insights, data, learning, thought-provoking ideas
- APPRECIATION → gratitude, teamwork, community, support
- ENTERTAINMENT → funny, humorous, lighthearted content`;

type LinkedInReaction = 'LIKE' | 'PRAISE' | 'EMPATHY' | 'INTEREST' | 'APPRECIATION' | 'ENTERTAINMENT';
const VALID_REACTIONS: LinkedInReaction[] = ['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT'];

type EngagementSettings = {
    enablePostDiscovery?: boolean;
    enableAsPostEngager?: boolean;
    preferredActions?: string[];
    enableCommentDiscovery?: boolean;
    commentPreferredActions?: string[];
    personality?: { presets: string[]; custom?: string };
};

type EngagementConnection = ConnectedAccount & {
    engagementSettings?: EngagementSettings;
};

type ScheduledActionAuthorizationInput = {
    userId: string;
    platform: string;
    ownerAccountId: string;
    engagingAccountId: string;
    actionType: string;
    targetType: string;
};

type AuthorizedScheduledAction = {
    engagingConnection: EngagementConnection;
    ownerConnection: EngagementConnection;
};

class ScheduledActionAuthorizationRevoked extends Error {
    constructor() {
        super('Scheduled social engagement action is no longer authorized');
        this.name = 'ScheduledActionAuthorizationRevoked';
    }
}

const POST_ACTION_REQUIREMENTS: Record<string, string[]> = {
    like: ['like'],
    comment: ['comment'],
    comment_and_like: ['comment', 'like'],
};

const COMMENT_ACTION_REQUIREMENTS: Record<string, string[]> = {
    like_comment: ['like'],
    reply_comment: ['reply'],
    like_and_reply_comment: ['like', 'reply'],
};

function includesAllActions(
    preferredActions: unknown,
    requiredActions: string[],
    defaultActions: string[]
): boolean {
    // These defaults deliberately mirror the scanner. Nullish legacy arrays mean
    // "use the product default"; an explicit empty/malformed value is an opt-out
    // and must fail closed.
    const actions = preferredActions == null
        ? defaultActions
        : Array.isArray(preferredActions) ? preferredActions : [];
    return requiredActions.every(action => actions.includes(action));
}

function getLinkedInAdapter(): LinkedInAdapter {
    return new LinkedInAdapter();
}

/**
 * Processes all due social engagement actions from the scheduleDb queue.
 * Executes directly via LinkedIn adapter + optional LLM for comment generation.
 * No Emma / runScheduledChat involved.
 */
export class SocialEngagementExecutor {
    private isProcessing = false;

    public async processQueue(): Promise<boolean> {
        if (this.isProcessing) {
            console.log('[SocialEngagementExecutor] Already processing, skipping concurrent run.');
            return false;
        }
        this.isProcessing = true;
        console.log('[SocialEngagementExecutor] Checking for due engagements...');
        try {
            const now = new Date().toISOString();
            const actions = await scheduleDb.getSocialEngagementActionsUpTo(now);

            if (actions.length === 0) {
                console.log('[SocialEngagementExecutor] No engagements due.');
                return true;
            }

            console.log(`[SocialEngagementExecutor] ${actions.length} engagement(s) to process.`);

            for (const action of actions) {
                try {
                    await this.processAction(action);
                } catch (error) {
                    console.error(`[SocialEngagementExecutor] Failed to process action ${action.scheduleId}:`, error);
                }
                // 4-second pause between actions to avoid LinkedIn per-minute burst throttling
                await new Promise(resolve => setTimeout(resolve, 4000));
            }
        } catch (error) {
            console.error('[SocialEngagementExecutor] Critical error:', error);
            return false;
        } finally {
            this.isProcessing = false;
        }
        return true;
    }

    private async processAction(action: any) {
        const { userId, variableValues, scheduleId } = action;
        const { postId, commentId, commentText, platform, ownerAccountId, engagingAccountId, actionType, targetType } = variableValues || {};

        console.log(`\n[Executor] ════ Processing action ${scheduleId} ════`);
        console.log(`[Executor] Action: ${actionType} | Target: ${targetType || 'post'} | Platform: ${platform}`);

        // Atomically claim this action — prevents duplicate execution across instances
        const claimed = await scheduleDb.claimAction(scheduleId, INSTANCE_ID);
        if (!claimed) {
            console.log(`[Executor] Action ${scheduleId} already claimed by another instance, skipping.`);
            return;
        }

        if (!postId || !platform || !ownerAccountId || !engagingAccountId || !actionType || !targetType) {
            console.warn(`[Executor] Skipping invalid action ${scheduleId}: missing required fields.`);
            await this.markActionDone(scheduleId);
            return;
        }

        const authorizationInput: ScheduledActionAuthorizationInput = {
            userId,
            platform,
            ownerAccountId,
            engagingAccountId,
            actionType,
            targetType,
        };
        const authorizedAction = await this.getAuthorizedScheduledAction(authorizationInput);
        if (!authorizedAction) {
            // A schedule is only a delayed intent. Current account state and consent are
            // the authority to perform the LinkedIn write, so fail closed when either
            // has changed since scheduling.
            console.log(`[Executor] Skipping ${actionType} on ${scheduleId}: action is no longer authorized by current account settings.`);
            await this.discardUnauthorizedAction(scheduleId, authorizationInput, postId, commentId);
            return;
        }

        const { engagingConnection, ownerConnection } = authorizedAction;
        const engagingOwnerId = userId;

        console.log(`[Executor] Engaging as: "${engagingConnection.account_name}" (${engagingAccountId})`);

        // Load engagement memory and personality for personalized comments
        const engagerMemory = engagingConnection.engagementMemory?.content || '';
        const engagerPersonality = engagingConnection.engagementSettings?.personality;

        const adapter = getLinkedInAdapter();
        let success = false;
        let errorMsg: string | undefined;

        let retryable = false;
        let generated: { generatedText?: string; reactionType?: string } = {};
        try {
            if (targetType === 'comment') {
                generated = await this.executeCommentAction(
                    adapter, authorizationInput, engagingConnection, engagingOwnerId, postId, commentId, commentText, actionType, engagerMemory, engagerPersonality
                );
            } else {
                generated = await this.executePostAction(
                    adapter, authorizationInput, engagingConnection, ownerConnection, engagingOwnerId, postId, actionType, engagerMemory, engagerPersonality
                );
            }
            success = true;
            console.log(`[Executor] Action ${scheduleId} completed successfully.`);
        } catch (err: any) {
            if (err instanceof ScheduledActionAuthorizationRevoked) {
                console.log(`[Executor] Skipping ${actionType} on ${scheduleId}: action was revoked before its LinkedIn write.`);
                await this.discardUnauthorizedAction(scheduleId, authorizationInput, postId, commentId);
                return;
            }
            errorMsg = err?.message || String(err);
            console.error(`[Executor] Action ${scheduleId} failed:`, errorMsg);
            // Rate limit is transient — retry in 30 minutes; all other errors are permanent
            retryable = (err?.response?.status === 429) || (errorMsg?.includes('rate limit') ?? false);
        }

        // Record engagement outcome — postId is always the post URN, commentId for reply actions
        if (postId) {
            try {
                await socialEngagementTrackingDb.recordEngagement({
                        userId,
                        postId,
                        commentId: targetType === 'comment' ? commentId : undefined,
                        platform,
                        ownerAccountId: ownerAccountId || '',
                        engagingAccountId,
                        actionType,
                        scheduleId,
                        status: success ? 'completed' : 'failed',
                        executedAt: new Date().toISOString(),
                        generatedText: generated.generatedText,
                        reactionType: generated.reactionType,
                    });
            } catch (trackErr) {
                console.warn(`[Executor] Could not record engagement tracking:`, trackErr);
            }
        }

        if (retryable) {
            // Reschedule 30 minutes from now — don't mark done
            const retryTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
            await scheduleDb.updateSchedule(scheduleId, { nextRunTime: retryTime });
            console.log(`[Executor] Action ${scheduleId} will retry at ${retryTime}`);
        } else {
            await this.markActionDone(scheduleId);
        }
        console.log(`[Executor] ════ Action ${scheduleId} done ════\n`);
    }

    /**
     * A queued action never grants durable permission to use a LinkedIn token.
     * Re-read the primary User record and validate every participant's current
     * settings immediately before executing it. `getUserById` alone is unsafe
     * here because its GSI can briefly return credentials removed by disconnect.
     */
    private async getAuthorizedScheduledAction(
        input: ScheduledActionAuthorizationInput
    ): Promise<AuthorizedScheduledAction | null> {
        if (input.platform !== 'linkedin') return null;

        const user = await userDb.getUserByIdConsistent(input.userId);
        if (!user || user.engagementPaused === true || !Array.isArray(user.connected_accounts)) {
            return null;
        }

        const accounts = user.connected_accounts as EngagementConnection[];
        const engagingConnection = accounts.find(
            account => account.account_id === input.engagingAccountId && account.platform === input.platform
        );
        const engagerSettings = engagingConnection?.engagementSettings;
        if (!engagingConnection || !engagerSettings) return null;

        if (input.targetType === 'post') {
            const requiredActions = POST_ACTION_REQUIREMENTS[input.actionType];
            const ownerConnection = accounts.find(
                account => account.account_id === input.ownerAccountId && account.platform === input.platform
            );
            const ownerSettings = ownerConnection?.engagementSettings;

            if (!requiredActions || !ownerConnection || !ownerSettings) return null;
            if (engagerSettings.enableAsPostEngager !== true || ownerSettings.enablePostDiscovery !== true) {
                return null;
            }
            if (!includesAllActions(engagerSettings.preferredActions, requiredActions, ['like', 'comment'])
                || !includesAllActions(ownerSettings.preferredActions, requiredActions, ['like'])) {
                return null;
            }
            return { engagingConnection, ownerConnection };
        }

        if (input.targetType === 'comment') {
            const requiredActions = COMMENT_ACTION_REQUIREMENTS[input.actionType];
            if (!requiredActions || input.ownerAccountId !== input.engagingAccountId) return null;
            if (engagerSettings.enableCommentDiscovery !== true
                || !includesAllActions(engagerSettings.commentPreferredActions, requiredActions, ['reply'])) {
                return null;
            }
            return { engagingConnection, ownerConnection: engagingConnection };
        }

        return null;
    }

    private async requireAuthorizedScheduledAction(
        input: ScheduledActionAuthorizationInput
    ): Promise<AuthorizedScheduledAction> {
        const authorized = await this.getAuthorizedScheduledAction(input);
        if (!authorized) throw new ScheduledActionAuthorizationRevoked();
        return authorized;
    }

    /**
     * Remove the scanner's provisional tracking reservation when consent is
     * withdrawn before any LinkedIn write. Otherwise a `queued` record would
     * block the same still-recent post forever after the owner re-enables the
     * automation. This is deliberately not called after a partial compound
     * action, where a comment or reply may already have been published.
     */
    private async discardUnauthorizedAction(
        scheduleId: string,
        input: ScheduledActionAuthorizationInput,
        postId: string,
        commentId?: string
    ): Promise<void> {
        try {
            await socialEngagementTrackingDb.deleteEngagement({
                userId: input.userId,
                postId,
                commentId: input.targetType === 'comment' ? commentId : undefined,
                engagingAccountId: input.engagingAccountId,
                actionType: input.actionType,
                scheduleId,
            });
        } catch (error) {
            // The schedule is still terminalized below. A transient cleanup error
            // must never turn revoked consent into a retryable LinkedIn action.
            console.warn(`[Executor] Could not release tracking reservation for revoked action ${scheduleId}:`, error);
        }
        await this.markActionDone(scheduleId);
    }

    // ────────────────────────────────────────────────────────────────────────────
    // POST ENGAGEMENT
    // ────────────────────────────────────────────────────────────────────────────

    private async executePostAction(
        adapter: LinkedInAdapter,
        authorizationInput: ScheduledActionAuthorizationInput,
        engagingConnection: EngagementConnection,
        ownerConnection: EngagementConnection,
        engagingUserId: string,
        postId: string,
        actionType: string,
        engagerMemory?: string,
        engagerPersonality?: { presets: string[]; custom?: string }
    ): Promise<{ generatedText?: string; reactionType?: string }> {
        const doLike = actionType === 'like' || actionType === 'comment_and_like';
        const doComment = actionType === 'comment' || actionType === 'comment_and_like';

        // Fetch post content and owner context once — used for both comment generation and reaction selection
        const { content: postContent } = await this.fetchPostContext(adapter, engagingConnection, ownerConnection, engagingUserId, postId);
        const ownerContext = ownerConnection
            ? { name: ownerConnection.account_name, memory: ownerConnection.engagementMemory?.content }
            : undefined;

        let generatedText: string | undefined;
        let reactionType: string | undefined;

        if (doComment) {
            // Treat whitespace-only or very short content as "no content" — commenting on it makes the
            // model produce a refusal ("Please provide the post content…") that would be posted verbatim.
            if (!postContent || postContent.trim().length < MIN_POST_CONTENT_LENGTH) {
                console.warn(`[Executor] Skipping comment on ${postId}: post content unavailable or too short to comment meaningfully.`);
            } else {
                // Real-time dedup: check if this account already commented on the post
                const alreadyCommented = await this.hasAccountCommented(adapter, engagingConnection, engagingUserId, postId);
                if (alreadyCommented) {
                    console.log(`[Executor] Account ${engagingConnection.account_id} already commented on ${postId}, skipping comment.`);
                } else {
                    const recentComments = await socialEngagementTrackingDb.getRecentGeneratedTexts(engagingConnection.account_id, 10);
                    const comment = await this.generatePostComment(postContent, engagerMemory, engagerPersonality, ownerContext, recentComments, engagingUserId);
                    if (!comment) {
                        console.warn(`[Executor] No usable comment generated for ${postId}, skipping comment.`);
                    } else {
                        generatedText = comment;
                        console.log(`[Executor] Generated comment: "${generatedText.slice(0, 100)}..."`);
                        const current = await this.requireAuthorizedScheduledAction(authorizationInput);
                        await adapter.createComment(current.engagingConnection, postId, generatedText, engagingUserId);
                        console.log(`[Executor] Comment posted on post ${postId}`);
                    }
                }
            }
        }

        if (doLike) {
            try {
                reactionType = await this.generateReactionType(postContent || '', engagingUserId);
                const current = await this.requireAuthorizedScheduledAction(authorizationInput);
                await adapter.createReaction(current.engagingConnection, postId, reactionType, engagingUserId);
                console.log(`[Executor] Reacted "${reactionType}" on post ${postId}`);
            } catch (likeErr: any) {
                if (doComment && generatedText) {
                    // Like is secondary in comment_and_like — the comment already
                    // succeeded, so do not retry and risk posting it twice.
                    // Log and continue so the action is marked completed rather than retried,
                    // which would post a duplicate comment.
                    console.warn(`[Executor] Like sub-action failed (comment already succeeded), continuing:`, likeErr?.message);
                    reactionType = undefined;
                } else {
                    throw likeErr;
                }
            }
        }

        return { generatedText, reactionType };
    }

    private async fetchPostContext(
        adapter: LinkedInAdapter,
        engagingConnection: EngagementConnection,
        ownerConnection: EngagementConnection,
        engagingUserId: string,
        postId: string
    ): Promise<{ content: string | null }> {
        try {
            // Prefer fetching via the owner's account (has direct DB/API access to the post)
            let fetchConnection = engagingConnection;
            let fetchUserId = engagingUserId;
            if (ownerConnection.account_id !== engagingConnection.account_id) {
                fetchConnection = ownerConnection;
                fetchUserId = engagingUserId;
            }

            const content = await adapter.getPost(fetchConnection, postId, fetchUserId);
            if (content) return { content };
        } catch (err) {
            console.warn(`[Executor] Could not fetch post content for ${postId}:`, err);
        }
        return { content: null };
    }

    /**
     * Check if an account has already commented/replied on a post or comment.
     * Fetches real comments from the LinkedIn API as a runtime dedup safety net.
     * Fails open (returns false) if the API call fails, so we don't block legitimate comments.
     */
    private async hasAccountCommented(
        adapter: LinkedInAdapter,
        engagingConnection: ConnectedAccount,
        engagingUserId: string,
        targetUrn: string
    ): Promise<boolean> {
        try {
            const comments = await adapter.getComments(engagingConnection, targetUrn, engagingUserId);
            return comments.some((c) => c.actorUrn === engagingConnection.account_id);
        } catch (err) {
            console.warn(`[Executor] Could not fetch comments for dedup check on ${targetUrn}, assuming already commented to prevent duplicates:`, err);
            return true; // Fail closed — skip commenting when check fails to prevent duplicate posts
        }
    }

    private async generatePostComment(postContent: string, engagerMemory?: string, personality?: { presets: string[]; custom?: string }, ownerContext?: { name?: string; memory?: string }, recentComments?: string[], engagingUserId?: string): Promise<string | null> {
        try {
            let systemPrompt = POST_COMMENT_SYSTEM_PROMPT;
            if (personality?.presets?.length || personality?.custom) {
                const parts: string[] = [];
                if (personality.presets.length) parts.push(`Tone/style: ${personality.presets.join(', ')}`);
                if (personality.custom) parts.push(`Additional guidance: ${personality.custom}`);
                systemPrompt += `\n\nPersonality:\n${parts.join('\n')}`;
            }
            if (engagerMemory) {
                systemPrompt += `\n\nPerson profile (write as this person, matching their voice and interests):\n${engagerMemory}`;
            }
            if (ownerContext?.name || ownerContext?.memory) {
                const parts: string[] = [];
                if (ownerContext.name) parts.push(`Name: ${ownerContext.name}`);
                if (ownerContext.memory) parts.push(ownerContext.memory);
                systemPrompt += `\n\nPost author profile (who wrote the post you are commenting on):\n${parts.join('\n')}`;
            }
            if (recentComments && recentComments.length > 0) {
                systemPrompt += `\n\nDo NOT repeat or closely echo any of these recent comments you've already written. Make sure your new comment is structurally and tonally distinct from all of these:\n${recentComments.map((c, i) => `${i + 1}. "${c}"`).join('\n')}`;
            }
            const geminiClient = await agentModeService.getGeminiClient();
            const completion = await geminiClient.chat.completions.create({
                model: COMMENT_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Post content: ${postContent}` },
                ],
                temperature: COMMENT_TEMPERATURE,
            });
            // Charge automated engagement spend to the account owner's quota — policy:
            // every LLM call with a real userId is billed to that user, nothing absorbed.
            meterUsageFromResponse({
                userId: engagingUserId,
                model: COMMENT_MODEL,
                provider: 'gemini',
                feature: 'social_engagement_comment',
            }, completion);
            const sanitized = sanitizeGeneratedComment(completion.choices[0]?.message?.content);
            if (sanitized) return sanitized;
            console.warn(`[Executor] Generated comment rejected by sanitizer (refusal/meta/empty), skipping comment.`);
        } catch (err) {
            console.warn(`[Executor] LLM comment generation failed:`, err);
        }
        // Return null rather than a canned fallback — a generic bot-like line is worse than no
        // comment. The caller skips posting when generation fails or is rejected.
        return null;
    }

    private async generateReactionType(content: string, engagingUserId?: string): Promise<LinkedInReaction> {
        try {
            const geminiClient = await agentModeService.getGeminiClient();
            const completion = await geminiClient.chat.completions.create({
                model: COMMENT_MODEL,
                messages: [
                    { role: 'system', content: REACTION_SYSTEM_PROMPT },
                    { role: 'user', content: content || '[No content available]' },
                ],
                temperature: 0.1,
            });
            meterUsageFromResponse({
                userId: engagingUserId,
                model: COMMENT_MODEL,
                provider: 'gemini',
                feature: 'social_engagement_reaction',
            }, completion);
            const raw = completion.choices[0]?.message?.content?.trim().toUpperCase() as LinkedInReaction;
            if (VALID_REACTIONS.includes(raw)) return raw;
            console.warn(`[Executor] LLM returned invalid reaction "${raw}", defaulting to LIKE`);
        } catch (err) {
            console.warn(`[Executor] LLM reaction generation failed:`, err);
        }
        return 'LIKE';
    }

    // ────────────────────────────────────────────────────────────────────────────
    // COMMENT ENGAGEMENT
    // ────────────────────────────────────────────────────────────────────────────

    private async executeCommentAction(
        adapter: LinkedInAdapter,
        authorizationInput: ScheduledActionAuthorizationInput,
        engagingConnection: EngagementConnection,
        engagingUserId: string,
        postId: string,
        commentId: string | undefined,
        commentText: string | undefined,
        actionType: string,
        engagerMemory?: string,
        engagerPersonality?: { presets: string[]; custom?: string }
    ): Promise<{ generatedText?: string; reactionType?: string }> {
        if (!commentId) {
            throw new Error('commentId is required for comment engagement actions');
        }

        const doLike = actionType === 'like_comment' || actionType === 'like_and_reply_comment';
        const doReply = actionType === 'reply_comment' || actionType === 'like_and_reply_comment';

        let generatedText: string | undefined;
        let reactionType: string | undefined;

        if (doReply) {
            // Real-time dedup: check if this account already replied to the comment
            const alreadyReplied = await this.hasAccountCommented(adapter, engagingConnection, engagingUserId, commentId);
            if (alreadyReplied) {
                console.log(`[Executor] Account ${engagingConnection.account_id} already replied to ${commentId}, skipping reply.`);
            } else if (!commentText || commentText.trim().length < 3) {
                // Without the comment text the model has nothing to reply to and produces a refusal.
                console.warn(`[Executor] Skipping reply on ${commentId}: original comment text unavailable.`);
            } else {
                const recentComments = await socialEngagementTrackingDb.getRecentGeneratedTexts(engagingConnection.account_id, 10);
                const reply = await this.generateCommentReply(commentText, engagerMemory, engagerPersonality, recentComments, engagingUserId);
                if (!reply) {
                    console.warn(`[Executor] No usable reply generated for ${commentId}, skipping reply.`);
                } else {
                    generatedText = reply;
                    console.log(`[Executor] Generated reply: "${generatedText.slice(0, 100)}..."`);
                    const current = await this.requireAuthorizedScheduledAction(authorizationInput);
                    await adapter.createComment(current.engagingConnection, postId, generatedText, engagingUserId, commentId);
                    console.log(`[Executor] Reply posted on comment ${commentId}`);
                }
            }
        }

        if (doLike) {
            try {
                reactionType = await this.generateReactionType(commentText || '', engagingUserId);
                const current = await this.requireAuthorizedScheduledAction(authorizationInput);
                await adapter.createReaction(current.engagingConnection, commentId, reactionType, engagingUserId);
                console.log(`[Executor] Reacted "${reactionType}" on comment ${commentId}`);
            } catch (likeErr: any) {
                if (doReply && generatedText) {
                    // Like is secondary in like_and_reply_comment — the reply already
                    // succeeded, so do not retry and risk posting it twice.
                    // Log and continue so the action is marked completed rather than retried,
                    // which would post a duplicate reply.
                    console.warn(`[Executor] Like sub-action failed (reply already succeeded), continuing:`, likeErr?.message);
                    reactionType = undefined;
                } else {
                    throw likeErr;
                }
            }
        }

        return { generatedText, reactionType };
    }

    private async generateCommentReply(commentText: string, engagerMemory?: string, personality?: { presets: string[]; custom?: string }, recentComments?: string[], engagingUserId?: string): Promise<string | null> {
        try {
            let systemPrompt = COMMENT_REPLY_SYSTEM_PROMPT;
            if (personality?.presets?.length || personality?.custom) {
                const parts: string[] = [];
                if (personality.presets.length) parts.push(`Tone/style: ${personality.presets.join(', ')}`);
                if (personality.custom) parts.push(`Additional guidance: ${personality.custom}`);
                systemPrompt += `\n\nPersonality:\n${parts.join('\n')}`;
            }
            if (engagerMemory) {
                systemPrompt += `\n\nPerson profile (write as this person, matching their voice and interests):\n${engagerMemory}`;
            }
            if (recentComments && recentComments.length > 0) {
                systemPrompt += `\n\nDo NOT repeat or closely echo any of these recent replies you've already written. Make sure your new reply is structurally and tonally distinct from all of these:\n${recentComments.map((c, i) => `${i + 1}. "${c}"`).join('\n')}`;
            }
            const geminiClient = await agentModeService.getGeminiClient();
            const completion = await geminiClient.chat.completions.create({
                model: COMMENT_MODEL,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: `Comment: ${commentText}` },
                ],
                temperature: COMMENT_TEMPERATURE,
            });
            // Charge automated reply spend to the account owner's quota (all-cost-to-user policy).
            meterUsageFromResponse({
                userId: engagingUserId,
                model: COMMENT_MODEL,
                provider: 'gemini',
                feature: 'social_engagement_reply',
            }, completion);
            const sanitized = sanitizeGeneratedComment(completion.choices[0]?.message?.content);
            if (sanitized) return sanitized;
            console.warn(`[Executor] Generated reply rejected by sanitizer (refusal/meta/empty), skipping reply.`);
        } catch (err) {
            console.warn(`[Executor] LLM reply generation failed:`, err);
        }
        // Return null rather than a canned fallback — skip rather than post a generic bot-like reply.
        return null;
    }

    // ────────────────────────────────────────────────────────────────────────────

    private async markActionDone(scheduleId: string) {
        try {
            const now = new Date().toISOString();
            await scheduleDb.updateScheduleAfterRun(
                scheduleId,
                now,  // lastRunTime = actual execution time
                now,  // nextRunTime = same — status becomes 'paused' which blocks re-pickup,
                      // so this value is never used; set to execution time for clean history
                true
            );
        } catch (error) {
            console.error(`[Executor] Failed to mark action ${scheduleId} as done:`, error);
        }
    }
}

// ────────────────────────────────────────────────────────────────────────────
// TIMER SCHEDULER
// ────────────────────────────────────────────────────────────────────────────

const TIMER_LOOKAHEAD_MS = 30 * 60 * 1000;  // register timers for actions due within 30 min
const TIMER_CHECK_INTERVAL_MS = 30 * 60 * 1000;  // check every 30 min

/**
 * Polls DB every 5 minutes for social engagement actions due within the next 10 minutes
 * and registers a precise setTimeout for each. Replaces the fixed-interval executor poll:
 *
 * - No long-lived timers: only actions within a 10-min rolling window are in memory
 * - Crash recovery built-in: overdue actions (nextRunTime < now) are picked up on the
 *   next 5-min check with delay=0 (fires immediately)
 * - Multi-instance safety: the claimAction guard in the executor prevents duplicate execution
 */
export class SocialEngagementTimerScheduler {
    private pendingTimers = new Set<string>();

    constructor(private executor: SocialEngagementExecutor) {}

    public start() {
        console.log('[TimerScheduler] Starting — first pass in 1s...');
        // Small delay on startup so the executor is fully initialised first
        setTimeout(() => {
            cronJobRegistry.track('SocialEngagementTimerScheduler.scheduleUpcoming', this.scheduleUpcoming());
        }, 1000);
        setInterval(() => {
            if (!isCronEnabled()) return;
            cronJobRegistry.track('SocialEngagementTimerScheduler.scheduleUpcoming', this.scheduleUpcoming());
        }, TIMER_CHECK_INTERVAL_MS);
    }

    private async scheduleUpcoming() {
        try {
            const windowEnd = new Date(Date.now() + TIMER_LOOKAHEAD_MS).toISOString();
            const actions = await scheduleDb.getSocialEngagementActionsUpTo(windowEnd);

            let registered = 0;
            for (const action of actions) {
                const { scheduleId, nextRunTime } = action;
                if (this.pendingTimers.has(scheduleId)) continue;

                const delay = Math.max(0, new Date(nextRunTime).getTime() - Date.now());
                setTimeout(() => {
                    this.pendingTimers.delete(scheduleId);
                    if (!isCronEnabled()) return;
                    cronJobRegistry.track('SocialEngagementExecutor.processQueue', this.executor.processQueue())
                        .catch(e => console.error('[TimerScheduler] processQueue error:', e));
                }, delay);
                this.pendingTimers.add(scheduleId);
                registered++;

                if (delay === 0) {
                    console.log(`[TimerScheduler] Overdue action ${scheduleId} — firing immediately`);
                } else {
                    console.log(`[TimerScheduler] Registered timer for ${scheduleId} — fires in ${Math.round(delay / 1000)}s`);
                }
            }

            if (registered > 0) {
                console.log(`[TimerScheduler] Registered ${registered} new timer(s). Pending: ${this.pendingTimers.size}`);
            }
        } catch (error) {
            console.error('[TimerScheduler] Error during scheduled check:', error);
        }
    }
}
