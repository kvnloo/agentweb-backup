import express from "express";
import nodePath from "path";
import cors from "cors";
import passport from "passport";
import authRoutes from "./routes/auth";
import taskRoutes from "./routes/tasks";
import waitlistRoutes from "./routes/waitlist";
import scheduleRoutes from "./routes/schedules";
import adminRoutes from "./routes/admin";
import adminUsageRoutes from "./routes/adminUsage";
import mcpUsageAdminRoutes from "./routes/mcpUsageAdmin";
import adminV0CreditsRoutes from "./routes/adminV0Credits";
import internalUsageRoutes from "./routes/internalUsage";
import configRouter from "./routes/config";
import browserCookiesRouter from "./routes/browserCookies";
import workflowRoutes from "./routes/workflows";
import templateRoutes from "./routes/templates";
import chatbotRoutes from "./routes/chatbot";
import growthGeniusRoutes from "./routes/growthGenius";
import docsRoutes from "./routes/docs";
import stripeRoutes from "./routes/stripe";
import stripeConnectRoutes from "./routes/stripeConnect";
import brandRoutes from "./routes/brand";
import marketStrategyRoutes from "./routes/marketStrategy";
import slackRoutes from "./routes/slack";
import metaRoutes from "./routes/meta";
import metaV2Routes from "./routes/metaV2";
import blogRoutes from "./routes/blog";
import agentModeRoutes from "./routes/agentMode";
import settingsRoutes from "./routes/settings";
import imageModelsRoutes from "./routes/image-models";
import webhookRoutes from "./routes/webhooks";
import devEnvRoutes from "./routes/devEnv";
import benchmarkRoutes from "./routes/benchmark";
import seoRoutes from "./routes/seo";
import funnelRoutes from "./routes/funnel";
import gtmPlanRoutes from "./routes/gtmPlan";
import crmRoutes from "./routes/crm";
import crmCompaniesRoutes from "./routes/crmCompanies";
import sequenceRoutes from "./routes/sequences";
import crmPublicRoutes from "./routes/crmPublic";
import subscriptionRoutes from "./routes/subscription";
import booksRoutes from "./routes/books";
import linkedinAuthRoutes from "./routes/linkedinAuth";
import gmailAuthRoutes from "./routes/gmailAuth";
import outlookAuthRoutes from "./routes/outlookAuth";
import googleDriveAuthRoutes from "./routes/googleDriveAuth";
import twitterAuthRoutes from "./routes/twitterAuth";
import metaAuthRoutes from "./routes/metaAuth";
import clickupAuthRoutes from "./routes/clickupAuth";
import foreplayAuthRoutes from "./routes/foreplayAuth";
import connectedAccountsRoutes from "./routes/connectedAccounts";
import linkedInOutreachAuthRoutes from "./routes/linkedInOutreachAuth";
import linkedInAdsAuthRoutes from "./routes/linkedInAdsAuth";
import youtubeAuthRoutes from "./routes/youtubeAuth";
import googleAdsAuthRoutes from "./routes/googleAdsAuth";
import fathomAuthRoutes from "./routes/fathomAuth";
import fathomWebhookRoutes from "./routes/fathomWebhook";
import whatsappWebhookRoutes from "./routes/whatsappWebhook";
import messagingChannelsRoutes from "./routes/messagingChannels";
import fathomOnboardingAdminRoutes from "./routes/fathomOnboardingAdmin";
import hubspotAuthRoutes from "./routes/hubspotAuth";
import attioAuthRoutes from "./routes/attioAuth";
import crmSyncRoutes from "./routes/crmSync";
import crmWebhookRoutes from "./routes/crmWebhook";
import mcpServersRoutes, { mcpOAuthPublicRouter } from "./routes/mcpServers";
import skillRoutes from "./routes/skillRoutes";
import userSkillRoutes from "./routes/userSkillRoutes";
import userWorkPlanRoutes from "./routes/userWorkPlanRoutes";
import adminWorkPlanRoutes from "./routes/adminWorkPlanRoutes";
import adminPromptTemplatesRoutes from "./routes/adminPromptTemplates";
import adminScheduleTemplateRoutes from "./routes/adminScheduleTemplateRoutes";
import supportRoutes from "./routes/support";
import integrationsRoutes from "./routes/integrations";
import featurebaseRoutes from "./routes/featurebase";
import errorsRoutes from "./routes/errors";
import agentApiRoutes from "./routes/agentApi";
import emmaApiRoutes from "./routes/emmaApi";
import memoryRoutes from "./routes/memory";
import leadMagnetAdminRoutes from "./routes/leadMagnetAdmin";
import onboardingLoopAdminRoutes from "./routes/onboardingLoopAdmin";
import agentRunsRoutes from "./routes/agentRuns";
import socialPostsRoutes from "./routes/socialPosts";
import landingPagesRoutes from "./routes/landingPages";
import htmlTemplatesRoutes from "./routes/htmlTemplates";
import landingPageGenerationRoutes from "./routes/landingPageGeneration";
import domainRoutes from "./routes/domains";
import resultEndpointsRoutes, { reviewRouter } from "./routes/resultEndpoints";
import batchReviewRoutes, { batchReviewPublicRouter } from "./routes/batchReview";
import imageReportsRoutes from "./routes/imageReports";
import clientHealthRoutes from "./routes/clientHealth";
import leadMagnetRoutes from "./routes/leadMagnet";
import orgRoutes from "./routes/org";
import orgMemoryRoutes from "./routes/orgMemory";
import orgShareSettingsRoutes from "./routes/orgShareSettings";
import orgMemberRemovalRoutes from "./routes/orgMemberRemoval";
import testAccountsRoutes from "./routes/testAccounts";
import onboardingEventsRoutes from "./routes/onboardingEvents";
import onboardingVariantsRoutes from "./routes/onboardingVariants";
import loopEventsRoutes from "./routes/loopEvents";
import humanEvalRoutes from "./routes/humanEval";
import { registerAiEvalFunnelForProduction } from "./loops/instances/ai-eval-funnel";
import { registerAiReadinessFunnel } from "./loops/instances/ai-readiness-funnel";
import { checkFinalizeGuardMisconfiguration, registerAgentModeLoop } from "./loops/instances/agent-mode";
import loopHealthRoutes from "./routes/loopHealth";
import brandBuildRoutes from "./routes/brandBuild";
import adGenRoutes from "./routes/adGen";
import onboardingStepsRoutes from "./routes/onboardingSteps";
import outreachOnboardingRoutes from "./routes/outreachOnboarding";
import usersRoutes from "./routes/users";
import charactersRoutes from "./routes/characters";
import contractorRoutes from "./routes/contractor";
import { authenticateToken } from "./middleware/auth";
import { isAdmin } from "./middleware/admin";


import { setupMcpServer } from "./mcp/server/mcpServer";
import { setupMcpOAuth } from "./mcp/oauth/oauthRoutes";
import {
  viewExternalFile,
  getFileContent,
  saveHtmlContent,
  getPresignedFileUrl,
  batchPresignUrls,
  exportHtmlToPdf,
} from "./controllers/filesController";
import { serveAsset, getAssetStats } from "./controllers/assetController";

const app = express();

// Security hardening (TAC Security report — Low findings):
//   1. Remove the default "X-Powered-By: Express" header so the framework is not
//      disclosed to unauthenticated clients (fingerprinting aid).
//   2. Add standard security response headers on every response. We set these
//      manually rather than pulling in helmet to avoid a new dependency and to
//      keep full control over values (helmet's CSP/defaults can break the
//      existing CORS + cross-origin asset flows).
app.disable("x-powered-by");
app.use((req, res, next) => {
  // Prevent MIME-type sniffing.
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Disallow framing to mitigate clickjacking. The API is not meant to be framed.
  res.setHeader("X-Frame-Options", "DENY");
  // Do not leak the full URL (which may contain tokens/ids) in the Referer header.
  res.setHeader("Referrer-Policy", "no-referrer");
  // Enforce HTTPS for one year, including subdomains. Safe because all production
  // traffic is served over TLS via nginx/Elastic Beanstalk.
  res.setHeader(
    "Strict-Transport-Security",
    "max-age=31536000; includeSubDomains"
  );
  next();
});

// Initialize MCP Server routes BEFORE global body parsers
setupMcpServer(app);

// Initialize MCP OAuth 2.1 routes (well-known, register, authorize, token)
// NOTE: setupMcpOAuth used to be called here, before the CORS middleware and
// body parsers. That broke browser-driven OAuth consent because the MCP OAuth
// routes were never wrapped in CORS headers and had to register their own
// per-route body parsers. Moved below, after the global CORS and body parsers.

// CORS configuration
const corsOptions = {
  origin: function (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) {
    const allowedOrigins = [
      /^https:\/\/[a-zA-Z0-9\-]+\.agentweb\.pro$/, // Allow any subdomain of agentweb.pro
      /^https:\/\/[a-zA-Z0-9\-]+\.agentwebforms\.com$/, // Allow any subdomain of agentwebforms.com
      "https://agentweb.pro", // Main Production Partner URL
      /^https:\/\/[a-zA-Z0-9\-]+\.hireemma\.ai$/, // Allow any subdomain of hireemma.ai (e.g. www)
      "https://hireemma.ai", // hireemma.ai apex domain
      "https://agentweb-user-files.s3.us-west-2.amazonaws.com", // S3 bucket for user files
      process.env.FRONTEND_URL || "http://localhost:5173", // Partner Portal (Deployed or Local)
      process.env.CUSTOMER_FRONTEND_URL || "http://localhost:5174", // Customer Portal (Deployed or Local)
      process.env.GROWTH_GENIUS_CHAT_URL || "http://localhost:8080", // Growth Genius Chat (Deployed or Local)
      /^https:\/\/[a-zA-Z0-9\-]+\.ngrok-free\.app$/, // Allow any ngrok-free.app subdomain
      /^https:\/\/[a-zA-Z0-9\-]+\.ngrok\.io$/, // Allow any ngrok.io subdomain
    ];

    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Check if the origin matches any allowed pattern or string
    const isAllowed = allowedOrigins.some((allowedOrigin) => {
      if (allowedOrigin instanceof RegExp) {
        return allowedOrigin.test(origin);
      }
      return origin === allowedOrigin;
    });

    // Allow local network IP addresses (192.168.x.x, 10.x.x.x, 172.16-31.x.x, localhost, 127.0.0.1)
    if (!isAllowed) {
      const localNetworkPatterns = [
        /^http:\/\/localhost(:\d+)?$/, // localhost with optional port
        /^http:\/\/127\.0\.0\.1(:\d+)?$/, // 127.0.0.1 with optional port
        /^http:\/\/192\.168\.\d+\.\d+(:\d+)?$/, // 192.168.x.x with optional port
        /^http:\/\/10\.\d+\.\d+\.\d+(:\d+)?$/, // 10.x.x.x with optional port
        /^http:\/\/172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+(:\d+)?$/, // 172.16-31.x.x with optional port
        /^https?:\/\/\d+\.\d+\.\d+\.\d+(:\d+)?$/, // Any IP address (for cloud test environments)
      ];

      const isLocalNetwork = localNetworkPatterns.some((pattern) =>
        pattern.test(origin)
      );

      if (isLocalNetwork) {
        return callback(null, true);
      }
    }

    if (isAllowed) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  // OPTIONS is intentionally omitted — the cors middleware handles preflight (OPTIONS)
  // requests automatically. This list specifies allowed methods for actual requests.
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  // Cache-Control + Pragma are needed because the top-nav UsageMeter's
  // useTokenUsage hook cache-busts /api/subscription/usage with those request
  // headers; cross-origin (app.agentweb.pro -> api.agentweb.pro) the browser
  // preflights them and, if absent here, blocks the fetch so the meter never loads.
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma"],
  credentials: true,
};

// CORS middleware with exception for public subscriber join endpoint
app.use((req, res, next) => {
  // Check if this is a public endpoint that needs open CORS
  if (req.path.match(/^\/api\/tasks\/[^\/]+\/subscribers\/join$/) ||
      req.path.startsWith('/api/lead-magnet/') ||
      req.path.startsWith('/batch-review/')) {
    // Allow all origins for public endpoints
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }
    // Skip the main CORS middleware for this endpoint
    return next();
  }
  // Apply CORS middleware for all other routes
  cors(corsOptions)(req, res, next);
});
// Stripe webhook needs the raw body (Buffer) for signature verification.
// This MUST come before express.json() which parses the body.
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
// Stripe Connect webhook needs its own raw-body handler — also before express.json().
app.use("/api/stripe/connect/webhook", express.raw({ type: "application/json" }));
// HubSpot webhook needs raw body for HMAC-SHA256 signature verification.
app.use("/api/webhooks/hubspot", express.raw({ type: "application/json" }));
// Linear webhook (bug-resolve bridge) needs raw body for HMAC signature verification — before express.json().
app.use("/api/integrations/linear/webhook", express.raw({ type: "application/json" }));
// Featurebase webhook (Slack ship-notify) signs the raw body too — before express.json().
app.use("/api/integrations/featurebase/webhook", express.raw({ type: "application/json" }));
// WhatsApp Cloud API webhook: Meta signs the exact payload bytes as X-Hub-Signature-256,
// so the HMAC must be computed over the raw Buffer, not a re-serialized parse (ENG-273).
app.use("/api/webhooks/whatsapp", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(passport.initialize());

// MCP OAuth 2.1 routes. Registered AFTER the CORS middleware and body parsers
// so the consent page (served from the customer portal origin) can POST to
// /oauth/authorize/decision without being blocked, and so the decision +
// token endpoints inherit the global JSON + urlencoded body parsers instead
// of re-registering their own.
setupMcpOAuth(app);

// Create a new router for file-related routes
const fileRoutes = express.Router();
fileRoutes.get("/content", authenticateToken, getFileContent);
fileRoutes.post("/html", authenticateToken, saveHtmlContent);
fileRoutes.get("/presign", authenticateToken, getPresignedFileUrl);
fileRoutes.post("/presign-batch", authenticateToken, batchPresignUrls);
fileRoutes.post("/export-pdf", authenticateToken, exportHtmlToPdf);

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/users", usersRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/waitlist", waitlistRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminUsageRoutes);
app.use("/api/admin", mcpUsageAdminRoutes);
app.use("/api/admin", adminV0CreditsRoutes);
app.use("/api/internal", internalUsageRoutes);
app.use("/api/config", configRouter);
app.use("/api/browser-cookies", browserCookiesRouter);
app.use("/api/workflows", workflowRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/chatbot", chatbotRoutes);
app.use("/api/growth-genius", growthGeniusRoutes);
app.use("/api/docs", docsRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/stripe/connect", stripeConnectRoutes);
app.use("/api/stripe", stripeRoutes);
app.use("/api/brand", brandRoutes);
app.use("/api/landing-pages/v0", landingPageGenerationRoutes);
app.use("/api/landing-pages", landingPagesRoutes);
app.use("/api/html-templates", authenticateToken, htmlTemplatesRoutes);
app.use("/api/domains", domainRoutes);
app.use("/api/market-strategy", marketStrategyRoutes);
app.use("/api/slack", slackRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/meta/v2", metaV2Routes);
app.use("/api/blog", blogRoutes);
app.use("/api/agent-mode", agentModeRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/image-models", imageModelsRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/webhooks/fathom", fathomWebhookRoutes);
app.use("/api/webhooks/whatsapp", whatsappWebhookRoutes);
app.use("/api/messaging-channels", messagingChannelsRoutes);
app.use("/api", devEnvRoutes);
app.use("/api/benchmark", benchmarkRoutes);
app.use("/api/seo", seoRoutes);
app.use("/api/funnels", funnelRoutes);
app.use("/api/gtm-plan", gtmPlanRoutes);
app.use("/api/crm/public", crmPublicRoutes);
app.use("/api/crm", crmWebhookRoutes);  // per-list webhook URLs — must be after /public, before main crm routes
// Apollo run_waterfall_email async callback. Public route (Apollo doesn't
// send a JWT); auth is via shared secret in the URL query string. Must be
// mounted BEFORE crmRoutes which applies authenticateToken to everything.
import apolloWebhookRoutes from "./routes/apolloWebhook";
app.use("/api/crm/webhooks/apollo", apolloWebhookRoutes);
app.use("/api/crm/sequences", sequenceRoutes);
app.use("/api/crm/companies", crmCompaniesRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/books", booksRoutes);
app.use("/api/oauth/linkedin", linkedinAuthRoutes);
app.use("/api/oauth/linkedin-outreach", linkedInOutreachAuthRoutes);
app.use("/api/oauth/linkedin-ads", linkedInAdsAuthRoutes);
app.use("/api/oauth/gmail", gmailAuthRoutes);
app.use("/api/oauth/outlook", outlookAuthRoutes);
app.use("/api/oauth/google-drive", googleDriveAuthRoutes);
app.use("/api/oauth/twitter", twitterAuthRoutes);
app.use("/api/oauth/meta", metaAuthRoutes);
app.use("/api/oauth/instagram", metaAuthRoutes);
app.use("/api/oauth/youtube", youtubeAuthRoutes);
app.use("/api/oauth/google-ads", googleAdsAuthRoutes);
app.use("/api/oauth/fathom", fathomAuthRoutes);
app.use("/api/oauth/hubspot", hubspotAuthRoutes);
app.use("/api/oauth/attio", attioAuthRoutes);
app.use("/api/crm-sync", crmSyncRoutes);
app.use("/api/oauth/clickup", clickupAuthRoutes);
app.use("/api/oauth/foreplay", foreplayAuthRoutes);
app.use("/api/oauth", connectedAccountsRoutes);
// Public OAuth redirect callback for outbound MCP server connections (no auth —
// the browser is redirected here by the OAuth provider with no JWT).
app.use("/api/mcp-oauth", mcpOAuthPublicRouter);
app.use("/api/admin/mcp-servers", authenticateToken, isAdmin, mcpServersRoutes);
app.use("/api/admin/lead-magnets", authenticateToken, isAdmin, leadMagnetAdminRoutes);
app.use("/api/admin/fathom-onboarding", authenticateToken, isAdmin, fathomOnboardingAdminRoutes);
app.use("/api/admin/onboarding-loop", authenticateToken, isAdmin, onboardingLoopAdminRoutes);
app.use("/api/admin/loops", authenticateToken, isAdmin, loopHealthRoutes);
app.use("/api/admin/agent-runs", authenticateToken, isAdmin, agentRunsRoutes);
app.use("/api/client-health", authenticateToken, isAdmin, clientHealthRoutes);
app.use("/api/skills", authenticateToken, isAdmin, skillRoutes);
app.use("/api/user-skills", authenticateToken, userSkillRoutes);
app.use("/api/user-work-plans", authenticateToken, userWorkPlanRoutes);
app.use("/api/admin/work-plans", authenticateToken, isAdmin, adminWorkPlanRoutes);
app.use("/api/admin/prompt-templates", authenticateToken, isAdmin, adminPromptTemplatesRoutes);
app.use("/api/admin/schedule-templates", authenticateToken, isAdmin, adminScheduleTemplateRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/integrations", integrationsRoutes);
app.use("/api/featurebase", featurebaseRoutes);
app.use("/api/errors", errorsRoutes);
app.use("/api/v1/agent", agentApiRoutes);
app.use("/api/emma", emmaApiRoutes);
app.use("/api/memory", memoryRoutes);
app.use("/api/test-accounts", testAccountsRoutes);
app.use("/api/onboarding", onboardingEventsRoutes);
app.use("/api/onboarding", onboardingVariantsRoutes);
app.use("/api/loop-events", loopEventsRoutes);
app.use("/api/human-eval", humanEvalRoutes);

// Register closed-loop instances with production impls. The route handlers
// look up loop manifests from LOOP_REGISTRY; the cron in server.ts invokes
// each loop and the generic attribution pass on schedules.
try {
  registerAiEvalFunnelForProduction();
} catch (err) {
  console.warn("[loops] registerAiEvalFunnelForProduction skipped:", String(err));
}
// Always registered so /api/loop-events accepts + stores the lander's events;
// the daily analysis run is scheduled separately in server.ts.
try {
  registerAiReadinessFunnel();
} catch (err) {
  console.warn("[loops] registerAiReadinessFunnel skipped:", String(err));
}
// Always registered so the agent-mode loop is visible to /api/admin/loops/health
// and the attribution cron; the recorder hot-path hook is gated separately by
// AGENT_RUNTIME_SPINE_ENABLED, while the daily analysis run is gated by
// AGENT_MODE_LOOP_ENABLED.
try {
  registerAgentModeLoop();
  const finalizeGuardWarning = checkFinalizeGuardMisconfiguration();
  if (finalizeGuardWarning) {
    console.warn("[loops] finalize guard misconfigured:", finalizeGuardWarning);
  }
} catch (err) {
  console.warn("[loops] registerAgentModeLoop skipped:", String(err));
}
app.use("/api/onboarding", brandBuildRoutes);
app.use("/api/onboarding", adGenRoutes);
app.use("/api/onboarding", onboardingStepsRoutes);
app.use("/api/onboarding", outreachOnboardingRoutes);
app.use("/api", socialPostsRoutes);
app.use("/r", resultEndpointsRoutes);
app.get("/asset/:assetHash/stats", getAssetStats);
app.get("/asset/:assetHash", serveAsset);
app.use("/review", reviewRouter);
app.use("/api/batch-review", batchReviewRoutes);
app.use("/batch-review", batchReviewPublicRouter);
app.use("/api/image-reports", imageReportsRoutes);
app.use("/api/lead-magnet", leadMagnetRoutes);
app.use("/api/org", orgRoutes);
app.use("/api/org", orgMemoryRoutes);
app.use("/api/orgs/me/share-settings", authenticateToken, orgShareSettingsRoutes);
app.use("/api/orgs/me/members", authenticateToken, orgMemberRemovalRoutes);
app.use("/api/characters", charactersRoutes);
app.use("/api/contractor", contractorRoutes);


// Agent API documentation (public, no auth)
app.get("/docs/agent-api", (req, res) => {
  const path = require("path");
  const fs = require("fs");
  const docPath = path.join(__dirname, "../docs/AGENT_API.md");
  try {
    const content = fs.readFileSync(docPath, "utf-8");
    res.type("text/markdown").send(content);
  } catch {
    res.status(404).json({ error: "Documentation not found" });
  }
});

// Serve skill.md — agent-readable guide for external MCP clients (public, no auth)
app.get("/skill.md", (req, res) => {
  const path = require("path");
  const fs = require("fs");
  const docPath = path.join(__dirname, "../docs/skill.md");
  try {
    const content = fs.readFileSync(docPath, "utf-8");
    res.type("text/markdown").send(content);
  } catch {
    res.status(404).json({ error: "Documentation not found" });
  }
});

// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Global error handler — catches unhandled errors from all routes and reports them to Notion
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // CORS rejections are expected for external bots/scanners — return 403 silently, don't report.
  // No ACAO header here: the origin was rejected, so it must stay unreadable to the browser.
  if (err.message === "Not allowed by CORS") {
    if (!res.headersSent) {
      res.status(403).json({ error: "Forbidden" });
    }
    return;
  }
  console.error("Unhandled route error:", err);
  const { reportUIError } = require("./utils/errorReporter");
  reportUIError({
    operation: `${req.method} ${req.path}`,
    errorMessage: err.message || String(err),
    userId: (req as any).user?.userId,
    context: { Path: req.path, Method: req.method },
  }).catch((reportErr: Error) => console.error("errorReporter failed:", reportErr));
  if (!res.headersSent) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// Temporary static exports — for one-off file downloads (files in backend/tmp-exports/)
app.use("/tmp-exports", express.static(nodePath.join(__dirname, "../tmp-exports"), {
  setHeaders: (res, filePath) => {
    res.setHeader("Content-Disposition", `attachment; filename="${nodePath.basename(filePath)}"`);
  },
}));

export default app;
