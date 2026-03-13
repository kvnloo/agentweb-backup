import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import axios from "axios";
import { Agent, setGlobalDispatcher } from "undici";
import * as fs from "fs";
import * as path from "path";
import { getV0ApiKey, getGitHubOrgToken, getVercelToken } from "../utils/secretsManager";

// v0 code generation can take several minutes — extend Node's default fetch timeouts.
// Node 20's built-in undici has headersTimeout=300s which is too short for v0.
setGlobalDispatcher(new Agent({
  headersTimeout: 10 * 60 * 1000,  // 10 minutes
  bodyTimeout: 10 * 60 * 1000,     // 10 minutes
  connectTimeout: 30 * 1000,       // 30 seconds for initial connection
}));
console.log("[V0 SERVICE] Extended fetch timeouts to 10 minutes for v0 API calls");

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
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
function extractTemplateOutline(fullHtml: string): string {
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
    parts.push(
      `\n\nInclude a contact/lead capture form that POSTs JSON to: ${process.env.BACKEND_URL || 'https://api.agentweb.pro'}/api/crm/public/lists/${leadListId}/capture with fields: email (required), firstName, lastName, company, phone, message. The form should use fetch() with mode 'cors' and Content-Type 'application/json'.`
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
  let effectiveTemplate = templateHtml;
  if (!effectiveTemplate) {
    try {
      const templatePath = path.join(__dirname, "../templates/landing-page-v2.html");
      const fullTemplate = fs.readFileSync(templatePath, "utf-8");
      // Extract a condensed version: section structure + key CSS variables + first body section
      effectiveTemplate = extractTemplateOutline(fullTemplate);
      console.log(`[V0 SERVICE] Loaded landing page template outline (${effectiveTemplate.length} chars) as design inspiration`);
    } catch (err) {
      console.warn("[V0 SERVICE] Could not load landing page template, continuing without:", err);
    }
  }

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

    const chatResponse = await v0.chats.create({ message: enrichedPrompt });

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
 * Creates app/<slug>/page.tsx via the GitHub Contents API. Vercel auto-redeploys.
 * No v0 call — the new page content is generated from the prompt + template HTML.
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

  const match = existingPage.githubRepoUrl!.match(/github\.com\/([^\/]+)\/([^\/]+)/);
  if (!match) throw new Error("Invalid GitHub repo URL on existing page");
  const [, owner, repo] = match;
  const repoName = repo.replace(".git", "");

  console.log(`[GITHUB] Adding new page /${slug} to existing repo ${owner}/${repoName}`);

  // Build the page content — a simple React component from the template/prompt
  const pageContent = buildNewPageContent(name, prompt, brandContext, leadListId, templateHtml);

  // Derive the base URL from the Vercel project name in the GitHub repo URL
  const repoSlug = repoName; // e.g. "lp-taskflow-landing-9262210a"
  const baseUrl = `https://${repoSlug}.vercel.app`;

  const record: GeneratedLandingPage = {
    id,
    userId,
    name,
    prompt,
    status: "deploying",
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
    const { token: ghToken } = await getGitHubOrgToken();
    const ghHeaders = {
      Authorization: `Bearer ${ghToken}`,
      Accept: "application/vnd.github.v3+json",
    };

    // Create the new page file: app/<slug>/page.tsx
    const filePath = `app/${slug}/page.tsx`;
    const encoded = Buffer.from(pageContent, "utf-8").toString("base64");

    await axios.put(
      `https://api.github.com/repos/${owner}/${repoName}/contents/${filePath}`,
      {
        message: `Add new page: ${name} (/${slug})`,
        content: encoded,
      },
      { headers: ghHeaders }
    );

    console.log(`[GITHUB] Created ${filePath} in ${owner}/${repoName} — Vercel will auto-redeploy`);

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
    console.error("[GITHUB] Failed to add page to repo:", error);

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
 * Build a simple React page component from prompt + brand context.
 * Used when adding new pages to an existing repo (no v0 needed).
 */
function buildNewPageContent(
  name: string,
  prompt: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string
): string {
  // If template HTML is provided, wrap it in a React component with dangerouslySetInnerHTML
  if (templateHtml) {
    // Escape backticks in the HTML for the template literal
    const escapedHtml = templateHtml.replace(/`/g, "\\`").replace(/\$/g, "\\$");
    return `export default function ${name.replace(/[^a-zA-Z0-9]/g, "")}Page() {
  return (
    <div dangerouslySetInnerHTML={{ __html: \`${escapedHtml}\` }} />
  );
}
`;
  }

  // Otherwise, generate a minimal page from the prompt context
  const brandName = brandContext.brandName || name;
  const primaryColor = brandContext.primaryColor || "#007AFF";
  const tagline = brandContext.tagline || prompt.slice(0, 100);

  return `export default function ${name.replace(/[^a-zA-Z0-9]/g, "")}Page() {
  return (
    <main className="min-h-screen bg-white">
      <section className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h1 className="text-4xl font-bold mb-4" style={{ color: "${primaryColor}" }}>
          ${brandName}
        </h1>
        <p className="text-xl text-gray-600 mb-8">
          ${tagline}
        </p>
        <p className="text-gray-500">
          ${prompt.replace(/'/g, "\\'")}
        </p>
      </section>
    </main>
  );
}
`;
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

    // Step 1: Get the latest version from v0 chat
    console.log(`[V0 SERVICE] Step 1: Getting latest version for chat ${record.v0ChatId}`);
    const chat = await v0.chats.getById({ chatId: record.v0ChatId });
    const versionId = chat.latestVersion?.id;

    if (!versionId) {
      throw new Error("No version found in v0 chat — generation may still be in progress");
    }

    // Step 2: Download project files from v0
    console.log(`[V0 SERVICE] Step 2: Downloading files from v0 (version ${versionId})`);
    const zipBuffer = await v0.chats.downloadVersion({
      chatId: record.v0ChatId,
      versionId,
      // @ts-ignore — SDK types may not include these yet
      format: "zip",
      includeDefaultFiles: true,
    });

    // Step 3: Create GitHub repo and push files
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

    return {
      ...record,
      status: "deployed",
      deployedUrl,
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
    { headers }
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
    { headers }
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
      { headers }
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
    { headers }
  );

  // Step D: Create a commit
  const commitRes = await axios.post<any>(
    `https://api.github.com/repos/${repoFullName}/git/commits`,
    {
      message: "Initial landing page from v0 generation",
      tree: treeRes.data.sha,
      parents: [latestCommitSha],
    },
    { headers }
  );

  // Step E: Update the ref to point to the new commit
  await axios.patch<any>(
    `https://api.github.com/repos/${repoFullName}/git/refs/heads/main`,
    { sha: commitRes.data.sha },
    { headers }
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
    { headers }
  );

  const vercelProjectId = createRes.data.id;
  const deployedUrl = `https://${projectName}.vercel.app`;

  console.log(`[V0 SERVICE] Created Vercel project: ${vercelProjectId}, URL: ${deployedUrl}`);

  // Manually trigger a deployment — Vercel doesn't always auto-deploy when linking to an existing repo
  const { token: ghToken } = await getGitHubOrgToken();
  const repoInfoRes = await axios.get<any>(`https://api.github.com/repos/${repoFullName}`, {
    headers: { Authorization: `Bearer ${ghToken}`, Accept: "application/vnd.github.v3+json" },
  });
  const repoId = repoInfoRes.data.id;

  try {
    await axios.post<any>(
      "https://api.vercel.com/v13/deployments",
      {
        name: projectName,
        project: vercelProjectId,
        gitSource: { type: "github", repo: repoFullName, ref: "main", repoId },
      },
      { headers }
    );
    console.log(`[V0 SERVICE] Triggered manual deployment for ${projectName}`);
  } catch (deployErr: any) {
    // Non-fatal — Vercel may have already auto-triggered
    console.warn(`[V0 SERVICE] Manual deploy trigger failed (may already be deploying): ${deployErr.message}`);
  }

  // Poll for deployment status
  const deploymentResult = await pollVercelDeployment(vercelProjectId, vercelToken);

  return { deployedUrl, vercelProjectId, ...deploymentResult };
}

/**
 * Poll Vercel for the latest deployment status. Returns build status and errors if any.
 * Polls every 10s for up to 5 minutes.
 */
async function pollVercelDeployment(
  projectId: string,
  vercelToken: string
): Promise<{ buildStatus: string; buildError?: string }> {
  const headers = { Authorization: `Bearer ${vercelToken}` };
  const maxAttempts = 30; // 30 * 10s = 5 minutes
  const pollInterval = 10000;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      // List deployments for this project
      const deploymentsRes = await axios.get<any>(
        `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=1`,
        { headers }
      );

      const deployment = deploymentsRes.data?.deployments?.[0];
      if (!deployment) {
        console.log(`[V0 SERVICE] No deployment found yet (attempt ${attempt + 1})`);
        await new Promise(r => setTimeout(r, pollInterval));
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
      await new Promise(r => setTimeout(r, pollInterval));
    } catch (err: any) {
      console.error(`[V0 SERVICE] Error polling deployment (attempt ${attempt + 1}):`, err.message);
      await new Promise(r => setTimeout(r, pollInterval));
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
      { headers }
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
 * List all generated landing pages for a user (excludes archived).
 */
export async function listLandingPages(
  userId: string
): Promise<GeneratedLandingPage[]> {
  const result = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      FilterExpression: "attribute_not_exists(archived) OR archived = :archivedFalse",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":archivedFalse": false,
      },
      ScanIndexForward: false, // newest first
    })
    .promise();

  return (result.Items || []) as GeneratedLandingPage[];
}

/**
 * Find the user's landing site (GitHub repo + Vercel project).
 * Searches ALL records including archived — the site survives page deletion.
 * Also auto-marks the site record as isRootPage if not already set.
 */
async function findUserSiteRecord(userId: string): Promise<GeneratedLandingPage | null> {
  const result = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: { ":userId": userId },
    })
    .promise();

  const pages = (result.Items || []) as GeneratedLandingPage[];

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
