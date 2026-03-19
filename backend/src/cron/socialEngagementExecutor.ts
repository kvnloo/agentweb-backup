import { scheduleDb, userDb, socialEngagementTrackingDb } from '../services/db';
import { LinkedInAdapter } from '../services/adapters/linkedInAdapter';
import { ConnectedAccount } from '../services/connectedAccountsDb';

/**
 * Processes all due social engagement actions from the scheduleDb queue.
 * For each action, it builds a prompt and fires a headless chat session via
 * the existing `runScheduledChat` mechanism in agentModeController.
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
        const { targetPostUrn, boosterAccountId, actionType } = variableValues || {};

        console.log(`\n[Executor] ════ Processing action ${scheduleId} ════`);
        console.log(`[Executor] User: ${userId}`);
        console.log(`[Executor] Target post: ${targetPostUrn}`);
        console.log(`[Executor] Booster account: ${boosterAccountId}`);
        console.log(`[Executor] Action type: ${actionType}`);

        if (!userId || !targetPostUrn || !boosterAccountId) {
            console.warn(`[Executor] Skipping invalid action ${scheduleId}: missing required fields.`);
            await this.markActionDone(scheduleId);
            return;
        }

        // 1. Load user and find the booster connected account
        const user = await userDb.getUserById(userId);
        if (!user || !user.connected_accounts) {
            console.warn(`[Executor] User ${userId} not found or has no connected accounts.`);
            await this.markActionDone(scheduleId);
            return;
        }

        const boosterConnection = user.connected_accounts.find(
            (c: ConnectedAccount) => c.account_id === boosterAccountId && c.platform === 'linkedin'
        );

        if (!boosterConnection) {
            console.warn(`[Executor] Booster account ${boosterAccountId} not found in connected LinkedIn accounts for user ${userId}.`);
            console.warn(`[Executor] Available accounts: ${user.connected_accounts.filter((c: ConnectedAccount) => c.platform === 'linkedin').map((c: ConnectedAccount) => c.account_id).join(', ')}`);
            await this.markActionDone(scheduleId);
            return;
        }

        console.log(`[Executor] Found booster connection: "${boosterConnection.account_name}" (${boosterAccountId})`);

        // 2. Find the TARGET account connection to fetch the post content
        //    (The post belongs to the target account, not the booster)
        const config = (user as any).socialEngagementConfig;
        const targetAccountId = config?.targets?.find(() => true); // first target — the post URN carries identity

        // Try to find the target account connection; fall back to booster if not found
        const targetConnection = user.connected_accounts.find(
            (c: ConnectedAccount) => config?.targets?.includes(c.account_id) && c.platform === 'linkedin'
        ) || boosterConnection;

        console.log(`[Executor] Fetching post content via account: "${targetConnection.account_name}" (${targetConnection.account_id})`);

        // 3. Fetch the target post to give Emma context
        let postContent = '[Post content unavailable]';
        try {
            const adapter = new LinkedInAdapter();
            // Try the target connection first (more likely to have the post)
            const posts = await adapter.listPosts(targetConnection, { limit: 20 }, userId);
            const post = posts.find((p: any) => (p.id || p.urn) === targetPostUrn);
            if (post) {
                postContent = post.commentary || post.content || post.text || '[No text content]';
                console.log(`[Executor] Found post – content preview: "${postContent.slice(0, 100)}..."`);
            } else {
                console.warn(`[Executor] Could not find post ${targetPostUrn} in the last ${posts.length} posts from ${targetConnection.account_name}. Proceeding without post text.`);
            }
        } catch (error) {
            console.warn(`[Executor] Could not fetch post content for ${targetPostUrn}:`, error);
        }

        // 4. Build the Emma prompt
        const boosterName = boosterConnection.account_name || boosterAccountId;
        const doComment = actionType === 'comment_and_like';

        const prompt = doComment
            ? `You are an automated social engagement assistant. Your job is to engage with a LinkedIn post using the account "${boosterName}" (account_id: "${boosterAccountId}").

Here is the LinkedIn post to engage with:

POST URN: ${targetPostUrn}
CONTENT:
${postContent}

Task:
- Write a professional, thoughtful 1-2 sentence comment that adds genuine value to this post. Avoid clichés like "Great post!" or "Absolutely!". The comment should feel natural and insightful based on the post content.
- Post the comment on the post (URN: ${targetPostUrn}) using account "${boosterAccountId}".
- Also "LIKE" the same post using account "${boosterAccountId}".

Do this now without asking for confirmation.`
            : `You are an automated social engagement assistant. Your job is to engage with a LinkedIn post using the account "${boosterName}" (account_id: "${boosterAccountId}").

LinkedIn post URN to engage with: ${targetPostUrn}

Task:
- "LIKE" this post using account "${boosterAccountId}".

Do this now without asking for confirmation.`;

        console.log(`[Executor] Action: ${doComment ? 'COMMENT + LIKE' : 'LIKE ONLY'}`);
        console.log(`[Executor] Prompt preview:\n${prompt.slice(0, 300)}...`);

        // 5. Fire it as a scheduled chat using the existing infrastructure
        const scheduleForEmma = {
            ...action,
            type: 'scheduled_chat',
            startingMessage: prompt,
            scheduleName: `Social Engagement – ${targetPostUrn.slice(-12)} via ${boosterName}`,
            taskId: 'SYSTEM_SOCIAL_ENGAGEMENT',
            variables: [],
            variableValues: {},
            requiredFunctionCalls: [],
            keywords: [],
        };

        console.log(`[Executor] ▶ Handing off to Emma (runScheduledChat)...`);
        const { runScheduledChat } = await import('../controllers/agentModeController') as any;
        const result = await runScheduledChat(scheduleForEmma, userId, false);

        // 6. Log full result for debugging
        console.log(`[Executor] ◀ Emma finished.`);
        console.log(`[Executor] ── Session ID: ${result?.sessionId || '(none)'}`);
        console.log(`[Executor] ── Status: ${result?.status}`);
        console.log(`[Executor] ── Passed: ${result?.passed}`);
        console.log(`[Executor] ── Attempts: ${result?.attempt}`);
        console.log(`[Executor] ── Tool calls made: [${(result?.actualFunctionCalls || []).join(', ')}]`);
        if (result?.functionCallMisses?.length > 0) {
            console.warn(`[Executor] ── Missing expected tool calls: [${result.functionCallMisses.join(', ')}]`);
        }
        if (result?.sessionId) {
            console.log(`[Executor] ── 👉 To inspect: find chat session "${result.sessionId}" in Emma's session list.`);
        }
        if (!result?.passed && result?.actualResponse) {
            console.warn(`[Executor] ── Emma response (first 500 chars): ${result.actualResponse?.slice(0, 500)}`);
        }

        // 7. Mark the action as done
        await this.markActionDone(scheduleId);
        console.log(`[Executor] ════ Action ${scheduleId} complete ════\n`);
    }

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
