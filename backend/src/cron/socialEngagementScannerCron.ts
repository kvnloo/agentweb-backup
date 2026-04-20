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

            // De-duplicate posts by content AND by normalized URN ID — LinkedIn can return
            // the same physical post under multiple URN formats (e.g. urn:li:share:X and
            // urn:li:ugcPost:X share the same numeric ID) in a single listPosts response,
            // which would cause the same engager accounts to be scheduled to comment twice.
            // Empty-content posts are deduplicated by URN ID; posts with content use the
            // content text as a fallback for cross-URN-format matching.
            const seenContent = new Set<string>();
            const seenUrnIds = new Set<string>();
            const dedupedPosts = recentPosts.filter((p: any) => {
                const postUrn: string = p.id || p.urn || '';
                const urnId = postUrn.match(/:(\d+)$/)?.[1] ?? '';
                if (urnId) {
                    if (seenUrnIds.has(urnId)) {
                        console.log(`[Scanner/Posts] Dedup: skipping post ${postUrn} — same URN ID ${urnId} as another post in this response`);
                        return false;
                    }
                    seenUrnIds.add(urnId);
                }
                const content = (p.commentary || p.content || '').trim();
                if (!content) return true; // URN ID dedup above covers empty-content posts
                if (seenContent.has(content)) {
                    console.log(`[Scanner/Posts] Dedup: skipping post ${postUrn} — same content as another post in this response`);
                    return false;
                }
                seenContent.add(content);
                return true;
            });

            console.log(`[Scanner/Posts] ${ownerAccount.account_name}: ${dedupedPosts.length} recent post(s) (${recentPosts.length} before dedup)`);

            for (const post of dedupedPosts) {
                const postId: string = post.id || post.urn;
                if (!postId) continue;
                await this.schedulePostEngagers(ownerAccount, ownerSettings, postId, platform, potentialEngagers);
            }
        } catch (error) {
            console.error(`[Scanner/Posts] Failed to fetch posts for ${ownerAccount.account_id}:`, error);
        }
    }

    // ────────────────────────────────────────────────────────────────────────────
    // SHARED SCHEDULING HELPER
    // ────────────────────────────────────────────────────────────────────────────

    /**
     * Records the tracking entry FIRST (dedup guard), then creates the schedule.
     * If createSchedule fails, the tracking record is deleted so the scanner can
     * retry on the next run — preventing a permanently blocked post+account+actionType.
     */
    private async scheduleOneAction(params: {
        userId: string;
        postId: string;
        commentId?: string;
        commentText?: string;
        platform: string;
        ownerAccountId: string;
        engagingAccountId: string;
        engagingAccountName: string;
        actionType: string;
        targetType: 'post' | 'comment';
        windowMs: number;
        description: string;
    }) {
        const delayMs = Math.floor(Math.random() * params.windowMs);
        const executionTime = new Date(Date.now() + delayMs).toISOString();
        const scheduleId = uuidv4();

        // Atomically claim the scheduling slot. Uses a conditional DynamoDB write so
        // concurrent scanner instances on multiple EB hosts cannot both schedule the
        // same action — only the first writer succeeds; the rest return false and skip.
        const claimed = await socialEngagementTrackingDb.recordEngagement({
            userId: params.userId,
            postId: params.postId,
            commentId: params.commentId,
            platform: params.platform,
            ownerAccountId: params.ownerAccountId,
            engagingAccountId: params.engagingAccountId,
            actionType: params.actionType,
            scheduleId,
            status: 'queued',
        });

        if (!claimed) {
            console.log(`[Scanner] Dedup: "${params.actionType}" for ${params.commentId || params.postId} already claimed by another instance, skipping.`);
            return;
        }

        try {
            await scheduleDb.createSchedule({
                scheduleId,
                taskId: 'SYSTEM_SOCIAL_ENGAGEMENT',
                userId: params.userId,
                frequency: 'once',
                runCount: 1,
                nextRunTime: executionTime,
                status: 'active',
                createdAt: new Date().toISOString(),
                type: 'social_engagement_action',
                description: params.description,
                variableValues: {
                    postId: params.postId,
                    ...(params.commentId !== undefined && { commentId: params.commentId }),
                    ...(params.commentText !== undefined && { commentText: params.commentText }),
                    platform: params.platform,
                    ownerAccountId: params.ownerAccountId,
                    engagingAccountId: params.engagingAccountId,
                    actionType: params.actionType,
                    targetType: params.targetType,
                },
            });
        } catch (scheduleErr) {
            // Schedule creation failed — remove the tracking record so the scanner
            // can retry on the next run instead of permanently blocking this action.
            console.error(`[Scanner] createSchedule failed for "${params.actionType}" on ${params.postId}, rolling back tracking record:`, scheduleErr);
            try {
                await socialEngagementTrackingDb.deleteEngagement({
                    userId: params.userId,
                    postId: params.postId,
                    commentId: params.commentId,
                    engagingAccountId: params.engagingAccountId,
                    actionType: params.actionType,
                });
            } catch (deleteErr) {
                console.error(`[Scanner] Failed to roll back tracking record for "${params.actionType}" on ${params.postId}:`, deleteErr);
            }
            throw scheduleErr;
        }

        console.log(`[Scanner] Scheduled "${params.actionType}" at ${executionTime} — ${params.description}`);

        if (delayMs <= SCANNER_DIRECT_SCHEDULE_MS) {
            this.onActionScheduled?.(delayMs);
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

        // Limit how many distinct accounts can engage on a single post
        const cappedEngagers = potentialEngagers.slice(0, maxEngagers);

        let likeCount = 0;
        let commentCount = 0;

        for (const engager of cappedEngagers) {
            // Engager's own preferredActions gates what actions it will perform.
            // Intersect with the owner's preferences so neither side is overridden.
            const engagerPrefs: ('like' | 'comment')[] = engager.engagementSettings?.preferredActions || ['like', 'comment'];
            const needsLike = wantsLike && likeCount < maxLikes && engagerPrefs.includes('like');
            const needsComment = wantsComment && commentCount < maxComments && engagerPrefs.includes('comment');
            if (!needsLike && !needsComment) break;

            // Check per action type so an engager who already liked can still comment (and vice versa)
            const [alreadyLiked, alreadyCommented] = await Promise.all([
                needsLike
                    ? socialEngagementTrackingDb.hasEngaged(ownerAccount.userId, postId, engager.account_id, 'like')
                    : Promise.resolve(true),
                needsComment
                    ? socialEngagementTrackingDb.hasEngaged(ownerAccount.userId, postId, engager.account_id, 'comment')
                    : Promise.resolve(true),
            ]);

            if (needsLike && !alreadyLiked) {
                await this.scheduleOneAction({
                    userId: ownerAccount.userId,
                    postId,
                    platform,
                    ownerAccountId: ownerAccount.account_id,
                    engagingAccountId: engager.account_id,
                    engagingAccountName: engager.account_name,
                    actionType: 'like',
                    targetType: 'post',
                    windowMs,
                    description: `Like post ${postId} as ${engager.account_name}`,
                });
                likeCount++;
            }

            if (needsComment && !alreadyCommented) {
                await this.scheduleOneAction({
                    userId: ownerAccount.userId,
                    postId,
                    platform,
                    ownerAccountId: ownerAccount.account_id,
                    engagingAccountId: engager.account_id,
                    engagingAccountName: engager.account_name,
                    actionType: 'comment',
                    targetType: 'post',
                    windowMs,
                    description: `Comment on post ${postId} as ${engager.account_name}`,
                });
                commentCount++;
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

        // Enforce per-post lifetime cap — counts both queued AND completed items
        // (queued items now have executedAt set so they appear in the GSI)
        const { likedCount, repliedCount } = await socialEngagementTrackingDb
            .getCommentEngagementCountsForPost(postId, account.account_id);

        const remainingReplies = Math.max(0, maxReplies - repliedCount);
        const remainingLikes = Math.max(0, maxLikes - likedCount);

        if (remainingReplies === 0 && remainingLikes === 0) {
            console.log(`[Scanner/CommentReply] Post ${postId}: lifetime cap reached (likes: ${likedCount}/${maxLikes}, replies: ${repliedCount}/${maxReplies}), skipping.`);
            return;
        }

        // Collect candidates per action type independently, checking per-action dedup
        const replyEligible: typeof comments = [];
        const likeEligible: typeof comments = [];

        for (const comment of comments) {
            if (wantsReply && replyEligible.length < remainingReplies) {
                const alreadyReplied = await socialEngagementTrackingDb.hasEngaged(
                    account.userId, comment.commentUrn, account.account_id, 'reply_comment'
                );
                if (!alreadyReplied) replyEligible.push(comment);
            }
            if (wantsLike && likeEligible.length < remainingLikes) {
                const alreadyLiked = await socialEngagementTrackingDb.hasEngaged(
                    account.userId, comment.commentUrn, account.account_id, 'like_comment'
                );
                if (!alreadyLiked) likeEligible.push(comment);
            }
        }

        console.log(`[Scanner/CommentReply] Post ${postId}: ${replyEligible.length} reply candidate(s), ${likeEligible.length} like candidate(s)`);

        // Shuffle and cap each list independently
        const replyTargets = [...replyEligible].sort(() => Math.random() - 0.5).slice(0, remainingReplies);
        const likeTargets = [...likeEligible].sort(() => Math.random() - 0.5).slice(0, remainingLikes);

        for (const comment of replyTargets) {
            await this.scheduleOneAction({
                userId: account.userId,
                postId,
                commentId: comment.commentUrn,
                commentText: comment.text,
                platform,
                ownerAccountId: account.account_id,
                engagingAccountId: account.account_id,
                engagingAccountName: account.account_name,
                actionType: 'reply_comment',
                targetType: 'comment',
                windowMs,
                description: `Reply to comment on post ${postId} as ${account.account_name}`,
            });
        }

        for (const comment of likeTargets) {
            await this.scheduleOneAction({
                userId: account.userId,
                postId,
                commentId: comment.commentUrn,
                commentText: comment.text,
                platform,
                ownerAccountId: account.account_id,
                engagingAccountId: account.account_id,
                engagingAccountName: account.account_name,
                actionType: 'like_comment',
                targetType: 'comment',
                windowMs,
                description: `Like comment on post ${postId} as ${account.account_name}`,
            });
        }
    }
}
