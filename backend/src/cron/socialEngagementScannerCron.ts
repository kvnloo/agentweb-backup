import { userDb, scheduleDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';
import { v4 as uuidv4 } from 'uuid';

export class SocialEngagementScanner {
    /**
     * Main entry point — discover all posts that need engagement and schedule them.
     */
    public async runScanner() {
        console.log('[SocialEngagementScanner] Starting discovery scan...');
        try {
            const allUsers = await userDb.getAllUsers();
            const activeUsers = allUsers.filter(u => (u as any).socialEngagementConfig?.isEnabled === true);

            console.log(`[SocialEngagementScanner] Found ${activeUsers.length} users with active config.`);

            for (const user of activeUsers) {
                await this.processUser(user as any);
            }
        } catch (error) {
            console.error('[SocialEngagementScanner] Critical error:', error);
        }
        console.log('[SocialEngagementScanner] Scan complete.');
    }

    private async processUser(user: any) {
        const config = user.socialEngagementConfig;
        if (!config || !user.connected_accounts) return;

        for (const targetAccountId of config.targets) {
            const targetConnection = user.connected_accounts.find(
                (c: ConnectedAccount) => c.account_id === targetAccountId && c.platform === 'linkedin'
            );
            if (!targetConnection) {
                console.warn(`[Scanner] Target ${targetAccountId} not found in connected_accounts for user ${user.userId}`);
                continue;
            }
            await this.scanTarget(user, targetConnection, config);
        }
    }

    private async scanTarget(user: any, targetConnection: ConnectedAccount, config: any) {
        try {
            const adapter = new LinkedInAdapter();
            if (targetConnection.config?.account_type === 'company_page') {
                console.log(`[Scanner] Fetching recent posts from organization page: ${targetConnection.account_name} (${targetConnection.account_id})`);
            }
            const posts = await adapter.listPosts(targetConnection, { limit: 10 }, user.userId);

            // Only process posts from the last 7 days
            const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const recentPosts = posts.filter((p: any) => {
                // Handle different timestamp formats:
                // - Organization posts (versioned API): p.createdAt
                // - Personal posts (DB-backed): p.created.time
                // - Legacy/Other: p.timestamp
                const ts = p.createdAt || p.publishedAt || p.created?.time || p.timestamp || 0;
                return ts >= cutoff;
            });

            for (const post of recentPosts) {
                const postUrn: string = post.id || post.urn;
                if (!postUrn) continue;

                await this.scheduleBoostersForPost(user, postUrn, config);
            }
        } catch (error) {
            console.error(`[Scanner] Failed to fetch posts for ${targetConnection.account_id}:`, error);
        }
    }

    private async scheduleBoostersForPost(user: any, postUrn: string, config: any) {
        const available: string[] = [];

        for (const boosterAccountId of config.boosters) {
            const alreadyQueued = await socialEngagementTrackingDb.hasEngaged(
                user.userId, postUrn, boosterAccountId
            );
            if (!alreadyQueued) {
                available.push(boosterAccountId);
            }
        }

        // Determine action type and limit based on strategy
        const strategy = config.strategy || {};
        const preferredAction = strategy.preferredAction;
        const maxComments = strategy.maxCommentsPerPost || 0;
        const maxLikes = strategy.maxLikesPerPost || 0;

        let actionType: 'comment_and_like' | 'like' = 'comment_and_like';
        let limit = maxComments;

        // If caller explicitly asks for 'like', or if comment cap is 0 but like cap is > 0
        if (preferredAction === 'like' || (maxComments === 0 && maxLikes > 0)) {
            actionType = 'like';
            limit = maxLikes;
        }

        const toQueue = available.slice(0, limit);
        if (toQueue.length === 0) return;

        console.log(`[Scanner] Post ${postUrn}: scheduling ${toQueue.length} engagements.`);
        const windowMs = config.strategy.engagementWindowMinutes * 60 * 1000;

        for (const boosterAccountId of toQueue) {
            const delayMs = Math.floor(Math.random() * windowMs);
            const executionTime = new Date(Date.now() + delayMs).toISOString();

            // Push to scheduleDb as a queued task
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
                description: `Engage post ${postUrn} as ${boosterAccountId}`,
                variableValues: {
                    targetPostUrn: postUrn,
                    boosterAccountId,
                    actionType,
                },
            });

            // Record so scanner won't re-queue on next run
            await socialEngagementTrackingDb.recordEngagement({
                userId: user.userId,
                targetPostUrn: postUrn,
                boosterAccountId,
                actionType,
                scheduledAt: executionTime,
            });

            console.log(`[Scanner] Scheduled engagement for post ${postUrn} via ${boosterAccountId} at ${executionTime}`);
        }
    }
}
