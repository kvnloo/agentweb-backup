import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import { getV0ApiKey } from "../utils/secretsManager";

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
  brand: BrandContext
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

  parts.push(
    "\n\nIMPORTANT: Create a complete, production-ready landing page. Use modern design patterns, responsive layout, and the brand colors/fonts specified above."
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
  brandContext: BrandContext
): Promise<GeneratedLandingPage> {
  const id = uuidv4();
  const now = new Date().toISOString();
  const enrichedPrompt = buildBrandEnrichedPrompt(prompt, brandContext);

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

  await dynamodb
    .put({
      TableName: TABLE_NAME,
      Item: record,
    })
    .promise();

  try {
    const v0 = await getV0Client();

    // Step 1: Create a v0 project for this landing page
    const project = await v0.projects.create({
      name: `LP - ${name}`,
      description: `Landing page: ${name}. Generated for userId: ${userId}`,
    });

    // Step 2: Generate the landing page via chat
    const chat = await v0.chats.create({
      message: enrichedPrompt,
      projectId: project.id,
    });

    const chatId = chat.id;
    if (!chatId) {
      throw new Error("v0 chat creation did not return an id");
    }

    // Update record with v0 IDs and mark as draft
    const updatedRecord: Partial<GeneratedLandingPage> = {
      status: "draft",
      v0ProjectId: project.id,
      v0ChatId: chatId,
      updatedAt: new Date().toISOString(),
    };

    // Extract web URL if available
    if (chat.webUrl) {
      updatedRecord.githubRepoUrl = chat.webUrl;
    }

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, v0ProjectId = :projectId, v0ChatId = :chatId, updatedAt = :updatedAt" +
          (updatedRecord.githubRepoUrl ? ", githubRepoUrl = :repoUrl" : ""),
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "draft",
          ":projectId": project.id,
          ":chatId": chatId,
          ":updatedAt": updatedRecord.updatedAt,
          ...(updatedRecord.githubRepoUrl
            ? { ":repoUrl": updatedRecord.githubRepoUrl }
            : {}),
        },
      })
      .promise();

    return {
      ...record,
      ...updatedRecord,
    } as GeneratedLandingPage;
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
 * Deploy a generated landing page to Vercel via v0
 */
export async function deployLandingPage(
  id: string,
  userId: string
): Promise<GeneratedLandingPage> {
  const record = await getLandingPage(id, userId);
  if (!record) {
    throw new Error("Landing page not found");
  }

  if (!record.v0ProjectId || !record.v0ChatId) {
    throw new Error("Landing page has no v0 project/chat — generate first");
  }

  if (record.status !== "draft") {
    throw new Error(`Cannot deploy a landing page with status: ${record.status}`);
  }

  try {
    const v0 = await getV0Client();

    // Get the chat to find the latest version ID
    const chat = await v0.chats.getById({ chatId: record.v0ChatId });
    const versionId = chat.latestVersion?.id;

    if (!versionId) {
      throw new Error("No version found in v0 chat — generation may still be in progress");
    }

    // Create deployment
    const deployment = await v0.deployments.create({
      projectId: record.v0ProjectId,
      chatId: record.v0ChatId,
      versionId,
    });

    const deployedUrl = deployment.webUrl;

    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id },
        UpdateExpression:
          "SET #status = :status, deployedUrl = :url, vercelProjectId = :vercelId, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "deployed",
          ":url": deployedUrl || "",
          ":vercelId": deployment.id || "",
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();

    return {
      ...record,
      status: "deployed",
      deployedUrl: deployedUrl || "",
      vercelProjectId: deployment.id || "",
      updatedAt: new Date().toISOString(),
    };
  } catch (error: any) {
    console.error("[V0 SERVICE] Deployment failed:", error);
    throw new Error(`Deployment failed: ${error.message}`);
  }
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
