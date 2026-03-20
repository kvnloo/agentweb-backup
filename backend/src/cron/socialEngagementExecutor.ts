import { scheduleDb, userDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { agentModeService } from '../services/agentModeService';

const COMMENT_MODEL = 'gemini-3.1-flash-lite-preview';

const POST_COMMENT_SYSTEM_PROMPT = `You are a professional social media engagement assistant.
Write a thoughtful, genuine 1-2 sentence comment on the following LinkedIn post.
Avoid generic phrases like "Great post!" or "Totally agree!".
Return ONLY the comment text, no quotes or explanation.`;

const COMMENT_REPLY_SYSTEM_PROMPT = `You are a professional social media engagement assistant.
Write a genuine, concise reply to the following comment on a LinkedIn post.
The reply should add value or acknowledge the comment naturally.
Return ONLY the reply text, no quotes or explanation.`;

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
    public async processQueue() {
        console.log('[SocialEngagementExecutor] Checking for due engagements...');
        try {
            const actions = await scheduleDb.getDueSocialEngagementActions();

            if (actions.length === 0) {
                console.log('[SocialEngagementExecutor] No engagements due.');
                return;
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
        }
    }

    private async processAction(action: any) {
        const { userId, variableValues, scheduleId } = action;
        const { postId, commentId, commentText, platform, ownerAccountId, engagingAccountId, actionType, targetType } = variableValues || {};

        console.log(`\n[Executor] ════ Processing action ${scheduleId} ════`);
        console.log(`[Executor] Action: ${actionType} | Target: ${targetType || 'post'} | Platform: ${platform}`);

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

        const adapter = getLinkedInAdapter();
        let success = false;
        let errorMsg: string | undefined;

        let retryable = false;
        let generated: { generatedText?: string; reactionType?: string } = {};
        try {
            if (targetType === 'comment') {
                generated = await this.executeCommentAction(
                    adapter, engagingConnection, engagingOwnerId, postId, commentId, commentText, actionType
                );
            } else {
                // Default: post engagement
                generated = await this.executePostAction(
                    adapter, engagingConnection, engagingOwnerId, ownerAccountId, userId, postId, actionType
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
        actionType: string
    ): Promise<{ generatedText?: string; reactionType?: string }> {
        const doLike = actionType === 'like' || actionType === 'comment_and_like';
        const doComment = actionType === 'comment' || actionType === 'comment_and_like';

        // Fetch post content once — used for both comment generation and reaction selection
        const postContent = await this.fetchPostContent(adapter, engagingConnection, engagingUserId, ownerAccountId, ownerUserId, postId);

        let generatedText: string | undefined;
        let reactionType: string | undefined;

        if (doComment) {
            generatedText = await this.generatePostComment(postContent);
            console.log(`[Executor] Generated comment: "${generatedText.slice(0, 100)}..."`);
            await adapter.createComment(engagingConnection, postId, generatedText, engagingUserId);
            console.log(`[Executor] Comment posted on post ${postId}`);
        }

        if (doLike) {
            reactionType = await this.generateReactionType(postContent);
            await adapter.createReaction(engagingConnection, postId, reactionType, engagingUserId);
            console.log(`[Executor] Reacted "${reactionType}" on post ${postId}`);
        }

        return { generatedText, reactionType };
    }

    private async fetchPostContent(
        adapter: LinkedInAdapter,
        engagingConnection: ConnectedAccount,
        engagingUserId: string,
        ownerAccountId: string | undefined,
        ownerUserId: string,
        postId: string
    ): Promise<string> {
        try {
            // Try to fetch with owner's account if available, otherwise use engager
            let fetchConnection = engagingConnection;
            if (ownerAccountId && ownerAccountId !== engagingConnection.account_id) {
                const ownerUser = await userDb.getUserById(ownerUserId);
                const ownerConn = ownerUser?.connected_accounts?.find(
                    (c: ConnectedAccount) => c.account_id === ownerAccountId
                );
                if (ownerConn) fetchConnection = ownerConn;
            }

            const posts = await adapter.listPosts(fetchConnection, { limit: 20 }, engagingUserId);
            const post = posts.find((p: any) => (p.id || p.urn) === postId);
            if (post) {
                return post.commentary || post.content || post.text || '[No text content]';
            }
        } catch (err) {
            console.warn(`[Executor] Could not fetch post content for ${postId}:`, err);
        }
        return '[Post content unavailable]';
    }

    private async generatePostComment(postContent: string): Promise<string> {
        try {
            const geminiClient = await agentModeService.getGeminiClient();
            const completion = await geminiClient.chat.completions.create({
                model: COMMENT_MODEL,
                messages: [
                    { role: 'system', content: POST_COMMENT_SYSTEM_PROMPT },
                    { role: 'user', content: `Post content: ${postContent}` },
                ],
                temperature: 0.8,
            });
            const text = completion.choices[0]?.message?.content?.trim();
            if (text) return text;
        } catch (err) {
            console.warn(`[Executor] LLM comment generation failed:`, err);
        }
        return 'Great insights! Thanks for sharing.';
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
        actionType: string
    ): Promise<{ generatedText?: string; reactionType?: string }> {
        if (!commentId) {
            throw new Error('commentId is required for comment engagement actions');
        }

        const doLike = actionType === 'like_comment' || actionType === 'like_and_reply_comment';
        const doReply = actionType === 'reply_comment' || actionType === 'like_and_reply_comment';

        let generatedText: string | undefined;
        let reactionType: string | undefined;

        if (doReply) {
            generatedText = await this.generateCommentReply(commentText || '');
            console.log(`[Executor] Generated reply: "${generatedText.slice(0, 100)}..."`);
            await adapter.createComment(engagingConnection, postId, generatedText, engagingUserId, commentId);
            console.log(`[Executor] Reply posted on comment ${commentId}`);
        }

        if (doLike) {
            reactionType = await this.generateReactionType(commentText || '');
            await adapter.createReaction(engagingConnection, commentId, reactionType, engagingUserId);
            console.log(`[Executor] Reacted "${reactionType}" on comment ${commentId}`);
        }

        return { generatedText, reactionType };
    }

    private async generateCommentReply(commentText: string): Promise<string> {
        try {
            const geminiClient = await agentModeService.getGeminiClient();
            const completion = await geminiClient.chat.completions.create({
                model: COMMENT_MODEL,
                messages: [
                    { role: 'system', content: COMMENT_REPLY_SYSTEM_PROMPT },
                    { role: 'user', content: `Comment: ${commentText}` },
                ],
                temperature: 0.8,
            });
            const text = completion.choices[0]?.message?.content?.trim();
            if (text) return text;
        } catch (err) {
            console.warn(`[Executor] LLM reply generation failed:`, err);
        }
        return 'Thank you for your perspective!';
    }

    // ────────────────────────────────────────────────────────────────────────────

    private async markActionDone(scheduleId: string) {
        try {
            await scheduleDb.updateScheduleAfterRun(
                scheduleId,
                new Date().toISOString(),
                new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
                true
            );
        } catch (error) {
            console.error(`[Executor] Failed to mark action ${scheduleId} as done:`, error);
        }
    }
}
