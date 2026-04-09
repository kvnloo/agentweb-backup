import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn, execSync } from "child_process";
import { Resend } from "resend";
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5175;

// Load .env manually (avoid dotenv dependency)
try {
  const envPath = path.join(__dirname, ".env");
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
} catch {
  // .env file not found, rely on environment variables
}

const resend = new Resend(process.env.RESEND_API_KEY);

const SG_ID = process.env.SG_ID || "";
const AWS_REGION = process.env.AWS_REGION || "us-west-2";
const SG_PORTS = [22, 3001, 5173, 5174, 5175]; // ports to open per verified IP
const ec2 = SG_ID ? new EC2Client({ region: AWS_REGION }) : null;

// Use /app/data volume in Docker, fallback to local file for dev
const DATA_DIR = fs.existsSync("/app/data") ? "/app/data" : __dirname;
const ALLOWLIST_PATH = path.join(DATA_DIR, "allowlist.json");
const ALLOWED_DOMAINS = ["agentweb.pro", "argusoft.com"];
const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
const MAX_VERIFY_ATTEMPTS = 5;
const MAX_CODE_REQUESTS_PER_HOUR = 3;
const SERVICES = ["customer-portal", "partner-portal", "backend"];

// In-memory stores
const pendingCodes = new Map(); // ip -> { code, email, expiresAt, attempts }
const rateLimits = new Map(); // ip -> [timestamp, ...]

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Helpers ---

function readAllowlist() {
  try {
    return JSON.parse(fs.readFileSync(ALLOWLIST_PATH, "utf-8"));
  } catch {
    return { ips: [] };
  }
}

function writeAllowlist(data) {
  fs.writeFileSync(ALLOWLIST_PATH, JSON.stringify(data, null, 2) + "\n");
}

function getClientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  let addr = req.socket.remoteAddress || "";
  // Normalize IPv6-mapped IPv4
  if (addr.startsWith("::ffff:")) addr = addr.slice(7);
  return addr;
}

function toSubnet24(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return ip; // not IPv4, return as-is
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

function isIpAllowed(ip) {
  const subnet = toSubnet24(ip);
  const allowlist = readAllowlist();
  return allowlist.ips.some((entry) => entry.ip === ip || entry.subnet === subnet);
}

function checkRateLimit(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  let timestamps = rateLimits.get(ip) || [];
  timestamps = timestamps.filter((t) => t > hourAgo);
  rateLimits.set(ip, timestamps);
  return timestamps.length < MAX_CODE_REQUESTS_PER_HOUR;
}

function recordCodeRequest(ip) {
  const timestamps = rateLimits.get(ip) || [];
  timestamps.push(Date.now());
  rateLimits.set(ip, timestamps);
}

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function addSecurityGroupRules(cidr) {
  if (!ec2) {
    console.warn("SG_ID not set — skipping security group update");
    return;
  }
  for (const port of SG_PORTS) {
    try {
      await ec2.send(
        new AuthorizeSecurityGroupIngressCommand({
          GroupId: SG_ID,
          IpPermissions: [
            {
              IpProtocol: "tcp",
              FromPort: port,
              ToPort: port,
              IpRanges: [{ CidrIp: cidr, Description: "test-env-access self-service" }],
            },
          ],
        })
      );
    } catch (err) {
      // Ignore duplicate rule errors (check both SDK v3 .name and .Code)
      const code = err.Code || err.name || "";
      if (!code.includes("InvalidPermission.Duplicate")) {
        console.error(`Failed to add SG rule for ${cidr}:${port}:`, err.message || err);
      }
    }
  }
  console.log(`Security group rules added for ${cidr} on ports ${SG_PORTS.join(", ")}`);
}

// --- Routes ---

app.get("/api/status", (req, res) => {
  const ip = getClientIp(req);
  const subnet = toSubnet24(ip);
  const allowed = isIpAllowed(ip);
  const services = {};
  for (const svc of SERVICES) {
    services[svc] = allowed;
  }
  res.json({ ip, subnet, allowed, services });
});

app.post("/api/request-code", async (req, res) => {
  const ip = getClientIp(req);
  const { email } = req.body;

  if (!email || typeof email !== "string") {
    return res.status(400).json({ error: "Email is required." });
  }

  const domain = email.split("@")[1]?.toLowerCase();
  if (!ALLOWED_DOMAINS.includes(domain)) {
    return res.status(400).json({
      error: `Email must be @${ALLOWED_DOMAINS.join(" or @")}.`,
    });
  }

  if (isIpAllowed(ip)) {
    return res.status(400).json({ error: "This IP is already allowed." });
  }

  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: "Too many requests. Max 3 code requests per hour.",
    });
  }

  const code = generateCode();
  pendingCodes.set(ip, {
    code,
    email: email.toLowerCase(),
    expiresAt: Date.now() + CODE_EXPIRY_MS,
    attempts: 0,
  });
  recordCodeRequest(ip);

  try {
    await resend.emails.send({
      from: "no-reply@updates.agentweb.pro",
      to: email.toLowerCase(),
      subject: "Your test environment access code",
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="color: #1a1a2e;">Test Environment Access</h2>
          <p>Your verification code is:</p>
          <div style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #1a1a2e; background: #f0f0f5; padding: 16px 24px; border-radius: 8px; text-align: center; margin: 16px 0;">
            ${code}
          </div>
          <p style="color: #666; font-size: 14px;">This code expires in 10 minutes.<br>IP being authorized: <code>${ip}</code></p>
        </div>
      `,
    });
    res.json({ ok: true, message: "Verification code sent to your email." });
  } catch (err) {
    console.error("Failed to send email:", err);
    pendingCodes.delete(ip);
    res.status(500).json({ error: "Failed to send email. Check server logs." });
  }
});

app.post("/api/verify", async (req, res) => {
  const ip = getClientIp(req);
  const { code } = req.body;

  if (!code || typeof code !== "string") {
    return res.status(400).json({ error: "Code is required." });
  }

  const pending = pendingCodes.get(ip);
  if (!pending) {
    return res
      .status(400)
      .json({ error: "No pending verification for this IP. Request a new code." });
  }

  if (Date.now() > pending.expiresAt) {
    pendingCodes.delete(ip);
    return res
      .status(400)
      .json({ error: "Code has expired. Request a new one." });
  }

  pending.attempts++;
  if (pending.attempts > MAX_VERIFY_ATTEMPTS) {
    pendingCodes.delete(ip);
    return res.status(400).json({
      error: "Too many attempts. Request a new code.",
    });
  }

  if (code.trim() !== pending.code) {
    const remaining = MAX_VERIFY_ATTEMPTS - pending.attempts;
    return res.status(400).json({
      error: `Invalid code. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
    });
  }

  // Code is valid — add IP subnet to allowlist and security group
  const subnet = toSubnet24(ip);
  const allowlist = readAllowlist();
  if (!allowlist.ips.some((entry) => entry.subnet === subnet)) {
    allowlist.ips.push({
      ip,
      subnet,
      email: pending.email,
      addedAt: new Date().toISOString(),
    });
    writeAllowlist(allowlist);
  }
  pendingCodes.delete(ip);

  // Add security group ingress rules for the /24 subnet
  await addSecurityGroupRules(subnet);

  res.json({ ok: true, message: "IP added to allowlist." });
});

app.get("/api/allowlist", (_req, res) => {
  const allowlist = readAllowlist();
  res.json(allowlist);
});

// ---------------------------------------------------------------------------
// Claude Code prompt relay
// ---------------------------------------------------------------------------

const smClient = new SecretsManagerClient({ region: AWS_REGION });
const secretCache = new Map();

async function getCachedSecret(name) {
  if (secretCache.has(name)) return secretCache.get(name);
  const res = await smClient.send(
    new GetSecretValueCommand({ SecretId: name })
  );
  const value = res.SecretString || "";
  secretCache.set(name, value);
  return value;
}

async function getNotionToken() {
  return getCachedSecret("agentweb/test-env/notion-token");
}

async function getRelaySecret() {
  return getNotionToken(); // reuse Notion token as shared secret
}

const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

async function postNotionComment(pageId, text) {
  const token = await getNotionToken();
  // Notion rich_text has a 2000-char limit per element — split if needed
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ text: { content: text.slice(i, i + 2000) } });
  }
  const res = await fetch(`${NOTION_API}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: chunks,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[relay] Failed to post Notion comment: ${res.status} ${body}`);
  }
}

async function updateNotionStatus(pageId, status) {
  const token = await getNotionToken();
  const res = await fetch(`${NOTION_API}/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: { Status: { status: { name: status } } },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`[relay] Failed to update Notion status: ${res.status} ${body}`);
  }
}

// Serial prompt queue
const promptQueue = [];
let processing = false;
const recentlyPostedComments = new Set(); // track to prevent loops

// Heartbeat state
let currentActivity = "idle"; // "idle" | "processing: <prompt snippet>" | "waiting_retry: <seconds>s"
let lastPromptTime = null;
let lastResponseTime = null;

// ---------------------------------------------------------------------------
// Fetch attachments from Notion page (images, files, PDFs, videos)
// ---------------------------------------------------------------------------
const ATTACHMENTS_DIR = "/home/ec2-user/agentweb/.notion-attachments";

async function fetchNotionAttachments(notionPageId) {
  try {
    const notionToken = fs.readFileSync("/home/ec2-user/agentweb/.notion-token", "utf-8").trim();
    if (!notionToken) return [];

    // Fetch page properties for file-type properties
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${notionPageId}`, {
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
      },
    });
    const pageJson = await pageRes.json();

    // Fetch page blocks for inline images/files
    const blocksRes = await fetch(
      `https://api.notion.com/v1/blocks/${notionPageId}/children?page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );
    const blocksJson = await blocksRes.json();

    // Fetch page comments for comment-level attachments (screenshots pasted in comments)
    const commentsRes = await fetch(
      `https://api.notion.com/v1/comments?block_id=${notionPageId}&page_size=100`,
      {
        headers: {
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
        },
      }
    );
    const commentsJson = await commentsRes.json();

    const attachments = [];

    // Extract from page-level file properties
    if (pageJson.properties) {
      for (const [, prop] of Object.entries(pageJson.properties)) {
        if (prop.type === "files" && Array.isArray(prop.files)) {
          for (const f of prop.files) {
            const url = f.type === "file" ? f.file?.url : f.external?.url;
            if (url) attachments.push({ url, name: f.name || "attachment" });
          }
        }
      }
    }

    // Extract from block-level images, files, PDFs, videos
    for (const block of blocksJson.results || []) {
      if (!["image", "file", "pdf", "video"].includes(block.type)) continue;
      const content = block[block.type];
      if (!content) continue;
      const url = content.type === "file" ? content.file?.url : content.external?.url;
      if (!url) continue;
      let name;
      if (content.caption?.length > 0) {
        name = content.caption.map((c) => c.plain_text).join("");
      } else if (content.name) {
        name = content.name;
      } else {
        name = url.split("/").pop().split("?")[0];
      }
      attachments.push({ url, name: name || "attachment" });
    }

    // Extract from comment attachments (screenshots pasted in Notion comments)
    for (const comment of commentsJson.results || []) {
      if (!comment.attachments?.length) continue;
      const commentId = comment.id.split("-").pop(); // short suffix for uniqueness
      for (let i = 0; i < comment.attachments.length; i++) {
        const att = comment.attachments[i];
        const url = att.file?.url;
        if (!url) continue;
        const rawName = url.split("/").pop().split("?")[0] || "attachment";
        // Prefix with comment ID suffix to avoid name collisions across comments
        const name = `${commentId}-${rawName}`;
        attachments.push({ url, name });
      }
    }

    console.log(`[relay] Notion attachments found: ${attachments.length} (blocks: ${blocksJson.results?.length || 0}, comments with attachments: ${(commentsJson.results || []).filter(c => c.attachments?.length).length})`);
    return attachments;
  } catch (err) {
    console.error("[relay] Error fetching Notion attachments:", err);
    return [];
  }
}

async function downloadAttachments(attachments) {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
  const existing = new Set(fs.readdirSync(ATTACHMENTS_DIR));
  const downloaded = [];

  for (const { url, name } of attachments) {
    // Sanitize filename
    const safeName = name.replace(/\//g, "").replace(/[^\x20-\x7E]/g, "") || `attachment_${Date.now()}`;
    if (existing.has(safeName)) {
      // Already downloaded in a prior prompt — skip
      continue;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`[relay] Failed to download ${safeName}: ${res.status}`);
        continue;
      }
      const dest = path.join(ATTACHMENTS_DIR, safeName);
      const buffer = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(dest, buffer);
      downloaded.push(dest);
      console.log(`[relay] Downloaded attachment: ${safeName}`);
    } catch (err) {
      console.error(`[relay] Error downloading ${safeName}:`, err);
    }
  }

  return downloaded;
}

async function processQueue() {
  if (processing || promptQueue.length === 0) return;
  processing = true;

  while (promptQueue.length > 0) {
    const { prompt, notionPageId } = promptQueue.shift();
    console.log(`[relay] Processing prompt for page ${notionPageId}: "${prompt.slice(0, 100)}..."`);
    currentActivity = `processing: ${prompt.slice(0, 80)}`;
    lastPromptTime = new Date();

    try {
      await updateNotionStatus(notionPageId, "In progress");

      // Fetch and download any attachments from the Notion page
      const attachments = await fetchNotionAttachments(notionPageId);
      const downloadedPaths = await downloadAttachments(attachments);

      let enrichedPrompt = prompt;
      if (downloadedPaths.length > 0) {
        enrichedPrompt += `\n\nIMPORTANT: The following screenshot/image attachments from the Notion page have been downloaded. You MUST use the Read tool to view each image file BEFORE starting any work — these contain critical visual context for the task:\n${downloadedPaths.map((p) => `- ${p}`).join("\n")}`;
      }

      // Prepend conversation history so Claude has context even after a session reset
      const conversationLog = readConversationLog();
      if (conversationLog.trim()) {
        enrichedPrompt = `=== Previous conversation context (for continuity) ===\n${conversationLog.trim()}\n\n=== Current request ===\n${enrichedPrompt}`;
      }

      const output = await runClaude(enrichedPrompt);
      lastResponseTime = new Date();

      // Check for retry directive: [RELAY_RETRY_AFTER:<seconds>]
      const retryMatch = output.match(/\[RELAY_RETRY_AFTER:(\d+)\]/);
      const cleanedOutput = output.replace(/\[RELAY_RETRY_AFTER:\d+\]/g, "").trim();

      // Persist this turn so future sessions have context
      appendToConversationLog(prompt, cleanedOutput);

      // Truncate to ~10000 chars for Notion (5 rich_text chunks of 2000)
      const truncated = cleanedOutput.length > 10000
        ? cleanedOutput.slice(0, 9950) + "\n\n...(truncated)"
        : cleanedOutput;

      if (truncated && truncated !== "(no output)") {
        await postNotionComment(notionPageId, truncated);
        recentlyPostedComments.add(truncated.slice(0, 200));
      } else if (!retryMatch) {
        // No output and no retry — let the user know Claude ran but produced nothing
        await postNotionComment(notionPageId, "(Claude produced no output for this prompt. You may need to re-prompt or check the instance.)");
      }

      // If Claude requested a retry, re-queue after the specified delay
      if (retryMatch) {
        const delaySec = Math.min(parseInt(retryMatch[1], 10), 600); // cap at 10 minutes
        console.log(`[relay] Claude requested retry in ${delaySec}s for page ${notionPageId}`);
        currentActivity = `waiting_retry: ${delaySec}s`;
        setTimeout(() => {
          promptQueue.push({ prompt: "Continue where you left off. Check the status of what you were waiting for.", notionPageId });
          processQueue().catch((err) =>
            console.error("[relay] Queue processor error after retry:", err)
          );
        }, delaySec * 1000);
      }

      // Update status when Claude is done (not waiting for retry)
      if (!retryMatch) {
        if (prompt === "Prep for deploy") {
          // Deploy prompt triggers teardown via Done status
          const isProduction = (process.env.NODE_ENV || "") === "production";
          await updateNotionStatus(notionPageId, isProduction ? "Done" : "Done_Test");
        } else {
          await updateNotionStatus(notionPageId, "In Review");
        }
      }
    } catch (err) {
      console.error(`[relay] Error processing prompt:`, err);
      const errMsg = err.message || String(err);
      try {
        await postNotionComment(
          notionPageId,
          `Claude Code error: ${errMsg}`
        );
      } catch (commentErr) {
        console.error(`[relay] Failed to post error comment:`, commentErr);
      }

      // If Claude crashed (non-zero exit, but NOT 143=SIGTERM/timeout), re-queue the
      // prompt so the user's message isn't lost.  Post the error comment above
      // so the user knows what happened, then retry after a short delay.
      // Exit 143 = SIGTERM (timeout or OOM kill) — don't retry, it will just loop.
      if (/exited with code (?!0\b)(?!143\b)\d+/.test(errMsg)) {
        console.log(`[relay] Re-queuing prompt after crash for page ${notionPageId}`);
        await new Promise((r) => setTimeout(r, 5000)); // 5s cooldown
        promptQueue.push({ prompt, notionPageId });
      }
    }
  }

  processing = false;
  currentActivity = "idle";
}

function stripAnsiAndControlCodes(text) {
  return text
    // Strip ANSI escape sequences (CSI, OSC, etc.)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[()][0-9A-B]/g, "")
    .replace(/\x1b\[[\?]?[0-9;]*[hlmsu]/g, "")
    // Strip remaining escape chars and control codes (except newline/tab)
    .replace(/\x1b[^\n]*/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    // Strip script(1) artifacts like [<u or ]9;4;0;
    .replace(/\[\<u/g, "")
    .replace(/\][0-9;]+/g, "")
    .trim();
}

const COST_FILE = "/home/ec2-user/agentweb/.claude-total-cost";

// ---------------------------------------------------------------------------
// Conversation log — persists Q&A turns across sessions so Claude has context
// even after a session reset (--continue doesn't reliably restore history)
// ---------------------------------------------------------------------------
const CONVERSATION_LOG_FILE = "/home/ec2-user/agentweb/.claude-conversation-log";
const MAX_CONVERSATION_LOG_CHARS = 15000; // ~4k tokens, well within context window
const MAX_RESPONSE_IN_LOG_CHARS = 1500;   // keep responses concise in the log

function readConversationLog() {
  try {
    return fs.readFileSync(CONVERSATION_LOG_FILE, "utf-8");
  } catch {
    return "";
  }
}

function appendToConversationLog(prompt, response) {
  try {
    const existing = readConversationLog();
    const truncatedResponse = response.length > MAX_RESPONSE_IN_LOG_CHARS
      ? response.slice(0, MAX_RESPONSE_IN_LOG_CHARS) + "...(truncated)"
      : response;
    const entry = `\n[User]: ${prompt.slice(0, 500)}\n[Claude]: ${truncatedResponse}\n`;
    let updated = existing + entry;
    // Trim oldest entries if log grows too large
    if (updated.length > MAX_CONVERSATION_LOG_CHARS) {
      updated = updated.slice(updated.length - MAX_CONVERSATION_LOG_CHARS);
      // Snap to the start of the first complete turn to avoid cutting mid-entry
      const firstTurn = updated.indexOf("\n[User]:");
      if (firstTurn > 0) updated = updated.slice(firstTurn);
    }
    fs.writeFileSync(CONVERSATION_LOG_FILE, updated);
  } catch (err) {
    console.error("[relay] Failed to write conversation log:", err);
  }
}

function formatUsageLine(data) {
  try {
    const cost = data.total_cost_usd || 0;
    const usage = data.usage || {};
    const durationMs = data.duration_ms || 0;
    const inputTok = usage.input_tokens || 0;
    const outputTok = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreate = usage.cache_creation_input_tokens || 0;

    // Read previous total and accumulate
    let prevTotal = 0;
    try {
      prevTotal = parseFloat(fs.readFileSync(COST_FILE, "utf-8").trim()) || 0;
    } catch {
      // file doesn't exist yet
    }
    const total = prevTotal + cost;
    try {
      fs.writeFileSync(COST_FILE, total.toFixed(6));
    } catch {
      // ignore write errors
    }

    const parts = [`Cost: $${cost.toFixed(4)} (Total: $${total.toFixed(4)})`];
    const cacheParts = [];
    if (cacheRead) cacheParts.push(`${cacheRead.toLocaleString()} cache-read`);
    if (cacheCreate) cacheParts.push(`${cacheCreate.toLocaleString()} cache-write`);
    let tokDetail = `${inputTok.toLocaleString()} in + ${outputTok.toLocaleString()} out`;
    if (cacheParts.length) tokDetail += ` (${cacheParts.join(", ")})`;
    parts.push(`Tokens: ${tokDetail}`);
    if (durationMs) parts.push(`Duration: ${Math.round(durationMs / 1000)}s`);
    const models = Object.keys(data.modelUsage || {});
    if (models.length) parts.push(`Model: ${models.join(", ")}`);
    return parts.join(" | ");
  } catch {
    return "";
  }
}

const SESSION_ID_FILE = "/home/ec2-user/agentweb/.claude-session-id";

function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    // Escape single quotes in prompt for shell
    const escaped = prompt.replace(/'/g, "'\\''");
    // Use --resume <id> to continue the exact same session; fall back to --continue
    let resumeFlag = "--continue";
    try {
      const sessionId = fs.readFileSync(SESSION_ID_FILE, "utf-8").trim();
      if (sessionId) resumeFlag = `--resume ${sessionId}`;
    } catch {}
    const child = spawn(
      "bash",
      ["-lc", `cd /home/ec2-user/agentweb && claude ${resumeFlag} --model us.anthropic.claude-sonnet-4-6 --permission-mode bypassPermissions --output-format json -p '${escaped}'`],
      {
        uid: 1000, // ec2-user UID
        gid: 1000,
        env: { ...process.env, HOME: "/home/ec2-user" },
        timeout: 60 * 60 * 1000, // 60 minutes
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("close", (code) => {
      // Try to parse JSON output for result text + usage
      try {
        const data = JSON.parse(stdout);
        // Persist session ID so future relay calls resume the same session
        if (data.session_id) {
          try { fs.writeFileSync(SESSION_ID_FILE, data.session_id, "utf-8"); } catch {}
        }
        let text = data.result || "(no output)";
        const usageLine = formatUsageLine(data);
        if (usageLine) text += `\n\n---\n${usageLine}`;
        resolve(text);
      } catch {
        // Fallback: strip ANSI codes from raw output
        const cleaned = stripAnsiAndControlCodes(stdout);
        if (code === 0) {
          resolve(cleaned || "(no output)");
        } else {
          reject(new Error(`Claude exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

app.post("/api/claude-prompt", async (req, res) => {
  try {
    // Verify relay secret
    const expectedSecret = await getRelaySecret();
    const providedSecret = req.headers["x-relay-secret"];

    if (!expectedSecret || providedSecret !== expectedSecret) {
      return res.status(403).json({ error: "Invalid relay secret" });
    }

    const { prompt, notionPageId } = req.body;

    if (!prompt || !notionPageId) {
      return res.status(400).json({ error: "Missing prompt or notionPageId" });
    }

    // Add to queue and process
    const position = promptQueue.length + 1;
    promptQueue.push({ prompt, notionPageId });
    console.log(`[relay] Queued prompt for page ${notionPageId} (position ${position})`);

    // Kick the queue processor (async, don't await)
    processQueue().catch((err) =>
      console.error("[relay] Queue processor error:", err)
    );

    res.json({ ok: true, position });
  } catch (err) {
    console.error("[relay] /api/claude-prompt error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Heartbeat — update "Cloud Dev Status" Notion property every minute
// ---------------------------------------------------------------------------

const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || "";
const HEARTBEAT_INTERVAL_MS = 60 * 1000;

async function updateNotionCloudEnvStatus(text) {
  if (!NOTION_PAGE_ID) return;
  try {
    const token = await getNotionToken();
    const res = await fetch(`${NOTION_API}/pages/${NOTION_PAGE_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          "Cloud Dev Status": {
            rich_text: [{ text: { content: text.slice(0, 2000) } }],
          },
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[heartbeat] Failed to update Notion property: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error(`[heartbeat] Error:`, err.message || err);
  }
}

function getHeartbeatStatus() {
  const parts = [];
  const now = new Date();

  // 1. Claude activity
  parts.push(`Claude: ${currentActivity}`);

  // 2. Queue depth
  if (promptQueue.length > 0) {
    parts.push(`Queue: ${promptQueue.length} pending`);
  }

  // 3. Time since last prompt/response
  if (lastPromptTime) {
    const agoMin = Math.round((now - lastPromptTime) / 60000);
    parts.push(`Last prompt: ${agoMin}m ago`);
  }
  if (lastResponseTime) {
    const agoMin = Math.round((now - lastResponseTime) / 60000);
    parts.push(`Last response: ${agoMin}m ago`);
  }

  // 4. Services status (quick check via tmux)
  try {
    const tmuxOut = execSync("tmux ls 2>/dev/null || true", { encoding: "utf-8", timeout: 5000 });
    const services = ["backend", "partner-portal", "customer-portal"];
    const down = services.filter((s) => !tmuxOut.includes(s));
    if (down.length > 0) {
      parts.push(`DOWN: ${down.join(", ")}`);
    } else {
      parts.push("Services: all up");
    }
  } catch {
    parts.push("Services: unknown");
  }

  // 5. Claude process check
  try {
    const psOut = execSync("pgrep -f 'claude.*-p' 2>/dev/null || true", { encoding: "utf-8", timeout: 5000 });
    if (psOut.trim()) {
      parts.push("Claude process: running");
    }
  } catch {
    // ignore
  }

  // 6. Conversation file size
  try {
    const convDir = "/home/ec2-user/.claude/projects/-home-ec2-user-agentweb";
    const files = execSync(`ls -S ${convDir}/*.jsonl 2>/dev/null | head -1`, { encoding: "utf-8", timeout: 5000 }).trim();
    if (files) {
      const stat = fs.statSync(files);
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      parts.push(`Conversation: ${sizeMB}MB`);
      if (stat.size > 10 * 1024 * 1024) {
        parts.push("⚠️ conversation file large");
      }
    }
  } catch {
    // ignore
  }

  // 7. EC2 cost (Option A: hardcoded price table)
  const EC2_PRICES = {
    "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416,
    "t3.large": 0.0832, "t3.xlarge": 0.1664, "t3.2xlarge": 0.3328,
  };
  try {
    const meta = {};
    fs.readFileSync("/home/ec2-user/agentweb/.ec2-session-meta", "utf-8")
      .split("\n")
      .forEach((line) => {
        const eq = line.indexOf("=");
        if (eq > 0) meta[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      });
    const itype = meta.instance_type || "";
    const launchEpoch = parseInt(meta.launch_epoch || "0", 10);
    if (itype && launchEpoch) {
      const elapsedH = (Date.now() / 1000 - launchEpoch) / 3600;
      const ec2Cost = elapsedH * (EC2_PRICES[itype] || 0);
      const h = Math.floor(elapsedH);
      const m = Math.floor((elapsedH - h) * 60);
      parts.push(`EC2: $${ec2Cost.toFixed(4)} (${h}h ${m}m @ ${itype})`);
    }
  } catch {
    // ignore if meta file not present
  }

  // 8. Timestamp
  parts.push(`Updated: ${now.toISOString().slice(11, 19)}Z`);

  return parts.join(" | ");
}

if (NOTION_PAGE_ID) {
  setInterval(async () => {
    const status = getHeartbeatStatus();
    await updateNotionCloudEnvStatus(status);
  }, HEARTBEAT_INTERVAL_MS);

  // Post initial status on startup
  setTimeout(async () => {
    await updateNotionCloudEnvStatus(getHeartbeatStatus());
    console.log("[heartbeat] Initial status posted to Notion");
  }, 5000);
}

// Fetch this instance's current public IP from EC2 metadata
async function getInstancePublicIp() {
  try {
    const tokenRes = await fetch("http://169.254.169.254/latest/api/token", {
      method: "PUT",
      headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
      signal: AbortSignal.timeout(3000),
    });
    const token = await tokenRes.text();
    const ipRes = await fetch("http://169.254.169.254/latest/meta-data/public-ipv4", {
      headers: { "X-aws-ec2-metadata-token": token },
      signal: AbortSignal.timeout(3000),
    });
    return (await ipRes.text()).trim();
  } catch {
    return null;
  }
}

// On startup, detect if the public IP changed since last launch and notify via Notion comment
async function checkForIpChange() {
  if (!NOTION_PAGE_ID) return;
  try {
    const currentIp = await getInstancePublicIp();
    if (!currentIp) return;

    const token = await getNotionToken();
    const pageRes = await fetch(`${NOTION_API}/pages/${NOTION_PAGE_ID}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION },
    });
    if (!pageRes.ok) return;
    const page = await pageRes.json();

    const storedIp = page.properties?.["Public IP"]?.rich_text?.[0]?.plain_text?.trim();

    const patchIp = () => fetch(`${NOTION_API}/pages/${NOTION_PAGE_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: { "Public IP": { rich_text: [{ text: { content: currentIp } }] } },
      }),
    });

    if (storedIp && storedIp !== currentIp) {
      console.log(`[ip-change] IP changed from ${storedIp} to ${currentIp} — posting Notion comment`);

      const plain = (text) => ({ text: { content: text } });
      const link = (url) => ({ text: { content: url, link: { url } } });

      const richText = [
        plain(`⚠️ Cloud env IP changed — the instance was stopped and restarted.\n\nOld IP: ${storedIp} (no longer valid)\nNew IP: ${currentIp}\n\nUpdated URLs:\n• Customer portal: `),
        link(`http://${currentIp}:5174`),
        plain(`\n• Partner portal:  `),
        link(`http://${currentIp}:5173`),
        plain(`\n• Backend API:     `),
        link(`http://${currentIp}:3001`),
        plain(`\n• IP unlock:       `),
        link(`http://${currentIp}:5175`),
      ];

      const postComment = () => fetch(`${NOTION_API}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parent: { page_id: NOTION_PAGE_ID }, rich_text: richText }),
      });

      await Promise.all([postComment(), patchIp()]);
    } else if (!storedIp) {
      await patchIp();
    }
  } catch (err) {
    console.error("[ip-change] Error:", err.message || err);
  }
}

// On startup, ensure all allowlisted IPs have SG rules (handles repo clone / new SG drift)
async function enforceAllowlist() {
  const allowlist = readAllowlist();
  const subnets = new Set();
  for (const entry of allowlist.ips) {
    const cidr = entry.subnet || toSubnet24(entry.ip);
    if (cidr.includes(".")) subnets.add(cidr); // skip non-IPv4 like ::1
  }
  if (subnets.size === 0) return;
  console.log(`[allowlist] Enforcing SG rules for ${subnets.size} subnet(s)...`);
  for (const cidr of subnets) {
    await addSecurityGroupRules(cidr);
  }
  console.log("[allowlist] SG reconciliation complete.");
}

app.listen(PORT, () => {
  console.log(`IP allowlist service running on http://localhost:${PORT}`);
  checkForIpChange().catch((err) =>
    console.error("[ip-change] Failed to check for IP change on startup:", err)
  );
  enforceAllowlist().catch((err) =>
    console.error("[allowlist] Failed to enforce allowlist on startup:", err)
  );
});
