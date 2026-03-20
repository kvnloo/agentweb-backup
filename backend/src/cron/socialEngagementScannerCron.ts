import { userDb, scheduleDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { v4 as uuidv4 } from 'uuid';

function getSocialAdapter(platform: string): LinkedInAdapter | null {
    switch (platform) {
        case 'linkedin': return new LinkedInAdapter();
        default: return null;
    }
}

/**
 * Scans all users for social engagement opportunities.
 *
 * Role-based model:
 *   - POST OWNER:    accounts with enablePostDiscovery = true  → their posts can receive engagement
 *   - POST ENGAGER:  accounts with enableAsPostEngager = true  → they engage on others' posts
 *   - COMMENT OWNER: accounts with enableCommentDiscovery = true → comments on their posts can receive engagement
 *   - COMMENT ENGAGER: accounts with enableAsCommentEngager = true → they engage on others' post comments
 *
 * Cross-user engagement is supported: engagers from any user can engage with owners from any other user
 * on the same platform.
 */
export class SocialEngagementScanner {
    public async runScanner() {
        console.log('[SocialEngagementScanner] Starting discovery scan...');
        try {
            const allUsers = await userDb.getAllUsers();

            // Collect all connected accounts across all users, annotated with userId
            const allAccounts: any[] = [];
            for (const user of allUsers) {
                for (const acc of (user.connected_accounts || [])) {
                    allAccounts.push({ ...acc, userId: user.userId });
                }
            }

            // Role slices
            const postOwners = allAccounts.filter(
                (a) => a.engagementSettings?.enablePostDiscovery === true
            );
            const postEngagers = allAccounts.filter(
                (a) => a.engagementSettings?.enableAsPostEngager === true
            );
            const commentOwners = allAccounts.filter(
                (a) => a.engagementSettings?.enableCommentDiscovery === true
            );
            const commentEngagers = allAccounts.filter(
                (a) => a.engagementSettings?.enableAsCommentEngager === true
            );

            console.log(`[SocialEngagementScanner] Post owners: ${postOwners.length}, Post engagers: ${postEngagers.length}`);
            console.log(`[SocialEngagementScanner] Comment owners: ${commentOwners.length}, Comment engagers: ${commentEngagers.length}`);

            // ── POST ENGAGEMENT ──────────────────────────────────────────────
            for (const owner of postOwners) {
                const eligibleEngagers = postEngagers.filter(
                    (e) => e.account_id !== owner.account_id && e.platform === owner.platform
                );
                if (eligibleEngagers.length === 0) continue;
                await this.scanOwnerPostsForEngagement(owner, eligibleEngagers);
            }

            // ── COMMENT ENGAGEMENT ───────────────────────────────────────────
            for (const owner of commentOwners) {
                const eligibleEngagers = commentEngagers.filter(
                    (e) => e.account_id !== owner.account_id && e.platform === owner.platform
                );
                if (eligibleEngagers.length === 0) continue;
                await this.scanOwnerPostsForCommentEngagement(owner, eligibleEngagers);
            }
        } catch (error) {
            console.error('[SocialEngagementScanner] Critical error:', error);
        }
        console.log('[SocialEngagementScanner] Scan complete.');
    }

    // ────────────────────────────────────────────────────────────────────────────
    // POST ENGAGEMENT
    // ────────────────────────────────────────────────────────────────────────────

    private async scanOwnerPostsForEngagement(ownerAccount: any, potentialEngagers: any[]) {
        const ownerSettings = ownerAccount.engagementSettings;
        const platform: string = ownerAccount.platform;

        console.log(`[Scanner/Posts] Fetching posts for ${ownerAccount.account_name} (${ownerAccount.account_id})`);
        try {
            const adapter = getSocialAdapter(platform);
            if (!adapter) return;

            const posts = await adapter.listPosts(ownerAccount as ConnectedAccount, { limit: 10 }, ownerAccount.userId);
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const recentPosts = posts.filter((p: any) => {
                const ts = p.createdAt || p.publishedAt || p.created?.time || p.timestamp || 0;
                return ts >= cutoff;
            });

            console.log(`[Scanner/Posts] ${ownerAccount.account_name}: ${recentPosts.length} recent post(s)`);

            for (const post of recentPosts) {
                const postId: string = post.id || post.urn;
                if (!postId) continue;
                await this.schedulePostEngagers(ownerAccount, ownerSettings, postId, platform, potentialEngagers);
            }
        } catch (error) {
            console.error(`[Scanner/Posts] Failed to fetch posts for ${ownerAccount.account_id}:`, error);
        }
    }

    private async schedulePostEngagers(
        ownerAccount: any,
        ownerSettings: any,
        postId: string,
        platform: string,
        potentialEngagers: any[]
    ) {
        const preferredActions: ('like' | 'comment')[] = ownerSettings.preferredActions || ['like'];
        const wantsLike = preferredActions.includes('like');
        const wantsComment = preferredActions.includes('comment');
        const maxLikes = wantsLike ? (ownerSettings.maxLikesPerPost || 0) : 0;
        const maxComments = wantsComment ? (ownerSettings.maxCommentsPerPost || 0) : 0;
        const windowMs = (ownerSettings.engagementWindowMinutes || 60) * 60 * 1000;

        const availableEngagers: any[] = [];
        for (const engager of potentialEngagers) {
            const alreadyQueued = await socialEngagementTrackingDb.hasEngaged(
                ownerAccount.userId, postId, engager.account_id
            );
            if (!alreadyQueued) availableEngagers.push(engager);
        }

        if (availableEngagers.length === 0) return;

        let likeCount = 0;
        let commentCount = 0;

        for (const engager of availableEngagers) {
            const canLike = wantsLike && likeCount < maxLikes;
            const canComment = wantsComment && commentCount < maxComments;
            if (!canLike && !canComment) break;

            const actionType: 'like' | 'comment' | 'comment_and_like' =
                canLike && canComment ? 'comment_and_like'
                    : canComment ? 'comment'
                        : 'like';

            if (canLike) likeCount++;
            if (canComment) commentCount++;

            const delayMs = Math.floor(Math.random() * windowMs);
            const executionTime = new Date(Date.now() + delayMs).toISOString();

            await scheduleDb.createSchedule({
                scheduleId: uuidv4(),
                taskId: 'SYSTEM_SOCIAL_ENGAGEMENT',
                userId: ownerAccount.userId,
                frequency: 'once',
                runCount: 1,
                nextRunTime: executionTime,
                status: 'active',
                createdAt: new Date().toISOString(),
                type: 'social_engagement_action',
                description: `Engage post ${postId} as ${engager.account_name} on ${platform}`,
                variableValues: {
                    postId,
                    platform,
                    ownerAccountId: ownerAccount.account_id,
                    engagingAccountId: engager.account_id,
                    engagingUserId: engager.userId,
                    actionType,
                    targetType: 'post',
                },
            });

            console.log(`[Scanner/Posts] Scheduled "${actionType}" on post ${postId} by ${engager.account_name} at ${executionTime}`);
        }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // COMMENT ENGAGEMENT
    // ────────────────────────────────────────────────────────────────────────────

    private async scanOwnerPostsForCommentEngagement(ownerAccount: any, potentialEngagers: any[]) {
        const ownerSettings = ownerAccount.engagementSettings;
        const platform: string = ownerAccount.platform;

        console.log(`[Scanner/Comments] Fetching posts for ${ownerAccount.account_name} to scan comments`);
        try {
            const adapter = getSocialAdapter(platform);
            if (!adapter) return;

            const posts = await adapter.listPosts(ownerAccount as ConnectedAccount, { limit: 10 }, ownerAccount.userId);
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const recentPosts = posts.filter((p: any) => {
                const ts = p.createdAt || p.publishedAt || p.created?.time || p.timestamp || 0;
                return ts >= cutoff;
            });

            for (const post of recentPosts) {
                const postId: string = post.id || post.urn;
                if (!postId) continue;

                let comments: Array<{ commentUrn: string; actorUrn: string; text: string; createdAt: number }> = [];
                try {
                    comments = await adapter.getComments(ownerAccount as ConnectedAccount, postId, ownerAccount.userId);
                } catch (err) {
                    console.warn(`[Scanner/Comments] Could not fetch comments for post ${postId}:`, err);
                    continue;
                }

                const recentComments = comments.filter((c) => c.createdAt >= cutoff);
                console.log(`[Scanner/Comments] Post ${postId}: ${recentComments.length} recent comment(s)`);

                for (const comment of recentComments) {
                    await this.scheduleCommentEngagers(
                        ownerAccount, ownerSettings, postId, comment.commentUrn, platform, potentialEngagers
                    );
                }
            }
        } catch (error) {
            console.error(`[Scanner/Comments] Failed to process ${ownerAccount.account_id}:`, error);
        }
    }

    private async scheduleCommentEngagers(
        ownerAccount: any,
        ownerSettings: any,
        postId: string,
        commentUrn: string,
        platform: string,
        potentialEngagers: any[]
    ) {
        const preferredActions: ('like' | 'reply')[] = ownerSettings.commentPreferredActions || ['like'];
        const wantsLike = preferredActions.includes('like');
        const wantsReply = preferredActions.includes('reply');
        const maxLikes = wantsLike ? (ownerSettings.maxCommentLikesPerPost || 0) : 0;
        const maxReplies = wantsReply ? (ownerSettings.maxCommentRepliesPerPost || 0) : 0;
        const windowMs = (ownerSettings.commentEngagementWindowMinutes || 60) * 60 * 1000;

        const availableEngagers: any[] = [];
        for (const engager of potentialEngagers) {
            const alreadyQueued = await socialEngagementTrackingDb.hasEngaged(
                ownerAccount.userId, commentUrn, engager.account_id
            );
            if (!alreadyQueued) availableEngagers.push(engager);
        }

        if (availableEngagers.length === 0) return;

        let likeCount = 0;
        let replyCount = 0;

        for (const engager of availableEngagers) {
            const canLike = wantsLike && likeCount < maxLikes;
            const canReply = wantsReply && replyCount < maxReplies;
            if (!canLike && !canReply) break;

            const actionType: 'like_comment' | 'reply_comment' | 'like_and_reply_comment' =
                canLike && canReply ? 'like_and_reply_comment'
                    : canReply ? 'reply_comment'
                        : 'like_comment';

            if (canLike) likeCount++;
            if (canReply) replyCount++;

            const delayMs = Math.floor(Math.random() * windowMs);
            const executionTime = new Date(Date.now() + delayMs).toISOString();

            await scheduleDb.createSchedule({
                scheduleId: uuidv4(),
                taskId: 'SYSTEM_SOCIAL_ENGAGEMENT',
                userId: ownerAccount.userId,
                frequency: 'once',
                runCount: 1,
                nextRunTime: executionTime,
                status: 'active',
                createdAt: new Date().toISOString(),
                type: 'social_engagement_action',
                description: `Engage comment ${commentUrn} as ${engager.account_name} on ${platform}`,
                variableValues: {
                    postId,
                    commentId: commentUrn,
                    platform,
                    ownerAccountId: ownerAccount.account_id,
                    engagingAccountId: engager.account_id,
                    engagingUserId: engager.userId,
                    actionType,
                    targetType: 'comment',
                },
            });

            console.log(`[Scanner/Comments] Scheduled "${actionType}" on comment ${commentUrn} by ${engager.account_name} at ${executionTime}`);
        }
    }
}
