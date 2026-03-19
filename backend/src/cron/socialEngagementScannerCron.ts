import { userDb, scheduleDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { v4 as uuidv4 } from 'uuid';

/**
 * Scans all users with any account that has autoEngagement = true.
 * For each such user, all their participating accounts monitor each other's posts
 * and schedule engagement actions. This is SINGLE-USER scope — accounts of different
 * users never engage with each other.
 */
export class SocialEngagementScanner {
    public async runScanner() {
        console.log('[SocialEngagementScanner] Starting discovery scan...');
        try {
            const allUsers = await userDb.getAllUsers();

            // A user participates if at least one connected account has autoEngagement = true
            const activeUsers = allUsers.filter((u: any) =>
                (u.connected_accounts || []).some(
                    (a: any) => a.engagementSettings?.autoEngagement === true
                )
            );

            console.log(`[SocialEngagementScanner] Found ${activeUsers.length} users with at least one auto-engagement account.`);

            for (const user of activeUsers) {
                await this.processUser(user as any);
            }
        } catch (error) {
            console.error('[SocialEngagementScanner] Critical error:', error);
        }
        console.log('[SocialEngagementScanner] Scan complete.');
    }

    private async processUser(user: any) {
        const connectedAccounts: any[] = user.connected_accounts || [];

        // All accounts of this user with autoEngagement enabled (LinkedIn only for now)
        const participants = connectedAccounts.filter(
            (a: any) => a.platform === 'linkedin' && a.engagementSettings?.autoEngagement === true
        );

        if (participants.length < 2) {
            console.log(`[Scanner] User ${user.userId}: only ${participants.length} participant(s) — need at least 2 to engage. Skipping.`);
            return;
        }

        console.log(`[Scanner] User ${user.userId}: ${participants.length} participants: ${participants.map((p: any) => p.account_name).join(', ')}`);

        // Each participant's posts are scanned; all OTHER participants are potential engagers
        for (const ownerAccount of participants) {
            await this.scanOwnerPosts(user, ownerAccount, participants);
        }
    }

    private async scanOwnerPosts(user: any, ownerAccount: any, allParticipants: any[]) {
        const ownerSettings = ownerAccount.engagementSettings;

        console.log(`[Scanner] Fetching recent posts for ${ownerAccount.account_name} (${ownerAccount.account_id})`);
        try {
            const adapter = new LinkedInAdapter();
            const posts = await adapter.listPosts(ownerAccount as ConnectedAccount, { limit: 10 }, user.userId);

            // Only process posts from the last 7 days
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const recentPosts = posts.filter((p: any) => {
                const ts = p.createdAt || p.publishedAt || p.created?.time || p.timestamp || 0;
                return ts >= cutoff;
            });

            console.log(`[Scanner] ${ownerAccount.account_name}: ${recentPosts.length} recent post(s) to process.`);

            for (const post of recentPosts) {
                const postUrn: string = post.id || post.urn;
                if (!postUrn) continue;

                // Engagers = all OTHER participants (not the post owner itself)
                const potentialEngagers = allParticipants.filter(
                    (a: any) => a.account_id !== ownerAccount.account_id
                );

                await this.scheduleEngagers(user, postUrn, ownerAccount, ownerSettings, potentialEngagers);
            }
        } catch (error) {
            console.error(`[Scanner] Failed to fetch posts for ${ownerAccount.account_id}:`, error);
        }
    }

    private async scheduleEngagers(
        user: any,
        postUrn: string,
        ownerAccount: any,
        ownerSettings: any,
        potentialEngagers: any[]
    ) {
        const preferredActions: ('like' | 'comment')[] = ownerSettings.preferredActions || ['like'];
        const wantsLike = preferredActions.includes('like');
        const wantsComment = preferredActions.includes('comment');

        // Determine how many engagements each type can receive (incoming caps from owner settings)
        const maxLikes = wantsLike ? (ownerSettings.maxLikesPerPost || 0) : 0;
        const maxComments = wantsComment ? (ownerSettings.maxCommentsPerPost || 0) : 0;
        const windowMs = (ownerSettings.engagementWindowMinutes || 60) * 60 * 1000;

        // Filter engagers not yet queued
        const availableEngagers: any[] = [];
        for (const engager of potentialEngagers) {
            const alreadyQueued = await socialEngagementTrackingDb.hasEngaged(
                user.userId, postUrn, engager.account_id
            );
            if (!alreadyQueued) {
                availableEngagers.push(engager);
            }
        }

        if (availableEngagers.length === 0) return;

        // Schedule likes (up to maxLikes from available engagers)
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
                userId: user.userId,
                frequency: 'once',
                runCount: 1,
                nextRunTime: executionTime,
                status: 'active',
                createdAt: new Date().toISOString(),
                type: 'social_engagement_action',
                description: `Engage post ${postUrn} as ${engager.account_name}`,
                variableValues: {
                    targetPostUrn: postUrn,
                    ownerAccountId: ownerAccount.account_id,
                    engagingAccountId: engager.account_id,
                    actionType,
                },
            });

            await socialEngagementTrackingDb.recordEngagement({
                userId: user.userId,
                targetPostUrn: postUrn,
                ownerAccountId: ownerAccount.account_id,
                engagingAccountId: engager.account_id,
                actionType,
                scheduledAt: executionTime,
            });

            console.log(`[Scanner] Scheduled "${actionType}" on post ${postUrn} by ${engager.account_name} at ${executionTime}`);
        }
    }
}
