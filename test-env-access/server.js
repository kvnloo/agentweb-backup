import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Resend } from "resend";
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
} from "@aws-sdk/client-ec2";

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
const SG_PORTS = [22, 3001, 5173, 5174]; // ports to open per verified IP
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

app.listen(PORT, () => {
  console.log(`IP allowlist service running on http://localhost:${PORT}`);
});
