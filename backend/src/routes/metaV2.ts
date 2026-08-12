import express from 'express';
import path from 'path';
import { authenticateToken } from '../middleware/auth';
import { userDb, taskDb } from '../services/db';
import { metaService } from '../services/metaService';
import {
  getConnectedMetaAccountsList,
  getMetaAccountCredentials,
} from '../services/metaAccountCredentials';

const router = express.Router();
router.use(authenticateToken);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
// cleanAccountId / getConnectedMetaAccountsList / getMetaAccountCredentials now live in
// services/metaAccountCredentials.ts so metaService.resolveMetaPixelForUser and the CAPI
// send in routes/webhooks.ts can reuse the same account-resolution logic.

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

    const { accountId: resolvedAccountId, accessToken } = await getMetaAccountCredentials(user, userId, accountId);

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
// GET /api/meta/v2/pixels
// ENG-1141: lists every pixel across every one of the caller's connected Meta
// accounts, so the frontend can offer one flat picker instead of a two-step
// "pick account, then pick pixel" flow. No new Graph integration — aggregates
// the same listPixels() resolveMetaPixelForUser already calls per-account.
// A single account's lookup failing (e.g. an expired token) is skipped, not
// fatal to the whole request — same "never let one bad account break
// everything" philosophy as resolveMetaPixelForUser itself.
// ---------------------------------------------------------------------------
router.get('/pixels', async (req, res) => {
  const userId = (req as any).user.userId;
  try {
    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const accounts = getConnectedMetaAccountsList(user);
    const perAccountPixels = await Promise.all(
      accounts.map(async (acc: any) => {
        try {
          const { accountId, accessToken } = await getMetaAccountCredentials(user, userId, acc.accountId);
          const pixels = await metaService.listPixels(accountId, accessToken);
          return (pixels || []).map((p: any) => ({ pixelId: p.id, accountId, accountName: acc.accountName }));
        } catch (err) {
          console.error(`[MetaV2] /pixels: skipping account ${acc.accountId} (lookup failed):`, err);
          return [];
        }
      })
    );

    res.json({ pixels: perAccountPixels.flat() });
  } catch (error: any) {
    console.error('[MetaV2] /pixels error:', error);
    res.status(500).json({ message: error.message });
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
    ad_name, ad_text, ad_headline, ad_description, ad_call_to_action,
    link_url, task_id, execution_id, session_id,
  } = req.body;

  try {
    if (!image_url || !campaign_id || !ad_set_id || !page_id || !ad_name?.trim()) {
      return res.status(400).json({
        message: 'Missing required fields: image_url, campaign_id, ad_set_id, page_id, ad_name',
      });
    }

    const user = await userDb.getUserById(userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { accountId, accessToken } = await getMetaAccountCredentials(user, userId, account_id);

    // 1. Upload image
    const imageHash = await uploadImageGetHash(accountId, accessToken, image_url, 'ad-image.jpg');

    // 2. Create ad creative
    const creative = await metaService.createAdCreative(accountId, accessToken, {
      name: `${ad_name.trim()} - Creative`,
      page_id,
      body: ad_text?.trim() || '',
      title: ad_headline?.trim() || ad_name.trim(),
      link_url: link_url?.trim() || 'https://example.com',
      image_hash: imageHash,
      call_to_action_type: ad_call_to_action || undefined,
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
    ad_name, ad_text, ad_call_to_action, default_link_url,
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

    const { accountId, accessToken } = await getMetaAccountCredentials(user, userId, account_id);
    const fallbackLink = default_link_url?.trim() || 'https://example.com';

    // Upload all images in parallel and build carousel_cards
    const carousel_cards = await Promise.all(
      images.map(async (img: { url: string; title?: string; link_url?: string }, idx: number) => {
        const imageHash = await uploadImageGetHash(
          accountId, accessToken, img.url, `carousel-slide-${idx + 1}.jpg`
        );
        return {
          image_hash: imageHash,
          title: img.title || undefined,
          link_url: img.link_url?.trim() || fallbackLink,
        };
      })
    );

    // Create carousel creative
    const creative = await metaService.createAdCreative(accountId, accessToken, {
      name: `${ad_name.trim()} - Carousel Creative`,
      page_id,
      body: ad_text?.trim() || '',
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
    ad_name, ad_text, ad_headline, ad_call_to_action, link_url,
    execution_id, session_id,
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

    const { accountId, accessToken } = await getMetaAccountCredentials(user, userId, account_id);

    // 1. Upload video (Meta fetches from URL)
    const videoResult = await metaService.uploadVideo(accountId, accessToken, video_url);
    const videoId: string = videoResult?.id || videoResult?.video_id;
    if (!videoId) throw new Error('Video uploaded but no video_id was returned by Meta.');

    // 2. Upload thumbnail
    const imageHash = await uploadImageGetHash(accountId, accessToken, thumbnail_url, 'thumbnail.jpg');

    // 3. Create video creative (thumbnail required by Meta)
    const creative = await metaService.createAdCreative(accountId, accessToken, {
      name: `${ad_name.trim()} - Video Creative`,
      page_id,
      body: ad_text?.trim() || '',
      title: ad_headline?.trim() || ad_name.trim(),
      link_url: link_url?.trim() || 'https://example.com',
      video_id: videoId,
      image_hash: imageHash,
      call_to_action_type: ad_call_to_action || undefined,
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
