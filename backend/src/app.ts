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
import brandRoutes from "./routes/brand";
import marketStrategyRoutes from "./routes/marketStrategy";
import slackRoutes from "./routes/slack";
import metaRoutes from "./routes/meta";
import blogRoutes from "./routes/blog";
import agentModeRoutes from "./routes/agentMode";
import settingsRoutes from "./routes/settings";
import imageModelsRoutes from "./routes/image-models";
import webhookRoutes from "./routes/webhooks";
import benchmarkRoutes from "./routes/benchmark";
import seoRoutes from "./routes/seo";
import gtmPlanRoutes from "./routes/gtmPlan";
import crmRoutes from "./routes/crm";
import subscriptionRoutes from "./routes/subscription";
import booksRoutes from "./routes/books";
import linkedinAuthRoutes from "./routes/linkedinAuth";
import connectedAccountsRoutes from "./routes/connectedAccounts";
import mcpServersRoutes from "./routes/mcpServers";
import { authenticateToken } from "./middleware/auth";
import { isAdmin } from "./middleware/admin";

const { version } = require('../package.json');


import { setupMcpServer } from "./mcp/server/mcpServer";
import {
  viewExternalFile,
  getFileContent,
  saveHtmlContent,
} from "./controllers/filesController";

const app = express();

// Initialize MCP Server routes BEFORE glocal body parsers
setupMcpServer(app);

// CORS configuration
const corsOptions = {
  origin: function (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void
  ) {
    const allowedOrigins = [
      /^https:\/\/[a-zA-Z0-9\-]+\.agentweb\.pro$/, // Allow any subdomain of agentweb.pro
      "https://agentweb.pro", // Main Production Partner URL
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
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};

// CORS middleware with exception for public subscriber join endpoint
app.use((req, res, next) => {
  // Check if this is the public subscriber join endpoint
  if (req.path.match(/^\/api\/tasks\/[^\/]+\/subscribers\/join$/)) {
    // Allow all origins for this endpoint only
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(passport.initialize());

// Create a new router for file-related routes
const fileRoutes = express.Router();
fileRoutes.get("/view-external", viewExternalFile);
fileRoutes.get("/content", getFileContent);
fileRoutes.post("/html", authenticateToken, saveHtmlContent);

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
app.use("/api/stripe", stripeRoutes);
app.use("/api/brand", brandRoutes);
app.use("/api/market-strategy", marketStrategyRoutes);
app.use("/api/slack", slackRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/blog", blogRoutes);
app.use("/api/agent-mode", agentModeRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/image-models", imageModelsRoutes);
app.use("/api/webhooks", webhookRoutes);
app.use("/api/benchmark", benchmarkRoutes);
app.use("/api/seo", seoRoutes);
app.use("/api/gtm-plan", gtmPlanRoutes);
app.use("/api/crm", crmRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/books", booksRoutes);
app.use("/api/oauth/linkedin", linkedinAuthRoutes);
app.use("/api/oauth", connectedAccountsRoutes);
app.use("/api/admin/mcp-servers", authenticateToken, isAdmin, mcpServersRoutes);


// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy", version });
});

export default app;
