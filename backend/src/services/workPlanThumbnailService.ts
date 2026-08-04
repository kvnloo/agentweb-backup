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

  async generateAIThumbnail(plan: WorkPlan): Promise<WorkPlan> {
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
        return this.setNoThumbnail(plan);
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
      // Attribute-scoped write: this runs long after create, so putting the
      // whole snapshot back would revert edits made in the meantime (ENG-889).
      await workPlanService.updateThumbnail(plan.planId, {
        thumbnail_url: url,
        thumbnail_source: 'ai',
        thumbnail_alt_text: updated.thumbnail_alt_text,
      // Automatic: only write if the thumbnail is still what this job started
      // from, so an upload or a clear made meanwhile is not undone.
      }, { expectedSource: plan.thumbnail_source ?? null });
      return updated;
    } catch (err) {
      console.error(
        `[ThumbnailService] Error generating thumbnail for plan ${plan.planId}:`,
        err,
      );
      return this.setNoThumbnail(plan);
    }
  }

  async uploadCustomThumbnail(
    plan: WorkPlan,
    buffer: Buffer,
    mimeType: string,
  ): Promise<WorkPlan> {
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
    await workPlanService.updateThumbnail(plan.planId, {
      thumbnail_url: url,
      thumbnail_source: 'upload',
      thumbnail_alt_text: updated.thumbnail_alt_text,
    });
    return updated;
  }

  async removeThumbnail(plan: WorkPlan): Promise<WorkPlan> {
    // Clear the current thumbnail fields first
    const cleared: WorkPlan = {
      ...plan,
      thumbnail_url: undefined,
      thumbnail_source: 'none',
      thumbnail_alt_text: undefined,
    };
    await workPlanService.updateThumbnail(plan.planId, {
      thumbnail_url: undefined,
      thumbnail_source: 'none',
      thumbnail_alt_text: undefined,
    });

    // Trigger AI regeneration asynchronously — caller gets the cleared state immediately
    this.generateAIThumbnail(cleared).catch((err) =>
      console.error(
        `[ThumbnailService] Background AI regen failed for plan ${plan.planId}:`,
        err,
      ),
    );

    return cleared;
  }

  private async setNoThumbnail(plan: WorkPlan): Promise<WorkPlan> {
    const updated: WorkPlan = { ...plan, thumbnail_source: 'none' };
    // Preserve any existing thumbnail_url when just setting source to 'none' on failure
    // Also automatic — the AI failure path must not stamp 'none' over an upload
    // or a clear the admin made while generation was running.
    await workPlanService.updateThumbnail(
      plan.planId,
      { thumbnail_source: 'none' },
      { expectedSource: plan.thumbnail_source ?? null },
    );
    return updated;
  }
}

export const workPlanThumbnailService = new WorkPlanThumbnailService();
