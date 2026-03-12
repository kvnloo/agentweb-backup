import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import axios from "axios";
import { getV0ApiKey, getGitHubOrgToken, getVercelToken } from "../utils/secretsManager";

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
  status: "generating" | "draft" | "deployed" | "failed";
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
  createdAt: string;
  updatedAt: string;
}

export interface BrandContext {
  brandName?: string;
  primaryColor?: string;
  secondaryColor?: string;
  fontFamily?: string;
  tagline?: string;
  toneOfVoice?: string;
  logoUrl?: string;
  brandPersonality?: string;
  keyMessages?: string[];
  targetAudience?: string;
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
  if (brand.primaryColor) brandParts.push(`Primary color: ${brand.primaryColor}`);
  if (brand.secondaryColor) brandParts.push(`Secondary color: ${brand.secondaryColor}`);
  if (brand.fontFamily) brandParts.push(`Font: ${brand.fontFamily}`);
  if (brand.tagline) brandParts.push(`Tagline: "${brand.tagline}"`);
  if (brand.toneOfVoice) brandParts.push(`Tone of voice: ${brand.toneOfVoice}`);
  if (brand.logoUrl) brandParts.push(`Logo URL: ${brand.logoUrl}`);
  if (brand.brandPersonality) brandParts.push(`Brand personality: ${brand.brandPersonality}`);
  if (brand.keyMessages && brand.keyMessages.length > 0)
    brandParts.push(`Key messages: ${brand.keyMessages.join(", ")}`);
  if (brand.targetAudience) brandParts.push(`Target audience: ${brand.targetAudience}`);

  if (brandParts.length > 0) {
    parts.push("\n\nBrand Guidelines:\n" + brandParts.join("\n"));
  }

  if (leadListId) {
    parts.push(
      `\n\nInclude a contact/lead capture form that POSTs JSON to: ${process.env.BACKEND_URL || 'https://api.agentweb.pro'}/api/crm/public/lists/${leadListId}/capture with fields: email (required), firstName, lastName, company, phone, message. The form should use fetch() with mode 'cors' and Content-Type 'application/json'.`
    );
  }

  if (templateHtml) {
    parts.push(
      '\n\nREFERENCE HTML TEMPLATE:\nThe following HTML template represents the approved design. Recreate this design faithfully as a production React/Next.js page. Match the layout, sections, colors, typography, and content as closely as possible. Convert inline styles to Tailwind CSS classes.\n\n```html\n' +
      templateHtml +
      '\n```'
    );
  }

  parts.push(
    '\n\nIMPORTANT: Create a complete, production-ready landing page. Use modern design patterns, responsive layout, and the brand colors/fonts specified above.' +
    '\n\nCRITICAL Next.js Rules:' +
    '\n- Any component that uses onClick, onChange, onSubmit, useState, useEffect, or any other event handler or React hook MUST have "use client" at the very top of the file.' +
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
 * Generate a landing page using v0 Platform API
 */
export async function generateLandingPage(
  userId: string,
  prompt: string,
  name: string,
  brandContext: BrandContext,
  leadListId?: string,
  templateHtml?: string
): Promise<GeneratedLandingPage> {
  // Dedup: if this user already has a page with a v0ChatId that isn't failed, reuse it.
  // This prevents burning extra v0 credits on retries or duplicate calls from Emma.
  const existingPages = await listLandingPages(userId);
  const reusable = existingPages.find(
    (p) => p.v0ChatId && ["generating", "draft", "deploying", "deployed"].includes(p.status)
  );
  if (reusable) {
    console.log(`[V0 SERVICE] Reusing existing page ${reusable.id} (status: ${reusable.status}, v0ChatId: ${reusable.v0ChatId}) — skipping new v0 chat`);
    return reusable;
  }

  const id = uuidv4();
  const now = new Date().toISOString();
  const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext, leadListId, templateHtml);

  // Create the record first in "generating" status
  const record: GeneratedLandingPage = {
    id,
    userId,
    name,
    prompt,
    status: "generating",
    iterations: 0,
    createdAt: now,
    updatedAt: now,
  };

  if (leadListId) {
    record.leadListId = leadListId;
  }
  if (templateHtml) {
    record.templateHtml = templateHtml;
  }

  await dynamodb
    .put({
      TableName: TABLE_NAME,
      Item: record,
    })
    .promise();

  try {
    const v0 = await getV0Client();

    // Generate the landing page via a standalone chat (no v0 project needed — we deploy via GitHub/Vercel)
    const chatResponse = await v0.chats.create({
      message: enrichedPrompt,
    });

    // Narrow the union type — streaming responses don't have 'id'
    if (!("id" in chatResponse) || !chatResponse.id) {
      throw new Error("v0 chat creation did not return a ChatDetail with an id");
    }
    const chat = chatResponse;
    const chatId = chat.id;

    // Update record with v0 chat ID and mark as draft
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

    // Auto-deploy: download from v0 → GitHub → Vercel in one shot
    console.log(`[V0 SERVICE] v0 chat created (${chatId}), auto-deploying...`);
    const deployed = await deployLandingPage(id, userId);
    return deployed;
  } catch (error: any) {
    console.error("[V0 SERVICE] Generation failed:", error);

    // Update record to failed status
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

  // Poll for initial deployment status (Vercel auto-triggers a build when linking GitHub)
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
 * Send a follow-up message to iterate on a landing page
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

    await v0.chats.sendMessage({
      chatId: record.v0ChatId,
      message,
    });

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
 * Get a single landing page by ID (scoped to user)
 */
export async function getLandingPage(
  id: string,
  userId: string
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

  return item;
}

/**
 * List all generated landing pages for a user
 */
export async function listLandingPages(
  userId: string
): Promise<GeneratedLandingPage[]> {
  const result = await dynamodb
    .query({
      TableName: TABLE_NAME,
      IndexName: "UserIdIndex",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
      ScanIndexForward: false, // newest first
    })
    .promise();

  return (result.Items || []) as GeneratedLandingPage[];
}

/**
 * Delete a landing page record
 */
export async function deleteLandingPage(
  id: string,
  userId: string
): Promise<void> {
  // Verify ownership first
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  await dynamodb
    .delete({
      TableName: TABLE_NAME,
      Key: { id },
    })
    .promise();
}
