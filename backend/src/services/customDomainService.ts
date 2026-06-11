import { v4 as uuidv4 } from "uuid";
import AWS from "aws-sdk";
import axios from "axios";
import { getVercelToken } from "../utils/secretsManager";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-CustomDomains`;
const LANDING_PAGES_TABLE = `${TABLE_PREFIX}AW-LandingPages`;

export const SUBDOMAIN_BASE = "agentwebforms.com";
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

/**
 * Check whether a domain's DNS is actually pointed at Vercel.
 *
 * Vercel's `verified` flag (returned when adding a domain or fetching the
 * project-domain object) only reflects domain *ownership* — it comes back
 * `true` as soon as no other Vercel account contests the domain, even when the
 * customer has not added any A/CNAME records yet. The signal that the domain is
 * genuinely reachable is the `misconfigured` flag from the domain config
 * endpoint: `misconfigured: false` means the DNS records resolve to Vercel.
 *
 * Returns `true` (treat as misconfigured / not yet reachable) on any error, so
 * we never mark a domain active without positive confirmation that DNS is set.
 */
async function isDomainMisconfigured(
  domain: string,
  headers: Record<string, string>
): Promise<boolean> {
  try {
    const res = await axios.get(
      `${VERCEL_API_BASE}/v6/domains/${domain}/config`,
      { headers }
    );
    return (res.data as any)?.misconfigured === true;
  } catch {
    return true;
  }
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
  domain: string
): Promise<CustomDomainRecord> {
  const cleanDomain = domain.toLowerCase().trim();
  validateDomain(cleanDomain);

  const headers = await getVercelHeaders();

  // Add domain to Vercel project. A 409 means the domain already exists on
  // Vercel — if it's already on THIS project (e.g. a prior add, or a disconnect
  // whose Vercel delete silently failed) we treat that as success and read its
  // current state instead of erroring. If it's on a different project, the 409
  // propagates so the user sees "already in use on another project".
  let vercelData: any;
  try {
    const response = await axios.post(
      `${VERCEL_API_BASE}/v10/projects/${vercelProjectId}/domains`,
      { name: cleanDomain },
      { headers }
    );
    vercelData = response.data;
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    // Already exists — confirm it's on this project by fetching it. If the GET
    // fails, the domain is on a different project (or otherwise unavailable):
    // re-throw the original 409 so the caller still sees the conflict.
    try {
      const existing = await axios.get(
        `${VERCEL_API_BASE}/v9/projects/${vercelProjectId}/domains/${cleanDomain}`,
        { headers }
      );
      vercelData = existing.data;
    } catch {
      throw err;
    }
  }

  const isVerified = vercelData.verified === true;

  // `verified` alone only proves domain ownership — Vercel returns it `true`
  // even before the customer adds any DNS records. The domain is only truly
  // reachable once its DNS resolves to Vercel (misconfigured === false), so we
  // require BOTH before marking it active. Otherwise the domain stays
  // pending_verification and we surface the DNS records the user must add.
  const misconfigured = isVerified
    ? await isDomainMisconfigured(cleanDomain, headers)
    : true;
  const isActive = isVerified && !misconfigured;

  // Reuse an existing record for this user+domain if one is already stored, so
  // a re-add (e.g. after a 409) updates in place rather than creating a
  // duplicate row in DynamoDB.
  const existingRecords = await listDomains(userId, vercelProjectId);
  const existing = existingRecords.find(
    (d) => d.type === "custom" && d.domain === cleanDomain
  );

  const now = new Date().toISOString();
  const record: CustomDomainRecord = {
    id: existing?.id ?? uuidv4(),
    userId,
    domain: cleanDomain,
    type: "custom",
    status: isActive ? "active" : "pending_verification",
    vercelProjectId,
    verificationRecords: isActive
      ? undefined
      : vercelData.verification?.map((v: any) => ({
          type: v.type,
          domain: v.domain,
          value: v.value,
        })),
    createdAt: existing?.createdAt ?? now,
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

  // Cascade: clear per-page subdomains that were under this domain
  try {
    const scanResult = await dynamodb.scan({
      TableName: LANDING_PAGES_TABLE,
      FilterExpression: "vercelProjectId = :pid AND attribute_exists(subdomainPrefix)",
      ExpressionAttributeValues: { ":pid": record.vercelProjectId },
    }).promise();

    const pages = (scanResult.Items || []) as Array<{
      id: string;
      subdomainPrefix?: string;
      customDomainUrl?: string;
    }>;

    await Promise.all(
      pages
        .filter((p) => p.customDomainUrl?.includes(record.domain))
        .map(async (p) => {
          // Remove the subdomain from Vercel (best-effort)
          if (p.subdomainPrefix) {
            try {
              await axios.delete(
                `${VERCEL_API_BASE}/v9/projects/${record.vercelProjectId}/domains/${p.subdomainPrefix}.${record.domain}`,
                { headers }
              );
            } catch {
              // Ignore 404 — already removed
            }
          }
          // Clear the fields from DynamoDB
          await dynamodb.update({
            TableName: LANDING_PAGES_TABLE,
            Key: { id: p.id },
            UpdateExpression: "REMOVE subdomainPrefix, customDomainUrl",
          }).promise();
        })
    );
  } catch (err: any) {
    console.error("[CUSTOM DOMAINS] Failed to cascade page-subdomain cleanup:", err?.message);
  }
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
): Promise<{ verified: boolean; status: string; verificationRecords?: VerificationRecord[] }> {
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

  // Ownership-verified is not enough — confirm the DNS records actually resolve
  // to Vercel (misconfigured === false) before marking the domain active.
  const misconfigured = isVerified
    ? await isDomainMisconfigured(record.domain, headers)
    : true;
  const isActive = isVerified && !misconfigured;

  if (isActive && record.status !== "active") {
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
          ":updatedAt": new Date().toISOString(),
        },
      })
      .promise();
  }

  return {
    verified: isActive,
    status: isActive ? "active" : "pending_verification",
    verificationRecords: isActive
      ? undefined
      : vercelData.verification?.map((v: any) => ({
          type: v.type,
          domain: v.domain,
          value: v.value,
        })),
  };
}

/**
 * Get the active custom domain (type="custom", status="active") for a Vercel project.
 * Returns null if the project has no verified custom domain yet.
 */
export async function getProjectDomain(
  userId: string,
  vercelProjectId: string
): Promise<CustomDomainRecord | null> {
  const domains = await listDomains(userId, vercelProjectId);
  return (
    domains.find((d) => d.type === "custom" && d.status === "active") ??
    domains.find((d) => d.type === "custom" && d.status === "pending_verification") ??
    null
  );
}

/**
 * Get the active subdomain (type="subdomain") record for a Vercel project.
 * Returns null if the project has no subdomain set yet.
 */
export async function getProjectSubdomain(
  userId: string,
  vercelProjectId: string
): Promise<CustomDomainRecord | null> {
  const domains = await listDomains(userId, vercelProjectId);
  return domains.find((d) => d.type === "subdomain") ?? null;
}

/**
 * Add `{subdomainPrefix}.{mainDomain}` to the Vercel project.
 * Returns the full domain string (e.g., "pricing.mysite.com").
 * Treats a 409 conflict as success (domain already on this project).
 */
export async function setPageSubdomain(
  userId: string,
  vercelProjectId: string,
  subdomainPrefix: string,
  mainDomain: string
): Promise<{ fullDomain: string }> {
  const cleanPrefix = subdomainPrefix.toLowerCase().trim();
  validateSubdomain(cleanPrefix);

  const fullDomain = `${cleanPrefix}.${mainDomain}`;
  const headers = await getVercelHeaders();

  try {
    await axios.post(
      `${VERCEL_API_BASE}/v10/projects/${vercelProjectId}/domains`,
      { name: fullDomain },
      { headers }
    );
  } catch (err: any) {
    if (err.response?.status !== 409) throw err;
    // Already on this project — treat as success
  }

  return { fullDomain };
}

/**
 * Remove `{fullDomain}` from the Vercel project.
 * Silently ignores 404 (already removed).
 */
export async function removePageSubdomainFromVercel(
  vercelProjectId: string,
  fullDomain: string
): Promise<void> {
  const headers = await getVercelHeaders();
  try {
    await axios.delete(
      `${VERCEL_API_BASE}/v9/projects/${vercelProjectId}/domains/${fullDomain}`,
      { headers }
    );
  } catch (err: any) {
    if (err.response?.status !== 404) throw err;
  }
}
