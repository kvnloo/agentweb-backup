import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import axios from "axios";
import fs from "fs";
import path from "path";
import { getV0ApiKey, getGitHubOrgToken, getVercelToken } from "../utils/secretsManager";
import { addSubdomain, generateSubdomain } from "./customDomainService";
import { settingsService } from "./settingsService";
import { paginatedQuery } from "../utils/dynamoPagination";

// Note: global fetch (undici) timeouts are managed by httpClient.ts (15 min headersTimeout/bodyTimeout).
// No setGlobalDispatcher call here — duplicate calls cause the last-loaded config to win unpredictably.

// Timeout constants for external API calls
const GITHUB_API_TIMEOUT_MS = 60_000;
const VERCEL_API_TIMEOUT_MS = 60_000;
const VERCEL_POLL_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Retry helper — exponential backoff for transient network failures
// ---------------------------------------------------------------------------
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2_000; // 2s, 4s, 8s

// Poll intervals for waiting on v0 generation to complete
let v0PollIntervalsMs = [0, 15_000, 30_000, 45_000, 60_000];

/** Override poll intervals (for testing) */
export function setV0PollIntervals(intervals: number[]) {
  v0PollIntervalsMs = intervals;
}

// Vercel deployment polling config
let vercelPollIntervalMs = 5_000;
let vercelPollMaxAttempts = 60;

/** Override Vercel polling config (for testing) */
export function setVercelPollConfig(intervalMs: number, maxAttempts: number) {
  vercelPollIntervalMs = intervalMs;
  vercelPollMaxAttempts = maxAttempts;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries = MAX_RETRIES,
  baseDelayMs = BASE_DELAY_MS
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const isRetryable =
        err.message?.includes("fetch failed") ||
        err.message?.includes("ECONNREFUSED") ||
        err.message?.includes("ENOTFOUND") ||
        err.message?.includes("network error") ||
        err.message?.includes("NetworkError") ||
        err.message?.includes("ETIMEDOUT") ||
        err.message?.includes("socket hang up") ||
        err.code === "ECONNRESET" ||
        err.code === "UND_ERR_HEADERS_TIMEOUT";

      if (!isRetryable || attempt === maxRetries) {
        console.error(`[V0 SERVICE] ${label} failed after ${attempt} attempt(s):`, err.message);
        throw err;
      }

      const jitter = Math.random() * 500;
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + jitter;
      console.warn(
        `[V0 SERVICE] ${label} attempt ${attempt}/${maxRetries} failed (${err.message}), retrying in ${delay}ms...`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: {
    // AWS SDK v2 defaults to 0 (no timeout), which can cause indefinite hangs on network issues.
    timeout: 30_000,
    connectTimeout: 5_000,
  },
});

const TABLE_PREFIX =
  process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

export interface GeneratedLandingPage {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  status: "generating" | "draft" | "deploying" | "deployed" | "failed";
  v0ProjectId?: string;
  v0ChatId?: string;
  vercelProjectId?: string;
  deployedUrl?: string;
  customDomainUrl?: string;
  githubRepoUrl?: string;
  previewImageUrl?: string;
  iterations: number;
  errorMessage?: string;
  leadListId?: string;
  templateHtml?: string;
  isRootPage?: boolean;
  slug?: string;
  archived?: boolean;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BrandContext {
  brandName?: string;
  primaryColor?: string;
  primaryColorEnd?: string;
  isGradient?: boolean;
  secondaryColor?: string;
  fontFamily?: string;
  tagline?: string;
  toneOfVoice?: string;
  logoUrl?: string;
  brandPersonality?: string;
  keyMessages?: string[];
  brandValues?: string[];
  targetAudience?: string;
  founders?: Array<{ name: string; jobTitle: string; styleTone: string }>;
  // Market strategy fields
  businessOverview?: string;
  icp?: Array<{ title: string; description: string; valueProposition: string; buyerPersonas: string[] }>;
  competitors?: Array<{ name: string; description: string }>;
}

/**
 * Extract a condensed outline from the full HTML template (~55KB → ~3KB).
 * Sends section structure, CSS variables, and key patterns to v0 as inspiration
 * without overwhelming its prompt limits.
 */
export function extractTemplateOutline(fullHtml: string): string {
  const sections: string[] = [];

  // Extract CSS variables block (design tokens)
  const cssVarMatch = fullHtml.match(/:root\s*\{([^}]+)\}/);
  if (cssVarMatch) {
    sections.push('/* CSS Design Tokens */\n:root {' + cssVarMatch[1] + '}');
  }

  // Extract section hierarchy from comments
  const hierarchyMatch = fullHtml.match(/SECTION HIERARCHY:[\s\S]*?={3,}/);
  if (hierarchyMatch) {
    sections.push('/* ' + hierarchyMatch[0]);
  }

  // Extract body section structure (class names and IDs give v0 the layout)
  const sectionHeaders = fullHtml.match(/<section[^>]*(?:id|class)="[^"]*"[^>]*>/g) || [];
  if (sectionHeaders.length > 0) {
    sections.push('<!-- Section structure -->\n' + sectionHeaders.join('\n'));
  }

  // Extract key template variables used (gives v0 an idea of what content to generate)
  const variables = new Set<string>();
  const varRegex = /\{\{([^}]+)\}\}/g;
  let match;
  while ((match = varRegex.exec(fullHtml)) !== null) {
    variables.add(match[1].trim());
  }
  if (variables.size > 0) {
    sections.push('<!-- Template variables (content structure) -->\n' +
      Array.from(variables).map(v => `{{${v}}}`).join(', '));
  }

  return sections.join('\n\n');
}

/**
 * Build an enriched prompt that includes brand guidelines context
 */
export function buildBrandEnrichedPrompt(
  userPrompt: string,
  brand: BrandContext,
  leadListId?: string,
  templateHtml?: string
): string {
  const parts: string[] = [];

  parts.push(userPrompt);

  const brandParts: string[] = [];
  if (brand.brandName) brandParts.push(`Brand: ${brand.brandName}`);
  if (brand.primaryColor && brand.isGradient && brand.primaryColorEnd) {
    brandParts.push(`Primary color: gradient from ${brand.primaryColor} to ${brand.primaryColorEnd}`);
  } else if (brand.primaryColor) {
    brandParts.push(`Primary color: ${brand.primaryColor}`);
  }
  if (brand.secondaryColor) brandParts.push(`Secondary color: ${brand.secondaryColor}`);
  if (brand.fontFamily) brandParts.push(`Font: ${brand.fontFamily}`);
  if (brand.tagline) brandParts.push(`Tagline: "${brand.tagline}"`);
  if (brand.toneOfVoice) brandParts.push(`Tone of voice: ${brand.toneOfVoice}`);
  if (brand.logoUrl) brandParts.push(`Logo URL: ${brand.logoUrl}`);
  if (brand.brandPersonality) brandParts.push(`Brand personality: ${brand.brandPersonality}`);
  if (brand.keyMessages && brand.keyMessages.length > 0)
    brandParts.push(`Key messages: ${brand.keyMessages.join(", ")}`);
  if (brand.brandValues && brand.brandValues.length > 0)
    brandParts.push(`Brand values: ${brand.brandValues.join(", ")}`);
  if (brand.targetAudience) brandParts.push(`Target audience: ${brand.targetAudience}`);
  if (brand.founders && brand.founders.length > 0) {
    const founderLines = brand.founders.map(f => `  - ${f.name}, ${f.jobTitle}`).join("\n");
    brandParts.push(`Founders:\n${founderLines}`);
  }

  if (brandParts.length > 0) {
    parts.push("\n\nBrand Guidelines:\n" + brandParts.join("\n"));
  }

  // Market strategy — gives v0 real business context for landing page copy
  const marketParts: string[] = [];
  if (brand.businessOverview) marketParts.push(`Business overview: ${brand.businessOverview}`);
  if (brand.icp && brand.icp.length > 0) {
    const icpLines = brand.icp.map(p =>
      `  - ${p.title}: ${p.description}${p.valueProposition ? ` | Value prop: ${p.valueProposition}` : ""}`
    ).join("\n");
    marketParts.push(`Ideal Customer Profiles:\n${icpLines}`);
  }
  if (brand.competitors && brand.competitors.length > 0) {
    const compLines = brand.competitors.map(c => `  - ${c.name}: ${c.description}`).join("\n");
    marketParts.push(`Competitors (differentiate from these):\n${compLines}`);
  }

  if (marketParts.length > 0) {
    parts.push("\n\nMarket Context:\n" + marketParts.join("\n"));
  }

  if (leadListId) {
    const apiBase = process.env.BACKEND_URL || 'https://api.agentweb.pro';
    parts.push(
      `\n\nLEAD CAPTURE FORM — IMPORTANT ARCHITECTURE:\n` +
      `1. Create a Next.js API route at app/api/capture/route.ts that proxies form submissions to the backend.\n` +
      `   The proxy route should POST to: ${apiBase}/api/webhooks/forward-lead\n` +
      `   The proxy route must add listId: '${leadListId}' and source: 'landing-page' to the body before forwarding.\n` +
      `2. The frontend form component MUST fetch('/api/capture', ...) using the RELATIVE path — never hardcode any backend URL in client-side code.\n` +
      `   The form should collect: email (required), firstName, lastName, company, phone.\n` +
      `   Show a success message after submission. Show an error message on failure.\n` +
      `3. NEVER put absolute backend URLs (like ${apiBase}) in any client-side .tsx file. Only the server-side API route should know the backend URL.`
    );
  }

  if (templateHtml) {
    parts.push(
      '\n\nDESIGN INSPIRATION:\nThe following HTML template is provided as design inspiration. Use it as a reference for layout structure, section ordering, and content patterns — but feel free to improve the visual design, use modern components, and adapt it to look polished and professional. Do NOT copy the HTML verbatim; instead, build a superior React/Next.js version inspired by its structure.\n\n```html\n' +
      templateHtml +
      '\n```'
    );
  }

  parts.push(
    '\n\nIMPORTANT: Create a complete, production-ready landing page. Use modern design patterns, responsive layout, and the brand colors/fonts specified above.' +
    '\n\nCRITICAL Next.js Rules:' +
    '\n- Any component that uses onClick, onChange, onSubmit, useState, useEffect, or any other event handler or React hook MUST have "use client" at the very top of the file.' +
    '\n- Do NOT use <style jsx> anywhere. Use Tailwind CSS classes or CSS modules instead. styled-jsx causes Turbopack build failures in Next.js 15+.' +
    '\n- For CSS animations (like marquee), define @keyframes in globals.css and reference via Tailwind arbitrary values or className, never via <style jsx>.' +
    '\n- Never pass event handler props (onClick, onChange, etc.) from a Server Component to a Client Component — instead, make the parent a Client Component too, or wrap the interactive part in its own "use client" component.' +
    '\n- The main page.tsx can be a Server Component, but any interactive sections (forms, buttons with handlers, navigation with click handlers) must be extracted into separate Client Components with "use client".' +
    '\n\nCRITICAL Build Rules:' +
    '\n- Do NOT use @import "shadcn" in CSS files. Use standard Tailwind CSS imports instead: @tailwind base; @tailwind components; @tailwind utilities;' +
    '\n- Ensure all imports resolve to actual files in the project. Do not reference modules or paths that do not exist.' +
    '\n- The project must pass `npm run build` cleanly with zero errors.'
  );

  return parts.join("");
}

/**
 * Load the landing-page-v2 template outline as a fallback design inspiration for v0.
 * Checks email_templates_public → templates_public → filesystem, in that order.
 */
async function loadDefaultTemplateOutline(): Promise<string | undefined> {
  const parseArr = (s: any): any[] => {
    if (!s?.settingValue) return [];
    try { return JSON.parse(s.settingValue); } catch { return []; }
  };

  try {
    const oldPublicSetting = await settingsService.getSetting("email_templates_public");
    const oldMatch = parseArr(oldPublicSetting).find((t: any) => t.template_name === "landing-page-v2");
    if (oldMatch?.html_content) {
      const outline = extractTemplateOutline(oldMatch.html_content);
      console.log(`[V0 SERVICE] Loaded landing-page-v2 outline from email_templates_public (${outline.length} chars)`);
      return outline;
    }
  } catch (err) {
    console.warn("[V0 SERVICE] Could not load from email_templates_public:", err);
  }

  try {
    const newPublicSetting = await settingsService.getSetting("templates_public");
    const newMatch = parseArr(newPublicSetting).find((t: any) => t.template_name === "landing-page-v2");
    if (newMatch?.html_content) {
      const outline = extractTemplateOutline(newMatch.html_content);
      console.log(`[V0 SERVICE] Loaded landing-page-v2 outline from templates_public (${outline.length} chars)`);
      return outline;
    }
  } catch (err) {
    console.warn("[V0 SERVICE] Could not load from templates_public:", err);
  }

  try {
    const fallbackPath = path.join(__dirname, "..", "templates", "landing-page-v2.html");
    if (fs.existsSync(fallbackPath)) {
      const outline = extractTemplateOutline(fs.readFileSync(fallbackPath, "utf-8"));
      console.log(`[V0 SERVICE] Loaded landing-page-v2 outline from filesystem (${outline.length} chars)`);
      return outline;
    }
  } catch (fsErr) {
    console.warn("[V0 SERVICE] Filesystem template fallback failed:", fsErr);
  }

  return undefined;
}

/**
 * Create a v0 client using the stored API key.
 * Uses dynamic import since v0-sdk is an ESM package.
 */
async function getV0Client() {
  const apiKey = await getV0ApiKey();
  const { createClient } = await import("v0-sdk");
  return createClient({ apiKey });
}

/**
 * Generate a landing page.
 *
 * Strategy:
 * - If user has NO deployed landing page with a GitHub repo → call v0 (the only v0 call),
 *   create a GitHub repo, deploy to Vercel. This is the "first page" path.
 * - If user ALREADY has a deployed landing page → add a new page route to the EXISTING
 *   GitHub repo via the GitHub Contents API. No v0 call, no new repo. Vercel auto-redeploys.
 */
export async function generateLandingPage(
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string
): Promise<GeneratedLandingPage> {
  // Check if user already has a site (GitHub repo) — includes archived records.
  // This is the core guard: v0 is only called if NO site exists at all.
  const siteRecord = await findUserSiteRecord(userId);

  if (siteRecord) {
    // ── Add new page route to existing repo (no v0 call) ──
    return addPageToExistingRepo(siteRecord, userId, prompt, name, brandContext, leadListId, templateHtml);
  }

  // Dedup: if this user already has a page in-progress with a v0ChatId, reuse it.
  const existingPages = await listLandingPages(userId);
  const reusable = existingPages.find(
    (p) => p.v0ChatId && ["generating", "draft", "deploying"].includes(p.status)
  );
  if (reusable) {
    console.log(`[V0 SERVICE] Reusing existing page ${reusable.id} (status: ${reusable.status}, v0ChatId: ${reusable.v0ChatId}) — skipping new v0 chat`);
    return reusable;
  }

  // ── First page: call v0 → create repo → deploy ──
  return generateFirstPage(userId, prompt, name, brandContext, leadListId, templateHtml);
}

/**
 * First-ever landing page for this user. Calls v0 once, creates GitHub repo, deploys to Vercel.
 */
async function generateFirstPage(
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string
): Promise<GeneratedLandingPage> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Auto-load the HTML template structure as design inspiration for v0.
  // We send a condensed outline (not the full 55KB HTML) to avoid exceeding v0 prompt limits.
  const effectiveTemplate = templateHtml ?? await loadDefaultTemplateOutline();

  const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext, leadListId, effectiveTemplate);

  const record: GeneratedLandingPage = {
    id,
    userId,
    name,
    prompt,
    status: "generating",
    iterations: 0,
    isRootPage: true,
    createdAt: now,
    updatedAt: now,
  };

  if (leadListId) record.leadListId = leadListId;
  if (templateHtml) record.templateHtml = templateHtml;

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  try {
    const v0 = await getV0Client();

    const chatResponse = await withRetry(
      () => v0.chats.create({ message: enrichedPrompt }),
      "v0 chat creation"
    );

    if (!("id" in chatResponse) || !chatResponse.id) {
      throw new Error("v0 chat creation did not return a ChatDetail with an id");
    }
    const chatId = chatResponse.id;

    let updateExpression =
      "SET #status = :status, v0ChatId = :chatId, updatedAt = :updatedAt";
    const expressionAttributeValues: Record<string, any> = {
      ":status": "draft",
      ":chatId": chatId,
      ":updatedAt": new Date().toISOString(),
    };

    if (leadListId) {
      updateExpression += ", leadListId = :leadListId";
      expressionAttributeValues[":leadListId"] = leadListId;
    }

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: expressionAttributeValues,
      })
      .promise();

    console.log(`[V0 SERVICE] v0 chat created (${chatId}), auto-deploying...`);
    const deployed = await deployLandingPage(id, userId);
    return deployed;
  } catch (error: any) {
    console.error("[V0 SERVICE] Generation failed:", error);

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": error.message || "Unknown error during generation",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return {
      ...record,
      status: "failed",
      errorMessage: error.message || "Unknown error during generation",
    };
  }
}

/**
 * Add a new page route to an existing deployed landing page's GitHub repo.
 * Calls v0 to generate a full-quality page, extracts files, and commits them
 * under app/<slug>/ in the existing repo. Vercel auto-redeploys.
 */
async function addPageToExistingRepo(
  existingPage: GeneratedLandingPage,
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string
): Promise<GeneratedLandingPage> {
  const id = uuidv4();
  const now = new Date().toISOString();

  // Create a slug for the new page route
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);

  const repoMatch = existingPage.githubRepoUrl!.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!repoMatch) throw new Error("Invalid GitHub repo URL on existing page");
  const [, owner, repo] = repoMatch;
  const repoName = repo.replace(".git", "");
  const repoFullName = `${owner}/${repoName}`;

  console.log(`[V0 SERVICE] Adding new page /${slug} to existing repo ${repoFullName} via v0 generation`);

  // Use the existing page's deployed URL as the base
  let baseUrl = `https://${repoName}.vercel.app`;
  if (existingPage.deployedUrl) {
    try {
      const parsed = new URL(existingPage.deployedUrl);
      baseUrl = parsed.origin;
    } catch {
      // URL parse failed — fall back to repo-name-based URL
    }
  }

  const record: GeneratedLandingPage = {
    id,
    userId,
    name,
    prompt,
    status: "generating",
    iterations: 0,
    slug,
    githubRepoUrl: existingPage.githubRepoUrl,
    vercelProjectId: existingPage.vercelProjectId,
    deployedUrl: baseUrl ? `${baseUrl}/${slug}` : undefined,
    createdAt: now,
    updatedAt: now,
  };

  if (leadListId) record.leadListId = leadListId;
  if (templateHtml) record.templateHtml = templateHtml;

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  try {
    // ── Step 1: Call v0 to generate proper page content ──
    // If no template provided, fall back to landing-page-v2 (same behaviour as generateFirstPage)
    const effectiveTemplate = templateHtml ?? await loadDefaultTemplateOutline();

    const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext, leadListId, effectiveTemplate);
    const v0 = await getV0Client();

    console.log(`[V0 SERVICE] Creating v0 chat for additional page /${slug}...`);
    const chatResponse = await withRetry(
      () => v0.chats.create({ message: enrichedPrompt }),
      "v0 chat creation (additional page)"
    );

    if (!("id" in chatResponse) || !chatResponse.id) {
      throw new Error("v0 chat creation did not return a ChatDetail with an id");
    }
    const chatId = chatResponse.id;

    // Save v0ChatId so the record can be retried/iterated later
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET v0ChatId = :chatId, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
          ":chatId": chatId,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    // ── Step 2: Poll for v0 version completion ──
    const V0_POLL_INTERVALS_MS = v0PollIntervalsMs;
    let versionId: string | undefined;

    for (let pollAttempt = 0; pollAttempt < V0_POLL_INTERVALS_MS.length; pollAttempt++) {
      if (V0_POLL_INTERVALS_MS[pollAttempt] > 0) {
        console.log(`[V0 SERVICE] v0 generation not ready yet for /${slug}, waiting ${V0_POLL_INTERVALS_MS[pollAttempt] / 1000}s (attempt ${pollAttempt + 1}/${V0_POLL_INTERVALS_MS.length})...`);
        await new Promise(resolve => setTimeout(resolve, V0_POLL_INTERVALS_MS[pollAttempt]));
      }

      const chat = await withRetry(
        () => v0.chats.getById({ chatId }),
        "v0 chat fetch (additional page)"
      );
      versionId = chat.latestVersion?.id;

      if (versionId) {
        console.log(`[V0 SERVICE] v0 version found for /${slug}: ${versionId} (poll attempt ${pollAttempt + 1})`);
        break;
      }
    }

    if (!versionId) {
      throw new Error("No version found in v0 chat after polling — generation may have failed");
    }

    // ── Step 3: Download and validate v0 output ──
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deploying",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    const V0_VALIDATION_MAX_RETRIES = 2;
    let zipBuffer: any;

    for (let validationAttempt = 0; validationAttempt <= V0_VALIDATION_MAX_RETRIES; validationAttempt++) {
      console.log(`[V0 SERVICE] Downloading v0 files for /${slug} (version ${versionId}, attempt ${validationAttempt + 1})`);
      zipBuffer = await withRetry(
        () => v0.chats.downloadVersion({
          chatId,
          versionId: versionId!,
          // @ts-ignore — SDK types may not include these yet
          format: "zip",
          includeDefaultFiles: true,
        }),
        "v0 zip download (additional page)"
      );

      const previewFiles = await unzipBuffer(zipBuffer);
      autoFixV0Files(previewFiles);

      try {
        validateV0Output(previewFiles);
        break;
      } catch (valErr: any) {
        if (valErr instanceof V0OutputValidationError && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
          console.warn(`[V0 SERVICE] v0 output validation failed for /${slug} (attempt ${validationAttempt + 1}): ${valErr.reason}`);

          await withRetry(
            () => v0.chats.sendMessage({
              chatId,
              message:
                "The previous output was not valid code. Please generate actual React/Next.js code — " +
                "not markdown, not a prompt description, not empty files. " +
                "Output must include .tsx files with real React components using export and function/const. " +
                `Issue: ${valErr.reason}`,
            }),
            "v0 correction message (additional page)"
          );

          await new Promise((resolve) => setTimeout(resolve, 5000));

          const updatedChat = await withRetry(
            () => v0.chats.getById({ chatId }),
            "v0 chat re-fetch (additional page)"
          );
          versionId = updatedChat.latestVersion?.id;
          if (!versionId) throw new Error("No version found after correction message");

          continue;
        }
        throw valErr;
      }
    }

    // ── Step 4: Extract and remap files for the new page route ──
    const allFiles = await unzipBuffer(zipBuffer);
    autoFixV0Files(allFiles);
    const filesToCommit = remapFilesForSubPage(allFiles, slug, name);

    console.log(`[V0 SERVICE] Extracted ${filesToCommit.length} files for /${slug}: ${filesToCommit.map(f => f.path).join(", ")}`);

    // ── Step 5: Commit files to existing repo using Git Trees API ──
    const { token: ghToken } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    };

    // Get latest commit SHA
    const refRes = await axios.get<any>(
      `https://api.github.com/repos/${repoFullName}/git/ref/heads/main`,
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    );
    const latestCommitSha = refRes.data.object.sha;

    // Create blobs for each file
    const blobPromises = filesToCommit.map(async (file) => {
      const blobRes = await axios.post<any>(
        `https://api.github.com/repos/${repoFullName}/git/blobs`,
        {
          content: file.content.toString("base64"),
          encoding: "base64",
        },
        { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
      );
      return {
        path: file.path,
        mode: "100644" as const,
        type: "blob" as const,
        sha: blobRes.data.sha,
      };
    });
    const treeItems = await Promise.all(blobPromises);

    // Create tree → commit → update ref
    const treeRes = await axios.post<any>(
      `https://api.github.com/repos/${repoFullName}/git/trees`,
      { base_tree: latestCommitSha, tree: treeItems },
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    );

    const commitRes = await axios.post<any>(
      `https://api.github.com/repos/${repoFullName}/git/commits`,
      {
        message: `Add new page: ${name} (/${slug})`,
        tree: treeRes.data.sha,
        parents: [latestCommitSha],
      },
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    );

    await axios.patch<any>(
      `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
      { sha: commitRes.data.sha },
      { headers: ghHeaders, timeout: GITHUB_API_TIMEOUT_MS }
    );

    // Capture timestamp after the ref push (Vercel webhook fires on push).
    // pollVercelDeployment uses this to ignore pre-existing READY deployments.
    const pushTimestampMs = Date.now();

    console.log(`[V0 SERVICE] Pushed ${filesToCommit.length} files for /${slug} to ${repoFullName} — polling Vercel for build status`);

    // Poll Vercel deployment to verify the build succeeds before marking as deployed
    const vercelToken = await getVercelToken();
    const deploymentResult = await pollVercelDeployment(existingPage.vercelProjectId!, vercelToken, pushTimestampMs);

    if (deploymentResult.buildStatus === "error" || deploymentResult.buildStatus === "timeout") {
      const errorMsg = `Vercel build failed for /${slug}: ${deploymentResult.buildError || "Unknown build error"}`;
      console.error(`[V0 SERVICE] ${errorMsg}`);

      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { id },
          UpdateExpression: "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "failed",
            ":error": errorMsg,
            ":updatedAt": new Date().toISOString(),
          },
        })
        .promise();

      return {
        ...record,
        status: "failed" as const,
        errorMessage: errorMsg,
      };
    }

    // Update record to deployed
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deployed",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return {
      ...record,
      status: "deployed",
      updatedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error("[V0 SERVICE] Failed to add page to repo:", error);

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "failed",
          ":error": error.message || "Failed to add page to repo",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return {
      ...record,
      status: "failed",
      errorMessage: error.message || "Failed to add page to repo",
    };
  }
}

/**
 * Inject or replace a Next.js App Router `metadata` export in a page.tsx so the
 * resolved `<title>` reflects the new page instead of inheriting the root
 * layout's stale title (e.g. a hardcoded "xCures® | HIMSS 2026…" from an
 * earlier generation). Next.js per-page metadata takes precedence over
 * layout metadata, so this is sufficient to fix the rendered <title>.
 *
 * Behaviour:
 * - If the file already exports a `metadata` object, rewrite its `title`
 *   field (or insert one) to the provided title.
 * - Otherwise, prepend a new `export const metadata = { title: "…" }` block
 *   right after any leading `'use client'` directive (if present — though
 *   `metadata` exports only work in server components, so this case is rare).
 */
export function ensurePageMetadataTitle(content: string, title: string): string {
  if (!title || !title.trim()) return content;
  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  // Case 1: existing `export const metadata = { ... }` — rewrite its title field
  const existingMetadataRegex = /export\s+const\s+metadata\s*(?::\s*[^=]+)?=\s*\{([\s\S]*?)\}\s*;?/;
  const match = content.match(existingMetadataRegex);
  if (match) {
    const body = match[1];
    let newBody: string;
    if (/\btitle\s*:/.test(body)) {
      // Replace existing title field value (string or template literal)
      newBody = body.replace(
        /(\btitle\s*:\s*)(?:`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/,
        `$1"${escaped}"`
      );
    } else {
      // Insert a title field at the top of the metadata object
      newBody = `\n  title: "${escaped}",` + body;
    }
    const replacement = `export const metadata = {${newBody}}`;
    return content.replace(existingMetadataRegex, replacement);
  }

  // Case 2: no existing metadata export — prepend a fresh one after any
  // 'use client' directive. In practice page.tsx should be a server component
  // so the directive is unusual here, but we handle it defensively.
  const metadataBlock = `export const metadata = { title: "${escaped}" };\n\n`;
  const useClientMatch = content.match(/^(\s*(?:'use client'|"use client");?\s*\n)/);
  if (useClientMatch) {
    return useClientMatch[1] + metadataBlock + content.slice(useClientMatch[1].length);
  }
  return metadataBlock + content;
}

/**
 * Remap files from a v0 zip for a sub-page route.
 * - app/page.tsx → app/<slug>/page.tsx
 * - components/*.tsx → app/<slug>/_components/*.tsx (avoids conflicts with root page)
 * - app/api/* → app/api/* (shared API routes, kept as-is)
 * - Config files, layout.tsx, globals.css → skipped (use existing project's)
 *
 * Also rewrites import paths in the page file to point to the relocated components.
 * If `pageTitle` is provided, injects/overrides a Next.js `metadata.title` export
 * on the remapped page.tsx so the rendered <title> reflects the new page rather
 * than inheriting a stale title from the root layout.
 */
export function remapFilesForSubPage(
  files: Array<{ path: string; content: Buffer }>,
  slug: string,
  pageTitle?: string
): Array<{ path: string; content: Buffer }> {
  // Files to skip — the existing project already has these
  const skipPatterns = [
    /^package\.json$/,
    /^package-lock\.json$/,
    /^tsconfig\.json$/,
    /^next\.config\.(ts|js|mjs)$/,
    /^next-env\.d\.ts$/,
    /^tailwind\.config\.(ts|js)$/,
    /^postcss\.config\.(ts|js|mjs|cjs)$/,
    /^\.gitignore$/,
    /^README\.md$/,
    /^app\/layout\.tsx$/,
    /^app\/globals\.css$/,
    /^lib\/utils\.ts$/,
    /^components\/ui\//,   // shadcn UI primitives — already in root project
  ];

  const result: Array<{ path: string; content: Buffer }> = [];
  const componentRenames = new Map<string, string>(); // old import path → new import path

  for (const file of files) {
    // Skip config and shared files
    if (skipPatterns.some((p) => p.test(file.path))) continue;

    if (file.path === "app/page.tsx") {
      // Main page → sub-route page
      result.push({ path: `app/${slug}/page.tsx`, content: file.content });
    } else if (file.path.startsWith("components/") && !file.path.startsWith("components/ui/")) {
      // Custom components → namespaced under the sub-route to avoid conflicts
      const relativeName = file.path.replace("components/", "");
      const newPath = `app/${slug}/_components/${relativeName}`;
      result.push({ path: newPath, content: file.content });
      // Track rename: @/components/foo → ./_components/foo (relative from app/<slug>/)
      const oldImport = `@/components/${relativeName.replace(/\.tsx$/, "")}`;
      const newImport = `./_components/${relativeName.replace(/\.tsx$/, "")}`;
      componentRenames.set(oldImport, newImport);
    } else if (file.path.startsWith("app/api/")) {
      // API routes (e.g. lead capture) — keep in place, shared across pages
      result.push({ path: file.path, content: file.content });
    } else if (file.path.startsWith("app/") && file.path !== "app/page.tsx") {
      // Other app files (e.g. app/loading.tsx) → namespace under slug
      const relativeName = file.path.replace("app/", "");
      result.push({ path: `app/${slug}/${relativeName}`, content: file.content });
    }
    // Skip everything else (public/, lib/, etc.) — root project already has them
  }

  // Rewrite imports in all committed .tsx/.ts files
  for (const file of result) {
    if (!file.path.endsWith(".tsx") && !file.path.endsWith(".ts")) continue;
    let content = file.content.toString("utf-8");
    let changed = false;

    // 1. Rewrite @/components/foo → ./_components/foo (absolute → relative)
    for (const [oldImport, newImport] of componentRenames) {
      const regex = new RegExp(
        `(from\\s+['"])${oldImport.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(['"])`,
        "g"
      );
      if (regex.test(content)) {
        content = content.replace(regex, `$1${newImport}$2`);
        changed = true;
      }
    }

    // 2. Fix relative imports inside _components/ files.
    //    When v0 generates a component at components/foo.tsx that imports
    //    from "./_components/bar", after remapping to _components/foo.tsx
    //    the sibling is at _components/bar.tsx — so strip the extra "_components/" prefix.
    if (file.path.includes(`/_components/`)) {
      const fixedContent = content.replace(
        /(from\s+['"])\.?\/_components\//g,
        "$1./"
      );
      if (fixedContent !== content) {
        content = fixedContent;
        changed = true;
      }
    }

    if (changed) {
      file.content = Buffer.from(content);
    }
  }

  // Inject per-page metadata title so sub-pages don't inherit the root
  // layout's (possibly stale) <title>. See ensurePageMetadataTitle for details.
  if (pageTitle && pageTitle.trim()) {
    const pagePath = `app/${slug}/page.tsx`;
    const pageFile = result.find((f) => f.path === pagePath);
    if (pageFile) {
      const updated = ensurePageMetadataTitle(pageFile.content.toString("utf-8"), pageTitle);
      pageFile.content = Buffer.from(updated);
    }
  }

  return result;
}


/**
 * Deploy a generated landing page: download from v0 → create GitHub repo → connect to Vercel.
 * v0 is only used for initial code generation. All future edits go through GitHub → Vercel auto-deploys.
 */
export async function deployLandingPage(
  id: string,
  userId: string
): Promise<GeneratedLandingPage> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  if (!record.v0ChatId) {
    throw new Error("Landing page has no v0 chat — generate first");
  }

  if (!["draft", "failed", "deploying"].includes(record.status)) {
    throw new Error(`Cannot deploy a landing page with status: ${record.status}`);
  }

  try {
    const v0 = await getV0Client();

    // Step 1: Get the latest version from v0 chat (poll with backoff if generation is still in progress)
    console.log(`[V0 SERVICE] Step 1: Getting latest version for chat ${record.v0ChatId}`);
    const V0_POLL_INTERVALS_MS = v0PollIntervalsMs; // total wait: up to ~2.5 min
    let versionId: string | undefined;

    for (let pollAttempt = 0; pollAttempt < V0_POLL_INTERVALS_MS.length; pollAttempt++) {
      if (V0_POLL_INTERVALS_MS[pollAttempt] > 0) {
        console.log(`[V0 SERVICE] v0 generation not ready yet, waiting ${V0_POLL_INTERVALS_MS[pollAttempt] / 1000}s before retry (attempt ${pollAttempt + 1}/${V0_POLL_INTERVALS_MS.length})...`);
        await new Promise(resolve => setTimeout(resolve, V0_POLL_INTERVALS_MS[pollAttempt]));
      }

      const chat = await withRetry(
        () => v0.chats.getById({ chatId: record.v0ChatId! }),
        "v0 chat fetch"
      );
      versionId = chat.latestVersion?.id;

      if (versionId) {
        console.log(`[V0 SERVICE] v0 version found: ${versionId} (poll attempt ${pollAttempt + 1})`);
        break;
      }
    }

    if (!versionId) {
      throw new Error("No version found in v0 chat after polling for ~2.5 minutes — generation may have failed");
    }

    // Step 2: Download + validate v0 output (with retry on bad output)
    const V0_VALIDATION_MAX_RETRIES = 2;
    let zipBuffer: any;

    for (let validationAttempt = 0; validationAttempt <= V0_VALIDATION_MAX_RETRIES; validationAttempt++) {
      console.log(`[V0 SERVICE] Step 2: Downloading files from v0 (version ${versionId}, attempt ${validationAttempt + 1})`);
      zipBuffer = await withRetry(
        () => v0.chats.downloadVersion({
          chatId: record.v0ChatId!,
          versionId: versionId!,
          // @ts-ignore — SDK types may not include these yet
          format: "zip",
          includeDefaultFiles: true,
        }),
        "v0 zip download"
      );

      // Unzip and validate before pushing to GitHub
      const previewFiles = await unzipBuffer(zipBuffer);
      autoFixV0Files(previewFiles);

      try {
        validateV0Output(previewFiles);
        break; // validation passed
      } catch (valErr: any) {
        if (valErr instanceof V0OutputValidationError && validationAttempt < V0_VALIDATION_MAX_RETRIES) {
          console.warn(`[V0 SERVICE] v0 output validation failed (attempt ${validationAttempt + 1}): ${valErr.reason}`);

          // Send correction message to v0 and re-download
          await withRetry(
            () => v0.chats.sendMessage({
              chatId: record.v0ChatId!,
              message:
                "The previous output was not valid code. Please generate actual React/Next.js code — " +
                "not markdown, not a prompt description, not empty files. " +
                "Output must include .tsx files with real React components using export and function/const. " +
                `Issue: ${valErr.reason}`,
            }),
            "v0 correction message"
          );

          // Wait for v0 to process the correction
          await new Promise((resolve) => setTimeout(resolve, 5000));

          // Get the new version
          const updatedChat = await withRetry(
            () => v0.chats.getById({ chatId: record.v0ChatId! }),
            "v0 chat re-fetch"
          );
          versionId = updatedChat.latestVersion?.id;
          if (!versionId) throw new Error("No version found after correction message");

          continue;
        }
        // Out of retries or not a validation error — rethrow
        throw valErr;
      }
    }

    // Step 3: Create GitHub repo and push files (validation already passed)
    console.log("[V0 SERVICE] Step 3: Creating GitHub repo and pushing files");
    const slug = record.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30);
    const repoName = `lp-${slug}-${id.slice(0, 8)}`;
    const { githubRepoUrl, repoFullName } = await createGitHubRepoAndPush(repoName, zipBuffer, record.name);

    // Save GitHub repo URL immediately so it's not lost if Vercel step fails
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: "SET #status = :status, githubRepoUrl = :repoUrl, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deploying",
          ":repoUrl": githubRepoUrl,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    // Step 4: Create Vercel project linked to the GitHub repo
    console.log(`[V0 SERVICE] Step 4: Creating Vercel project linked to ${repoFullName}`);
    const { deployedUrl, vercelProjectId, buildStatus, buildError } = await createVercelProject(repoFullName, repoName);

    // Step 5: Update DB record
    const now = new Date().toISOString();
    const finalStatus = buildStatus === "success" ? "deployed" : "failed";

    let updateExpression =
      "SET #status = :status, deployedUrl = :url, vercelProjectId = :vercelId, githubRepoUrl = :repoUrl, updatedAt = :updatedAt";
    const exprValues: Record<string, any> = {
      ":status": finalStatus,
      ":url": deployedUrl,
      ":vercelId": vercelProjectId,
      ":repoUrl": githubRepoUrl,
      ":updatedAt": now,
    };

    if (buildError) {
      updateExpression += ", errorMessage = :error";
      exprValues[":error"] = buildError;
    }

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: exprValues,
      })
      .promise();

    if (buildStatus !== "success") {
      console.error(`[V0 SERVICE] Build failed for ${id}: ${buildError}`);
      return {
        ...record,
        status: finalStatus,
        deployedUrl,
        vercelProjectId,
        githubRepoUrl,
        errorMessage: buildError,
        updatedAt: now,
      };
    }

    console.log(`[V0 SERVICE] Deployment complete: ${deployedUrl} | GitHub: ${githubRepoUrl}`);

    // Auto-assign an agentwebforms.com subdomain after successful deploy
    let customDomain: string | undefined;
    try {
      const subdomain = generateSubdomain(record.name || "page");
      const domainRecord = await addSubdomain(userId, vercelProjectId, subdomain);
      customDomain = domainRecord.domain;
      console.log(`[V0 SERVICE] Auto-assigned subdomain: ${customDomain}`);
    } catch (subdomainErr: any) {
      // Non-fatal — the Vercel URL still works
      console.warn(`[V0 SERVICE] Could not auto-assign subdomain: ${subdomainErr.message}`);
    }

    return {
      ...record,
      status: "deployed",
      deployedUrl,
      customDomainUrl: customDomain ? `https://${customDomain}` : undefined,
      vercelProjectId,
      githubRepoUrl,
      updatedAt: now,
    };
  } catch (error: any) {
    console.error("[V0 SERVICE] Deployment failed:", error);

    // Update DB record to "failed" so user/Emma knows what happened and can retry
    try {
      await dynamodb
        .update({
          TableName: TABLE_NAME,
          Key: { id },
          UpdateExpression:
            "SET #status = :status, errorMessage = :error, updatedAt = :updatedAt",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: {
            ":status": "failed",
            ":error": error.message || "Unknown deployment error",
            ":updatedAt": new Date().toISOString(),
          },
        })
        .promise();
    } catch (dbError) {
      console.error("[V0 SERVICE] Failed to update DB after deploy error:", dbError);
    }

    throw new Error(`Deployment failed: ${error.message}`);
  }
}

/**
 * Unzip a buffer and return file entries as { path, content } pairs.
 * Uses the built-in zlib + manual ZIP parsing to avoid extra dependencies.
 */
async function unzipBuffer(buffer: Buffer | ArrayBuffer): Promise<Array<{ path: string; content: Buffer }>> {
  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  const entries = zip.getEntries();
  const files: Array<{ path: string; content: Buffer }> = [];

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (!entry.entryName) continue;
    files.push({ path: entry.entryName, content: entry.getData() });
  }

  return files;
}

/**
 * Auto-fix common v0-generated code issues that cause Next.js build failures.
 * Modifies files in-place before they are pushed to GitHub.
 *
 * Known issues:
 * 1. `<style jsx>` in Server Components → add 'use client' directive
 * 2. Missing 'use client' for files using hooks (useState, useEffect, etc.)
 * 3. @import "shadcn" in CSS → replace with standard Tailwind imports
 */
function autoFixV0Files(files: Array<{ path: string; content: Buffer }>): number {
  let fixCount = 0;

  for (const file of files) {
    if (!file.path.endsWith(".tsx") && !file.path.endsWith(".ts")) continue;

    const content = file.content.toString("utf-8");
    const hasUseClient = content.trimStart().startsWith("'use client'") || content.trimStart().startsWith('"use client"');

    if (hasUseClient) continue;

    // Check if file needs 'use client'
    const needsClient =
      /<style jsx/.test(content) ||
      /\buseState\b/.test(content) ||
      /\buseEffect\b/.test(content) ||
      /\buseRef\b/.test(content) ||
      /\buseCallback\b/.test(content) ||
      /\buseMemo\b/.test(content) ||
      /\bonClick\b/.test(content) ||
      /\bonChange\b/.test(content) ||
      /\bonSubmit\b/.test(content);

    if (needsClient) {
      file.content = Buffer.from("'use client'\n\n" + content);
      fixCount++;
      console.log(`[V0 SERVICE] Auto-fix: added 'use client' to ${file.path}`);
    }
  }

  // Fix CSS issues
  for (const file of files) {
    if (!file.path.endsWith(".css")) continue;

    let content = file.content.toString("utf-8");
    let changed = false;

    // Replace @import "shadcn" with nothing (it's not a real CSS import)
    if (content.includes('@import "shadcn"') || content.includes("@import 'shadcn'")) {
      content = content.replace(/@import\s+['"]shadcn['"];?\s*/g, "");
      changed = true;
      console.log(`[V0 SERVICE] Auto-fix: removed @import "shadcn" from ${file.path}`);
    }

    if (changed) {
      file.content = Buffer.from(content);
      fixCount++;
    }
  }

  return fixCount;
}

// ---------------------------------------------------------------------------
// v0 output validation — catches "prompts instead of code", empty files, garbage
// ---------------------------------------------------------------------------

export class V0OutputValidationError extends Error {
  constructor(public readonly reason: string) {
    super(`v0 output validation failed: ${reason}`);
    this.name = "V0OutputValidationError";
  }
}

/**
 * Validate that unzipped v0 output contains actual React/Next.js code.
 * Rejects: empty output, markdown/prompts echoed back, files too small to be real code.
 */
export function validateV0Output(files: Array<{ path: string; content: Buffer }>): void {
  // 1. Must have at least one .tsx file
  const tsxFiles = files.filter((f) => f.path.endsWith(".tsx"));
  if (tsxFiles.length === 0) {
    throw new V0OutputValidationError("No .tsx files found in v0 output");
  }

  // 2. At least one .tsx file must have meaningful content (>50 chars)
  const meaningfulTsx = tsxFiles.filter((f) => f.content.toString("utf-8").trim().length > 50);
  if (meaningfulTsx.length === 0) {
    throw new V0OutputValidationError("All .tsx files are empty or trivially small (<50 chars)");
  }

  // 3. At least one .tsx file must look like React code (has export + function/const)
  const reactFiles = meaningfulTsx.filter((f) => {
    const content = f.content.toString("utf-8");
    return /\bexport\b/.test(content) && (/\bfunction\b/.test(content) || /\bconst\b/.test(content));
  });
  if (reactFiles.length === 0) {
    throw new V0OutputValidationError(
      "No .tsx file contains React code (missing export + function/const)"
    );
  }

  // 4. Anti-markdown check: reject if >50% of lines in main .tsx files start with # or >
  for (const file of reactFiles) {
    const lines = file.content.toString("utf-8").split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const markdownLines = lines.filter((l) => /^\s*[#>]/.test(l));
    if (markdownLines.length / lines.length > 0.5) {
      throw new V0OutputValidationError(
        `File ${file.path} appears to be markdown, not code (${markdownLines.length}/${lines.length} lines start with # or >)`
      );
    }
  }

  // 5. Anti-prompt-echo check: reject if a .tsx file contains common prompt patterns
  const promptPatterns = [
    /^Create a (?:landing page|website|page)/m,
    /^Build (?:me )?a/m,
    /^Generate a/m,
    /^Design a (?:modern|professional|sleek)/m,
    /^Make a (?:landing page|website)/m,
  ];
  for (const file of reactFiles) {
    const content = file.content.toString("utf-8");
    for (const pattern of promptPatterns) {
      if (pattern.test(content)) {
        throw new V0OutputValidationError(
          `File ${file.path} appears to echo the user's prompt instead of containing code`
        );
      }
    }
  }

  console.log(`[V0 SERVICE] Output validation passed: ${tsxFiles.length} .tsx files, ${reactFiles.length} with React code`);
}

/**
 * Create a GitHub repo under the AgentWebPro org and push all files via the Contents API.
 */
async function createGitHubRepoAndPush(
  repoName: string,
  zipData: any,
  description: string
): Promise<{ githubRepoUrl: string; repoFullName: string }> {
  const { token, org } = await getGitHubOrgToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github.v3+json",
  };

  // Create the repo
  const createRepoRes = await axios.post<any>(
    `https://api.github.com/orgs/${org}/repos`,
    {
      name: repoName,
      description: `Landing page: ${description}`,
      private: true,
      auto_init: true, // Creates an initial commit with README
    },
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );

  const githubRepoUrl = createRepoRes.data.html_url;
  const repoFullName = createRepoRes.data.full_name; // e.g. "AgentWebPro/lp-acme-a1b2c3"

  console.log(`[V0 SERVICE] Created GitHub repo: ${githubRepoUrl}`);

  // Unzip the downloaded files
  const files = await unzipBuffer(zipData);
  console.log(`[V0 SERVICE] Extracted ${files.length} files from v0 zip`);

  // v0 downloads only contain modified files — add standard Next.js scaffolding
  // that's required for the build but not included in the zip
  const scaffoldFiles: Array<{ path: string; content: Buffer }> = [];

  const hasFile = (name: string) => files.some((f) => f.path === name || f.path.endsWith(`/${name}`));

  if (!hasFile("tsconfig.json")) {
    scaffoldFiles.push({
      path: "tsconfig.json",
      content: Buffer.from(JSON.stringify({
        compilerOptions: {
          target: "ES2017",
          lib: ["dom", "dom.iterable", "esnext"],
          allowJs: true,
          skipLibCheck: true,
          strict: true,
          noEmit: true,
          esModuleInterop: true,
          module: "esnext",
          moduleResolution: "bundler",
          resolveJsonModule: true,
          isolatedModules: true,
          jsx: "preserve",
          incremental: true,
          plugins: [{ name: "next" }],
          paths: { "@/*": ["./*"] },
        },
        include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
        exclude: ["node_modules"],
      }, null, 2)),
    });
  }

  if (!hasFile("next.config.ts") && !hasFile("next.config.js") && !hasFile("next.config.mjs")) {
    scaffoldFiles.push({
      path: "next.config.ts",
      content: Buffer.from('import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {};\nexport default nextConfig;\n'),
    });
  }

  if (!hasFile("lib/utils.ts")) {
    scaffoldFiles.push({
      path: "lib/utils.ts",
      content: Buffer.from('import { type ClassValue, clsx } from "clsx"\nimport { twMerge } from "tailwind-merge"\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs))\n}\n'),
    });
  }

  if (scaffoldFiles.length > 0) {
    console.log(`[V0 SERVICE] Adding ${scaffoldFiles.length} scaffold files: ${scaffoldFiles.map(f => f.path).join(", ")}`);
    files.push(...scaffoldFiles);
  }

  // Auto-fix common v0 build issues before pushing to GitHub
  const fixCount = autoFixV0Files(files);
  if (fixCount > 0) {
    console.log(`[V0 SERVICE] Auto-fixed ${fixCount} files for build compatibility`);
  }

  // Push files to the repo using the Git Trees API (single commit for all files)
  // Step A: Get the default branch SHA
  const refRes = await axios.get<any>(
    `https://api.github.com/repos/${repoFullName}/git/ref/heads/main`,
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );
  const latestCommitSha = refRes.data.object.sha;

  // Step B: Create blobs for each file
  const blobPromises = files.map(async (file) => {
    const blobRes = await axios.post<any>(
      `https://api.github.com/repos/${repoFullName}/git/blobs`,
      {
        content: file.content.toString("base64"),
        encoding: "base64",
      },
      { headers, timeout: GITHUB_API_TIMEOUT_MS }
    );
    return {
      path: file.path,
      mode: "100644" as const,
      type: "blob" as const,
      sha: blobRes.data.sha,
    };
  });
  const treeItems = await Promise.all(blobPromises);

  // Step C: Create a tree
  const treeRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/git/trees`,
    {
      base_tree: latestCommitSha,
      tree: treeItems,
    },
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );

  // Step D: Create a commit
  const commitRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/git/commits`,
    {
      message: "Initial landing page from v0 generation",
      tree: treeRes.data.sha,
      parents: [latestCommitSha],
    },
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );

  // Step E: Update the ref to point to the new commit
  await axios.patch<any>(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
    { sha: commitRes.data.sha },
    { headers, timeout: GITHUB_API_TIMEOUT_MS }
  );

  console.log(`[V0 SERVICE] Pushed ${files.length} files to ${repoFullName}`);

  return { githubRepoUrl, repoFullName };
}

/**
 * Create a Vercel project linked to a GitHub repo. Vercel auto-deploys on push.
 * Polls deployment status and returns build errors if the deploy fails.
 */
async function createVercelProject(
  repoFullName: string,
  projectName: string
): Promise<{ deployedUrl: string; vercelProjectId: string; buildStatus: string; buildError?: string }> {
  const vercelToken = await getVercelToken();
  const headers = {
    Authorization: `Bearer ${vercelToken}`,
    "Content-Type": "application/json",
  };

  // Create the Vercel project linked to the GitHub repo
  const createRes = await axios.post<any>(
    "https://api.vercel.com/v10/projects",
    {
      name: projectName,
      framework: "nextjs",
      installCommand: "npm install",  // v0 generates package.json for npm, not pnpm
      buildCommand: "npm run build",  // Prevent Vercel from defaulting to pnpm
      gitRepository: {
        type: "github",
        repo: repoFullName,
      },
    },
    { headers, timeout: VERCEL_API_TIMEOUT_MS }
  );

  const vercelProjectId = createRes.data.id;
  // Use the actual alias/domain from Vercel API — Vercel truncates long project names
  const vercelAlias = createRes.data.alias?.[0]?.domain
    || createRes.data.targets?.production?.alias?.[0]
    || `${createRes.data.name || projectName}.vercel.app`;
  const deployedUrl = vercelAlias.startsWith("https://") ? vercelAlias : `https://${vercelAlias}`;

  console.log(`[V0 SERVICE] Created Vercel project: ${vercelProjectId}, URL: ${deployedUrl} (requested name: ${projectName})`);

  // Disable deployment protection so preview deployments are publicly accessible
  try {
    await axios.patch(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { ssoProtection: null, passwordProtection: null, trustedIps: null },
      { headers, timeout: VERCEL_API_TIMEOUT_MS }
    );
    console.log(`[V0 SERVICE] Disabled deployment protection for ${projectName}`);
  } catch (authErr: any) {
    console.warn(`[V0 SERVICE] Could not disable deployment protection: ${authErr.message}`);
  }

  // Manually trigger a deployment — Vercel doesn't always auto-deploy when linking to an existing repo
  const { token: ghToken } = await getGitHubOrgToken();
  const repoInfoRes = await axios.get<any>(`https://api.github.com/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
    timeout: 30_000,
  });
  const repoId = repoInfoRes.data.id;

  // Capture timestamp immediately before triggering — pollVercelDeployment uses
  // this to ignore any pre-existing READY deployment.
  const deployTriggerMs = Date.now();
  try {
    await axios.post<any>(
      "https://api.vercel.com/v13/deployments",
      {
        name: projectName,
        project: vercelProjectId,
        gitSource: { type: "github", repo: repoFullName, ref: "main", repoId },
      },
      { headers, timeout: VERCEL_API_TIMEOUT_MS }
    );
    console.log(`[V0 SERVICE] Triggered manual deployment for ${projectName}`);
  } catch (deployErr: any) {
    // Non-fatal — Vercel may have already auto-triggered
    console.warn(`[V0 SERVICE] Manual deploy trigger failed (may already be deploying): ${deployErr.message}`);
  }

  // Poll for deployment status — only accept deployments created after our trigger
  const deploymentResult = await pollVercelDeployment(vercelProjectId, vercelToken, deployTriggerMs);

  // After deployment, fetch the project to get the real production alias.
  // Vercel truncates long project names in domains (e.g. our requested name
  // "lp-foo--abc123" may become "lp-foo-ab" in the domain), so we read the
  // actual domain from targets.production.alias[0] which is authoritative.
  let finalUrl = deployedUrl;
  try {
    const projectRes = await axios.get<any>(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { headers, timeout: VERCEL_API_TIMEOUT_MS }
    );
    const productionAliases: string[] = projectRes.data?.targets?.production?.alias || [];
    const vercelDomain = productionAliases.find((a: string) => a.endsWith(".vercel.app"));
    if (vercelDomain) {
      finalUrl = `https://${vercelDomain}`;
    }
  } catch (aliasErr: any) {
    console.warn(`[V0 SERVICE] Could not fetch project aliases, using constructed URL: ${aliasErr.message}`);
  }

  if (finalUrl !== deployedUrl) {
    console.log(`[V0 SERVICE] URL corrected: ${deployedUrl} → ${finalUrl}`);
  }

  return { deployedUrl: finalUrl, vercelProjectId, ...deploymentResult };
}

/**
 * Poll Vercel for a deployment created at or after `sinceMs` (Unix ms).
 * Passing sinceMs prevents catching a previously-READY deployment when a new
 * build has just been triggered by a GitHub push.
 */
async function pollVercelDeployment(
  projectId: string,
  vercelToken: string,
  sinceMs?: number
): Promise<{ buildStatus: string; buildError?: string }> {
  const headers = { Authorization: `Bearer ${vercelToken}` };

  for (let attempt = 0; attempt < vercelPollMaxAttempts; attempt++) {
    try {
      const sinceParam = sinceMs !== undefined ? `&since=${sinceMs}` : "";
      const deploymentsRes = await axios.get<any>(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=1${sinceParam}`,
        { headers, timeout: VERCEL_POLL_TIMEOUT_MS }
      );

      const deployment = deploymentsRes.data?.deployments?.[0];
      if (!deployment) {
        console.log(`[V0 SERVICE] No deployment found yet${sinceMs !== undefined ? ` after ${new Date(sinceMs).toISOString()}` : ""} (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, vercelPollIntervalMs));
        continue;
      }

      const state = deployment.readyState || deployment.state;
      console.log(`[V0 SERVICE] Deployment ${deployment.uid}: state=${state} (attempt ${attempt + 1})`);

      if (state === "READY") {
        return { buildStatus: "success" };
      }

      if (state === "ERROR" || state === "CANCELED") {
        // Fetch build logs to get the error details
        const buildError = await getVercelBuildErrors(deployment.uid, vercelToken);
        return {
          buildStatus: "error",
          buildError: buildError || `Vercel build failed with state: ${state}`,
        };
      }

      // Still building (QUEUED, BUILDING, INITIALIZING) — wait and retry
      await new Promise(r => setTimeout(r, vercelPollIntervalMs));
    } catch (err: any) {
      console.error(`[V0 SERVICE] Error polling deployment (attempt ${attempt + 1}):`, err.message);
      await new Promise(r => setTimeout(r, vercelPollIntervalMs));
    }
  }

  return { buildStatus: "timeout", buildError: "Deployment timed out after 5 minutes. Check Vercel dashboard." };
}

/**
 * Fetch build error messages from Vercel deployment events.
 */
async function getVercelBuildErrors(deploymentId: string, vercelToken: string): Promise<string> {
  try {
    const headers = { Authorization: `Bearer ${vercelToken}` };
    const eventsRes = await axios.get<any>(
      `https://api.vercel.com/v3/deployments/${deploymentId}/events?limit=-1`,
      { headers, timeout: VERCEL_POLL_TIMEOUT_MS }
    );

    const events = eventsRes.data || [];
    const errorLines: string[] = [];

    for (const event of events) {
      const type = event.type;
      const text = event.payload?.text || event.text || "";
      if ((type === "stderr" || type === "fatal") && text.trim()) {
        errorLines.push(text);
      }
    }

    // Return the last 30 error lines (most relevant)
    return errorLines.slice(-30).join("\n") || "Build failed — no error details available in logs.";
  } catch (err: any) {
    console.error("[V0 SERVICE] Error fetching build logs:", err.message);
    return "Build failed — could not retrieve error details.";
  }
}

/**
 * Get the current deployment status and build logs for a landing page.
 * Exposed as a tool so Emma can check on builds.
 */
export async function getDeploymentStatus(
  id: string,
  userId: string
): Promise<{ status: string; buildStatus?: string; buildError?: string; deployedUrl?: string }> {
  const record = await getLandingPage(id, userId);
  if (!record) throw new Error("Landing page not found");
  if (!record.vercelProjectId) return { status: record.status };

  const vercelToken = await getVercelToken();
  const headers = { Authorization: `Bearer ${vercelToken}` };

  const deploymentsRes = await axios.get<any>(
    `https://api.vercel.com/v6/deployments?projectId=${record.vercelProjectId}&limit=1`,
    { headers }
  );

  const deployment = deploymentsRes.data?.deployments?.[0];
  if (!deployment) return { status: record.status, buildStatus: "no_deployment" };

  const state = deployment.readyState || deployment.state;

  if (state === "ERROR" || state === "CANCELED") {
    const buildError = await getVercelBuildErrors(deployment.uid, vercelToken);
    return { status: record.status, buildStatus: "error", buildError, deployedUrl: record.deployedUrl };
  }

  return {
    status: record.status,
    buildStatus: state === "READY" ? "success" : state.toLowerCase(),
    deployedUrl: record.deployedUrl,
  };
}

/**
 * Get the Vercel preview deployment URL for a non-main branch.
 * Vercel automatically creates preview deployments for branch pushes.
 * Returns the preview URL and build status.
 */
export async function getPreviewDeploymentUrl(
  vercelProjectId: string,
  branch: string
): Promise<{ previewUrl?: string; buildStatus: string; buildError?: string; prUrl?: string }> {
  const vercelToken = await getVercelToken();
  const headers = { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" };

  // Fetch project info and ensure Vercel Authentication is disabled
  let projRes: any = null;
  try {
    projRes = await axios.get<any>(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { headers }
    );
    console.log(`[V0 SERVICE] Project ${vercelProjectId} protection settings:`, JSON.stringify({
      ssoProtection: projRes.data?.ssoProtection,
      passwordProtection: projRes.data?.passwordProtection,
      trustedIps: projRes.data?.trustedIps,
    }));

    // Disable all protection types
    const patchRes = await axios.patch(
      `https://api.vercel.com/v9/projects/${vercelProjectId}`,
      { ssoProtection: null, passwordProtection: null, trustedIps: null },
      { headers }
    );
    console.log(`[V0 SERVICE] Disabled deployment protection for project ${vercelProjectId}: ${patchRes.status}`);
  } catch (authErr: any) {
    console.warn(`[V0 SERVICE] Could not disable deployment protection for ${vercelProjectId}: ${authErr.response?.status} ${authErr.response?.data?.error?.message || authErr.message}`);
  }

  // List recent deployments filtered by the branch (meta.githubCommitRef)
  const deploymentsRes = await axios.get<any>(
    `https://api.vercel.com/v6/deployments?projectId=${vercelProjectId}&limit=20`,
    { headers }
  );

  const deployments = deploymentsRes.data?.deployments || [];
  console.log(`[V0 SERVICE] Found ${deployments.length} deployments for project ${vercelProjectId}, looking for branch "${branch}". Branches in deployments: [${deployments.map((d: any) => d.meta?.githubCommitRef || 'none').join(', ')}]`);

  // Find the most recent deployment for this branch
  const branchDeployment = deployments.find((d: any) =>
    d.meta?.githubCommitRef === branch
  );

  if (!branchDeployment) {
    // No deployment found — Vercel deploys on PRs, not branch pushes.
    // Create a draft PR to trigger the Vercel preview deployment.
    const repoLink = projRes?.data?.link;
    if (repoLink?.type === "github" && repoLink.repo) {
      try {
        const repoFullName = `${repoLink.org}/${repoLink.repo}`;
        console.log(`[V0 SERVICE] No deployment found for branch "${branch}", creating draft PR to trigger Vercel preview`);
        const prUrl = await createDraftPrForBranch(repoFullName, branch);
        return { buildStatus: "building", previewUrl: undefined, prUrl };
      } catch (prErr: any) {
        console.warn(`[V0 SERVICE] Failed to create draft PR for branch "${branch}": ${prErr.response?.data?.message || prErr.message}`);
      }
    }
    return { buildStatus: "not_found", previewUrl: undefined };
  }

  const state = branchDeployment.readyState || branchDeployment.state;
  const previewUrl = branchDeployment.url ? `https://${branchDeployment.url}` : undefined;

  if (state === "READY") {
    return { buildStatus: "success", previewUrl };
  }

  if (state === "ERROR" || state === "CANCELED") {
    const buildError = await getVercelBuildErrors(branchDeployment.uid, vercelToken);
    return { buildStatus: "error", buildError, previewUrl };
  }

  // Still building
  return { buildStatus: state.toLowerCase(), previewUrl };
}

/**
 * Create a draft PR for a branch if one doesn't already exist.
 * Vercel's GitHub integration deploys on PRs, so this triggers the preview deployment.
 */
async function createDraftPrForBranch(repoFullName: string, branch: string): Promise<string | undefined> {
  const { token: ghToken } = await getGitHubOrgToken();
  const ghHeaders = { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" };

  // Check if a PR already exists for this branch
  const existingPrs = await axios.get<any>(
    `https://api.github.com/repos/${repoFullName}/pulls?head=${repoFullName.split('/')[0]}:${branch}&state=open`,
    { headers: ghHeaders }
  );
  if (existingPrs.data?.length > 0) {
    console.log(`[V0 SERVICE] Draft PR already exists for branch "${branch}": #${existingPrs.data[0].number}`);
    return existingPrs.data[0].html_url;
  }

  // Create a draft PR
  const prRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/pulls`,
    {
      title: `Preview: ${branch}`,
      head: branch,
      base: "main",
      draft: true,
      body: "Auto-created draft PR to trigger Vercel preview deployment.",
    },
    { headers: ghHeaders }
  );
  console.log(`[V0 SERVICE] Created draft PR #${prRes.data.number} for branch "${branch}" to trigger Vercel preview`);
  return prRes.data.html_url;
}

/**
 * Trigger a Vercel deployment for a project on a given branch (defaults to "main").
 * Used after merging a draft branch to ensure Vercel picks up the changes.
 */
export async function triggerVercelDeployment(
  vercelProjectId: string,
  repoFullName: string,
  ref: string = "main"
): Promise<void> {
  const vercelToken = await getVercelToken();
  const headers = { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" };

  const { token: ghToken } = await getGitHubOrgToken();
  const repoInfoRes = await axios.get<any>(`https://api.github.com/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
  });
  const repoId = repoInfoRes.data.id;

  await axios.post<any>(
    "https://api.vercel.com/v13/deployments",
    {
      name: vercelProjectId,
      project: vercelProjectId,
      gitSource: { type: "github", repo: repoFullName, ref, repoId },
    },
    { headers }
  );
  console.log(`[V0 SERVICE] Triggered deployment for ${repoFullName} on ${ref}`);
}

/**
 * Refine a landing page with follow-up instructions via v0 chat.
 */
export async function iterateLandingPage(
  id: string,
  userId: string,
  message: string
): Promise<GeneratedLandingPage> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  if (!record.v0ChatId) {
    throw new Error("Landing page has no v0 chat — generate first");
  }

  try {
    const v0 = await getV0Client();

    await withRetry(
      () => v0.chats.sendMessage({
        chatId: record.v0ChatId!,
        message,
      }),
      "v0 chat iterate"
    );

    // Reset status to draft (needs re-deploy after iteration)
    const newStatus = record.status === "deployed" ? "draft" : record.status;

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, iterations = :iterations, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": newStatus,
          ":iterations": (record.iterations || 0) + 1,
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return {
      ...record,
      status: newStatus,
      iterations: (record.iterations || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error("[V0 SERVICE] Iteration failed:", error);
    throw new Error(`Iteration failed: ${error.message}`);
  }
}

/**
 * Get a single landing page by ID (scoped to user). Excludes archived unless requested.
 */
export async function getLandingPage(
  id: string,
  userId: string,
  includeArchived = false
): Promise<GeneratedLandingPage | null> {
  const result = await dynamodb
    .get({
      TableName: TABLE_NAME,
      Key: { id },
    })
    .promise();

  const item = result.Item as GeneratedLandingPage | undefined;
  if (!item || item.userId !== userId) {
    return null;
  }
  if (item.archived && !includeArchived) {
    return null;
  }

  return item;
}

/**
 * Resolve the vercelProjectId for a page that is missing it by looking up
 * sibling pages (same user, same githubRepoUrl) that have the field set.
 * If found, backfills the value on the page record so future lookups are fast.
 */
export async function resolveVercelProjectId(
  page: GeneratedLandingPage
): Promise<string | null> {
  if (page.vercelProjectId) return page.vercelProjectId;
  if (!page.githubRepoUrl) return null;

  const siblings = await paginatedQuery<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    IndexName: "UserIdIndex",
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": page.userId },
  });

  const donor = siblings.find(
    (s) => s.githubRepoUrl === page.githubRepoUrl && !!s.vercelProjectId
  );
  if (!donor?.vercelProjectId) return null;

  // Backfill so this page won't need resolution again
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id: page.id },
      UpdateExpression: "SET vercelProjectId = :vpid, updatedAt = :now",
      ExpressionAttributeValues: {
        ":vpid": donor.vercelProjectId,
        ":now": new Date().toISOString(),
      },
    })
    .promise();
  console.log(
    `[V0 SERVICE] Backfilled vercelProjectId ${donor.vercelProjectId} on page ${page.id} from sibling ${donor.id}`
  );

  return donor.vercelProjectId;
}

/**
 * List all generated landing pages for a user (excludes archived).
 */
export async function listLandingPages(
  userId: string
): Promise<GeneratedLandingPage[]> {
  return await paginatedQuery<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    IndexName: "UserIdIndex",
    KeyConditionExpression: "userId = :userId",
    FilterExpression: "attribute_not_exists(archived) OR archived = :archivedFalse",
    ExpressionAttributeValues: {
      ":userId": userId,
      ":archivedFalse": false,
    },
    ScanIndexForward: false, // newest first
  });
}

/**
 * Find the user's landing site (GitHub repo + Vercel project).
 * Searches ALL records including archived — the site survives page deletion.
 * Also auto-marks the site record as isRootPage if not already set.
 */
async function findUserSiteRecord(userId: string): Promise<GeneratedLandingPage | null> {
  const pages = await paginatedQuery<GeneratedLandingPage>(dynamodb, {
    TableName: TABLE_NAME,
    IndexName: "UserIdIndex",
    KeyConditionExpression: "userId = :userId",
    ExpressionAttributeValues: { ":userId": userId },
  });

  // Prefer: 1) explicit root page, 2) page with v0ChatId (original v0 page), 3) any with githubRepoUrl
  const siteRecord =
    pages.find((p) => p.isRootPage && p.githubRepoUrl) ||
    pages.find((p) => p.v0ChatId && p.githubRepoUrl) ||
    pages.find((p) => !!p.githubRepoUrl);

  if (siteRecord && !siteRecord.isRootPage) {
    // Backfill: mark this as the root page
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: siteRecord.id },
        UpdateExpression: "SET isRootPage = :val",
        ExpressionAttributeValues: { ":val": true },
      })
      .promise();
    siteRecord.isRootPage = true;
  }

  return siteRecord || null;
}

/**
 * Remove a page route file from the GitHub repo.
 */
async function removePageFromGitHub(githubRepoUrl: string, slug: string): Promise<void> {
  const match = githubRepoUrl.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) return;
  const [, owner, repo] = match;
  const repoName = repo.replace(".git", "");
  const filePath = `app/${slug}/page.tsx`;

  const { token: ghToken } = await getGitHubOrgToken();
  const ghHeaders = {
    Authorization: `Bearer ${ghToken}`,
    Accept: "application/vnd.github.v3+json",
  };

  // Get the file SHA (required for deletion)
  const fileRes = await axios.get<any>(
    `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
    { headers: ghHeaders }
  );

  await axios({
    method: "DELETE",
    url: `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
    headers: ghHeaders,
    data: {
      message: `Remove page /${slug}`,
      sha: fileRes.data.sha,
    },
  });

  console.log(`[GITHUB] Removed ${filePath} from ${owner}/${repoName}`);
}

/**
 * Delete a landing page. Root page cannot be deleted.
 * Sub-pages are soft-deleted (archived) and their route file is removed from GitHub.
 */
export async function deleteLandingPage(
  id: string,
  userId: string
): Promise<void> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  if (record.isRootPage) {
    throw new Error("Cannot delete the root landing page. Use Emma to edit it instead.");
  }

  // Remove route file from GitHub
  if (record.githubRepoUrl && record.slug) {
    try {
      await removePageFromGitHub(record.githubRepoUrl, record.slug);
    } catch (err: any) {
      console.error("[V0 SERVICE] Failed to remove route from GitHub:", err.message);
      // Continue with soft-delete even if GitHub cleanup fails
    }
  }

  // Soft-delete (archive)
  await dynamodb
    .update({
      TableName: TABLE_NAME,
      Key: { id },
      UpdateExpression: "SET archived = :archived, archivedAt = :archivedAt, updatedAt = :updatedAt",
      ExpressionAttributeValues: {
        ":archived": true,
        ":archivedAt": new Date().toISOString(),
        ":updatedAt": new Date().toISOString(),
      },
    })
    .promise();
}
