import { registerLeadNotificationProcessor } from './services/orgLeadNotificationService';
import { registerHotLeadCallProcessor } from './services/hotLeadCallService';
import { evaluationAdminRoutes } from './routes/evaluation';
import { evaluationHttpBoundary } from './middleware/evaluation';
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
import adminZomaScoreboardRoutes from "./routes/adminZomaScoreboard";
import adminZomaReferralsRoutes from "./routes/adminZomaReferrals";
import mcpUsageAdminRoutes from "./routes/mcpUsageAdmin";
import adminV0CreditsRoutes from "./routes/adminV0Credits";
import adminVendorRatesRoutes from "./routes/adminVendorRates";
import adminCustomSubscriptionLinksRoutes from "./routes/adminCustomSubscriptionLinks";
import internalUsageRoutes from "./routes/internalUsage";
import configRouter from "./routes/config";
import browserCookiesRouter from "./routes/browserCookies";
import workflowRoutes from "./routes/workflows";
import templateRoutes from "./routes/templates";
import chatbotRoutes from "./routes/chatbot";
import docsRoutes from "./routes/docs";
import stripeRoutes from "./routes/stripe";
import stripeConnectRoutes from "./routes/stripeConnect";
import brandRoutes from "./routes/brand";
import marketStrategyRoutes from "./routes/marketStrategy";
import slackRoutes from "./routes/slack";
import teamsRoutes from "./routes/teamsMessages";
import approvalDeskRoutes from "./routes/approvalDesk";
import metaRoutes from "./routes/meta";
import metaV2Routes from "./routes/metaV2";
import blogRoutes from "./routes/blog";
import agentModeRoutes from "./routes/agentMode";
import settingsRoutes from "./routes/settings";
import imageModelsRoutes from "./routes/image-models";
import webhookRoutes from "./routes/webhooks";
import { PUBLIC_LEAD_ALIAS_PATH, publicLeadAlias } from "./routes/publicLeadAlias";
import twilioVoiceWebhookRoutes, { twilioVoiceBodyParser } from "./routes/twilioVoiceWebhook";
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
import calendlyAuthRoutes from "./routes/calendlyAuth";
import lumaAuthRoutes from "./routes/lumaAuth";
import smartleadAuthRoutes from "./routes/smartleadAuth";
import smartleadPushRoutes from "./routes/smartleadPush";
import smartleadWebhookRoutes, { smartleadWebhookPreParse } from "./routes/smartleadWebhook";
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
import xAdsAuthRoutes from "./routes/xAdsAuth";
import fathomAuthRoutes from "./routes/fathomAuth";
import fathomWebhookRoutes from "./routes/fathomWebhook";
import whatsappWebhookRoutes from "./routes/whatsappWebhook";
import messagingChannelsRoutes from "./routes/messagingChannels";
import approvalRequestsRoutes from "./routes/approvalRequests";
import calendlyWebhookRoutes from "./routes/calendlyWebhook";
import unipileWebhookRoutes from "./routes/unipileWebhook";
// ENG-926 §C: registers the CRM -> Meta conversion relay's queue processor at boot. The
// poller leaves a job claimed-but-unprocessed when no processor is registered for its
// source, so this cannot be deferred to the first status transition of a process's life —
// jobs queued before that (including any left pending by a restart) would strand.
import { registerConversionRelayProcessor } from "./services/metaConversionRelay";
import fathomOnboardingAdminRoutes from "./routes/fathomOnboardingAdmin";
import hubspotAuthRoutes from "./routes/hubspotAuth";
import attioAuthRoutes from "./routes/attioAuth";
import crmSyncRoutes from "./routes/crmSync";
import adsThresholdsRoutes from "./routes/adsThresholds";
import outcomeLedgerRoutes from "./routes/outcomeLedger";
import crmWebhookRoutes from "./routes/crmWebhook";
import mcpServersRoutes, { mcpOAuthPublicRouter } from "./routes/mcpServers";
import metaToolkitRoutes from "./routes/metaToolkit";
import zomaRoutes from "./routes/zoma";
import { createToolBridgeRouter } from "./routes/toolBridge";
import { createLlmConnectionsRouter } from "./routes/llmConnections";
import { createHostedSubscriptionsRouter } from "./routes/hostedSubscriptions";
import { toolBridgeMcp } from "./services/funding/toolBridgeService";
import skillRoutes from "./routes/skillRoutes";
import userSkillRoutes from "./routes/userSkillRoutes";
import userWorkPlanRoutes from "./routes/userWorkPlanRoutes";
import adminWorkPlanRoutes from "./routes/adminWorkPlanRoutes";
import adminLandingPagesRoutes from "./routes/adminLandingPages";
import adminSessionCleanupRoutes from "./routes/adminSessionCleanup";
import adminOrgDiagnosticsRoutes from "./routes/adminOrgDiagnostics";
import adminScheduledChatsRoutes from "./routes/adminScheduledChats";
import adminTrackingMonitorRoutes from "./routes/adminTrackingMonitor";
import adminRenewalIntegrationHealthRoutes from "./routes/adminRenewalIntegrationHealth";
import adminPromptTemplatesRoutes from "./routes/adminPromptTemplates";
import adminScheduleTemplateRoutes from "./routes/adminScheduleTemplateRoutes";
import adminGoldenSetRoutes from "./routes/adminGoldenSet";
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
import landerUtmRoutes from "./routes/landerUtm";
import htmlTemplatesRoutes from "./routes/htmlTemplates";
import landingPageGenerationRoutes from "./routes/landingPageGeneration";
import domainRoutes from "./routes/domains";
import resultEndpointsRoutes, { reviewRouter } from "./routes/resultEndpoints";
import batchReviewRoutes, { batchReviewPublicRouter } from "./routes/batchReview";
import imageReportsRoutes from "./routes/imageReports";
import clientHealthRoutes from "./routes/clientHealth";
import leadVolumeMonitorRoutes from "./routes/leadVolumeMonitor";
import l2DiagnoseRoutes from "./routes/l2Diagnose";
import leadMagnetRoutes from "./routes/leadMagnet";
import orgRoutes from "./routes/org";
import sourceAccessRoutes from "./routes/sourceAccess";
import orgMemoryRoutes from "./routes/orgMemory";
import orgModelRolesRoutes from './routes/orgModelRoles';
import orgShareSettingsRoutes from "./routes/orgShareSettings";
import orgHotLeadCallRoutes from "./routes/orgHotLeadCall";
import orgMemberRemovalRoutes from "./routes/orgMemberRemoval";
import testAccountsRoutes from "./routes/testAccounts";
import onboardingEventsRoutes from "./routes/onboardingEvents";
import onboardingVariantsRoutes from "./routes/onboardingVariants";
import loopEventsRoutes from "./routes/loopEvents";
import humanEvalRoutes from "./routes/humanEval";
import trackingRoutes from "./routes/tracking";
import trackIngestRoutes, { trackBodyParser } from "./routes/trackIngest";
import sdkRouter from "./routes/trackSdk";
import { registerAiEvalFunnelForProduction } from "./loops/instances/ai-eval-funnel";
import { registerAiReadinessFunnel } from "./loops/instances/ai-readiness-funnel";
import { checkFinalizeGuardMisconfiguration, registerAgentModeLoop } from "./loops/instances/agent-mode";
import loopHealthRoutes from "./routes/loopHealth";
import brandBuildRoutes from "./routes/brandBuild";
import designSystemBuildRoutes from "./routes/designSystemBuild";
import adGenRoutes from "./routes/adGen";
import onboardingStepsRoutes from "./routes/onboardingSteps";
import outreachOnboardingRoutes from "./routes/outreachOnboarding";
import usersRoutes from "./routes/users";
import charactersRoutes from "./routes/characters";
import contractorRoutes from "./routes/contractor";
import { authenticateToken } from "./middleware/auth";
import { isAdmin } from "./middleware/admin";
import { authenticateAgentRunsSecretOrAdmin } from "./middleware/agentRunsAuth";


import { setupMcpServer } from "./mcp/server/mcpServer";
import { setupMcpOAuth } from "./mcp/oauth/oauthRoutes";
import {
  getFileContent,
  saveHtmlContent,
  getPresignedFileUrl,
  batchPresignUrls,
  exportHtmlToPdf,
} from "./controllers/filesController";
import { serveAsset, getAssetStats } from "./controllers/assetController";
import { healthPayload } from "./utils/buildInfo";

const app = express();

// ENG-493: trust the first 2 hops in front of this process so `req.ip` (and everything
// keyed off it, e.g. express-rate-limit's default per-IP keying in routes/auth.ts)
// resolves to the real client instead of collapsing to one value for every caller.
//
// Prod topology is ALB -> nginx -> Node, all on the same EB instance, with nginx
// proxying to Node over loopback. The EB-platform-managed nginx config for the general
// proxy location isn't in this repo (only .platform/nginx/conf.d/elasticbeanstalk/
// websocket.conf's /socket.io/ location is, as an analogous example of the same directive
// — it does not itself govern the routes below), so this is confirmed against live prod
// rather than static config: nginx sets `X-Forwarded-For: $proxy_add_x_forwarded_for`,
// which APPENDS nginx's own
// connecting address (the ALB's private IP) to whatever X-Forwarded-For it received —
// and the ALB itself already sets X-Forwarded-For to the real client IP before that.
// So by the time Express sees the request: the socket is loopback (hop 1, nginx) and
// X-Forwarded-For is "<real client>, <ALB private IP>" (hop 2 is the ALB). Trusting 2
// hops skips both and leaves the real client as `req.ip` — confirmed by spoofing
// X-Forwarded-For against live prod and reading the raw header chain Node received:
// exactly 2 trailing hops, no CDN/WAF in front. nginx's own $remote_addr is always one
// of a small set of internal ALB addresses, but that set churns across AZs, so this is
// keyed on a numeric hop count, never an IP allowlist.
//
// This is load-bearing on the ALB's own X-Forwarded-For handling, not just nginx's:
//   - routing.http.xff_header_processing.mode must stay "append" (the default). If it's
//     ever changed to "preserve", the ALB stops appending the real client IP and the
//     chain collapses to "<attacker-supplied XFF>, <ALB private IP>" — hop count 2 would
//     then resolve `req.ip` straight to an attacker-controlled value instead of skipping
//     past it, the exact spoofing class this fix (and its rework test) exists to prevent.
//   - routing.http.xff_client_port.enabled must stay disabled — enabling it appends
//     "ip:port" entries that `proxy-addr` doesn't parse as a plain address.
// Both are ALB load balancer attributes, not app code — nothing here enforces them.
app.set('trust proxy', 2);

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
    ];

    // ngrok tunnels are a local-dev convenience (exposing a laptop's backend to a
    // webhook sender, a mobile device, etc.) and must never be a credentialed
    // origin in production — any ngrok tenant on the internet would otherwise be
    // allowed (ENG-1751). Fail closed on NODE_ENV: neither tracked EB config nor
    // package.json sets NODE_ENV=production explicitly, so `!== "production"`
    // was fail-open (unset/mistyped/staging all fell through as "allow"), the
    // exact class of bug already fixed in webhooks.ts's Attio isDev check. Only
    // an explicit NODE_ENV=development, or the CORS_ALLOW_NGROK=1 opt-in, allows
    // ngrok origins.
    if (
      process.env.NODE_ENV === "development" ||
      process.env.CORS_ALLOW_NGROK === "1"
    ) {
      allowedOrigins.push(
        /^https:\/\/[a-zA-Z0-9\-]+\.ngrok-free\.app$/, // Allow any ngrok-free.app subdomain
        /^https:\/\/[a-zA-Z0-9\-]+\.ngrok\.io$/ // Allow any ngrok.io subdomain
      );
    }

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
  // ENG-2650: X-Review-Token carries the result-endpoint reviewer capability
  // from the portal's /review/:sessionId page to the /review API routes.
  allowedHeaders: ["Content-Type", "Authorization", "Cache-Control", "Pragma", "X-Review-Token"],
  // ENG-2418: GET /api/tasks/executions/with-images returns paging metadata in
  // headers; cross-origin the portal can only read them if they are exposed.
  exposedHeaders: ["X-Total-Tasks", "X-Next-Cursor"],
  credentials: true,
};

// CORS middleware with exception for public subscriber join endpoint
app.use((req, res, next) => {
  // Check if this is a public endpoint that needs open CORS
  if (req.path.match(/^\/api\/tasks\/[^\/]+\/subscribers\/join$/) ||
      // ENG-2991: the confirmation page's button is a plain form post. The signed link in the email is the credential (no cookie is sent), so
      // this needs no origin check, and without it the button is refused on any deployment whose address is not on the list above.
      /^\/api\/tasks\/+[^\/]+\/+subscribers\/+confirm\/*$/i.test(req.path) ||
      req.path.startsWith('/api/lead-magnet/') ||
      // ENG-2315: the tracker SDK and its ingest are called from visitors' browsers on any customer
      // domain. Origins are enforced per list inside the route (trackingConfig.allowedOrigins), not here.
      req.path === '/api/track/event' ||
      // ENG-2593: customer web forms on any domain POST leads here from the browser.
      // Access is gated per list (publicAccessEnabled) inside routes/webhooks.ts.
      req.path === '/api/webhooks/forward-lead' ||
      // ENG-2657: emma-forms.js posts to /api/leads/public/:listId (alias of forward-lead below).
      /^\/api\/leads\/public\/[^\/]+\/?$/.test(req.path) ||
      req.path.startsWith('/sdk/v1/') ||
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
app.use("/api/slack/events", express.raw({ type: "application/json", limit: "1mb" }));
app.use("/api/stripe/webhook", express.raw({ type: "application/json" }));
// Stripe Connect webhook needs its own raw-body handler — also before express.json().
app.use("/api/stripe/connect/webhook", express.raw({ type: "application/json" }));
// HubSpot webhook needs raw body for HMAC-SHA256 signature verification.
app.use("/api/webhooks/hubspot", express.raw({ type: "application/json" }));
app.use("/api/webhooks/calendly", express.raw({ type: "application/json" })); // raw body needed for HMAC signature verification
app.use("/api/webhooks/smartlead", ...smartleadWebhookPreParse); // ENG-673: token check first, then the capped raw body (see the route for why the order matters)
app.use("/api/webhooks/attio", express.raw({ type: "application/json" })); // raw body needed for Attio-Signature HMAC verification
// Linear webhook (bug-resolve bridge) needs raw body for HMAC signature verification — before express.json().
app.use("/api/integrations/linear/webhook", express.raw({ type: "application/json" }));
// Featurebase webhook (Slack ship-notify) signs the raw body too — before express.json().
app.use("/api/integrations/featurebase/webhook", express.raw({ type: "application/json" }));
// WhatsApp Cloud API webhook: Meta signs the exact payload bytes as X-Hub-Signature-256,
// so the HMAC must be computed over the raw Buffer, not a re-serialized parse (ENG-273).
app.use("/api/webhooks/whatsapp", express.raw({ type: "application/json", limit: "2mb" }));
// Unipile account_status webhook (ENG-1197): Unipile's deliveries do not carry a
// Content-Type of exactly "application/json", so the global express.json() below
// (which only parses when that type matches) leaves req.body empty, and the
// request then falls through to express.urlencoded() — which parses the raw JSON
// text as a single URL-encoded key with an empty value, logged forever as
// "Malformed payload" (ENG-2180: confirmed in prod, 100% of deliveries across
// every connected account, since this webhook was introduced). This route needs
// no raw Buffer (auth is a plain shared header, not an HMAC over the body), so
// force JSON parsing regardless of the declared content-type instead.
app.use("/api/webhooks/unipile", express.json({ type: () => true, limit: "1mb" }));
// ENG-2315: public tracker ingest. Its own 16kb parser must run before the global 50mb one below
// (body-parser skips a request whose body is already parsed).
app.use("/api/track/event", ...trackBodyParser);
// ENG-2271: Twilio voice callbacks are small flat forms; parse them with a narrow limit first (body-parser
// skips a body that is already parsed), so the global 50mb extended parser below never sees them.
app.use("/api/webhooks/twilio-voice", twilioVoiceBodyParser);
// ENG-2991: the public subscriber calls (join, confirm, unsubscribe, undo) take a short address or a token, and anyone can call them without
// logging in. Parse them with a narrow limit first (body-parser skips a body that is already parsed), so the global 50mb parser below never
// buffers a large body for a request that nothing has limited yet. The routers match paths in any letter case, with a trailing slash and with
// a doubled slash after the mount path (`/api/tasks//<id>/unsubscribe`), so these patterns do too. The unsubscribe call gets more room because its feedback note is cut to 2000 characters by the route, not refused.
const publicSubscriberBody = (limit: string) => [
  express.json({ limit }),
  express.urlencoded({ limit, extended: false }),
  // A body that is too large or not valid is the caller's mistake: answer it here, plainly, by its status, instead of letting the global
  // handler below report every one of these anonymous requests as a server error.
  (err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = Number(err?.status ?? err?.statusCode);
    if (!(status >= 400 && status < 500)) return next(err);
    if (err?.type === "request.aborted" || res.headersSent) return undefined; // the caller went away: nothing to answer
    return res.status(status === 413 ? 413 : 400).json({ message: status === 413 ? "Request too large" : "Invalid request" });
  },
];
app.use(/^\/api\/tasks\/+[^\/]+\/+(?:subscribers\/+(?:join|confirm)|resubscribe)\/*$/i, ...publicSubscriberBody("8kb"));
app.use(/^\/api\/tasks\/+[^\/]+\/+unsubscribe\/*$/i, ...publicSubscriberBody("32kb"));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ENG-2657: /api/leads/public/:listId is an alias of /api/webhooks/forward-lead.
app.post(PUBLIC_LEAD_ALIAS_PATH, publicLeadAlias);
app.use(passport.initialize());
app.use(evaluationHttpBoundary);
app.use("/api/admin/evaluations", evaluationAdminRoutes);

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
// D78: mounted AHEAD of the catch-all `/api/admin` router below (which applies a blanket
// authenticateToken/isAdmin via router.use with no path filter, matching this path too) —
// registration order matters in Express, so a later, more specific mount here would never
// be reached; a request without a valid admin session would 401 out of the catch-all before
// this gate's own secret-header check ever ran. Mounting first means this route's own gate
// decides: a correct AW_AGENT_RUNS_SECRET header authenticates directly (narrowed to one
// sessionId, limit<=3, never falling through to the catch-all below); no header falls
// through to this gate's own authenticateToken/isAdmin call, identical to the old behavior,
// and never reaches the catch-all a second time since this mount already terminates the
// response either way. See middleware/agentRunsAuth.ts.
app.use("/api/admin/agent-runs", authenticateAgentRunsSecretOrAdmin(agentRunsRoutes));
app.use("/api/admin", adminZomaScoreboardRoutes);
app.use("/api/admin", adminZomaReferralsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin", adminUsageRoutes);
app.use("/api/admin", mcpUsageAdminRoutes);
app.use("/api/admin", adminV0CreditsRoutes);
app.use("/api/admin", adminVendorRatesRoutes);
app.use("/api/admin", adminCustomSubscriptionLinksRoutes);
app.use("/api/internal", internalUsageRoutes);
// ENG-2109: MCP endpoint for claude -p sessions this backend spawned. Local-only; see routes/toolBridge.ts.
app.use("/internal/tool-bridge", createToolBridgeRouter(toolBridgeMcp));
// ENG-2110 (1c): connecting a Claude subscription: the sign-in ceremony runs on the login host, so the backend never holds
// the customer's token. Mounted before the generic router so its paths are never read as a connection id.
// (The earlier backend-local ceremony, /claude-subscription/*, was removed: it sealed the token on the connection record.)
app.use("/api/llm-connections/subscriptions/:provider", createHostedSubscriptionsRouter());
// ENG-2105: a customer's own LLM provider keys (BYOK). Adding or re-validating a key
// is gated by the eng1816_funding_flags row; listing and revoking always work.
app.use("/api/llm-connections", createLlmConnectionsRouter());
app.use("/api/config", configRouter);
app.use("/api/browser-cookies", browserCookiesRouter);
app.use("/api/workflows", workflowRoutes);
app.use("/api/templates", templateRoutes);
app.use("/api/chatbot", chatbotRoutes);
app.use("/api/docs", docsRoutes);
app.use("/api/files", fileRoutes);
app.use("/api/stripe/connect", stripeConnectRoutes);
app.use("/api/stripe", stripeRoutes);
app.use("/api/brand", brandRoutes);
app.use("/api/landing-pages/v0", landingPageGenerationRoutes);
app.use("/api/landing-pages", landingPagesRoutes);
app.use("/api/lander-utm", landerUtmRoutes);
app.use("/api/html-templates", authenticateToken, htmlTemplatesRoutes);
app.use("/api/domains", domainRoutes);
app.use("/api/market-strategy", marketStrategyRoutes);
app.use("/api/slack", slackRoutes);
// ENG-272: Teams' Bot Framework endpoint authenticates with a bearer JWT, not an HMAC over the
// raw bytes, and CloudAdapter reads the parsed body — so this belongs here, after
// express.json(), and NOT in the raw-body block above with Slack and WhatsApp.
app.use("/api/teams", teamsRoutes);
app.use("/api/approval-desk", approvalDeskRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/meta/v2", metaV2Routes);
app.use("/api/blog", blogRoutes);
app.use("/api/agent-mode", agentModeRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/image-models", imageModelsRoutes);
// ENG-2271: Twilio voice callbacks (form-encoded, parsed by the narrow 64kb parser mounted before the global
// ones). Every route verifies X-Twilio-Signature itself, so there is deliberately no auth middleware here.
app.use("/api/webhooks/twilio-voice", twilioVoiceWebhookRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/webhooks/fathom", fathomWebhookRoutes);
app.use("/api/webhooks/whatsapp", whatsappWebhookRoutes);
app.use("/api/messaging-channels", messagingChannelsRoutes);
app.use("/api/approval-requests", approvalRequestsRoutes);
app.use("/api/webhooks/calendly", calendlyWebhookRoutes);
app.use("/api/webhooks/smartlead", smartleadWebhookRoutes); // ENG-673: no user auth; the URL token proves the caller (see the route)
app.use("/api/webhooks/unipile", unipileWebhookRoutes);
registerConversionRelayProcessor();
registerLeadNotificationProcessor();
registerHotLeadCallProcessor();
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
app.use("/api/crm/smartlead-push", smartleadPushRoutes);  // before the main crm routes
app.use("/api/crm/sequences", sequenceRoutes);
app.use("/api/crm/companies", crmCompaniesRoutes);
app.use("/api/crm", crmRoutes);
// ENG-1100 — caller-scoped, Super Premium-gated recap read paths (ENG-711 consumer).
import recapRoutes from "./routes/recap";
app.use("/api/recap", recapRoutes);
// ENG-918 — per-account ads-detection thresholds. Every route authenticates and re-derives
// ad-account ownership from the caller's own connected accounts; see the route file's header.
app.use("/api/ads-thresholds", adsThresholdsRoutes);
// ENG-1550 — outcome ledger. Read is owner-scoped like ads-thresholds; record/score are
// admin-only — a recommendation is the agent's own prediction, not a customer-set value. See the
// route file's header.
app.use("/api/outcome-ledger", outcomeLedgerRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/books", booksRoutes);
app.use("/api/oauth/linkedin", linkedinAuthRoutes);
app.use("/api/oauth/linkedin-outreach", linkedInOutreachAuthRoutes);
app.use("/api/oauth/linkedin-ads", linkedInAdsAuthRoutes);
app.use("/api/oauth/gmail", gmailAuthRoutes);
app.use("/api/oauth/outlook", outlookAuthRoutes);
app.use("/api/oauth/calendly", calendlyAuthRoutes);
app.use("/api/oauth/luma", lumaAuthRoutes);
app.use("/api/oauth/smartlead", smartleadAuthRoutes);
app.use("/api/oauth/google-drive", googleDriveAuthRoutes);
app.use("/api/oauth/twitter", twitterAuthRoutes);
app.use("/api/oauth/meta", metaAuthRoutes);
app.use("/api/oauth/instagram", metaAuthRoutes);
app.use("/api/oauth/youtube", youtubeAuthRoutes);
app.use("/api/oauth/google-ads", googleAdsAuthRoutes);
app.use("/api/oauth/x-ads", xAdsAuthRoutes); // ENG-3142: 404s while ZOMA_X_ADS_ENABLED is off
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
// ENG-2288: external-agent Meta Toolkit. Auth is the gateway's own bearer check
// (aw_ agent API key or MCP OAuth token), not the portal JWT.
app.use("/api/meta-toolkit", metaToolkitRoutes);
// ENG-2496: Zoma device-flow onboarding. Unauthenticated by design (RFC 8628); the
// user binds the device code through the existing MCP OAuth sign-in + consent page.
app.use("/api/zoma", zomaRoutes);
app.use("/api/admin/mcp-servers", authenticateToken, isAdmin, mcpServersRoutes);
app.use("/api/admin/lead-magnets", authenticateToken, isAdmin, leadMagnetAdminRoutes);
app.use("/api/admin/fathom-onboarding", authenticateToken, isAdmin, fathomOnboardingAdminRoutes);
app.use("/api/admin/onboarding-loop", authenticateToken, isAdmin, onboardingLoopAdminRoutes);
app.use("/api/admin/loops", authenticateToken, isAdmin, loopHealthRoutes);
app.use("/api/client-health", authenticateToken, isAdmin, clientHealthRoutes);
// ENG-1551 — lead volume drought monitor. Same double-gate as client-health: middleware +
// service-layer admin check.
app.use("/api/lead-volume-monitor", authenticateToken, isAdmin, leadVolumeMonitorRoutes);
app.use("/api/l2-diagnose", authenticateToken, isAdmin, l2DiagnoseRoutes);
app.use("/api/skills", authenticateToken, isAdmin, skillRoutes);
app.use("/api/user-skills", authenticateToken, userSkillRoutes);
app.use("/api/user-work-plans", authenticateToken, userWorkPlanRoutes);
app.use("/api/admin/work-plans", authenticateToken, isAdmin, adminWorkPlanRoutes);
app.use("/api/admin/landing-pages", authenticateToken, isAdmin, adminLandingPagesRoutes);
// ENG-2314 — dry-run-first merge/delete of LP session rows. Same admin double-gate as above.
app.use("/api/admin/session-cleanup", authenticateToken, isAdmin, adminSessionCleanupRoutes);
app.use("/api/admin/org-diagnostics", authenticateToken, isAdmin, adminOrgDiagnosticsRoutes);
// ENG-778 — audited cross-owner scheduled-chat inspect + pause/resume (no edit/delete).
app.use("/api/admin/scheduled-chats", authenticateToken, isAdmin, adminScheduledChatsRoutes);
app.use("/api/admin/tracking-monitor", authenticateToken, isAdmin, adminTrackingMonitorRoutes);
app.use("/api/admin/renewal-integration-health", authenticateToken, isAdmin, adminRenewalIntegrationHealthRoutes);
app.use("/api/admin/prompt-templates", authenticateToken, isAdmin, adminPromptTemplatesRoutes);
app.use("/api/admin/schedule-templates", authenticateToken, isAdmin, adminScheduleTemplateRoutes);
// ENG-2135: golden-set labelling (inert until EVAL_GOLDEN_CASES_TABLE is set by OPS-2).
app.use("/api/admin/eval/golden-cases", authenticateToken, isAdmin, adminGoldenSetRoutes);
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
// ENG-2313: traffic-source taxonomy + tagged-link generator. Pure, no persistence; the router
// applies authenticateToken itself (user auth, not admin).
app.use("/api/tracking", trackingRoutes);
// ENG-2315: public (unauthenticated) tracker ingest + SDK. Distinct prefix from /api/tracking above, which is user-auth.
app.use("/api/track", trackIngestRoutes);
app.use("/sdk/v1", sdkRouter);

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
app.use("/api/onboarding", designSystemBuildRoutes);
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
app.use("/api/source-access", sourceAccessRoutes);
app.use("/api/org", orgMemoryRoutes);
app.use("/api/orgs/me/model-roles", authenticateToken, orgModelRolesRoutes);
app.use("/api/orgs/me/share-settings", authenticateToken, orgShareSettingsRoutes);
app.use("/api/orgs/me/hot-lead-call", authenticateToken, orgHotLeadCallRoutes);
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
  res.status(200).json(healthPayload());
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
