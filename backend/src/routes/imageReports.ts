import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { ChatbotDB } from '../services/chatbotService';

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

function buildStartingMessage(images: ImageReportImage[], reportType: string, customInstruction?: string): string {
  const label = REPORT_TYPE_LABELS[reportType] || 'Report';
  const imageList = images.map((img, i) => `Image ${i + 1}: ${img.filename} — ${img.url}`).join('\n');

  const typeInstructions: Record<string, string> = {
    'ad-copy': `Create a comprehensive Ad Copy Analysis report that includes:
1. Overview of the visual creative direction
2. For each image: suggested headline, subheadline, call-to-action text, and 3 body copy variants
3. Tone & voice analysis
4. Platform recommendations (Facebook/Instagram/Google/LinkedIn) with copy length guidance
5. Key messaging themes extracted from the visuals
Embed each image in the report using an img tag with the provided URL as src, so readers can see the images inline.`,

    'social-media-captions': `Create a Social Media Caption Pack report that includes:
1. For each image: 3 caption variants for Instagram, 2 for LinkedIn, 2 for Twitter/X, 1 for Facebook
2. Relevant hashtag sets (5-10 tags per platform group)
3. Posting time recommendations
4. Engagement hooks and CTA suggestions
5. A/B testing recommendations
Embed each image in the report using an img tag with the provided URL as src, so readers can see the images inline.`,

    'brand-consistency': `Create a Brand Consistency Review report that includes:
1. Brand identity audit: color palette analysis, typography observations, visual style notes
2. Consistency score for each image (1-10) with reasoning
3. Inconsistencies identified and actionable recommendations
4. Brand strength highlights — what is working well
5. Priority fixes with specific, actionable guidance
Embed each image in the report using an img tag with the provided URL as src, so readers can see the images inline.`,
  };

  if (reportType === 'custom' && customInstruction) {
    return `Please create a custom HTML report for the following ${images.length} image(s).

Custom instructions: ${customInstruction}

Images:
${imageList}

Important: Do NOT call describe_image or any vision tool — work directly from the image filenames and URLs provided above. Embed the images using img tags with the provided URLs as src. Use create_html_file to save the final report.`;
  }

  const instructions = typeInstructions[reportType] || typeInstructions['ad-copy'];
  return `Please create a "${label}" HTML report for the following ${images.length} image(s).

${instructions}

Images:
${imageList}

Important: Do NOT call describe_image or any vision tool — work directly from the image filenames and URLs provided above. Embed the images using img tags with the provided URLs as src.
Use create_html_file to save the final report with title "${label}".`;
}

// POST /api/image-reports/generate
// Creates a new agent-mode session and runs the agent to generate a report via create_html_file.
// The resulting report appears automatically on the Reports page.
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
    // Create a new agent-mode session for this report
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
    const { runVerifiedChat } = await import('../controllers/agentModeController');

    const startingMessage = buildStartingMessage(images, reportType, customInstruction);

    console.log(`ImageReports: running agent for session ${session.sessionId}, ${images.length} images`);

    const result = await runVerifiedChat({
      sessionId: session.sessionId,
      userId,
      startingMessage,
      requiredFunctions: [{ functionName: 'create_html_file', minCount: 1 }],
      keywords: [],
      maxAttempts: 5,
      // ENG-634: headless run (no human present) — enable completion-gate halt
      // protection so a free-text confirmation halt auto-continues rather than
      // returning a non-deliverable.
      completionGate: true,
    });

    // Set title after agent completes — agent auto-titles the session during the run
    await chatbotDb.updateSessionTitle(session.sessionId, reportTitle);

    console.log(`ImageReports: agent completed. Success: ${result.success}, tool calls: ${result.toolCalls.length}`);

    if (!result.success) {
      return res.status(500).json({ success: false, message: 'Agent failed to generate report' });
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error('ImageReports: generation error:', err);
    return res.status(500).json({ success: false, message: err.message || 'Generation failed' });
  }
});

export default router;
