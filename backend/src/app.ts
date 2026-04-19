import express from "express";
import cors from "cors";
import passport from "passport";
import authRoutes from "./routes/auth";
import taskRoutes from "./routes/tasks";
import waitlistRoutes from "./routes/waitlist";
import scheduleRoutes from "./routes/schedules";
import adminRoutes from "./routes/admin";
import configRouter from "./routes/config";
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
import crmPublicRoutes from "./routes/crmPublic";
import subscriptionRoutes from "./routes/subscription";
import booksRoutes from "./routes/books";
import linkedinAuthRoutes from "./routes/linkedinAuth";
import gmailAuthRoutes from "./routes/gmailAuth";
import metaAuthRoutes from "./routes/metaAuth";
import clickupAuthRoutes from "./routes/clickupAuth";
import foreplayAuthRoutes from "./routes/foreplayAuth";
import connectedAccountsRoutes from "./routes/connectedAccounts";
import linkedInOutreachAuthRoutes from "./routes/linkedInOutreachAuth";
import linkedInAdsAuthRoutes from "./routes/linkedInAdsAuth";
import youtubeAuthRoutes from "./routes/youtubeAuth";
import fathomAuthRoutes from "./routes/fathomAuth";
import fathomWebhookRoutes from "./routes/fathomWebhook";
import hubspotAuthRoutes from "./routes/hubspotAuth";
import attioAuthRoutes from "./routes/attioAuth";
import crmSyncRoutes from "./routes/crmSync";
import crmWebhookRoutes from "./routes/crmWebhook";
import mcpServersRoutes from "./routes/mcpServers";
import skillRoutes from "./routes/skillRoutes";
import userSkillRoutes from "./routes/userSkillRoutes";
import userWorkPlanRoutes from "./routes/userWorkPlanRoutes";
import adminWorkPlanRoutes from "./routes/adminWorkPlanRoutes";
import adminScheduleTemplateRoutes from "./routes/adminScheduleTemplateRoutes";
import supportRoutes from "./routes/support";
import errorsRoutes from "./routes/errors";
import agentApiRoutes from "./routes/agentApi";
import emmaApiRoutes from "./routes/emmaApi";
import memoryRoutes from "./routes/memory";
import leadMagnetAdminRoutes from "./routes/leadMagnetAdmin";
import socialPostsRoutes from "./routes/socialPosts";
import landingPagesRoutes from "./routes/landingPages";
import htmlTemplatesRoutes from "./routes/htmlTemplates";
import landingPageGenerationRoutes from "./routes/landingPageGeneration";
import domainRoutes from "./routes/domains";
import resultEndpointsRoutes, { reviewRouter } from "./routes/resultEndpoints";
import batchReviewRoutes, { batchReviewPublicRouter } from "./routes/batchReview";
import clientHealthRoutes from "./routes/clientHealth";
import leadMagnetRoutes from "./routes/leadMagnet";
import orgRoutes from "./routes/org";
import testAccountsRoutes from "./routes/testAccounts";
import onboardingEventsRoutes from "./routes/onboardingEvents";
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
} from "./controllers/filesController";
import { serveAsset, getAssetStats } from "./controllers/assetController";

const app = express();

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
  allowedHeaders: ["Content-Type", "Authorization"],
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

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/tasks", taskRoutes);
app.use("/api/waitlist", waitlistRoutes);
app.use("/api/schedules", scheduleRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/config", configRouter);
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
app.use("/api/html-templates", htmlTemplatesRoutes);
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
app.use("/api", devEnvRoutes);
app.use("/api/benchmark", benchmarkRoutes);
app.use("/api/seo", seoRoutes);
app.use("/api/funnels", funnelRoutes);
app.use("/api/gtm-plan", gtmPlanRoutes);
app.use("/api/crm/public", crmPublicRoutes);
app.use("/api/crm", crmWebhookRoutes);  // per-list webhook URLs — must be after /public, before main crm routes
app.use("/api/crm", crmRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/books", booksRoutes);
app.use("/api/oauth/linkedin", linkedinAuthRoutes);
app.use("/api/oauth/linkedin-outreach", linkedInOutreachAuthRoutes);
app.use("/api/oauth/linkedin-ads", linkedInAdsAuthRoutes);
app.use("/api/oauth/gmail", gmailAuthRoutes);
app.use("/api/oauth/meta", metaAuthRoutes);
app.use("/api/oauth/instagram", metaAuthRoutes);
app.use("/api/oauth/youtube", youtubeAuthRoutes);
app.use("/api/oauth/fathom", fathomAuthRoutes);
app.use("/api/oauth/hubspot", hubspotAuthRoutes);
app.use("/api/oauth/attio", attioAuthRoutes);
app.use("/api/crm-sync", crmSyncRoutes);
app.use("/api/oauth/clickup", clickupAuthRoutes);
app.use("/api/oauth/foreplay", foreplayAuthRoutes);
app.use("/api/oauth", connectedAccountsRoutes);
app.use("/api/admin/mcp-servers", authenticateToken, isAdmin, mcpServersRoutes);
app.use("/api/admin/lead-magnets", authenticateToken, isAdmin, leadMagnetAdminRoutes);
app.use("/api/client-health", authenticateToken, isAdmin, clientHealthRoutes);
app.use("/api/skills", authenticateToken, isAdmin, skillRoutes);
app.use("/api/user-skills", authenticateToken, userSkillRoutes);
app.use("/api/user-work-plans", authenticateToken, userWorkPlanRoutes);
app.use("/api/admin/work-plans", authenticateToken, isAdmin, adminWorkPlanRoutes);
app.use("/api/admin/schedule-templates", authenticateToken, isAdmin, adminScheduleTemplateRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/errors", errorsRoutes);
app.use("/api/v1/agent", agentApiRoutes);
app.use("/api/emma", emmaApiRoutes);
app.use("/api/memory", memoryRoutes);
app.use("/api/test-accounts", testAccountsRoutes);
app.use("/api/onboarding", onboardingEventsRoutes);
app.use("/api", socialPostsRoutes);
app.use("/r", resultEndpointsRoutes);
app.get("/asset/:assetHash/stats", getAssetStats);
app.get("/asset/:assetHash", serveAsset);
app.use("/review", reviewRouter);
app.use("/api/batch-review", batchReviewRoutes);
app.use("/batch-review", batchReviewPublicRouter);
app.use("/api/lead-magnet", leadMagnetRoutes);
app.use("/api/org", orgRoutes);


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
  // CORS rejections are expected for external bots/scanners — return 403 silently, don't report
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

export default app;
