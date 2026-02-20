import express from 'express';
import path from 'path';
import { authenticateToken } from '../middleware/auth';
import { userDb, taskDb } from '../services/db';
import { metaService } from '../services/metaService';

const router = express.Router();
router.use(authenticateToken);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const cleanAccountId = (id: string) => (id || '').replace('act_', '');

/**
 * Return all connected Meta ad-account entries for a user.
 */
function getConnectedMetaAccountsList(user: any) {
  const accounts = user.connected_accounts || [];
  return accounts
    .filter((acc: any) =>
      (acc.platform === 'facebook' || acc.platform === 'meta') &&
      acc.config?.account_type === 'ad_account' &&
      acc.config?.access_token
    )
    .map((acc: any) => ({
      accountId: cleanAccountId(acc.account_id || acc.config?.ad_account_id || ''),
      accountName: acc.account_name || acc.config?.name || 'Unknown Account',
      currency: acc.config?.currency || 'USD',
      status: acc.config?.account_status,
      tokenExpiresAt: acc.config?.token_expires_at || null,
    }));
}

/**
 * Get credentials for a specific (or the only) Meta ad account.
 * Throws a user-friendly error if the account is missing/expired.
 */
function getMetaAccountCredentials(
  user: any,
  accountId?: string
): { accountId: string; accessToken: string; accountName: string } {
  const accounts = user.connected_accounts || [];
  const fbAccounts = accounts.filter((acc: any) =>
    (acc.platform === 'facebook' || acc.platform === 'meta') &&
    acc.config?.account_type === 'ad_account' &&
    acc.config?.access_token
  );

  if (fbAccounts.length === 0) {
    throw new Error(
      'No Meta ad account connected. Please connect your Facebook account in Settings.'
    );
  }

  let selected: any;

  if (accountId) {
    const target = cleanAccountId(accountId);
    selected = fbAccounts.find(
      (acc: any) => cleanAccountId(acc.account_id || acc.config?.ad_account_id || '') === target
    );
    if (!selected) {
      throw new Error(
        `Meta ad account "${accountId}" not found in your connected accounts.`
      );
    }
  } else if (fbAccounts.length === 1) {
    selected = fbAccounts[0];
  } else {
    throw new Error(
      'Multiple Meta ad accounts found. Please specify account_id.'
    );
  }

  if (selected.config?.token_expires_at && selected.config.token_expires_at < Date.now()) {
    throw new Error(
      'Meta access token has expired. Please reconnect your Meta account in Settings.'
    );
  }

  return {
    accountId: cleanAccountId(selected.account_id || selected.config?.ad_account_id || ''),
    accessToken: selected.config.access_token,
    accountName: selected.account_name || selected.config?.name || 'Unknown Account',
  };
}

/**
 * Append UTM parameters to a URL query string.
 */
function applyUtmParams(url: string, utm: any): string {
  if (!utm || !url) return url;
  try {
    const parsed = new URL(url);
    if (utm.utm_source) parsed.searchParams.set('utm_source', utm.utm_source);
    if (utm.utm_medium) parsed.searchParams.set('utm_medium', utm.utm_medium);
    if (utm.utm_campaign) parsed.searchParams.set('utm_campaign', utm.utm_campaign);
    if (utm.utm_content) parsed.searchParams.set('utm_content', utm.utm_content);
    return parsed.toString();
  } catch { return url; }
}

/**
 * Download a remote image and return a Buffer + resolved filename.
 * Converts WebP/GIF/BMP/TIFF → JPEG for Meta compatibility.
 */
async function downloadAndPrepareImage(
  imageUrl: string,
  fallbackName = 'ad-image.jpg'
): Promise<{ buffer: Buffer; filename: string }> {
  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw new Error(`Failed to download image from ${imageUrl}: ${response.status}`);
  }
  let buffer = Buffer.from(await response.arrayBuffer());

  // Resolve filename from URL
  let filename = fallbackName;
  try {
    const pathname = new URL(imageUrl).pathname;
    const name = path.basename(pathname);
    if (name && name.includes('.')) filename = name;
  } catch { /* ignore */ }

  // Convert unsupported formats to JPEG
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  if (['webp', 'gif', 'bmp', 'tiff'].includes(ext)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sharp = require('sharp');
      buffer = await sharp(buffer).jpeg({ quality: 90 }).toBuffer();
      filename = filename.replace(/\.[^/.]+$/, '.jpg');
    } catch { /* sharp unavailable — pass original, Meta may reject */ }
  }

  return { buffer, filename };
}

/**
 * Upload an image to the Meta ad account and return its hash string.
 */
async function uploadImageGetHash(
  accountId: string,
  accessToken: string,
  imageUrl: string,
  fallbackName?: string
): Promise<string> {
  const { buffer, filename } = await downloadAndPrepareImage(imageUrl, fallbackName);
  const result = await metaService.uploadImage(accountId, accessToken, filename, buffer);
  // SDK returns { images: { <filename>: { hash, url, ... } } } or flat { hash, ... }
  const imageEntry = result?.images ? Object.values(result.images)[0] as any : result;
  const hash: string = imageEntry?.hash || result?.hash;
  if (!hash) throw new Error('Image uploaded but no hash was returned by Meta.');
  return hash;
}

/**
 * Persist meta_ad info onto the matching result_file in a task execution.
 */
async function recordAdOnExecution(
  executionId: string,
  userId: string,
  matchUrl: string,
  adInfo: object
): Promise<void> {
  try {
    const execution = await taskDb.getTaskExecutionById(executionId);
    if (execution && execution.userId === userId) {
      const updated = (execution.result_files || []).map((f: any) =>
        f.url === matchUrl ? { ...f, meta_ad: adInfo } : f
      );
      await taskDb.updateTaskExecution(executionId, { result_files: updated });
    }
  } catch (err) {
    console.error('[MetaV2] recordAdOnExecution error (non-fatal):', err);
  }
}

/**
 * Append an assistant message to an agent-mode chat session.
 */
async function appendSessionMessage(
  sessionId: string,
  adName: string,
  managementUrl: string
): Promise<void> {
  try {
    const { chatbotDb } = await import('../services/chatbotService');
    await chatbotDb.addMessageToSession(sessionId, {
      role: 'assistant',
      content: `<p>✅ Meta Ad "<strong>${adName}</strong>" created successfully and is in draft status.</p>
<p><a href="${managementUrl}" target="_blank">Open in Facebook Ads Manager →</a></p>`,
      metadata: { timestamp: new Date().toISOString(), portalType: 'agent' },
    });
  } catch (err) {
    console.error('[MetaV2] appendSessionMessage error (non-fatal):', err);
  }
}

// ---------------------------------------------------------------------------
// GET /api/meta/v2/accounts
// Returns all connected Meta ad accounts for the current user.
// ---------------------------------------------------------------------------
router.get('/accounts', async (req, res) => {
  const userId = (req as any).user.userId;
  try {
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const accounts = getConnectedMetaAccountsList(user);
    res.json({ accounts });
  } catch (error: any) {
    console.error('[MetaV2] /accounts error:', error);
    res.status(500).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/meta/v2/campaigns-and-adsets?account_id=<id>
// Returns campaigns (with objective), ad sets (with budget), and pages.
// ---------------------------------------------------------------------------
router.get('/campaigns-and-adsets', async (req, res) => {
  const userId = (req as any).user.userId;
  const accountId = req.query.account_id as string | undefined;

  try {
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { accountId: resolvedAccountId, accessToken } = getMetaAccountCredentials(user, accountId);

    const [campaigns, adSets, pages] = await Promise.all([
      metaService.listCampaigns(resolvedAccountId, accessToken),
      metaService.listAdSets(resolvedAccountId, accessToken),
      metaService.getPages(accessToken),
    ]);

    res.json({
      campaigns: (campaigns || []).map((c: any) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        objective: c.objective || null, // included for display label
      })),
      adSets: (adSets || []).map((as: any) => ({
        id: as.id,
        name: as.name,
        campaign_id: as.campaign_id,
        status: as.status,
        daily_budget: as.daily_budget,
        lifetime_budget: as.lifetime_budget,
        is_dynamic_creative: as.is_dynamic_creative || false,
      })),
      pages: (pages || []).map((p: any) => ({ id: p.id, name: p.name })),
    });
  } catch (error: any) {
    console.error('[MetaV2] /campaigns-and-adsets error:', error);
    const status = error.message?.includes('not connected') || error.message?.includes('not found') ? 400 : 500;
    res.status(status).json({ message: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/meta/v2/create-image-ad
// Single-image ad flow using connected_accounts OAuth token.
// ---------------------------------------------------------------------------
router.post('/create-image-ad', async (req, res) => {
  const userId = (req as any).user.userId;
  const {
    account_id, image_url, campaign_id, ad_set_id, page_id,
    ad_name, primary_texts, headlines, url_descriptions, ad_call_to_action,
    link_url, utm_params, add_website_url, optimize_creative, task_id, execution_id, session_id,
  } = req.body;

  try {
    if (!image_url || !campaign_id || !ad_set_id || !page_id || !ad_name?.trim()) {
      return res.status(400).json({
        message: 'Missing required fields: image_url, campaign_id, ad_set_id, page_id, ad_name',
      });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { accountId, accessToken } = getMetaAccountCredentials(user, account_id);

    // 1. Upload image
    const imageHash = await uploadImageGetHash(accountId, accessToken, image_url, 'ad-image.jpg');

    // 2. Create ad creative
    const allPrimaryTexts = (primary_texts || []).map((t: string) => t.trim()).filter(Boolean);
    const allHeadlines = (headlines || []).map((h: string) => h.trim()).filter(Boolean);
    const allUrlDescriptions = (url_descriptions || []).map((d: string) => d.trim()).filter(Boolean);
    const creative = await metaService.createAdCreative(accountId, accessToken, {
      name: `${ad_name.trim()} - Creative`,
      page_id,
      body: allPrimaryTexts[0] || '',
      extra_bodies: allPrimaryTexts.slice(1),
      title: allHeadlines[0] || ad_name.trim(),
      extra_titles: allHeadlines.slice(1),
      description: allUrlDescriptions[0] || '',
      extra_descriptions: allUrlDescriptions.slice(1),
      add_website_url: add_website_url !== false,
      link_url: add_website_url !== false ? applyUtmParams(link_url?.trim() || undefined, utm_params) : undefined,
      image_hash: imageHash,
      call_to_action_type: ad_call_to_action || undefined,
      optimize_creative: !!optimize_creative,
    });

    // 3. Create ad
    const ad = await metaService.createAd(accountId, accessToken, {
      name: ad_name.trim(),
      adset_id: ad_set_id,
      creative_id: creative.id,
      status: 'PAUSED',
    });

    const managementUrl = `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${accountId}`;

    const adInfo = {
      adId: ad.id,
      adName: ad_name.trim(),
      campaignId: campaign_id,
      adSetId: ad_set_id,
      pageId: page_id,
      creativeId: creative.id,
      imageHash,
      managementUrl,
      status: 'PAUSED',
      createdAt: new Date().toISOString(),
    };

    if (execution_id) await recordAdOnExecution(execution_id, userId, image_url, adInfo);
    if (session_id) await appendSessionMessage(session_id, ad_name.trim(), managementUrl);

    res.json({
      success: true,
      adId: ad.id,
      managementUrl,
      message: 'Ad created successfully in paused status. Review and publish in Facebook Ads Manager.',
    });
  } catch (error: any) {
    console.error('[MetaV2] /create-image-ad error:', error);
    res.status(400).json({ message: error.message, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/meta/v2/create-carousel-ad
// Multi-image carousel ad flow.
// ---------------------------------------------------------------------------
router.post('/create-carousel-ad', async (req, res) => {
  const userId = (req as any).user.userId;
  const {
    account_id,
    images,       // Array<{ url: string; title?: string; link_url?: string }>
    campaign_id, ad_set_id, page_id,
    ad_name, primary_texts, ad_call_to_action, default_link_url, utm_params,
    session_id,
  } = req.body;

  try {
    if (!Array.isArray(images) || images.length < 2) {
      return res.status(400).json({ message: 'Carousel requires at least 2 images.' });
    }
    if (images.length > 10) {
      return res.status(400).json({ message: 'Carousel supports a maximum of 10 images.' });
    }
    if (!campaign_id || !ad_set_id || !page_id || !ad_name?.trim()) {
      return res.status(400).json({ message: 'Missing required fields: campaign_id, ad_set_id, page_id, ad_name' });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { accountId, accessToken } = getMetaAccountCredentials(user, account_id);
    const fallbackLink = applyUtmParams(default_link_url?.trim() || 'https://example.com', utm_params);

    // Upload all images in parallel and build carousel_cards
    const carousel_cards = await Promise.all(
      images.map(async (img: { url: string; title?: string; link_url?: string }, idx: number) => {
        const imageHash = await uploadImageGetHash(
          accountId, accessToken, img.url, `carousel-slide-${idx + 1}.jpg`
        );
        return {
          image_hash: imageHash,
          title: img.title || undefined,
          link_url: img.link_url?.trim() ? applyUtmParams(img.link_url.trim(), utm_params) : fallbackLink,
        };
      })
    );

    // Create carousel creative
    const creative = await metaService.createAdCreative(accountId, accessToken, {
      name: `${ad_name.trim()} - Carousel Creative`,
      page_id,
      body: (primary_texts?.[0])?.trim() || '',
      title: ad_name.trim(),
      link_url: fallbackLink,
      carousel_cards,
      call_to_action_type: ad_call_to_action || undefined,
    });

    // Create ad
    const ad = await metaService.createAd(accountId, accessToken, {
      name: ad_name.trim(),
      adset_id: ad_set_id,
      creative_id: creative.id,
      status: 'PAUSED',
    });

    const managementUrl = `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${accountId}`;

    if (session_id) await appendSessionMessage(session_id, ad_name.trim(), managementUrl);

    res.json({
      success: true,
      adId: ad.id,
      managementUrl,
      message: `Carousel ad with ${images.length} slides created successfully in paused status.`,
    });
  } catch (error: any) {
    console.error('[MetaV2] /create-carousel-ad error:', error);
    res.status(400).json({ message: error.message, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/meta/v2/create-video-ad
// Video ad flow: uploads video + thumbnail, creates creative + ad.
// ---------------------------------------------------------------------------
router.post('/create-video-ad', async (req, res) => {
  const userId = (req as any).user.userId;
  const {
    account_id, video_url, thumbnail_url,
    campaign_id, ad_set_id, page_id,
    ad_name, primary_texts, headlines, url_descriptions, ad_call_to_action, link_url, utm_params,
    add_website_url: addWebsiteUrlVideo, optimize_creative: optimizeCreativeVideo, execution_id, session_id,
  } = req.body;

  try {
    if (!video_url || !campaign_id || !ad_set_id || !page_id || !ad_name?.trim()) {
      return res.status(400).json({ message: 'Missing required fields: video_url, campaign_id, ad_set_id, page_id, ad_name' });
    }
    if (!thumbnail_url) {
      return res.status(400).json({
        message: 'thumbnail_url is required for Meta video ads. Please select a thumbnail image.',
      });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { accountId, accessToken } = getMetaAccountCredentials(user, account_id);

    // 1. Upload video (Meta fetches from URL)
    const videoResult = await metaService.uploadVideo(accountId, accessToken, video_url);
    const videoId: string = videoResult?.id || videoResult?.video_id;
    if (!videoId) throw new Error('Video uploaded but no video_id was returned by Meta.');

    // 2. Upload thumbnail
    const imageHash = await uploadImageGetHash(accountId, accessToken, thumbnail_url, 'thumbnail.jpg');

    // 3. Create video creative (thumbnail required by Meta)
    const allPrimaryTexts = (primary_texts || []).map((t: string) => t.trim()).filter(Boolean);
    const allHeadlines = (headlines || []).map((h: string) => h.trim()).filter(Boolean);
    const allUrlDescriptions = (url_descriptions || []).map((d: string) => d.trim()).filter(Boolean);
    const creative = await metaService.createAdCreative(accountId, accessToken, {
      name: `${ad_name.trim()} - Video Creative`,
      page_id,
      body: allPrimaryTexts[0] || '',
      extra_bodies: allPrimaryTexts.slice(1),
      title: allHeadlines[0] || ad_name.trim(),
      extra_titles: allHeadlines.slice(1),
      description: allUrlDescriptions[0] || '',
      extra_descriptions: allUrlDescriptions.slice(1),
      add_website_url: addWebsiteUrlVideo !== false,
      link_url: addWebsiteUrlVideo !== false ? applyUtmParams(link_url?.trim() || undefined, utm_params) : undefined,
      video_id: videoId,
      image_hash: imageHash,
      call_to_action_type: ad_call_to_action || undefined,
      optimize_creative: !!optimizeCreativeVideo,
    });

    // 4. Create ad
    const ad = await metaService.createAd(accountId, accessToken, {
      name: ad_name.trim(),
      adset_id: ad_set_id,
      creative_id: creative.id,
      status: 'PAUSED',
    });

    const managementUrl = `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${accountId}`;

    const adInfo = {
      adId: ad.id,
      adName: ad_name.trim(),
      campaignId: campaign_id,
      adSetId: ad_set_id,
      pageId: page_id,
      creativeId: creative.id,
      videoId,
      imageHash,
      managementUrl,
      status: 'PAUSED',
      createdAt: new Date().toISOString(),
    };

    if (execution_id) await recordAdOnExecution(execution_id, userId, video_url, adInfo);
    if (session_id) await appendSessionMessage(session_id, ad_name.trim(), managementUrl);

    res.json({
      success: true,
      adId: ad.id,
      managementUrl,
      message: 'Video ad created successfully in paused status. Review and publish in Facebook Ads Manager.',
    });
  } catch (error: any) {
    console.error('[MetaV2] /create-video-ad error:', error);
    res.status(400).json({ message: error.message, error: error.message });
  }
});

export default router;
