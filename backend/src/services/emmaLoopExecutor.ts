import jwt from 'jsonwebtoken';

export interface EmmaLoopConfig {
  systemUserId: string;
  prompt: string;
  baseUrl?: string;
  jwtSecret?: string;
}

export interface EmmaTickResult {
  status: 'completed' | 'failed';
  summary?: string;
  error?: string;
  durationMs: number;
}

const MAX_SUMMARY_LENGTH = 2000;

export class EmmaLoopExecutor {
  private config: EmmaLoopConfig;

  constructor(config: EmmaLoopConfig) {
    this.config = config;
  }

  private generateToken(): string {
    const secret = this.config.jwtSecret || process.env.JWT_SECRET || 'your-secret-key';
    return jwt.sign(
      { userId: this.config.systemUserId, email: 'system@agentweb.pro', isAdmin: true },
      secret,
      { expiresIn: 300 },
    );
  }

  private getBaseUrl(): string {
    return this.config.baseUrl || `http://localhost:${process.env.PORT || '3001'}`;
  }

  async executeTick(): Promise<EmmaTickResult> {
    const startTime = Date.now();

    try {
      // Step 1: Create Emma session
      const token = this.generateToken();
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      };

      const sessionRes = await fetch(`${this.getBaseUrl()}/api/agent-mode/sessions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({}),
      });

      if (!sessionRes.ok) {
        const errBody = await sessionRes.json().catch(() => ({}));
        return {
          status: 'failed',
          error: `Emma session creation failed (${sessionRes.status}): ${errBody.error || 'Unknown error'}`,
          durationMs: Date.now() - startTime,
        };
      }

      const sessionData = await sessionRes.json();
      const sessionId = sessionData.sessionId;

      // Step 2: Send the loop prompt
      const messageRes = await fetch(`${this.getBaseUrl()}/api/agent-mode/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId,
          userMessage: this.config.prompt,
        }),
      });

      if (!messageRes.ok) {
        const errBody = await messageRes.json().catch(() => ({}));
        return {
          status: 'failed',
          error: `Emma message send failed (${messageRes.status}): ${errBody.error || 'Unknown error'}`,
          durationMs: Date.now() - startTime,
        };
      }

      const messageData = await messageRes.json();
      const response = messageData.response || JSON.stringify(messageData);

      return {
        status: 'completed',
        summary: typeof response === 'string'
          ? response.substring(0, MAX_SUMMARY_LENGTH)
          : JSON.stringify(response).substring(0, MAX_SUMMARY_LENGTH),
        durationMs: Date.now() - startTime,
      };
    } catch (err: any) {
      return {
        status: 'failed',
        error: err.message || 'Unknown error',
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Create an executor function compatible with LoopCoordinatorService.registerLoop
   */
  createExecutor(): () => Promise<any> {
    return async () => {
      const result = await this.executeTick();
      if (result.status === 'failed') {
        throw new Error(result.error || 'Emma loop tick failed');
      }
      return result.summary;
    };
  }
}

// Pre-configured loop prompts
export const CAMPAIGN_WATCHDOG_PROMPT = `You are running as the Campaign Watchdog loop.

For each active client:
1. Use get_meta_ads_metrics to pull the latest campaign performance data
2. Compare current CPL, CPC, and CTR against 7-day averages
3. Flag any anomalies:
   - CPL spike > 25% above average
   - Creative fatigue (CTR drop > 20%)
   - Budget underspending (< 70% daily budget used)
   - Budget overspending (> 110% daily budget used)
4. For flagged items, recommend specific actions

Return a structured summary of findings. If all metrics are healthy, report "All campaigns healthy — no action needed."`;

export const CLIENT_HEALTH_DIGEST_PROMPT = `You are running as the Client Health Digest loop.

For each active client:
1. Use assess_client_health to get the overall health score
2. Compile a morning brief with:
   - Overall health score (red/yellow/green)
   - Key metrics summary (engagement, campaign performance, content freshness)
   - Action items for the team
   - Clients that need immediate attention
3. Prioritize clients by health score (worst first)

Return a formatted digest suitable for posting to Slack. Keep it concise — max 3 bullet points per client.`;

export const LEAD_NURTURE_PROMPT = `You are running as the Lead Nurture loop.

1. Scan the CRM for leads that haven't been contacted in 3+ days
2. For each stale lead:
   - Review their last interaction and engagement history
   - Draft a personalized follow-up email using the appropriate email template
   - Queue the draft for human approval (do NOT send automatically)
3. Prioritize leads by:
   - Lead score (highest first)
   - Days since last contact (longest first)
   - Pipeline stage (closer to conversion first)

Return a summary: how many leads need follow-up, how many drafts created, any leads that should be escalated to a human.`;

export const CONTENT_CADENCE_PROMPT = `You are running as the Content Cadence loop.

For each active client:
1. Check the scheduled content calendar for the next 7 days
2. Identify gaps — days with no scheduled posts on any platform
3. For each gap:
   - Review the client's brand guidelines and recent content themes
   - Auto-draft a post appropriate for the platform and day
   - Add to the content queue for review
4. Flag clients with fewer than 3 posts scheduled this week

Return a summary: content gaps found per client, drafts created, clients needing attention.`;

export const SOCIAL_ENGAGEMENT_PROMPT = `You are running as the Social Engagement loop.

For each active client with LinkedIn integration:
1. Check recent LinkedIn post engagement (last 4 hours)
2. Identify posts with high engagement that have unanswered comments
3. For each unanswered comment:
   - Analyze the comment sentiment and intent
   - Suggest a thoughtful reply aligned with the client's brand voice
   - Queue the suggested reply for approval
4. Flag any negative comments or PR risks for immediate human attention

Return a summary: posts checked, comments found, replies suggested, any escalations needed.`;
