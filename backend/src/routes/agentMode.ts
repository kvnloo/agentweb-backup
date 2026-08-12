import express, { Request, Response } from 'express';
import { authenticateToken, AuthenticatedRequest, requireAdmin } from '../middleware/auth';
import { requireScheduledChatsServiceSecret } from '../middleware/serviceAuth';
import { agentModeController } from '../controllers/agentModeController';
import { chatbotDb } from '../services/chatbotService';
import { synthesizeSpeech } from '../services/voiceService';
import multer from 'multer';
import { MAX_FILE_SIZE } from '../config';

const router = express.Router();
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE }, // enforce global upload cap (100MB)
});

// Helper function to wrap async handlers
const asyncHandler = (fn: (req: Request, res: Response, next: express.NextFunction) => Promise<any>) => {
  return (req: Request, res: Response, next: express.NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Helper function to wrap async handlers for authenticated routes
const asyncHandlerAuth = (fn: (req: AuthenticatedRequest, res: Response) => Promise<any>) => {
  return (req: Request, res: Response, next: express.NextFunction) => {
    Promise.resolve(fn(req as AuthenticatedRequest, res)).catch(next);
  };
};


// Public routes (no authentication required)
// GET /api/agent-mode/share/:shareId/og
// Get OG metadata for shared conversation (public, lightweight)
router.get('/share/:shareId/og', asyncHandler(agentModeController.getShareOgMetadata));

// GET /api/agent-mode/share/:shareId
// Get shared conversation (public)
router.get('/share/:shareId', asyncHandler(agentModeController.getSharedConversation));

// GET /api/agent-mode/ishare/:shareId
// Get interactive shared conversation (with conversable token)
router.get('/ishare/:shareId', asyncHandler(agentModeController.getSharedConversation));

// POST /api/agent-mode/share/:shareId/generate
// Generate response for shared conversation (with conversable token)
router.post('/share/:shareId/generate', asyncHandler(agentModeController.generateSharedResponse));

// POST /api/agent-mode/ishare/:shareId/generate
// Generate response for interactive shared conversation (with conversable token)
router.post('/ishare/:shareId/generate', asyncHandler(agentModeController.generateSharedResponse));

// PATCH /api/agent-mode/ishare/:shareId/llm-model
// Update session LLM model for interactive shared conversation (with conversable token)
router.patch('/ishare/:shareId/llm-model', asyncHandler(agentModeController.updateSharedSessionLlmModel));

// GET /api/agent-mode/ishare/:shareId/progress
// SSE endpoint for progress updates (public, with conversable token)
router.get('/ishare/:shareId/progress', asyncHandler(agentModeController.getProgressPublic));

// POST /api/agent-mode/ishare/:shareId/stop
// Stop generation for an interactive shared session (public, with conversable token)
router.post('/ishare/:shareId/stop', asyncHandler(agentModeController.stopGenerationPublic));

// PUT /api/agent-mode/ishare/:shareId/message/:messageIndex/feedback
// Submit message feedback for ishare sessions (public, with conversable token)
router.put('/ishare/:shareId/message/:messageIndex/feedback', asyncHandler(agentModeController.submitIShareMessageFeedback));

// POST /api/agent-mode/ishare/:shareId/upload
// Upload file attachment for ishare sessions (public, with conversable token)
router.post('/ishare/:shareId/upload', upload.single('file'), asyncHandler(agentModeController.uploadIShareAttachment));

// Note: Plan links also use ishare endpoint with conversable token, so they're covered by the above route

// GET /api/agent-mode/public/welcome-message
// Get current welcome message (public)
router.get('/public/welcome-message', asyncHandler(agentModeController.getWelcomeMessage));

// GET /api/agent-mode/public/conversation-starters
// Get current conversation starters (public)
router.get('/public/conversation-starters', asyncHandler(agentModeController.getConversationStarters));

// GET /api/agent-mode/public/plans
// Get all predefined work plans (public)
router.get('/public/plans', asyncHandler(agentModeController.getAllPredefinedWorkPlans));

// GET /api/agent-mode/public/plan/:planTitle
// Get predefined work plan by title (public)
router.get('/public/plan/:planTitle', asyncHandler(agentModeController.getPredefinedWorkPlan));

// POST /api/agent-mode/public/plan/:planTitle/session
// Create session with predefined work plan (public)
router.post('/public/plan/:planTitle/session', asyncHandler(agentModeController.createSessionWithPlan));

// GET /api/agent-mode/public/llm-models
// Get supported LLM models (public)
router.get('/public/llm-models', asyncHandler(agentModeController.getSupportedModels));

// GET /api/agent-mode/public/reports-model-options
// Get models suitable for report generation (public)
router.get('/public/reports-model-options', asyncHandler(agentModeController.getReportsModelOptions));

// GET /api/agent-mode/public/vision-model-options
// Get vision-capable models for the describe_image tool (public)
router.get('/public/vision-model-options', asyncHandler(agentModeController.getVisionModelOptions));

// GET /api/agent-mode/public/customer-support-default-model
// Get default model for customer support agent (public)
router.get('/public/customer-support-default-model', asyncHandler(agentModeController.getCustomerSupportDefaultModel));


// POST /api/agent-mode/run-scheduled-chats
// Run all scheduled chats that are ready to execute (called by agent-engine).
// Service-to-service auth: shared secret in x-service-secret, enforced when
// SCHEDULED_CHATS_SERVICE_SECRET is set (ENG-347).
router.post('/run-scheduled-chats', requireScheduledChatsServiceSecret, asyncHandler(agentModeController.runScheduledChats));

// GET /api/agent-mode/public/scheduled-chat-variables/:accessToken
// Get required variable metadata for a one-time public scheduled chat variable link
router.get('/public/scheduled-chat-variables/:accessToken', asyncHandler(agentModeController.getScheduledChatVariablesByAccessToken));

// POST /api/agent-mode/public/scheduled-chat-variables/:accessToken
// Submit variable values for a one-time public scheduled chat variable link
router.post('/public/scheduled-chat-variables/:accessToken', asyncHandler(agentModeController.submitScheduledChatVariablesByAccessToken));

// POST /api/agent-mode/public/scheduled-chat-variables/:accessToken/upload
// Upload a file for a file-type variable (public, validated by access token)
router.post('/public/scheduled-chat-variables/:accessToken/upload', upload.single('file'), asyncHandler(agentModeController.uploadScheduledChatVariableFile));

// Conversable routes (protected by conversable token, not authentication)

// POST /api/agent-mode/ishare/:shareId/email-report
// Send report email to lead (public, validated by conversable token)
router.post('/ishare/:shareId/email-report', asyncHandler(agentModeController.emailReportToLead));

// All other routes require authentication
router.use(authenticateToken);

// Create an authorized Skill-backed session with its existing static welcome brief.
router.post('/skill/:skillId/session', asyncHandler(agentModeController.createSession));

// PUT /api/agent-mode/session/:sessionId/transfer
// Transfer anonymous session to authenticated user (requires authentication)
router.put('/session/:sessionId/transfer', asyncHandlerAuth(agentModeController.transferSession));

// Agent Mode Chat Routes

// GET /api/agent-mode/sessions
// Get user's agent chat sessions
router.get('/sessions', asyncHandler(agentModeController.getSessions));

// POST /api/agent-mode/sessions
// Create new agent chat session
router.post('/sessions', asyncHandler(agentModeController.createSession));

// GET /api/agent-mode/session/:sessionId
// Get specific chat session
router.get('/session/:sessionId', asyncHandler(agentModeController.getSession));

// PATCH /api/agent-mode/session/:sessionId/llm-model
// Update session LLM model
router.patch('/session/:sessionId/llm-model', asyncHandlerAuth(agentModeController.updateSessionLlmModel));

// PATCH /api/agent-mode/session/:sessionId/title
// Update session title
router.patch('/session/:sessionId/title', asyncHandlerAuth(agentModeController.updateSessionTitle));

// GET /api/agent-mode/function-calls
// Get available function calls for benchmark tests
router.get('/function-calls', asyncHandler(agentModeController.getAvailableFunctionCalls));

// GET /api/agent-mode/session/:sessionId/progress
// SSE endpoint for progress updates
router.get('/session/:sessionId/progress', authenticateToken, asyncHandlerAuth(agentModeController.getProgress));

// POST /api/agent-mode/session/:sessionId/stop
// Stop generation for a session
router.post('/session/:sessionId/stop', asyncHandlerAuth(agentModeController.stopGeneration));

// POST /api/agent-mode/tts
// Convert Emma response text to speech (Google Cloud TTS, Chirp 3 HD)
router.post('/tts', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const { text } = req.body;
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'text is required' });
  }
  const audioBuffer = await synthesizeSpeech(text.trim());
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Length', String(audioBuffer.length));
  res.send(audioBuffer);
}));

// POST /api/agent-mode/generate
// Generate AI response for marketing conversation
router.post('/generate', asyncHandler(agentModeController.generateResponse));

// POST /api/agent-mode/verified-generate
// Generate response with verification that required functions are called minimum number of times
router.post('/verified-generate', asyncHandler(agentModeController.verifiedGenerate));

// POST /api/agent-mode/upload
// Upload file attachment for Agent Mode
router.post('/upload', upload.single('file'), asyncHandler(agentModeController.uploadAttachment));

// POST /api/agent-mode/sessions/:sessionId/upload-image
// Upload image directly to Agent Mode session (stores in session metadata)
router.post('/sessions/:sessionId/upload-image', upload.single('file'), asyncHandler(agentModeController.uploadImageToSession));

// POST /api/agent-mode/sessions/:sessionId/upload-video
// Upload video directly to Agent Mode session (stores in session metadata)
router.post('/sessions/:sessionId/upload-video', upload.single('file'), asyncHandler(agentModeController.uploadVideoToSession));

// GET /api/agent-mode/system-prompt
// Get current system prompt (admin only)
router.get('/system-prompt', requireAdmin, asyncHandler(agentModeController.getSystemPrompt));

// GET /api/agent-mode/welcome-message
// Get current welcome message (admin only)
router.get('/welcome-message', requireAdmin, asyncHandler(agentModeController.getWelcomeMessage));

// GET /api/agent-mode/conversation-starters
// Get current conversation starters (admin only)
router.get('/conversation-starters', requireAdmin, asyncHandler(agentModeController.getConversationStarters));


// DELETE /api/agent-mode/session/:sessionId
// Archive a chat session
router.delete('/session/:sessionId', asyncHandler(agentModeController.archiveSession));

// PUT /api/agent-mode/session/:sessionId/task/:taskId/execution/:executionId/status
// Update task execution status in session
router.put('/session/:sessionId/task/:taskId/execution/:executionId/status', asyncHandler(agentModeController.updateTaskStatus));

// PUT /api/agent-mode/session/:sessionId/message/:messageIndex/feedback
// Submit or update message feedback
router.put('/session/:sessionId/message/:messageIndex/feedback', asyncHandlerAuth(agentModeController.submitMessageFeedback));

// POST /api/agent-mode/share
// Create shareable link for conversation
router.post('/share', asyncHandler(agentModeController.createShareLink));

// DELETE /api/agent-mode/session/:sessionId/share
// Stop sharing conversation
router.delete('/session/:sessionId/share', asyncHandler(agentModeController.stopSharing));

// GET /api/agent-mode/session/:sessionId/share
// Get share information for a session
router.get('/session/:sessionId/share', asyncHandler(agentModeController.getShareInfo));

// POST /api/agent-mode/conversable-share
// Create conversable share link for a session
router.post('/conversable-share', asyncHandler(agentModeController.createConversableShare));

// DELETE /api/agent-mode/session/:sessionId/conversable-share
// Stop conversable sharing
router.delete('/session/:sessionId/conversable-share', asyncHandler(agentModeController.stopConversableShare));


// POST /api/agent-mode/scheduled-chats
// Create scheduled chat
router.post('/scheduled-chats', asyncHandler(agentModeController.createScheduledChat));

// GET /api/agent-mode/scheduled-chats
// Get user's scheduled chats
router.get('/scheduled-chats', asyncHandler(agentModeController.getScheduledChats));

// PUT /api/agent-mode/scheduled-chats/:scheduleId
// Update scheduled chat
router.put('/scheduled-chats/:scheduleId', asyncHandler(agentModeController.updateScheduledChat));

// POST /api/agent-mode/scheduled-chats/:scheduleId/variables
// Submit variable values for a scheduled chat
router.post('/scheduled-chats/:scheduleId/variables', asyncHandler(agentModeController.submitScheduledChatVariables));

// POST /api/agent-mode/scheduled-chats/:scheduleId/test
// Test scheduled chat
router.post('/scheduled-chats/:scheduleId/test', asyncHandler(agentModeController.testScheduledChat));

// POST /api/agent-mode/scheduled-chats/:scheduleId/publish-consent
// ENG-827: REVOKE-ONLY. Accepts { authorized: false } and nothing else — the grant
// direction is deliberately unreachable from the API (see the controller).
//
// No portal control calls this yet, and that is deliberate rather than an oversight.
// The default was NOT flipped to opt-in, so `autopublishAuthorized` is written only by
// scripts/grant-schedule-autopublish.ts against a recorded owner confirmation. This is
// how an owner takes such a grant back — needed the moment that migration runs, and the
// reason the endpoint is not removed as unreachable. The visible control today is
// ENG-803's `requirePublishApproval` hold, which works on granted and never-asked
// schedules alike.
router.post('/scheduled-chats/:scheduleId/publish-consent', asyncHandler(agentModeController.revokeScheduledChatPublishConsent));

// PATCH /api/agent-mode/scheduled-chats/:scheduleId/toggle
// Toggle scheduled chat status (enable/disable)
router.patch('/scheduled-chats/:scheduleId/toggle', asyncHandler(agentModeController.toggleScheduledChatStatus));

// DELETE /api/agent-mode/scheduled-chats/:scheduleId
// Delete scheduled chat
router.delete('/scheduled-chats/:scheduleId', asyncHandler(agentModeController.deleteScheduledChat));

// GET /api/agent-mode/scheduled-chats/:scheduleId/test-history
// Get test history for a scheduled chat
router.get('/scheduled-chats/:scheduleId/test-history', asyncHandler(agentModeController.getScheduledChatTestHistory));

// POST /api/agent-mode/scheduled-chats/:scheduleId/test-history/:runId/send-email
// Send test notification email for a specific test history record
router.post('/scheduled-chats/:scheduleId/test-history/:runId/send-email', asyncHandler(agentModeController.sendScheduledChatTestEmail));

// ─── Schedule Templates ──────────────────────────────────────────────────

// POST /api/agent-mode/schedule-templates
router.post('/schedule-templates', asyncHandlerAuth(agentModeController.createScheduleTemplate));

// GET /api/agent-mode/schedule-templates
router.get('/schedule-templates', asyncHandlerAuth(agentModeController.getScheduleTemplates));

// GET /api/agent-mode/schedule-templates/:templateId
router.get('/schedule-templates/:templateId', asyncHandlerAuth(agentModeController.getScheduleTemplate));

// PUT /api/agent-mode/schedule-templates/:templateId
router.put('/schedule-templates/:templateId', asyncHandlerAuth(agentModeController.updateScheduleTemplate));

// DELETE /api/agent-mode/schedule-templates/:templateId
router.delete('/schedule-templates/:templateId', asyncHandlerAuth(agentModeController.deleteScheduleTemplate));

// POST /api/agent-mode/schedule-templates/:templateId/use
router.post('/schedule-templates/:templateId/use', asyncHandlerAuth(agentModeController.createScheduleFromTemplate));

// POST /api/agent-mode/schedule-templates/:templateId/submit-for-review
router.post('/schedule-templates/:templateId/submit-for-review', asyncHandlerAuth(agentModeController.submitTemplateForReview));

// GET /api/agent-mode/foundation-tools
// Get foundation tools list (admin only)
router.get('/foundation-tools', requireAdmin, asyncHandler(agentModeController.getFoundationTools));

// PUT /api/agent-mode/foundation-tools
// Update foundation tools list (admin only)
router.put('/foundation-tools', requireAdmin, asyncHandlerAuth(agentModeController.updateFoundationTools));

export default router;
