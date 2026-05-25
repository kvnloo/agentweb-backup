import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import axios from "axios";
import { getVercelToken } from "../utils/secretsManager";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-CustomDomains`;

const SUBDOMAIN_BASE = "agentwebforms.com";
const VERCEL_API_BASE = "https://api.vercel.com";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationRecord {
  type: string;
  domain: string;
  value: string;
}

export interface CustomDomainRecord {
  id: string;
  userId: string;
  domain: string;
  type: "subdomain" | "custom";
  status: "active" | "pending_verification" | "error";
  vercelProjectId: string;
  landingPageId?: string;
  verificationRecords?: VerificationRecord[];
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Generate a clean subdomain slug from a brand/page name.
 * Strips special characters, lowercases, and truncates to 63 chars (DNS limit).
 */
export function generateSubdomain(name: string): string {
  if (!name || !name.trim()) {
    return `page-${uuidv4().slice(0, 8)}`;
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  if (!slug) {
    return `page-${uuidv4().slice(0, 8)}`;
  }

  return slug.slice(0, 63);
}

/**
 * Validate a subdomain string (alphanumeric + hyphens, 1-63 chars).
 */
function validateSubdomain(subdomain: string): void {
  if (!subdomain || subdomain.length === 0) {
    throw new Error("Invalid subdomain: cannot be empty");
  }
  if (subdomain.length > 63) {
    throw new Error("Invalid subdomain: exceeds 63 character limit");
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
    throw new Error(
      "Invalid subdomain: must contain only lowercase letters, numbers, and hyphens"
    );
  }
}

/**
 * Validate a custom domain format.
 */
function validateDomain(domain: string): void {
  // Basic domain validation: must have at least one dot, no spaces
  const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)+$/;
  if (!domain || !domainRegex.test(domain)) {
    throw new Error(
      "Invalid domain: must be a valid domain name (e.g., landing.example.com)"
    );
  }
}

async function getVercelHeaders(): Promise<Record<string, string>> {
  const token = await getVercelToken();
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Add a subdomain (e.g., mysite.agentwebforms.com) to a Vercel project.
 */
export async function addSubdomain(
  userId: string,
  vercelProjectId: string,
  subdomain: string
): Promise<CustomDomainRecord> {
  // Sanitize input
  const cleanSubdomain = subdomain.toLowerCase().trim();
  validateSubdomain(cleanSubdomain);

  const headers = await getVercelHeaders();

  // Try to add domain to Vercel project, retrying with a random suffix on conflict (409)
  let finalSubdomain = cleanSubdomain;
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const fullDomain = `${finalSubdomain}.${SUBDOMAIN_BASE}`;
    try {
      await axios.post(
        `${VERCEL_API_BASE}/v10/projects/${vercelProjectId}/domains`,
        { name: fullDomain },
        { headers }
      );
      break; // Success — exit loop
    } catch (err: any) {
      const isConflict = err.response?.status === 409;
      if (isConflict) {
        // Check if this domain is already on the same project — if so, treat as success
        try {
          await axios.get(
            `${VERCEL_API_BASE}/v9/projects/${vercelProjectId}/domains/${fullDomain}`,
            { headers }
          );
          // Domain exists on this project — no need to retry with a suffix
          break;
        } catch {
          // Domain is on a different project — retry with a suffix
        }
        if (attempt < MAX_RETRIES) {
          const suffix = Math.random().toString(16).slice(2, 6);
          finalSubdomain = `${cleanSubdomain}-${suffix}`.slice(0, 63);
          continue;
        }
      }
      throw err; // Not a conflict or out of retries — propagate
    }
  }

  const fullDomain = `${finalSubdomain}.${SUBDOMAIN_BASE}`;

  const now = new Date().toISOString();
  const record: CustomDomainRecord = {
    id: uuidv4(),
    userId,
    domain: fullDomain,
    type: "subdomain",
    status: "active", // Subdomains are active immediately (DNS is pre-configured)
    vercelProjectId,
    createdAt: now,
    updatedAt: now,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  return record;
}

/**
 * Add a custom domain to a Vercel project.
 * Returns verification records if DNS hasn't been configured yet.
 */
export async function addCustomDomain(
  userId: string,
  vercelProjectId: string,
  domain: string,
  landingPageId?: string
): Promise<CustomDomainRecord> {
  const cleanDomain = domain.toLowerCase().trim();
  validateDomain(cleanDomain);

  const headers = await getVercelHeaders();

  // Add domain to Vercel project
  const response = await axios.post(
    `${VERCEL_API_BASE}/v10/projects/${vercelProjectId}/domains`,
    { name: cleanDomain },
    { headers }
  );

  const vercelData = response.data as any;
  const isVerified = vercelData.verified === true;

  const now = new Date().toISOString();
  const record: CustomDomainRecord = {
    id: uuidv4(),
    userId,
    domain: cleanDomain,
    type: "custom",
    status: isVerified ? "active" : "pending_verification",
    vercelProjectId,
    ...(landingPageId ? { landingPageId } : {}),
    verificationRecords: isVerified
      ? undefined
      : vercelData.verification?.map((v: any) => ({
          type: v.type,
          domain: v.domain,
          value: v.value,
        })),
    createdAt: now,
    updatedAt: now,
  };

  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();

  return record;
}

/**
 * Remove a domain from both Vercel and DynamoDB.
 */
export async function removeDomain(
  domainId: string,
  userId: string
): Promise<void> {
  // Fetch the record first
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { id: domainId } })
    .promise();

  const record = result.Item as CustomDomainRecord | undefined;
  if (!record || record.userId !== userId) {
    throw new Error("Domain not found");
  }

  const headers = await getVercelHeaders();

  // Remove from Vercel
  try {
    await axios.delete(
      `${VERCEL_API_BASE}/v9/projects/${record.vercelProjectId}/domains/${record.domain}`,
      { headers }
    );
  } catch (err: any) {
    // If Vercel already removed it (404), that's fine
    if (err.response?.status !== 404) {
      console.error(
        `[CUSTOM DOMAINS] Failed to remove domain from Vercel: ${err.message}`
      );
    }
  }

  // Delete from DynamoDB
  await dynamodb.delete({ TableName: TABLE_NAME, Key: { id: domainId } }).promise();
}

/**
 * List all domains for a user, optionally filtered by Vercel project.
 */
export async function listDomains(
  userId: string,
  vercelProjectId?: string
): Promise<CustomDomainRecord[]> {
  let params: AWS.DynamoDB.DocumentClient.QueryInput;

  if (vercelProjectId) {
    // Use a filter expression on both userId and vercelProjectId
    params = {
      TableName: TABLE_NAME,
      IndexName: "userId-index",
      KeyConditionExpression: "userId = :userId",
      FilterExpression: "vercelProjectId = :projectId",
      ExpressionAttributeValues: {
        ":userId": userId,
        ":projectId": vercelProjectId,
      },
    };
  } else {
    params = {
      TableName: TABLE_NAME,
      IndexName: "userId-index",
      KeyConditionExpression: "userId = :userId",
      ExpressionAttributeValues: {
        ":userId": userId,
      },
    };
  }

  const result = await dynamodb.query(params).promise();
  return (result.Items || []) as CustomDomainRecord[];
}

/**
 * Get a single domain by ID, scoped to user.
 */
export async function getDomain(
  domainId: string,
  userId: string
): Promise<CustomDomainRecord | null> {
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { id: domainId } })
    .promise();

  const record = result.Item as CustomDomainRecord | undefined;
  if (!record || record.userId !== userId) {
    return null;
  }
  return record;
}

/**
 * Verify a custom domain's DNS configuration via Vercel.
 * Updates the record status if verification succeeds.
 */
export async function verifyDomain(
  domainId: string,
  userId: string
): Promise<{
  verified: boolean;
  status: string;
  verificationRecords?: VerificationRecord[];
  record: CustomDomainRecord;
}> {
  const result = await dynamodb
    .get({ TableName: TABLE_NAME, Key: { id: domainId } })
    .promise();

  const record = result.Item as CustomDomainRecord | undefined;
  if (!record || record.userId !== userId) {
    throw new Error("Domain not found");
  }

  const headers = await getVercelHeaders();

  // Check domain status on Vercel
  const response = await axios.get(
    `${VERCEL_API_BASE}/v9/projects/${record.vercelProjectId}/domains/${record.domain}`,
    { headers }
  );

  const vercelData = response.data as any;
  const isVerified = vercelData.verified === true;
  const now = new Date().toISOString();

  if (isVerified && record.status !== "active") {
    // Update DynamoDB to active
    await dynamodb
      .update({
        TableName: TABLE_NAME,
        Key: { id: domainId },
        UpdateExpression:
          "SET #status = :status, updatedAt = :updatedAt REMOVE verificationRecords",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":status": "active",
          ":updatedAt": now,
        },
      })
      .promise();
    record.status = "active";
    record.updatedAt = now;
    delete record.verificationRecords;
  } else if (isVerified) {
    // Already active on prior verify; mirror in-memory invariants without rewriting DB.
    delete record.verificationRecords;
  }

  return {
    verified: isVerified,
    status: isVerified ? "active" : "pending_verification",
    verificationRecords: isVerified
      ? undefined
      : vercelData.verification?.map((v: any) => ({
          type: v.type,
          domain: v.domain,
          value: v.value,
        })),
    record,
  };
}
