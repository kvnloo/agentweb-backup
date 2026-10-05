/**
 * ENG-2103 (F2) — social posts & connected-account analytics tool cluster,
 * extracted from `AgentModeService`.
 *
 * Moved verbatim (behavior byte-identical) from `AgentModeService.prototype.*`:
 * createSocialMediaPosts, getTaskSubscriberMetrics,
 * getTaskSubscriberEngagementEvents (contiguous, ~21448-21990 in the
 * pre-extraction file), then listConnectedAccounts (non-contiguous, picking
 * up again at ~23144 after an unrelated block of HTML-template/work-plan/
 * book/ads-description methods), then loadConnectedAccountPosts,
 * loadConnectedAccountMetrics, getPostAnalytics (contiguous with
 * listConnectedAccounts's block once the LinkedIn-posting methods between
 * them are skipped — see below) — the 15th domain cluster in this series.
 *
 * Three private helpers moved alongside the one method each exclusively
 * belongs to (verified by whole-backend grep — zero other callers anywhere):
 *   - `calculateEngagementMetrics` (used only by
 *     getTaskSubscriberEngagementEvents) — was `private`, not async. Moved as
 *     a plain (non-exported) module-scope function.
 *   - `describeMetaAdsCapability` (used only by listConnectedAccounts) — was
 *     `private async`, itself just a documented delegate to
 *     `utils/metaAdsScope.ts`'s own exported `describeMetaAdsCapability`.
 *     Moved as a plain (non-exported) module-scope function of the same name
 *     (the dynamic import inside it shadows the outer function name in its
 *     own body — verified this compiles cleanly, same as the original
 *     method-vs-local-const relationship).
 *   - `describeGoogleAdsAccount` (used only by listConnectedAccounts) — was
 *     `private async`. Moved as a plain (non-exported) module-scope function,
 *     along with its module-scope type dependency `GoogleAdsConfigShape`
 *     (previously a bare top-level `type` in agentModeService.ts, used
 *     nowhere else — moved here, removed there).
 *
 * NOT moved, explicitly out of scope for this cluster (the next cluster,
 * LinkedIn-posting, covers these — confirmed untouched, not even read past
 * what was needed to establish boundaries): `postOnConnectedAccount`,
 * `linkedinManagePost`, `linkedinRepost`, `commentOnLinkedInPost`,
 * `resolveAccessibleAccount`, `listLinkedInComments`, `reactToLinkedInPost`,
 * `linkedinOutreach`, `linkedInDisconnectedResponse`,
 * `linkedInSearchUnavailableResponse`. These sit physically between (and in
 * two cases immediately after) this cluster's methods in the original file
 * but were left exactly where they are.
 *
 * Zero hidden `this.callLLM`/`this.generateImage`/`this.describeImage`/
 * `this.callVisionLLMWithTimeout` coupling anywhere in the 7 moved methods or
 * their 3 helpers — grepped every method body individually (not just a
 * boundary-based line-range grep, given the established lesson that bare
 * `async methodName(...)` declarations without a `public`/`private` keyword
 * — true for 4 of these 7 methods — can cause a narrow boundary grep to
 * misattribute a neighboring method's `this.callLLM` call). None of the 7
 * methods in this cluster make any such call; no exclusions needed.
 *
 * REAL CROSS-DEPENDENCY on out-of-scope code, reported rather than silently
 * worked around: `loadConnectedAccountPosts`, `loadConnectedAccountMetrics`,
 * and `getPostAnalytics` all call `this.resolveAccessibleAccount(...)` —
 * confirmed by whole-backend grep to be a `private` method on
 * `AgentModeService` that ALSO serves two out-of-scope LinkedIn methods
 * (`listLinkedInComments`, `reactToLinkedInPost`), so it is correctly staying
 * on the class untouched for the next cluster. Because it is `private`,
 * external code (this module, and `emma/tools.ts`) has no legal way to call
 * it directly — unlike cluster 13's `WorkPlanModelRegistry` cross-dependency
 * (`getDefaultModel`/`getSupportedModels`, both bare `async` = effectively
 * public), a structural-interface parameter satisfied by handing
 * `agentModeService` itself to `emma/tools.ts`'s call site does NOT
 * typecheck here (`tsc` confirms: "Property 'resolveAccessibleAccount' is
 * private in type 'AgentModeService' but not in type '...'").
 *
 * Resolved by injecting the resolver as an explicit function parameter
 * (`AccountResolver`, defined below) rather than an instance, supplied ONLY
 * by `AgentModeService.prototype.<method>`'s still-present delegating
 * wrapper — the sole code that can legally read a private sibling method —
 * via `this.resolveAccessibleAccount.bind(this)`. A bound method reference
 * handed out as a plain function value is not a privacy violation (verified
 * with a standalone `tsc --strict` reproduction); only the *named,
 * dot-access* form is restricted to the class body. Because `emma/tools.ts`
 * has no comparable legal access to `resolveAccessibleAccount`, its
 * `execute()` bodies for these 3 tools (`get_post_analytics`,
 * `list_connected_account_posts`, `load_connected_account_metrics`)
 * deliberately keep calling `agentModeService.<method>(...)` (the class's
 * delegating wrapper) instead of this module directly — the only 3 of this
 * cluster's 7 tools not repointed straight to `socialAccountsImpl`, and the
 * private-method boundary is the sole reason. `resolveAccessibleAccount`
 * itself is unmodified: no visibility change, no move, no duplicated logic.
 *
 * `AgentModeService.prototype.<name>` now delegates to these functions
 * rather than duplicating them — ALL SEVEN keep a one-line delegating
 * wrapper (none deleted), each with a real caller beyond `emma/tools.ts`,
 * found by grepping the whole backend:
 *   - `createSocialMediaPosts`: `routes/emmaApi.ts`'s `POST /social-posts`
 *     handler, and `agentModeService.createSocialMediaPosts.test.ts` (calls
 *     the real method directly on the real singleton instance, ~20 call
 *     sites).
 *   - `getTaskSubscriberMetrics`: `routes/emmaApi.ts`'s
 *     `GET /task-subscriber-metrics` handler, and
 *     `agentModeService.taskSubscriberMetrics.test.ts` (direct real-instance
 *     calls).
 *   - `getTaskSubscriberEngagementEvents`: `routes/emmaApi.ts`'s
 *     `GET /task-subscriber-engagement-events` handler, and
 *     `agentModeService.engagementMetrics.test.ts` (direct real-instance
 *     calls).
 *   - `listConnectedAccounts`: no production route caller found, but several
 *     test files call the real method directly on a real instance
 *     (`agentModeService.listConnectedAccounts.test.ts`,
 *     `agentModeService.socialTools.test.ts`,
 *     `agentModeService.metaAdsScopeGate.test.ts`) — kept for those.
 *   - `loadConnectedAccountPosts`: `routes/emmaApi.ts`'s
 *     `GET /connected-account-posts` handler, `services/accountSummaryService.ts`
 *     (a genuine caller from another service file — confirmed
 *     `accountSummaryService.ts` does not import back into
 *     `agentModeService.ts` from anywhere else, so no new circularity), and
 *     several test files calling the real method directly.
 *   - `loadConnectedAccountMetrics`: `routes/emmaApi.ts`'s
 *     `GET /connected-account-metrics` handler, and direct real-instance test
 *     calls.
 *   - `getPostAnalytics`: `routes/emmaApi.ts`'s `POST /post-analytics`
 *     handler, `jest.spyOn(service, 'getPostAnalytics')` in
 *     `agentModeService.socialTools.test.ts` (still observed correctly since
 *     the spied-on method remains present on the prototype), and direct
 *     real-instance test calls.
 *
 * Transitive-import notes: `linkedInOutreachService` (used by
 * listConnectedAccounts), `googleAdsService`, and `describeGoogleAdsSpendRisk`
 * (both used by describeGoogleAdsAccount) are all statically imported here,
 * matching how they were already imported in `agentModeService.ts` — verified
 * none of the three imports back into `agentModeService.ts` anywhere (grepped
 * each file), so no new circularity is introduced. `connectedAccountsDb.ts`
 * (listConnectedAccounts), `socialPostsService.ts`
 * (loadConnectedAccountPosts), `socialPlatformService.ts`
 * (loadConnectedAccountMetrics, getPostAnalytics), and `services/db.ts`
 * (listConnectedAccounts's org-hint branch) were all ALREADY lazily
 * `await import(...)`-ed at their call sites in the original code — kept
 * exactly as-is (verbatim), which also happens to already follow the
 * established `services/db.ts` lazy-import idiom for this series without any
 * change needed. `chatbotService.ts`, `settingsService.ts`,
 * `orgProfileResolver.ts`, and `brandGuidelinesPopulation.ts` (the four
 * originally-named traps) are not referenced anywhere in this cluster.
 *
 * No stale-mock regressions found: the one `jest.spyOn` on any of these 7
 * methods (`getPostAnalytics` in `agentModeService.socialTools.test.ts`)
 * mocks the whole method's implementation, which still works because the
 * wrapper stays on the prototype. Every `<method>: jest.fn()` mock object
 * found while grepping either mocks a DIFFERENT identically-named method
 * (each social-platform adapter has its own `getPostAnalytics(account,
 * postIds, ownerId)`, unrelated to this one) or mocks the whole
 * `agentModeService` / `TaskSubscriberMetricsService` module wholesale
 * (`routes.emmaApi.test.ts`, `accountSummary.test.ts`,
 * `agentModeService.taskSubscriberMetrics.test.ts`,
 * `agentModeService.engagementMetrics.test.ts`) — both patterns are already
 * implementation-agnostic and need no changes.
 */
import { linkedInOutreachService } from '../../services/linkedInOutreachService';
import { googleAdsService } from '../../services/googleAdsService';
import { describeGoogleAdsSpendRisk } from '../../utils/googleAdsSpendRisk';

/** Narrow local shape of a stored google_ads config (ENG-1362). Moved verbatim from agentModeService.ts — used only by describeGoogleAdsAccount below. */
type GoogleAdsConfigShape = { customer_id: string; currency?: string; test_account?: boolean };

/**
 * Resolve a connected account the caller can actually reach — their own, or one a
 * teammate explicitly shared with the org — together with the id of the member who
 * owns it. Mirrors the return shape of `AgentModeService.prototype.resolveAccessibleAccount`,
 * which stays PRIVATE on the class (it belongs to the LinkedIn-posting cluster,
 * scheduled next) and is intentionally not moved or touched here — see the module
 * header comment for why `loadConnectedAccountPosts` / `loadConnectedAccountMetrics` /
 * `getPostAnalytics` all accept a resolver of this shape as an explicit parameter
 * instead of reading `this.resolveAccessibleAccount` directly.
 */
export type AccountResolver = (
  callerUserId: string,
  accountId: string,
  preferPlatform?: string
) => Promise<{ account: any; ownerUserId: string } | null>;

export async function createSocialMediaPosts(
  posts: Array<{ type: string; content: string; image_url?: string }>,
  userId: string,
  sessionId: string
): Promise<any> {
  try {
    console.log('AgentMode: Creating social media posts, count:', posts?.length || 0);

    if (!posts || !Array.isArray(posts) || posts.length === 0) {
      return {
        success: false,
        message: 'No posts provided. Please provide an array of posts.',
        error: 'invalid_input'
      };
    }

    // Import required utilities
    const { uploadFileToS3 } = await import('../../utils/s3Utils');

    // Dynamically import remark modules (ES modules)
    const { remark } = await import('remark');
    const remarkHtml = (await import('remark-html')).default;
    const remarkGfm = (await import('remark-gfm')).default;
    const remarkBreaks = (await import('remark-breaks')).default;

    // Convert markdown to HTML processor
    const processor = remark()
      .use(remarkGfm) // GitHub Flavored Markdown support
      .use(remarkBreaks) // Convert line breaks to <br> tags
      .use(remarkHtml, { sanitize: false }); // Convert to HTML

    // Gemini may serialize array items as JSON strings instead of objects — normalize
    const normalizedPosts = posts.map(p => (typeof p === 'string' ? JSON.parse(p) : p));

    // Generate HTML for each post
    const postsHtml = normalizedPosts.map((post, index) => {
      const postNumber = index + 1;
      // Map post types to display labels
      const typeLabelMap: Record<string, string> = {
        'linkedin': 'LinkedIn',
        'x/twitter': 'X (Twitter)',
        'instagram': 'Instagram',
        'facebook': 'Facebook',
        'custom': 'Custom'
      };
      const typeLabel = (post.type && typeLabelMap[post.type]) || (post.type ? post.type.charAt(0).toUpperCase() + post.type.slice(1) : 'Post');

      // Convert markdown content to HTML
      const htmlContent = processor.processSync(post.content || '').toString();

      // Build post HTML
      let postHtml = `
    <div class="post" data-type="${post.type}">
      <div class="post-header">
        <span class="post-number">Post ${postNumber}</span>
        <span class="post-type">${typeLabel}</span>
      </div>
      <div class="post-content">
        ${htmlContent}
      </div>`;

      // Add image if provided
      if (post.image_url) {
        postHtml += `
      <div class="post-image">
        <img src="${post.image_url}" alt="Post image" />
      </div>`;
      }

      // Add copy button
      postHtml += `
      <div class="post-actions">
        <button class="copy-button" onclick="copyPostContent(${index})">Copy Content</button>
      </div>
      <div class="post-raw-content" id="post-${index}-raw" style="display: none;">${post.content}</div>
    </div>`;

      return postHtml;
    }).join('\n');

    // Generate complete HTML file
    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Social Media Posts</title>
  <style>
      * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
      }
      body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
          line-height: 1.6;
          color: #333;
          background-color: #f5f5f5;
          padding: 20px;
      }
      .container {
          max-width: 800px;
          margin: 0 auto;
          background-color: #ffffff;
          border-radius: 8px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          padding: 30px;
      }
      h1 {
          font-size: 28px;
          font-weight: 700;
          margin-bottom: 10px;
          color: #1a1a1a;
      }
      .subtitle {
          color: #666;
          margin-bottom: 30px;
          font-size: 14px;
      }
      .post {
          border: 1px solid #e0e0e0;
          border-radius: 8px;
          padding: 20px;
          margin-bottom: 30px;
          background-color: #fafafa;
      }
      .post-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 15px;
          padding-bottom: 10px;
          border-bottom: 2px solid #e0e0e0;
      }
      .post-number {
          font-weight: 600;
          color: #666;
          font-size: 14px;
      }
      .post-type {
          background-color: #0077b5;
          color: white;
          padding: 4px 12px;
          border-radius: 4px;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
      }
      .post[data-type="x/twitter"] .post-type {
          background-color: #1da1f2;
      }
      .post[data-type="instagram"] .post-type {
          background: linear-gradient(45deg, #f09433 0%, #e6683c 25%, #dc2743 50%, #cc2366 75%, #bc1888 100%);
      }
      .post[data-type="facebook"] .post-type {
          background-color: #1877f2;
      }
      .post[data-type="custom"] .post-type {
          background-color: #666;
      }
      .post-content {
          margin: 15px 0;
          font-size: 16px;
          line-height: 1.6;
          color: #333;
      }
      .post-content p {
          margin-bottom: 12px;
      }
      .post-content h1, .post-content h2, .post-content h3 {
          margin-top: 20px;
          margin-bottom: 12px;
      }
      .post-content ul, .post-content ol {
          margin-left: 20px;
          margin-bottom: 12px;
      }
      .post-content a {
          color: #0077b5;
          text-decoration: none;
      }
      .post-content a:hover {
          text-decoration: underline;
      }
      .post-content img {
          max-width: 100%;
          height: auto;
          border-radius: 4px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
          margin: 15px 0;
          display: block;
      }
      .post-image {
          margin: 15px 0;
      }
      .post-image img {
          max-width: 100%;
          height: auto;
          border-radius: 4px;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }
      .post-actions {
          margin-top: 15px;
          padding-top: 15px;
          border-top: 1px solid #e0e0e0;
      }
      .copy-button {
          background-color: #0077b5;
          color: white;
          border: none;
          padding: 8px 16px;
          border-radius: 4px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 500;
          transition: background-color 0.2s;
      }
      .copy-button:hover {
          background-color: #005885;
      }
      .copy-button:active {
          transform: scale(0.98);
      }
      .post-raw-content {
          display: none;
      }
      @media (max-width: 600px) {
          .container {
              padding: 15px;
          }
          .post {
              padding: 15px;
          }
      }
  </style>
</head>
<body>
  <div class="container">
      <h1>Social Media Posts</h1>
      <p class="subtitle">${posts.length} post${posts.length !== 1 ? 's' : ''} created</p>
      ${postsHtml}
  </div>
  <script>
      function copyPostContent(index) {
          const rawContentElement = document.getElementById('post-' + index + '-raw');
          if (!rawContentElement) return;

          const content = rawContentElement.textContent || rawContentElement.innerText;

          // Create a temporary textarea to copy text
          const textarea = document.createElement('textarea');
          textarea.value = content;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();

          try {
              document.execCommand('copy');
              const button = event.target;
              const originalText = button.textContent;
              button.textContent = 'Copied!';
              button.style.backgroundColor = '#28a745';
              setTimeout(() => {
                  button.textContent = originalText;
                  button.style.backgroundColor = '#0077b5';
              }, 2000);
          } catch (err) {
              console.error('Failed to copy:', err);
              alert('Failed to copy content. Please select and copy manually.');
          }

          document.body.removeChild(textarea);
      }
  </script>
</body>
</html>`;

    // Upload HTML file to S3
    console.log('AgentMode: Uploading social media posts HTML file to S3...');
    const htmlFilename = `social-media-posts-${Date.now()}.html`;

    const uploadResult = await uploadFileToS3(
      htmlContent,
      htmlFilename,
      userId,
      'text/html'
    );

    if (!uploadResult.success || !uploadResult.url) {
      const uploadErr: any = new Error(uploadResult.error || 'Failed to upload HTML file to S3');
      uploadErr.status = uploadResult.statusCode;
      throw uploadErr;
    }

    const htmlUrl = uploadResult.url;

    console.log('AgentMode: Social media posts HTML file uploaded successfully to:', htmlUrl);

    return {
      success: true,
      message: `Successfully created ${posts.length} social media post${posts.length !== 1 ? 's' : ''}`,
      htmlUrl: htmlUrl,
      postsCount: posts.length
    };

  } catch (error: any) {
    console.error('AgentMode: Error creating social media posts:', error);
    return {
      success: false,
      message: 'Failed to create social media posts',
      error: error.message,
      // ENG-1300: this function never actually calls any per-platform social
      // API — it's a local markdown-to-HTML preview generator, and the only
      // external call is the S3 upload. Real HTTP status from there, when
      // that's what failed (uploadFileToS3's numeric statusCode).
      code: error?.status
    };
  }
}

/**
 * Get task subscriber metrics for Agent Mode function calls
 */
export async function getTaskSubscriberMetrics(taskId: string, userId: string): Promise<any> {
  try {
    const { TaskSubscriberMetricsService } = await import('../../services/taskSubscriberMetricsService');
    const metrics = await TaskSubscriberMetricsService.getTaskSubscriberMetrics(taskId, userId);

    // Strip engagedEmails from subject metrics to reduce data for agent processing
    const cleanedMetrics = {
      ...metrics,
      metrics: {
        ...metrics.metrics,
        subjectMetrics: Object.fromEntries(
          Object.entries(metrics.metrics.subjectMetrics).map(([subject, subjectData]) => [
            subject,
            Object.fromEntries(
              Object.entries(subjectData).filter(([key]) => key !== 'engagedEmails')
            )
          ])
        )
      }
    };

    return {
      success: true,
      message: 'Task subscriber metrics retrieved successfully',
      data: cleanedMetrics
    };
  } catch (error: any) {
    console.error('AgentMode: Error getting task subscriber metrics:', error);
    return {
      success: false,
      message: 'Failed to get task subscriber metrics',
      error: error.message
    };
  }
}

/**
 * Get task subscriber engagement events for Agent Mode function calls
 * Returns engagement metrics instead of raw events for better agent processing
 */
export async function getTaskSubscriberEngagementEvents(taskId: string, emailSubject: string, userId: string): Promise<any> {
  try {
    const { TaskSubscriberMetricsService } = await import('../../services/taskSubscriberMetricsService');
    const events = await TaskSubscriberMetricsService.getTaskSubscriberEngagementEvents(taskId, emailSubject, userId);

    // Transform raw events into meaningful engagement metrics
    const engagementMetrics = calculateEngagementMetrics(events);

    return {
      success: true,
      message: 'Task subscriber engagement metrics retrieved successfully',
      data: engagementMetrics
    };
  } catch (error: any) {
    console.error('AgentMode: Error getting task subscriber engagement events:', error);
    return {
      success: false,
      message: 'Failed to get task subscriber engagement events',
      error: error.message
    };
  }
}

/**
 * Calculate engagement metrics from raw events data
 * Used only by getTaskSubscriberEngagementEvents above — see module header.
 */
function calculateEngagementMetrics(events: any) {
  const { eventsByUser, totalEngagedUsers, taskId, emailSubject } = events;

  if (totalEngagedUsers === 0) {
    return {
      taskId,
      emailSubject,
      engagementPatterns: {
        immediateEngagement: 0,
        delayedEngagement: 0,
        multiTouchEngagement: 0,
        singleTouchEngagement: 0
      },
      timingMetrics: {
        averageTimeToOpen: null,
        averageTimeToClick: null,
        fastestEngagement: null,
        slowestEngagement: null
      },
      linkAnalysis: []
    };
  }

  // Calculate engagement-specific metrics
  let clickedCount = 0;
  const linkClicks = new Map<string, number>();
  const engagementTimes: number[] = [];
  const openTimes: number[] = [];
  const clickTimes: number[] = [];

  // Analyze each user's engagement
  let immediateEngagement = 0; // Users who engaged within 1 hour
  let delayedEngagement = 0; // Users who engaged after 1 hour
  let multiTouchEngagement = 0; // Users with 2+ engagement events (opened or clicked)
  let singleTouchEngagement = 0; // Users with only 1 engagement event (opened or clicked)

  eventsByUser.forEach((user: any) => {
    const userEvents = user.events;

    // Count event types for engagement analysis
    const eventTypes = new Set(userEvents.map((e: any) => e.eventType));
    userEvents.forEach((event: any) => {
      if (event.eventType === 'email.clicked') {
        clickedCount++;
        if (event.link) {
          // Normalize unsubscribe links by replacing email with placeholder
          let normalizedLink = event.link;
          if (event.link.includes('/unsubscribe?') && event.link.includes('email=')) {
            normalizedLink = event.link.replace(/email=[^&]+/, 'email=placeholder@example.com');
          }
          linkClicks.set(normalizedLink, (linkClicks.get(normalizedLink) || 0) + 1);
        }
      }
    });

    // Calculate engagement timing
    if (userEvents.length > 0) {
      const firstEvent = userEvents[0];
      const firstEventTime = new Date(firstEvent.createdAt).getTime();
      const emailSentTime = firstEventTime; // Assuming first event is delivery

      // Find first engagement (open or click)
      const firstEngagement = userEvents.find((e: any) =>
        e.eventType === 'email.opened' || e.eventType === 'email.clicked'
      );

      if (firstEngagement) {
        const engagementTime = new Date(firstEngagement.createdAt).getTime();
        const timeToEngagement = engagementTime - emailSentTime;
        engagementTimes.push(timeToEngagement);

        // Categorize engagement timing
        if (timeToEngagement <= 3600000) { // 1 hour in milliseconds
          immediateEngagement++;
        } else {
          delayedEngagement++;
        }
      }

      // Find open and click times
      const openEvent = userEvents.find((e: any) => e.eventType === 'email.opened');
      const clickEvent = userEvents.find((e: any) => e.eventType === 'email.clicked');

      if (openEvent) {
        const openTime = new Date(openEvent.createdAt).getTime();
        openTimes.push(openTime - emailSentTime);
      }

      if (clickEvent) {
        const clickTime = new Date(clickEvent.createdAt).getTime();
        clickTimes.push(clickTime - emailSentTime);
      }

      // Categorize engagement depth based on opened/clicked events
      const engagementEvents = userEvents.filter((event: any) =>
        event.eventType === 'email.opened' || event.eventType === 'email.clicked'
      );

      if (engagementEvents.length >= 2) {
        multiTouchEngagement++;
      } else if (engagementEvents.length === 1) {
        singleTouchEngagement++;
      }
    }
  });

  // Calculate timing metrics
  const averageTimeToOpen = openTimes.length > 0
    ? Math.round(openTimes.reduce((a, b) => a + b, 0) / openTimes.length / 1000 / 60) // Convert to minutes
    : null;

  const averageTimeToClick = clickTimes.length > 0
    ? Math.round(clickTimes.reduce((a, b) => a + b, 0) / clickTimes.length / 1000 / 60) // Convert to minutes
    : null;

  const fastestEngagement = engagementTimes.length > 0
    ? Math.round(Math.min(...engagementTimes) / 1000 / 60) // Convert to minutes
    : null;

  const slowestEngagement = engagementTimes.length > 0
    ? Math.round(Math.max(...engagementTimes) / 1000 / 60) // Convert to minutes
    : null;

  // Convert link clicks map to array of objects
  const linkAnalysis = Array.from(linkClicks.entries()).map(([url, clicks]) => ({
    url,
    clicks
  })).sort((a, b) => b.clicks - a.clicks); // Sort by click count descending

  return {
    taskId,
    emailSubject,
    engagementPatterns: {
      immediateEngagement,
      delayedEngagement,
      multiTouchEngagement,
      singleTouchEngagement
    },
    timingMetrics: {
      averageTimeToOpen,
      averageTimeToClick,
      fastestEngagement,
      slowestEngagement
    },
    linkAnalysis
  };
}

/**
 * Capability annotation for a Meta ad account in list_connected_accounts.
 *
 * Returns `{}` for non-Meta accounts and for Meta records whose grant we cannot
 * prove either way, so the payload only ever carries facts. (ENG-629 AC1)
 *
 * Used only by listConnectedAccounts below — see module header.
 */
async function describeMetaAdsCapability(acc: any): Promise<Record<string, any>> {
  // Delegates to the shared helper so this payload and the Settings → Connected
  // accounts payload are provably the same judgement (ENG-1158). They used to be
  // computed independently, which is how an account could be "degraded" here and
  // a green "Connected" row in the UI at the same moment.
  const { describeMetaAdsCapability } = await import('../../utils/metaAdsScope');
  return describeMetaAdsCapability(acc);
}

/**
 * ENG-1362. What an agent needs to know before choosing a Google Ads account to act on.
 *
 * `is_active` and `account_name` were the whole of it, which meant the only signal for
 * "is this safe to experiment in" was the NAME — and a name guarantees nothing. There is
 * a real, billable, ENABLED account on this platform whose descriptive name is literally
 * "Test". An agent asked to "use the test account" would pick it on the strength of that
 * string and spend real money.
 *
 * Google's own mechanism is `customer.test_account`: when true, the account CANNOT serve
 * ads and CANNOT spend. That is the fact worth surfacing, so it is surfaced.
 *
 * `can_spend` is derived here rather than left to each caller, and derived so that only
 * an affirmative `test_account: true` clears it. `false` and unknown both mean real
 * money. Making every consumer re-derive that is how "we never recorded it" quietly
 * becomes "it's fine".
 *
 * Used only by listConnectedAccounts below — see module header.
 */
async function describeGoogleAdsAccount(
  userId: string,
  config: GoogleAdsConfigShape,
): Promise<Record<string, unknown>> {
  const customerId = config.customer_id;
  // Recorded at connect time for anything connected since ENG-1362; resolved live (and
  // process-cached) for older records, so the answer is never simply missing.
  const testAccount = typeof config.test_account === 'boolean'
    ? config.test_account
    : await googleAdsService.isTestAccount(userId, customerId);
  return {
    customer_id: customerId,
    currency: config.currency || 'USD',
    // Same single rule the connected-accounts route uses. Two copies of "does true mean
    // safe" is how one of them eventually stops meaning it.
    ...describeGoogleAdsSpendRisk({ test_account: testAccount }),
  };
}

export async function listConnectedAccounts(userId: string, platform: string = 'all'): Promise<any> {
  try {
    const { getAccountsByUserIdIncludingOrgShared, isTokenValid } = await import('../../services/connectedAccountsDb');

    let accounts = await getAccountsByUserIdIncludingOrgShared(userId);

    if (platform && platform !== 'all') {
      accounts = accounts.filter(acc => acc.platform === platform);
    }

    // Unipile-managed (LinkedIn Outreach) accounts are saved with
    // token_expires_at = Number.MAX_SAFE_INTEGER (see linkedInOutreachAuth.ts)
    // since Unipile — not us — owns the session lifecycle. isTokenValid() only
    // performs a live API check for platform === 'linkedin'; for 'unipile' it
    // falls through to the timestamp-only check, which never expires and so
    // always reports is_active: true even after the underlying LinkedIn
    // session has died on Unipile's side (checkpoint, remote logout, etc).
    // Use the real Unipile connectivity check instead — the same one already
    // used by GET /api/oauth/connected-accounts (routes/connectedAccounts.ts)
    // — so this tool doesn't report a dead account as active.
    const unipileAccountIds = accounts
      .filter(acc => acc.platform === 'unipile')
      .map(acc => acc.account_id);
    const unipileStatusMap = unipileAccountIds.length > 0
      ? await linkedInOutreachService.getStatusesForAccounts(unipileAccountIds)
      : new Map<string, string>();

    // When a platform-specific lookup finds nothing the caller can access, the
    // account may still be connected by an org teammate who never shared it (the
    // ENG-368 case: a private Google Ads account owned by another member). Rather
    // than inspect teammates' private accounts to confirm — which would disclose
    // the existence of an account its owner deliberately kept private — surface
    // that possibility as a hint, but ONLY when the caller actually belongs to an
    // org. A solo user has no teammates, so the "ask a teammate to share" wording
    // would be confusing; they get a plain connect prompt instead. We check only
    // the caller's own orgId (never teammates' accounts), so the org privacy model
    // stays intact. Any uncertainty (missing user) falls back to the plain message.
    let message = `Found ${accounts.length} connected account(s)`;
    if (accounts.length === 0 && platform && platform !== 'all') {
      const { userDb } = await import('../../services/db');
      const caller = await userDb.getUserById(userId);
      const callerInOrg = !!(caller && (caller as any).orgId);
      if (callerInOrg) {
        message = `Found 0 ${platform} account(s) available to you. If a teammate in your organization has connected ${platform} but hasn't shared it, they'll need to open Settings → Connected Accounts and click "Share with org" — otherwise, connect ${platform} under this account directly.`;
      } else {
        message = `Found 0 ${platform} account(s). Connect ${platform} in Settings → Connected Accounts to continue.`;
      }
    }

    return {
      success: true,
      message,
      accounts: await Promise.all(accounts.map(async acc => ({
        id: acc.account_id,
        platform: acc.platform,
        account_name: acc.account_name,
        account_type: acc.config.account_type,
        is_active: acc.platform === 'unipile'
          ? unipileStatusMap.get(acc.account_id) === 'OK'
          : await isTokenValid(acc),
        ...(acc.platform === 'google_ads' && (acc.config as { customer_id?: string })?.customer_id
          ? await describeGoogleAdsAccount(userId, acc.config as GoogleAdsConfigShape)
          : {}),
        // A Meta ad account can be connected and unexpired yet unable to read ads
        // data because the owner never granted ads_read/ads_management. Without
        // this, `is_active: true` alone reads as "fully capable" and the model
        // plans work it cannot complete (ENG-629). Only emitted when we actually
        // know — an unknown legacy record stays silent rather than crying wolf.
        ...(await describeMetaAdsCapability(acc)),
      })))
    };
  } catch (error) {
    console.error('AgentMode: Error listing connected accounts:', error);
    return {
      success: false,
      message: 'Failed to list connected accounts',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

export async function loadConnectedAccountPosts(
  resolveAccessibleAccount: AccountResolver,
  userId: string,
  accountId: string,
  options: { limit?: number; include_metrics?: boolean; force_reload?: boolean } = {}
): Promise<any> {
  console.log('[AgentMode] loadConnectedAccountPosts called:', {
    userId,
    accountId,
    options
  });

  try {
    // ENG-1385: existence must be org-shared-aware (resolveAccessibleAccount),
    // not a plain per-caller lookup — a company page list_connected_accounts
    // reports as active can be owned by a teammate and shared with the org.
    const resolved = await resolveAccessibleAccount(userId, accountId);
    if (!resolved) {
      return {
        success: false,
        message: 'Account not found or access denied'
      };
    }
    const { account, ownerUserId } = resolved;

    // getPostsForUser does its own internal account lookup — it must be handed
    // the account's real owner, not the caller, or it re-derives nothing for a
    // teammate-owned account. Also matches every adapter call below needing the
    // owner's id for token lookup/refresh, same as loadConnectedAccountMetrics.
    const { getPostsForUser } = await import('../../services/socialPostsService');
    const result = await getPostsForUser(ownerUserId, {
      accountId,
      limit: options.limit || 10,
      includeMetrics: options.include_metrics !== false,
      forceReload: options.force_reload === true,
    });

    // If the account wasn't processed (adapter threw), treat as failure
    if (result.accounts.length === 0) {
      return {
        success: false,
        message: 'Failed to load posts',
      };
    }

    // If the account errored (0 posts + error field), surface the real error
    const accountResult = result.accounts.find(a => a.accountId === accountId);
    if (accountResult?.error && result.posts.length === 0) {
      return {
        success: false,
        message: `Failed to load posts: ${accountResult.error}`,
        error: accountResult.error,
        code: accountResult.code,
      };
    }

    // ENG-660: for a personal LinkedIn account, AgentWeb works from the posts
    // created through AgentWeb itself (personal profiles have no organic post
    // ingestion — only AgentWeb-published posts are ever on file). When none
    // are on file, a bare "Successfully loaded 0 posts" led the model to claim
    // the fetch of the
    // user's posts succeeded (a tool-success hallucination). Signal this as an
    // explicitly-unsupported read via organicReadUnsupported + the message so
    // the model states the truth instead of implying it read the user's
    // LinkedIn. success stays true on purpose: nothing failed (the account is
    // connected and healthy), so this must NOT render as a tool "failure" in
    // the UI. The message leads with what AgentWeb DOES (positive, ownership
    // framing) so the model doesn't present this as a weakness/"limitation".
    const accountType = (account.config as any)?.account_type;
    if (result.posts.length === 0 && account.platform === 'linkedin' && accountType === 'personal') {
      return {
        success: true,
        organicReadUnsupported: true,
        posts: [],
        message:
          'AgentWeb works from the LinkedIn posts you create with it, and there aren\'t any AgentWeb-created posts on file for this personal account — so there\'s nothing here to analyze for writing voice. Frame this as normal AgentWeb behavior and keep the focus on the constructive next step — do not describe it as a shortcoming and do not blame any external platform. Do NOT claim you have read or analyzed the user\'s existing LinkedIn posts, and there\'s no need to retry. The best next step: invite the user to paste or upload a few of their recent posts, then build their writing-voice profile from those — and offer to save it so future posts match their style.',
      };
    }

    return {
      success: true,
      message: `Successfully loaded ${result.posts.length} posts`,
      posts: result.posts
    };
  } catch (error) {
    console.error('AgentMode: Error loading connected account posts:', error);
    return {
      success: false,
      message: 'Failed to load posts',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

// Load metrics for connected account helper
export async function loadConnectedAccountMetrics(
  resolveAccessibleAccount: AccountResolver,
  userId: string,
  accountId: string,
  startDate?: Date,
  endDate?: Date
): Promise<any> {
  try {
    const { socialPlatformService } = await import('../../services/socialPlatformService');

    try {
      const resolved = await resolveAccessibleAccount(userId, accountId);

      if (!resolved) {
        return {
          success: false,
          message: 'Account not found or access denied'
        };
      }
      const { account, ownerUserId } = resolved;

      const adapter = socialPlatformService.getAdapter(account.platform);

      const metrics = await adapter.getAccountMetrics(account, ownerUserId, startDate, endDate);

      return {
        success: true,
        message: `Metrics loaded successfully from ${account.platform}`,
        metrics: metrics
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Failed to load metrics: ${error.message}`,
        code: error?.code
      };
    }

  } catch (error) {
    console.error('AgentMode: Error loading connected account metrics:', error);
    return {
      success: false,
      message: 'Failed to load metrics',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Get detailed analytics for specific posts
 * The account must belong to the authenticated user
 */
export async function getPostAnalytics(
  resolveAccessibleAccount: AccountResolver,
  userId: string,
  accountId: string,
  postIds: string[]
): Promise<any> {
  console.log('[AgentMode] getPostAnalytics called:', {
    userId,
    accountId,
    postIds: postIds?.length || 0
  });

  try {
    if (!postIds || postIds.length === 0) {
      return {
        success: false,
        message: 'No post IDs provided'
      };
    }

    const { socialPlatformService } = await import('../../services/socialPlatformService');

    // Verify the caller can reach this account (own or org-shared)
    const resolved = await resolveAccessibleAccount(userId, accountId);
    if (!resolved) {
      return {
        success: false,
        message: 'Account not found or access denied'
      };
    }
    const { account, ownerUserId } = resolved;

    const adapter = socialPlatformService.getAdapter(account.platform);
    const analytics = await adapter.getPostAnalytics(account, postIds, ownerUserId);

    // Check for any errors in the results
    const failedCount = analytics.filter((a: any) => a.error).length;
    const successCount = analytics.length - failedCount;

    return {
      success: true,
      message: failedCount > 0
        ? `Retrieved analytics for ${successCount}/${analytics.length} posts (${failedCount} failed)`
        : `Successfully retrieved analytics for ${analytics.length} post(s)`,
      analytics,
      summary: {
        totalPosts: analytics.length,
        successCount,
        failedCount
      }
    };

  } catch (error) {
    console.error('AgentMode: Error getting post analytics:', error);
    return {
      success: false,
      message: 'Failed to get post analytics',
      error: error instanceof Error ? error.message : 'Unknown error',
      code: (error as any)?.code
    };
  }
}
