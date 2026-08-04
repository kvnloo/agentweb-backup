import crypto from 'crypto';
import axios from 'axios';
import AWS from 'aws-sdk';
import { WorkPlan } from './workPlanService';
import { workPlanService } from './workPlanService';
import { ImageService } from './imageGeneration';

const THUMBNAIL_PROMPT_TEMPLATE =
  "Create a professional thumbnail image for a marketing tool called '{title}'. " +
  "Context: {description}. " +
  "Style: A realistic product-shot collage showing 2-4 overlapping deliverables the tool produces " +
  "(e.g. device screens, printed materials, social media posts, reports, ad creatives). " +
  "Arrange items in a slight 3D perspective with soft drop shadows on a clean, light neutral background. " +
  "No text or labels in the image. High detail, photorealistic mockup style. Aspect ratio: 1:1 (square).";

const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-west-2',
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const BUCKET = process.env.AWS_S3_BUCKET || 'agentweb-user-files';

async function uploadThumbnailBuffer(
  buffer: Buffer,
  key: string,
  contentType: string,
): Promise<string> {
  const result = await s3
    .upload({
      Bucket: BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
      Metadata: {
        'uploaded-by': 'workplan-thumbnails',
        'upload-timestamp': new Date().toISOString(),
      },
    })
    .promise();
  return result.Location;
}

async function downloadBuffer(url: string): Promise<Buffer> {
  const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(response.data);
}

export class WorkPlanThumbnailService {
  private readonly imageService = new ImageService();

  private versionHash(): string {
    return crypto.randomBytes(6).toString('hex');
  }

  /**
   * @param opts.supersedeInFlight Set by user-initiated regeneration. Bumps
   *   updatedAt before rendering, which invalidates any generation already
   *   running, so the admin's request wins instead of racing an older job for
   *   the same baseline. Background callers leave it off — they have nothing to
   *   supersede, and touching the plan would defeat their own ordering.
   */
  /**
   * Thin wrapper for fire-and-forget callers that only want the plan.
   * Callers that must tell "applied" from "a newer action won" — the manual
   * regenerate, where an admin is waiting — use generateAIThumbnailDetailed.
   */
  async generateAIThumbnail(
    plan: WorkPlan,
    opts: { supersedeInFlight?: boolean } = {},
  ): Promise<WorkPlan | null> {
    return (await this.generateAIThumbnailDetailed(plan, opts)).plan;
  }

  async generateAIThumbnailDetailed(
    plan: WorkPlan,
    opts: { supersedeInFlight?: boolean } = {},
  ): Promise<{ outcome: 'applied' | 'superseded' | 'gone'; plan: WorkPlan | null }> {
    // The plan as this job observed it. No claim write for background jobs: a
    // claim is a second unconditioned write that races the actions it is meant
    // to order. A user action is different — it is allowed to supersede.
    let basedOn = plan.updatedAt;
    if (opts.supersedeInFlight) {
      const superseded = await workPlanService.updateThumbnail(plan.planId, {});
      // Unconditional apart from attribute_exists, so null here means the plan
      // is gone. Bail before spending ~40s rendering a thumbnail for nothing.
      if (!superseded) return { outcome: 'gone', plan: null };
      basedOn = superseded;
    }
    const description = plan.description || 'A professional marketing automation tool';
    const prompt = THUMBNAIL_PROMPT_TEMPLATE.replace('{title}', plan.title).replace(
      '{description}',
      description,
    );

    try {
      const result = await this.imageService.generateImage({
        prompt,
        filename: `workplan-thumbnail-${this.versionHash()}.png`,
        size: '1024x1024',
        userId: 'workplans',
        removeC2PA: true,
      });

      if (!result.success || !result.imageUrl) {
        console.error(
          `[ThumbnailService] AI generation failed for plan ${plan.planId}:`,
          result.error,
        );
        return this.setNoThumbnail(plan, basedOn);
      }

      const imageBuffer = await downloadBuffer(result.imageUrl);
      const version = this.versionHash();
      const key = `workplans/${plan.planId}/thumbnails/thumbnail-${version}.png`;
      const url = await uploadThumbnailBuffer(imageBuffer, key, 'image/png');

      const updated: WorkPlan = {
        ...plan,
        thumbnail_url: url,
        thumbnail_source: 'ai',
        thumbnail_alt_text: `Thumbnail for ${plan.title}`,
      };
      // Ordered against the plan as it looked when this generation began, and
      // scoped to the thumbnail attributes, so a ~40s render cannot revert an
      // edit or a newer thumbnail action made meanwhile (ENG-889).
      const writtenAt = await workPlanService.updateThumbnail(plan.planId, {
        thumbnail_url: url,
        thumbnail_source: 'ai',
        thumbnail_alt_text: updated.thumbnail_alt_text,
      }, { expectedUpdatedAt: basedOn });
      // A newer action won, or the plan was deleted. Report what is actually
      // stored — never the stale input — and say which happened, so a caller
      // that an admin is waiting on does not present a no-op as success.
      if (!writtenAt) {
        const current = await workPlanService.getWorkPlan(plan.planId);
        return { outcome: current ? 'superseded' : 'gone', plan: current };
      }
      return { outcome: 'applied', plan: { ...updated, updatedAt: writtenAt } };
    } catch (err) {
      console.error(
        `[ThumbnailService] Error generating thumbnail for plan ${plan.planId}:`,
        err,
      );
      return this.setNoThumbnail(plan, basedOn);
    }
  }

  async uploadCustomThumbnail(
    plan: WorkPlan,
    buffer: Buffer,
    mimeType: string,
  ): Promise<WorkPlan | null> {
    const extMap: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const ext = extMap[mimeType] || 'png';
    const version = this.versionHash();
    const key = `workplans/${plan.planId}/thumbnails/thumbnail-${version}.${ext}`;
    const url = await uploadThumbnailBuffer(buffer, key, mimeType);

    const updated: WorkPlan = {
      ...plan,
      thumbnail_url: url,
      thumbnail_source: 'upload',
      thumbnail_alt_text: `Thumbnail for ${plan.title}`,
    };
    // User-initiated: unconditional, and bumping updatedAt invalidates any
    // generation still in flight.
    const writtenAt = await workPlanService.updateThumbnail(plan.planId, {
      thumbnail_url: url,
      thumbnail_source: 'upload',
      thumbnail_alt_text: updated.thumbnail_alt_text,
    });
    // Unconditional apart from attribute_exists, so null means the plan was
    // deleted while the image was uploading. Returning the locally built object
    // would report a 200 for a plan that no longer exists.
    if (!writtenAt) return null;
    return { ...updated, updatedAt: writtenAt };
  }

  async removeThumbnail(plan: WorkPlan): Promise<WorkPlan | null> {
    // Clear the current thumbnail fields first
    const cleared: WorkPlan = {
      ...plan,
      thumbnail_url: undefined,
      thumbnail_source: 'none',
      thumbnail_alt_text: undefined,
    };
    const clearedAt = await workPlanService.updateThumbnail(plan.planId, {
      thumbnail_url: undefined,
      thumbnail_source: 'none',
      thumbnail_alt_text: undefined,
    });
    // Same as above: null here means the plan is gone, so there is nothing to
    // clear and nothing to regenerate.
    if (!clearedAt) return null;
    cleared.updatedAt = clearedAt;

    // Trigger AI regeneration asynchronously — caller gets the cleared state
    // immediately. `cleared` carries the post-clear updatedAt, so this job is
    // ordered against the clear rather than against the pre-clear state.
    this.generateAIThumbnail(cleared).catch((err) =>
      console.error(
        `[ThumbnailService] Background AI regen failed for plan ${plan.planId}:`,
        err,
      ),
    );

    return cleared;
  }

  private async setNoThumbnail(
    plan: WorkPlan,
    basedOn?: string,
  ): Promise<{ outcome: 'applied' | 'superseded' | 'gone'; plan: WorkPlan | null }> {
    const updated: WorkPlan = { ...plan, thumbnail_source: 'none' };
    // Preserve any existing thumbnail_url when just setting source to 'none' on
    // failure. Carries the generation's ordering, so a failed background job
    // cannot stamp 'none' over a newer upload or clear.
    const writtenAt = await workPlanService.updateThumbnail(
      plan.planId,
      { thumbnail_source: 'none' },
      basedOn !== undefined ? { expectedUpdatedAt: basedOn } : {},
    );
    // The fallback write is conditioned exactly like the success write, so it
    // can lose the same races. Derive the outcome rather than assuming applied.
    if (!writtenAt) {
      const current = await workPlanService.getWorkPlan(plan.planId);
      return { outcome: current ? 'superseded' : 'gone', plan: current };
    }
    return { outcome: 'applied', plan: { ...updated, updatedAt: writtenAt } };
  }
}

export const workPlanThumbnailService = new WorkPlanThumbnailService();
