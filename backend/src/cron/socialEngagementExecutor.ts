import { scheduleDb, userDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { agentModeService } from '../services/agentModeService';

const COMMENT_MODEL = 'gemini-2.0-flash';

const POST_COMMENT_SYSTEM_PROMPT = `You are a professional social media engagement assistant.
Write a thoughtful, genuine 1-2 sentence comment on the following LinkedIn post.
Avoid generic phrases like "Great post!" or "Totally agree!".
Return ONLY the comment text, no quotes or explanation.`;

const COMMENT_REPLY_SYSTEM_PROMPT = `You are a professional social media engagement assistant.
Write a genuine, concise reply to the following comment on a LinkedIn post.
The reply should add value or acknowledge the comment naturally.
Return ONLY the reply text, no quotes or explanation.`;

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
            }
        } catch (error) {
            console.error('[SocialEngagementExecutor] Critical error:', error);
        }
    }

    private async processAction(action: any) {
        const { userId, variableValues, scheduleId } = action;
        const { postId, commentId, platform, ownerAccountId, engagingAccountId, engagingUserId, actionType, targetType } = variableValues || {};

        console.log(`\n[Executor] ════ Processing action ${scheduleId} ════`);
        console.log(`[Executor] Action: ${actionType} | Target: ${targetType || 'post'} | Platform: ${platform}`);

        if (!postId || !platform || !engagingAccountId) {
            console.warn(`[Executor] Skipping invalid action ${scheduleId}: missing required fields.`);
            await this.markActionDone(scheduleId);
            return;
        }

        // Resolve which user owns the engaging account
        // engagingUserId is set by the scanner for cross-user engagements; fall back to action.userId
        const engagingOwnerId = engagingUserId || userId;

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

        try {
            if (targetType === 'comment') {
                await this.executeCommentAction(
                    adapter, engagingConnection, engagingOwnerId, postId, commentId, actionType
                );
            } else {
                // Default: post engagement
                await this.executePostAction(
                    adapter, engagingConnection, engagingOwnerId, ownerAccountId, userId, postId, actionType
                );
            }
            success = true;
            console.log(`[Executor] Action ${scheduleId} completed successfully.`);
        } catch (err: any) {
            errorMsg = err?.message || String(err);
            console.error(`[Executor] Action ${scheduleId} failed:`, errorMsg);
        }

        // Record engagement outcome
        const trackingId = targetType === 'comment' ? commentId : postId;
        if (trackingId) {
            try {
                await socialEngagementTrackingDb.recordEngagement({
                    userId,
                    postId: trackingId,
                    platform,
                    ownerAccountId: ownerAccountId || '',
                    engagingAccountId,
                    actionType,
                    scheduleId,
                    status: success ? 'completed' : 'failed',
                    executedAt: new Date().toISOString(),
                });
            } catch (trackErr) {
                console.warn(`[Executor] Could not record engagement tracking:`, trackErr);
            }
        }

        await this.markActionDone(scheduleId);
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
    ) {
        const doLike = actionType === 'like' || actionType === 'comment_and_like';
        const doComment = actionType === 'comment' || actionType === 'comment_and_like';

        if (doComment) {
            const postContent = await this.fetchPostContent(adapter, engagingConnection, engagingUserId, ownerAccountId, ownerUserId, postId);
            const commentText = await this.generatePostComment(postContent);
            console.log(`[Executor] Generated comment: "${commentText.slice(0, 100)}..."`);
            await adapter.createComment(engagingConnection, postId, commentText, engagingUserId);
            console.log(`[Executor] Comment posted on post ${postId}`);
        }

        if (doLike) {
            await adapter.createReaction(engagingConnection, postId, 'LIKE', engagingUserId);
            console.log(`[Executor] Liked post ${postId}`);
        }
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

    // ────────────────────────────────────────────────────────────────────────────
    // COMMENT ENGAGEMENT
    // ────────────────────────────────────────────────────────────────────────────

    private async executeCommentAction(
        adapter: LinkedInAdapter,
        engagingConnection: ConnectedAccount,
        engagingUserId: string,
        postId: string,
        commentId: string | undefined,
        actionType: string
    ) {
        if (!commentId) {
            throw new Error('commentId is required for comment engagement actions');
        }

        const doLike = actionType === 'like_comment' || actionType === 'like_and_reply_comment';
        const doReply = actionType === 'reply_comment' || actionType === 'like_and_reply_comment';

        if (doReply) {
            const replyText = await this.generateCommentReply(commentId);
            console.log(`[Executor] Generated reply: "${replyText.slice(0, 100)}..."`);
            // createComment with parentCommentUrn posts a reply
            await adapter.createComment(engagingConnection, postId, replyText, engagingUserId, commentId);
            console.log(`[Executor] Reply posted on comment ${commentId}`);
        }

        if (doLike) {
            await adapter.createReaction(engagingConnection, commentId, 'LIKE', engagingUserId);
            console.log(`[Executor] Liked comment ${commentId}`);
        }
    }

    private async generateCommentReply(commentUrn: string): Promise<string> {
        try {
            const geminiClient = await agentModeService.getGeminiClient();
            const completion = await geminiClient.chat.completions.create({
                model: COMMENT_MODEL,
                messages: [
                    { role: 'system', content: COMMENT_REPLY_SYSTEM_PROMPT },
                    { role: 'user', content: `Comment URN to reply to: ${commentUrn}` },
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
