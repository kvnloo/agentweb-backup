import { userDb, scheduleDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { v4 as uuidv4 } from 'uuid';

// Actions scheduled within this window are fired directly via setTimeout by the scanner.
// Actions beyond this window are left for the TimerScheduler to pick up on its next interval.
const SCANNER_DIRECT_SCHEDULE_MS = 30 * 60 * 1000; // 30 minutes

function getSocialAdapter(platform: string): LinkedInAdapter | null {
    switch (platform) {
        case 'linkedin': return new LinkedInAdapter();
        default: return null;
    }
}

/**
 * Scans all users for social engagement opportunities.
 *
 * All engagement is scoped per user — no cross-user engagement.
 *
 * POST ENGAGEMENT:
 *   - POST OWNER (enablePostDiscovery=true): their posts get liked/commented by other accounts of the same user
 *   - POST ENGAGER (enableAsPostEngager=true): engages on other accounts' posts within the same user
 *
 * COMMENT AUTO-REPLY:
 *   - COMMENT OWNER (enableCommentDiscovery=true): this account auto-replies/likes comments on its OWN posts
 *     — the reply comes from the same account, not from other accounts
 */
export class SocialEngagementScanner {
    private isScanning = false;

    constructor(private onActionScheduled?: (delayMs: number) => void) {}

    public async runScanner() {
        if (this.isScanning) {
            console.log('[SocialEngagementScanner] Already scanning, skipping concurrent run.');
            return;
        }
        this.isScanning = true;
        console.log('[SocialEngagementScanner] Starting discovery scan...');
        try {
            // Only load users that have at least one connected account — skips the
            // expensive per-user task/workflow/chat count queries done by getAllUsers().
            const usersWithAccounts = await userDb.scanWithFilter(
                'attribute_exists(connected_accounts)',
                {}
            );
            for (const user of usersWithAccounts) {
                await this.processUser(user);
            }
        } catch (error) {
            console.error('[SocialEngagementScanner] Critical error:', error);
        } finally {
            this.isScanning = false;
        }
        console.log('[SocialEngagementScanner] Scan complete.');
    }

    private async processUser(user: any) {
        // Global kill switch — skip this user entirely
        if (user.engagementPaused === true) {
            console.log(`[SocialEngagementScanner] User ${user.userId}: engagement paused globally, skipping.`);
            return;
        }

        const accounts = (user.connected_accounts || []).map((a: any) => ({ ...a, userId: user.userId }));

        const postOwners = accounts.filter((a: any) => a.engagementSettings?.enablePostDiscovery === true);
        const postEngagers = accounts.filter((a: any) => a.engagementSettings?.enableAsPostEngager === true);
        const commentOwners = accounts.filter((a: any) => a.engagementSettings?.enableCommentDiscovery === true);

        console.log(`[SocialEngagementScanner] User ${user.userId}: post owners: ${postOwners.length}, post engagers: ${postEngagers.length}, comment auto-reply: ${commentOwners.length}`);

        // ── POST ENGAGEMENT ──────────────────────────────────────────────
        for (const owner of postOwners) {
            const eligibleEngagers = postEngagers.filter(
                (e: any) => e.account_id !== owner.account_id && e.platform === owner.platform
            );
            if (eligibleEngagers.length === 0) continue;
            await this.scanOwnerPostsForEngagement(owner, eligibleEngagers);
        }

        // ── COMMENT AUTO-REPLY (self-account) ────────────────────────────
        // Collect all account URNs for this user — used to filter out self-generated comments
        const allAccountIds = new Set<string>(accounts.map((a: any) => a.account_id));
        for (const account of commentOwners) {
            await this.scanAccountPostsForCommentReply(account, allAccountIds);
        }
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
        const maxEngagers = ownerSettings.maxEngagersPerPost || 2;
        const windowMs = (ownerSettings.engagementWindowMinutes || 60) * 60 * 1000;

        const availableEngagers: any[] = [];
        for (const engager of potentialEngagers) {
            const alreadyQueued = await socialEngagementTrackingDb.hasEngaged(
                ownerAccount.userId, postId, engager.account_id
            );
            if (!alreadyQueued) availableEngagers.push(engager);
        }

        if (availableEngagers.length === 0) return;

        // Limit how many distinct accounts can engage on a single post
        const cappedEngagers = availableEngagers.slice(0, maxEngagers);

        let likeCount = 0;
        let commentCount = 0;

        for (const engager of cappedEngagers) {
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

            const scheduleId = uuidv4();
            await scheduleDb.createSchedule({
                scheduleId,
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
                    actionType,
                    targetType: 'post',
                },
            });

            // Mark as queued immediately so subsequent scanner runs don't schedule it again
            await socialEngagementTrackingDb.recordEngagement({
                userId: ownerAccount.userId,
                postId,
                platform,
                ownerAccountId: ownerAccount.account_id,
                engagingAccountId: engager.account_id,
                actionType,
                scheduleId,
                status: 'queued',
            });

            console.log(`[Scanner/Posts] Scheduled "${actionType}" on post ${postId} by ${engager.account_name} at ${executionTime}`);

            // If within direct schedule window, fire executor via setTimeout instead of waiting for TimerScheduler
            if (delayMs <= SCANNER_DIRECT_SCHEDULE_MS) {
                this.onActionScheduled?.(delayMs);
            }
        }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // COMMENT AUTO-REPLY (self-account replies/likes its own post's comments)
    // ────────────────────────────────────────────────────────────────────────────

    private async scanAccountPostsForCommentReply(account: any, ownAccountIds: Set<string>) {
        const settings = account.engagementSettings;
        const platform: string = account.platform;

        console.log(`[Scanner/CommentReply] Scanning posts for ${account.account_name} (${account.account_id})`);
        try {
            const adapter = getSocialAdapter(platform);
            if (!adapter) return;

            const posts = await adapter.listPosts(account as ConnectedAccount, { limit: 10 }, account.userId);
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
                    comments = await adapter.getComments(account as ConnectedAccount, postId, account.userId);
                } catch (err) {
                    console.warn(`[Scanner/CommentReply] Could not fetch comments for post ${postId}:`, err);
                    continue;
                }

                // Filter out comments from this user's own connected accounts to avoid
                // replying to auto-generated engagement comments (feedback loop)
                const externalComments = comments.filter((c) => !ownAccountIds.has(c.actorUrn));
                const recentComments = externalComments.filter((c) => c.createdAt >= cutoff);
                console.log(`[Scanner/CommentReply] Post ${postId}: ${recentComments.length} recent external comment(s) (${comments.length - externalComments.length} self-comments filtered)`);

                if (recentComments.length === 0) continue;
                await this.scheduleCommentReplies(account, settings, postId, platform, recentComments);
            }
        } catch (error) {
            console.error(`[Scanner/CommentReply] Failed to process ${account.account_id}:`, error);
        }
    }

    private async scheduleCommentReplies(
        account: any,
        settings: any,
        postId: string,
        platform: string,
        comments: Array<{ commentUrn: string; actorUrn: string; text: string; createdAt: number }>
    ) {
        const preferredActions: ('like' | 'reply')[] = settings.commentPreferredActions || ['reply'];
        const wantsLike = preferredActions.includes('like');
        const wantsReply = preferredActions.includes('reply');
        const maxLikes = wantsLike ? (settings.maxCommentLikesPerPost || 0) : 0;
        const maxReplies = wantsReply ? (settings.maxCommentRepliesPerPost || 0) : 0;
        const windowMs = (settings.commentEngagementWindowMinutes || 60) * 60 * 1000;

        if (maxLikes === 0 && maxReplies === 0) return;

        // Filter out comments already acted on by this account
        const unhandled: typeof comments = [];
        for (const comment of comments) {
            const already = await socialEngagementTrackingDb.hasEngaged(
                account.userId, comment.commentUrn, account.account_id
            );
            if (!already) unhandled.push(comment);
        }

        if (unhandled.length === 0) return;

        // Enforce per-post lifetime cap — subtract already queued/completed counts
        const { likedCount, repliedCount } = await socialEngagementTrackingDb
            .getCommentEngagementCountsForPost(postId, account.account_id);

        const remainingLikes = Math.max(0, maxLikes - likedCount);
        const remainingReplies = Math.max(0, maxReplies - repliedCount);

        if (remainingLikes === 0 && remainingReplies === 0) {
            console.log(`[Scanner/CommentReply] Post ${postId}: lifetime cap reached (likes: ${likedCount}/${maxLikes}, replies: ${repliedCount}/${maxReplies}), skipping.`);
            return;
        }

        // Shuffle for random selection
        const shuffled = [...unhandled].sort(() => Math.random() - 0.5);

        // Select up to remaining capacity for each action independently
        const replyTargets = new Set(shuffled.slice(0, remainingReplies).map((c) => c.commentUrn));
        const likeTargets = new Set(shuffled.slice(0, remainingLikes).map((c) => c.commentUrn));

        // Union of all comments needing any action
        const allTargetUrns = new Set([...replyTargets, ...likeTargets]);

        for (const commentUrn of allTargetUrns) {
            const comment = unhandled.find((c) => c.commentUrn === commentUrn)!;
            const doReply = replyTargets.has(commentUrn);
            const doLike = likeTargets.has(commentUrn);

            const actionType: 'like_comment' | 'reply_comment' | 'like_and_reply_comment' =
                doLike && doReply ? 'like_and_reply_comment'
                    : doReply ? 'reply_comment'
                        : 'like_comment';

            const delayMs = Math.floor(Math.random() * windowMs);
            const executionTime = new Date(Date.now() + delayMs).toISOString();

            const scheduleId = uuidv4();
            await scheduleDb.createSchedule({
                scheduleId,
                taskId: 'SYSTEM_SOCIAL_ENGAGEMENT',
                userId: account.userId,
                frequency: 'once',
                runCount: 1,
                nextRunTime: executionTime,
                status: 'active',
                createdAt: new Date().toISOString(),
                type: 'social_engagement_action',
                description: `Auto-reply to comment on post ${postId} as ${account.account_name}`,
                variableValues: {
                    postId,
                    commentId: commentUrn,
                    commentText: comment.text,
                    platform,
                    ownerAccountId: account.account_id,
                    engagingAccountId: account.account_id, // self-reply: same account
                    actionType,
                    targetType: 'comment',
                },
            });

            // Mark as queued immediately so subsequent scanner runs don't schedule it again
            await socialEngagementTrackingDb.recordEngagement({
                userId: account.userId,
                postId,
                commentId: commentUrn,
                platform,
                ownerAccountId: account.account_id,
                engagingAccountId: account.account_id,
                actionType,
                scheduleId,
                status: 'queued',
            });

            console.log(`[Scanner/CommentReply] Scheduled "${actionType}" on comment ${commentUrn} as ${account.account_name} at ${executionTime}`);

            // If within direct schedule window, fire executor via setTimeout instead of waiting for TimerScheduler
            if (delayMs <= SCANNER_DIRECT_SCHEDULE_MS) {
                this.onActionScheduled?.(delayMs);
            }
        }
    }
}
