import { getAccountsByUserId, ConnectedAccount, EngagementMemory, saveEngagementMemory } from './connectedAccountsDb';
import { socialPlatformService } from './socialPlatformService';
import { linkedInService } from './linkedInService';
import { LinkedInConfig } from './connectedAccountsDb';
import { getPostsByAccount } from './linkedInPostsDb';

const SOCIAL_PLATFORMS = ['linkedin', 'instagram'];

interface GetPostsOptions {
  accountId?: string;
  limit?: number;
  includeMetrics?: boolean;
  forceReload?: boolean;
}

interface NormalizedPost {
  id: string;
  accountId: string;
  accountName: string;
  platform: string;
  accountType: string;
  content: string;
  createdAt: string;
  metrics: {
    likeCount: number;
    commentCount: number;
    shareCount: number;
    impressionCount: number;
    clickCount: number;
    engagement: number;
  } | null;
  [key: string]: any;
}

interface AccountSummary {
  accountId: string;
  accountName: string;
  platform: string;
  accountType: string;
  postCount: number;
  error?: string;
}

interface GetPostsResult {
  success: boolean;
  posts: NormalizedPost[];
  accounts: AccountSummary[];
}

export async function getPostsForUser(
  userId: string,
  options: GetPostsOptions = {}
): Promise<GetPostsResult> {
  const { accountId, limit = 20, includeMetrics = true, forceReload = false } = options;

  const allAccounts = await getAccountsByUserId(userId);

  // Filter to social platforms only
  let accounts = allAccounts.filter(a => SOCIAL_PLATFORMS.includes(a.platform));

  // Filter to specific account if requested
  if (accountId) {
    accounts = accounts.filter(a => a.account_id === accountId);
  }

  const allPosts: NormalizedPost[] = [];
  const accountSummaries: AccountSummary[] = [];

  for (const account of accounts) {
    try {
      const adapter = socialPlatformService.getAdapter(account.platform);
      let posts = await adapter.listPosts(account, { limit, force_reload: forceReload }, userId);

      if (includeMetrics && posts.length > 0) {
        try {
          const postIds = posts.map((p: any) => p.id).filter(Boolean);
          if (postIds.length > 0) {
            const metrics = await adapter.getPostMetrics(account, postIds, userId);
            posts = posts.map((post: any) => {
              const metric = metrics.find(m => m.share === post.id);
              return {
                ...post,
                metrics: metric ? {
                  likeCount: metric.likes ?? 0,
                  commentCount: metric.comments ?? 0,
                  shareCount: metric.shares ?? 0,
                  impressionCount: metric.impressions ?? 0,
                  clickCount: metric.clicks ?? 0,
                  engagement: metric.engagement ?? 0,
                } : null,
              };
            });
          }
        } catch (metricError) {
          console.warn(`[SocialPosts] Failed to fetch metrics for account ${account.account_id}:`, metricError);
        }
      }

      const accountType = (account.config as any)?.account_type || 'unknown';

      const normalizedPosts: NormalizedPost[] = posts.map((post: any) => {
        // Extract text content: LinkedIn uses 'commentary', fallback to 'text', 'caption'
        // Note: LinkedIn 'content' field is an object (media/article), so only use it if it's a string
        const content = post.commentary || post.text || post.caption
          || (typeof post.content === 'string' ? post.content : '') || '';

        // Extract creation date: personal LinkedIn has created.time (ms),
        // company has createdAt (ms) or publishedAt (ms), Instagram may have timestamp
        let createdAt: string;
        if (post.created?.time) {
          createdAt = new Date(post.created.time).toISOString();
        } else if (typeof post.createdAt === 'number') {
          createdAt = new Date(post.createdAt).toISOString();
        } else if (typeof post.publishedAt === 'number') {
          createdAt = new Date(post.publishedAt).toISOString();
        } else if (typeof post.createdAt === 'string') {
          createdAt = post.createdAt;
        } else if (post.timestamp) {
          createdAt = new Date(post.timestamp).toISOString();
        } else {
          createdAt = new Date().toISOString();
        }

        return {
          id: post.id,
          accountId: account.account_id,
          accountName: account.account_name,
          platform: account.platform,
          accountType,
          content,
          createdAt,
          metrics: post.metrics || null,
        };
      });

      allPosts.push(...normalizedPosts);

      accountSummaries.push({
        accountId: account.account_id,
        accountName: account.account_name,
        platform: account.platform,
        accountType,
        postCount: normalizedPosts.length,
      });
    } catch (error: any) {
      console.warn(`[SocialPosts] Failed to load posts for account ${account.account_id}:`, error);
      // Still include the account in summaries so it remains visible on the page
      const accountType = (account.config as any)?.account_type || 'unknown';
      accountSummaries.push({
        accountId: account.account_id,
        accountName: account.account_name,
        platform: account.platform,
        accountType,
        postCount: 0,
        error: error?.message || 'Failed to load posts',
      });
    }
  }

  return {
    success: true,
    posts: allPosts,
    accounts: accountSummaries,
  };
}

// ─── Engagement Memory Generation ─────────────────────────────────────────────

const MEMORY_MODEL = 'gemini-3.1-flash-lite';

const GENERATE_MEMORY_PROMPT = `You are an expert profile analyst. Based on the LinkedIn profile and recent posts provided, create a concise engagement persona profile in markdown format.

The profile should help an AI write personalized comments and replies that sound natural and relevant to this person's interests and communication style.

Include these sections:
## Bio
A 2-3 sentence summary of who this person is professionally.

## Voice & Tone
Describe their communication style based on their posts (e.g., professional, casual, technical, inspirational).

## Key Topics
Bullet list of 3-7 topics they frequently post about.

## Recent Themes
Bullet list of 2-5 themes from their most recent posts.

## Engagement Style
Brief guidance on how to engage authentically with this person (what resonates, what to avoid).

Keep the entire profile under 500 words. Be specific and actionable, not generic.
IMPORTANT: Always generate the profile with whatever data is available. Never ask for more information. If only a name is provided, create a general professional profile based on the name and account type.`;

const MERGE_MEMORY_PROMPT = `You are an expert profile analyst. You have an existing engagement persona profile and new LinkedIn data (profile info and recent posts).

Your task is to UPDATE the existing profile by:
1. Preserving any user-added customizations or edits (sections, notes, preferences)
2. Updating factual information that has changed (new topics, recent themes)
3. Adding new insights from recent posts
4. Removing outdated information

Return the complete updated profile in the same markdown format (Bio, Voice & Tone, Key Topics, Recent Themes, Engagement Style). Keep it under 500 words.
IMPORTANT: Always output a complete profile. Never ask for more information. If the existing profile seems invalid or empty, generate a fresh one from the available data.`;

/**
 * Generate or sync an engagement memory profile for a connected LinkedIn account.
 * - If no existing memory: generates from scratch using profile + recent posts.
 * - If existing memory: merges new data while preserving user edits.
 */
export async function generateEngagementMemory(
  userId: string,
  account: ConnectedAccount,
  existingMemory?: EngagementMemory | null
): Promise<EngagementMemory> {
  const config = account.config as LinkedInConfig;
  const accessToken = config.access_token;

  // Fetch profile data
  let profileSummary = '';
  try {
    if (config.account_type === 'personal') {
      const profile = await linkedInService.getProfile(accessToken);
      profileSummary = `Name: ${profile.name}\nType: Personal Profile`;
    } else if (config.account_type === 'company_page' && config.organization_id) {
      const orgUrn = `urn:li:organization:${config.organization_id}`;
      profileSummary = `Name: ${account.account_name}\nType: Company Page\nOrg URN: ${orgUrn}`;
    } else {
      profileSummary = `Name: ${account.account_name}\nType: ${config.account_type}`;
    }
  } catch (err) {
    console.warn(`[EngagementMemory] Failed to fetch profile for ${account.account_id}:`, err);
    profileSummary = `Name: ${account.account_name}`;
  }

  // Fetch recent posts — prefer DB cache (always works), fall back to LinkedIn API
  let recentPostsSummary = '';
  try {
    // Try DB cache first (populated by post sync cron)
    console.log(`[EngagementMemory] Fetching cached posts for accountId: ${account.account_id}`);
    const cachedPosts = await getPostsByAccount(account.account_id, 15);
    console.log(`[EngagementMemory] Found ${cachedPosts.length} cached posts`);
    if (cachedPosts.length > 0) {
      recentPostsSummary = cachedPosts
        .map((p, i) => {
          const text = p.content || '';
          const truncated = text.length > 300 ? text.slice(0, 300) + '...' : text;
          return `Post ${i + 1}: ${truncated}`;
        })
        .join('\n\n');
    } else {
      // Fallback: fetch via adapter (handles auth correctly for both personal and company pages)
      const adapter = socialPlatformService.getAdapter(account.platform);
      const posts = await adapter.listPosts(account, { limit: 15 }, userId);
      if (posts.length > 0) {
        recentPostsSummary = posts
          .slice(0, 15)
          .map((p: any, i: number) => {
            const text = p.content || p.commentary || '';
            const truncated = text.length > 300 ? text.slice(0, 300) + '...' : text;
            return `Post ${i + 1}: ${truncated}`;
          })
          .join('\n\n');
      }
    }
  } catch (err) {
    console.warn(`[EngagementMemory] Failed to fetch posts for ${account.account_id}:`, err);
  }

  // Build LLM prompt
  // Detect invalid existing memory (e.g., LLM asked for input instead of generating)
  const existingContent = existingMemory?.content || '';
  const isValidMemory = existingContent.length > 0
    && !existingContent.toLowerCase().includes('please provide')
    && !existingContent.toLowerCase().includes('standing by')
    && !existingContent.toLowerCase().includes('once you provide');
  const isSync = isValidMemory;
  const systemPrompt = isSync ? MERGE_MEMORY_PROMPT : GENERATE_MEMORY_PROMPT;

  let userContent = `## LinkedIn Profile\n${profileSummary}`;
  if (recentPostsSummary) {
    userContent += `\n\n## Recent Posts\n${recentPostsSummary}`;
  }
  if (isSync && existingMemory?.content) {
    userContent += `\n\n## Existing Memory Profile\n${existingMemory.content}`;
  }

  console.log(`[EngagementMemory] LLM input (${isSync ? 'sync' : 'generate'}): ${userContent.slice(0, 200)}...`);

  // Call Gemini flash-lite
  const { agentModeService } = await import('./agentModeService');
  const response = await agentModeService.callLLM(MEMORY_MODEL, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ], {
    temperature: 0.7,
    max_completion_tokens: 1500,
  });

  const generatedContent = response.choices[0]?.message?.content?.trim() || '';
  if (!generatedContent) {
    throw new Error('LLM returned empty response for memory generation');
  }

  const now = new Date().toISOString();
  const memory: EngagementMemory = {
    content: generatedContent,
    lastSyncedAt: now,
    createdAt: existingMemory?.createdAt || now,
    updatedAt: now,
  };

  // Save to connected account
  await saveEngagementMemory(userId, account.account_id, memory);

  return memory;
}

