import { scheduleDb, userDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { agentModeService } from '../services/agentModeService';
import { v4 as uuidv4 } from 'uuid';

const INSTANCE_ID = uuidv4();
const COMMENT_MODEL = 'gemini-3.1-flash-lite';

const POST_COMMENT_SYSTEM_PROMPT = `You are writing a LinkedIn comment on behalf of a real person. Write exactly as a human would — natural, specific, and personal to the post content.

Rules:
- Reference something specific from the post (a number, an idea, a phrase) — do not comment on the post in general terms
- Make a statement, share a reaction, or add a brief related thought — do NOT ask questions
- Keep it 1-3 sentences — shorter is often better
- Never start with "Great", "Love", "Wow", "Absolutely", "Totally", "Insightful", "Fascinating", or any generic opener
- No hashtags, no emojis unless the post itself is casual
- Do not say "Thanks for sharing" or "This is so important" or anything a bot would say
- Sound like you read the post, not like you scanned it
Return ONLY the comment text, no quotes, no explanation.`;

const COMMENT_REPLY_SYSTEM_PROMPT = `You are writing a LinkedIn reply on behalf of a real person. Write exactly as a human would — direct, warm, and specific to what was said.

Rules:
- Respond to something specific in the comment — a word, a claim, a question
- Keep it 1-2 sentences, conversational in tone
- Never start with "Absolutely", "Great point", "Totally agree", "So true", or any filler opener
- No hashtags, no "Thanks for sharing"
- It's fine to disagree gently, add nuance, or just connect briefly — whatever fits naturally
- Make a statement or add a thought — do NOT ask questions back
- Sound like a colleague continuing a conversation, not an assistant acknowledging a ticket
Return ONLY the reply text, no quotes, no explanation.`;

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

        if (!postId || !platform || !engagingAccountId) {
            console.warn(`[Executor] Skipping invalid action ${scheduleId}: missing required fields.`);
            await this.markActionDone(scheduleId);
            return;
        }

        const engagingOwnerId = userId;

        const engagingUser = await userDb.getUserById(engagingOwnerId);
        if (!engagingUser || !engagingUser.connected_accounts) {
            console.warn(`[Executor] Engaging user ${engagingOwnerId} not found or has no connected accounts.`);
            await this.markActionDone(scheduleId);
            return;
        }

        const engagingConnection = engagingUser.connected_accounts.find(
            (c: ConnectedAccount) => c.account_id === engagingAccountId && c.platform === platform
        );

        if (!engagingConnection) {
            console.warn(`[Executor] Engaging account ${engagingAccountId} not found for user ${engagingOwnerId}.`);
            await this.markActionDone(scheduleId);
            return;
        }

        console.log(`[Executor] Engaging as: "${engagingConnection.account_name}" (${engagingAccountId})`);

        // Re-validate the action against the current config — the user may have changed
        // settings after this action was scheduled.
        const engagerSettings = engagingConnection.engagementSettings || {};
        if (targetType === 'comment' && engagerSettings.commentPreferredActions) {
            // comment auto-reply: engager IS the post owner, check commentPreferredActions
            const commentPrefs: string[] = engagerSettings.commentPreferredActions;
            const requiresReply = actionType === 'reply_comment' || actionType === 'like_and_reply_comment';
            const requiresLike = actionType === 'like_comment' || actionType === 'like_and_reply_comment';
            const replyRevoked = requiresReply && !commentPrefs.includes('reply');
            const likeRevoked = requiresLike && !requiresReply && !commentPrefs.includes('like');
            if (replyRevoked || likeRevoked) {
                console.log(`[Executor] Skipping ${actionType} on ${scheduleId}: action no longer permitted by current commentPreferredActions=${JSON.stringify(commentPrefs)}`);
                await this.markActionDone(scheduleId);
                return;
            }
        } else if (targetType !== 'comment' && engagerSettings.preferredActions) {
            // post engagement: check engager's preferredActions
            const postPrefs: string[] = engagerSettings.preferredActions;
            if (actionType === 'comment' && !postPrefs.includes('comment')) {
                console.log(`[Executor] Skipping ${actionType} on ${scheduleId}: action no longer permitted by current preferredActions=${JSON.stringify(postPrefs)}`);
                await this.markActionDone(scheduleId);
                return;
            }
        }

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
                    adapter, engagingConnection, engagingOwnerId, postId, commentId, commentText, actionType, engagerMemory, engagerPersonality
                );
            } else {
                // Default: post engagement
                generated = await this.executePostAction(
                    adapter, engagingConnection, engagingOwnerId, ownerAccountId, userId, postId, actionType, engagerMemory, engagerPersonality
                );
            }
            success = true;
            console.log(`[Executor] Action ${scheduleId} completed successfully.`);
        } catch (err: any) {
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

    // ────────────────────────────────────────────────────────────────────────────
    // POST ENGAGEMENT
    // ────────────────────────────────────────────────────────────────────────────

    private async executePostAction(
        adapter: LinkedInAdapter,
        engagingConnection: ConnectedAccount,
        engagingUserId: string,
        ownerAccountId: string | undefined,
        ownerUserId: string,
        postId: string,
        actionType: string,
        engagerMemory?: string,
        engagerPersonality?: { presets: string[]; custom?: string }
    ): Promise<{ generatedText?: string; reactionType?: string }> {
        const doLike = actionType === 'like' || actionType === 'comment_and_like';
        const doComment = actionType === 'comment' || actionType === 'comment_and_like';

        // Fetch post content and owner context once — used for both comment generation and reaction selection
        const { content: postContent, ownerConnection } = await this.fetchPostContext(adapter, engagingConnection, engagingUserId, ownerAccountId, ownerUserId, postId);
        const ownerContext = ownerConnection
            ? { name: ownerConnection.account_name, memory: ownerConnection.engagementMemory?.content }
            : undefined;

        let generatedText: string | undefined;
        let reactionType: string | undefined;

        if (doComment) {
            if (!postContent) {
                console.warn(`[Executor] Skipping comment on ${postId}: post content could not be fetched.`);
            } else {
                // Real-time dedup: check if this account already commented on the post
                const alreadyCommented = await this.hasAccountCommented(adapter, engagingConnection, engagingUserId, postId);
                if (alreadyCommented) {
                    console.log(`[Executor] Account ${engagingConnection.account_id} already commented on ${postId}, skipping comment.`);
                } else {
                    const recentComments = await socialEngagementTrackingDb.getRecentGeneratedTexts(engagingConnection.account_id, 10);
                    generatedText = await this.generatePostComment(postContent, engagerMemory, engagerPersonality, ownerContext, recentComments);
                    console.log(`[Executor] Generated comment: "${generatedText.slice(0, 100)}..."`);
                    await adapter.createComment(engagingConnection, postId, generatedText, engagingUserId);
                    console.log(`[Executor] Comment posted on post ${postId}`);
                }
            }
        }

        if (doLike) {
            try {
                reactionType = await this.generateReactionType(postContent || '');
                await adapter.createReaction(engagingConnection, postId, reactionType, engagingUserId);
                console.log(`[Executor] Reacted "${reactionType}" on post ${postId}`);
            } catch (likeErr: any) {
                if (doComment) {
                    // Like is secondary in comment_and_like — comment already succeeded.
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
        engagingConnection: ConnectedAccount,
        engagingUserId: string,
        ownerAccountId: string | undefined,
        ownerUserId: string,
        postId: string
    ): Promise<{ content: string | null; ownerConnection?: ConnectedAccount }> {
        let ownerConnection: ConnectedAccount | undefined;
        try {
            // Prefer fetching via the owner's account (has direct DB/API access to the post)
            let fetchConnection = engagingConnection;
            let fetchUserId = engagingUserId;
            if (ownerAccountId && ownerAccountId !== engagingConnection.account_id) {
                const ownerUser = await userDb.getUserById(ownerUserId);
                const ownerConn = ownerUser?.connected_accounts?.find(
                    (c: ConnectedAccount) => c.account_id === ownerAccountId
                );
                if (ownerConn) {
                    fetchConnection = ownerConn;
                    fetchUserId = ownerUserId;
                    ownerConnection = ownerConn;
                }
            }

            const content = await adapter.getPost(fetchConnection, postId, fetchUserId);
            if (content) return { content, ownerConnection };
        } catch (err) {
            console.warn(`[Executor] Could not fetch post content for ${postId}:`, err);
        }
        return { content: null, ownerConnection };
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

    private async generatePostComment(postContent: string, engagerMemory?: string, personality?: { presets: string[]; custom?: string }, ownerContext?: { name?: string; memory?: string }, recentComments?: string[]): Promise<string> {
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
                temperature: 0.9,
            });
            const text = completion.choices[0]?.message?.content?.trim();
            if (text) return text;
        } catch (err) {
            console.warn(`[Executor] LLM comment generation failed:`, err);
        }
        const fallbacks = [
            'Hadn\'t considered it from this angle before. Makes sense though.',
            'Worth bookmarking. A lot of people overlook this.',
            'This resonates — the same pattern keeps showing up in a lot of places.',
            'The numbers here tell a story that\'s easy to miss at first glance.',
            'This is something more people should be paying attention to.',
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
    }

    private async generateReactionType(content: string): Promise<LinkedInReaction> {
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
        engagingConnection: ConnectedAccount,
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
            } else {
                const recentComments = await socialEngagementTrackingDb.getRecentGeneratedTexts(engagingConnection.account_id, 10);
                generatedText = await this.generateCommentReply(commentText || '', engagerMemory, engagerPersonality, recentComments);
                console.log(`[Executor] Generated reply: "${generatedText.slice(0, 100)}..."`);
                await adapter.createComment(engagingConnection, postId, generatedText, engagingUserId, commentId);
                console.log(`[Executor] Reply posted on comment ${commentId}`);
            }
        }

        if (doLike) {
            try {
                reactionType = await this.generateReactionType(commentText || '');
                await adapter.createReaction(engagingConnection, commentId, reactionType, engagingUserId);
                console.log(`[Executor] Reacted "${reactionType}" on comment ${commentId}`);
            } catch (likeErr: any) {
                if (doReply) {
                    // Like is secondary in like_and_reply_comment — reply already succeeded.
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

    private async generateCommentReply(commentText: string, engagerMemory?: string, personality?: { presets: string[]; custom?: string }, recentComments?: string[]): Promise<string> {
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
                temperature: 0.9,
            });
            const text = completion.choices[0]?.message?.content?.trim();
            if (text) return text;
        } catch (err) {
            console.warn(`[Executor] LLM reply generation failed:`, err);
        }
        const fallbacks = [
            'Interesting point — I hadn\'t thought about it that way.',
            'Fair. That tracks with what I\'ve seen too.',
            'Yeah, this keeps coming up. Worth paying attention to.',
            'Good call. More people should be thinking about this.',
        ];
        return fallbacks[Math.floor(Math.random() * fallbacks.length)];
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
        setTimeout(() => this.scheduleUpcoming(), 1000);
        setInterval(() => this.scheduleUpcoming(), TIMER_CHECK_INTERVAL_MS);
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
                    this.executor.processQueue()
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
