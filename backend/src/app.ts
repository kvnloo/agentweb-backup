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

// Import the new controller
import {
  viewExternalFile,
  getFileContent,
} from "./controllers/filesController";

const app = express();

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

// Middleware
app.use(cors(corsOptions));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));
app.use(passport.initialize());

// Create a new router for file-related routes
const fileRoutes = express.Router();
fileRoutes.get("/view-external", viewExternalFile);
fileRoutes.get("/content", getFileContent);

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

// Health check endpoint
app.get("/", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

export default app;
