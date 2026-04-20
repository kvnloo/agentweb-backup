import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { uploadFileToS3 } from '../utils/s3Utils';
import { ChatbotDB } from '../services/chatbotService';
import axios from 'axios';
import sharp from 'sharp';

const router = express.Router();

interface ImageReportImage {
  url: string;
  filename: string;
  executionId: string;
  taskId?: string;
}

const REPORT_TYPE_LABELS: Record<string, string> = {
  'ad-copy': 'Ad Copy Analysis',
  'social-media-captions': 'Social Media Caption Pack',
  'brand-consistency': 'Brand Consistency Review',
  'custom': 'Custom Report',
};

async function fetchImageAsBase64(url: string): Promise<{ base64: string; mimeType: string } | null> {
  try {
    const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
    const rawBuf = Buffer.from(response.data as ArrayBuffer);

    // Always convert to JPEG and resize to max 1024px to ensure compatibility with Bedrock
    const buf = await sharp(rawBuf)
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();

    return { base64: buf.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return null;
  }
}

function buildSystemPrompt(reportType: string, customInstruction?: string): string {
  if (reportType === 'custom' && customInstruction) {
    return `You are an expert marketing analyst and creative director. The user wants a custom report about their marketing images.
Custom instructions: ${customInstruction}
Produce a thorough, professional HTML report. Use modern, clean styling with a dark/light professional theme. Include your analysis in well-structured sections with headers. Output ONLY the complete HTML document (starting with <!DOCTYPE html>).`;
  }

  const prompts: Record<string, string> = {
    'ad-copy': `You are an expert copywriter and advertising specialist. Analyze the provided marketing images and produce a comprehensive Ad Copy Analysis report.
Your report must include:
1. Overview of the visual creative direction
2. For each image: suggested headline (primary ad copy), subheadline, call-to-action text, and body copy variants (3 per image)
3. Tone & voice analysis
4. Platform recommendations (Facebook/Instagram/Google/LinkedIn) with copy length guidance
5. Key messaging themes extracted from the visuals
Produce a thorough, professional HTML report with modern styling. Output ONLY the complete HTML document (starting with <!DOCTYPE html>).`,

    'social-media-captions': `You are a social media content strategist. Analyze the provided images and produce a Social Media Caption Pack.
Your report must include:
1. For each image: 3 caption variants for Instagram, 2 for LinkedIn, 2 for Twitter/X, 1 for Facebook
2. Relevant hashtag sets (5-10 tags per platform group)
3. Posting time recommendations
4. Engagement hooks and CTA suggestions
5. A/B testing recommendations for the best-performing captions
Produce a thorough, professional HTML report with modern styling. Output ONLY the complete HTML document (starting with <!DOCTYPE html>).`,

    'brand-consistency': `You are a brand strategist and creative director. Analyze the provided images for brand consistency.
Your report must include:
1. Brand identity audit: color palette analysis, typography observations, visual style notes
2. Consistency score for each image (1-10) with reasoning
3. Inconsistencies identified and actionable recommendations
4. Brand strength highlights — what is working well
5. Priority fixes with specific, actionable guidance
Produce a thorough, professional HTML report with modern styling. Output ONLY the complete HTML document (starting with <!DOCTYPE html>).`,
  };

  return prompts[reportType] || prompts['ad-copy'];
}

function buildUserPrompt(images: ImageReportImage[], reportType: string, customInstruction?: string): string {
  const label = REPORT_TYPE_LABELS[reportType] || 'Report';
  // Include S3 URLs so the LLM can embed <img> tags in the generated HTML
  const imageList = images.map((img, i) => `Image ${i + 1}: ${img.filename} (URL: ${img.url})`).join('\n');

  const embedNote = `\n\nIMPORTANT: When referencing the images in your HTML report, use their exact URLs as <img> src attributes so they render inline in the report.`;

  if (reportType === 'custom' && customInstruction) {
    return `Please analyze the ${images.length} image(s) I've provided and create the custom report as instructed.\n\nImages:\n${imageList}${embedNote}`;
  }

  return `Please analyze the ${images.length} image(s) I've provided and create a "${label}".\n\nImages:\n${imageList}${embedNote}`;
}

// POST /api/image-reports/generate
// Generates a report for selected images, saves HTML to S3, stores it as an agent-mode session
// so it appears automatically on the Reports page.
router.post('/generate', authenticateToken, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.userId;
  if (!userId) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const { images, reportType, customInstruction, title } = req.body as {
    images: ImageReportImage[];
    reportType: string;
    customInstruction?: string;
    title?: string;
  };

  if (!images || !Array.isArray(images) || images.length === 0) {
    return res.status(400).json({ success: false, message: 'images array is required' });
  }

  if (!reportType || !['ad-copy', 'social-media-captions', 'brand-consistency', 'custom'].includes(reportType)) {
    return res.status(400).json({ success: false, message: 'Invalid reportType' });
  }

  if (reportType === 'custom' && !customInstruction?.trim()) {
    return res.status(400).json({ success: false, message: 'customInstruction is required for custom reports' });
  }

  const reportTitle = title || `${REPORT_TYPE_LABELS[reportType]} — ${new Date().toLocaleDateString()}`;

  try {
    console.log(`ImageReports: starting generation, ${images.length} images`);

    // Fetch images as base64 for vision input (up to 6 to avoid token limits)
    const imageSlice = images.slice(0, 6);
    const imageData = await Promise.all(imageSlice.map(img => fetchImageAsBase64(img.url)));
    console.log(`ImageReports: fetched ${imageData.filter(Boolean).length}/${imageSlice.length} images`);

    const systemPrompt = buildSystemPrompt(reportType, customInstruction);
    const userPrompt = buildUserPrompt(images, reportType, customInstruction);

    // Use Bedrock Converse API directly for proper multimodal support
    const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');

    const bedrockClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION || 'us-west-2',
      credentials: process.env.AWS_ACCESS_KEY_ID ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      } : undefined,
      requestHandler: { requestTimeout: 5 * 60 * 1000 } as any,
    });

    const userContentBlocks: any[] = [{ text: userPrompt }];
    for (const data of imageData) {
      if (data) {
        userContentBlocks.push({
          image: {
            format: 'jpeg',
            source: { bytes: Buffer.from(data.base64, 'base64') },
          },
        });
      }
    }

    const converseResponse = await bedrockClient.send(new ConverseCommand({
      modelId: 'arn:aws:bedrock:us-west-2:992382574572:inference-profile/global.anthropic.claude-sonnet-4-6',
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: userContentBlocks }],
      inferenceConfig: { maxTokens: 8000, temperature: 0.7 },
    }));

    console.log('ImageReports: Bedrock response received');
    const outputContent = converseResponse.output?.message?.content || [];
    let htmlContent = outputContent.map((b: any) => b.text || '').join('');

    // Strip markdown code fences
    htmlContent = htmlContent.replace(/^```(?:html)?\r?\n/, '').replace(/\n```\s*$/, '').trim();

    if (!htmlContent.includes('<!DOCTYPE') && !htmlContent.includes('<html')) {
      htmlContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${reportTitle}</title></head><body>${htmlContent}</body></html>`;
    }

    // Upload HTML to S3
    const timestamp = Date.now();
    const filename = `image-report-${timestamp}.html`;
    const uploadResult = await uploadFileToS3(
      Buffer.from(htmlContent, 'utf-8'),
      filename,
      userId,
      'text/html',
    );

    if (!uploadResult.success || !uploadResult.url) {
      throw new Error(uploadResult.error || 'S3 upload failed');
    }

    // Store the HTML URL in a new agent-mode session so it appears on the Reports page
    const chatbotDb = new ChatbotDB();
    const session = await chatbotDb.createChatSession(
      userId,
      undefined,
      'agent',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'report_generation',
    );

    await chatbotDb.updateSessionTitle(session.sessionId, reportTitle);

    const generatedAt = new Date().toISOString();

    // Add a user message summarising what was requested
    const imageListText = images.map((img, i) => `- Image ${i + 1}: ${img.filename}`).join('\n');
    await chatbotDb.addMessageToSession(session.sessionId, {
      role: 'user',
      content: `Create a ${REPORT_TYPE_LABELS[reportType] || 'report'} for the following images:\n${imageListText}`,
      metadata: { timestamp: generatedAt },
    } as any);

    // Add an assistant message that contains the S3 URL — this acts as both a human-readable
    // summary and the source for scanMessagesForAssets to pick up the URL as a backup.
    await chatbotDb.addMessageToSession(session.sessionId, {
      role: 'assistant',
      content: `I've analysed the ${images.length} image(s) and generated your **${REPORT_TYPE_LABELS[reportType] || 'report'}**. You can view it here: ${uploadResult.url}`,
      metadata: {
        timestamp: generatedAt,
        toolCalls: [{
          name: 'create_html_file',
          result: { success: true, s3_url: uploadResult.url, filename, title: reportTitle },
        }],
      },
    } as any);

    // Pre-populate assetCache so the report appears immediately without a message rescan
    await chatbotDb.updateAssetCache(
      session.sessionId,
      { images: [], videos: [], htmlReports: [{ url: uploadResult.url, filename, generatedAt }] },
      2,
    );

    console.log(`ImageReports: report stored in session ${session.sessionId}`);
    return res.json({ success: true });
  } catch (err: any) {
    console.error('ImageReports: generation error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Generation failed' });
  }
});

export default router;
