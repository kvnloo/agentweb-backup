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

  /**
   * Whether the domain actually SERVES, written by the hourly reachability sweep (ENG-1839).
   *
   * Deliberately separate from `status`. That field is the Vercel VERIFICATION state, owned by
   * addCustomDomain / addSubdomain / verifyDomain, and `getProjectDomain` selects on it — so
   * writing a reachability verdict there makes a live custom domain render as "not configured"
   * in the portal after a few transient 5xx responses from the customer's own site.
   */
  reachabilityStatus?: "reachable" | "unreachable";
  reachabilityError?: string;
  lastReachabilityCheckAt?: string;
  /** Consecutive non-reachable probes. A success resets it to 0. */
  consecutiveFailures?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Conservative FQDN ceiling for certificate issuance.
 *
 * MEASURED (ENG-1839): FQDNs of 28/34/57/59 characters serve fine; two separate 77-character
 * FQDNs fail the TLS handshake outright while DNS resolves. No existing subdomain falls
 * between 60 and 76, so the true boundary is somewhere in that gap and is NOT pinned.
 *
 * 64 is chosen because it is the X.509 Common Name upper bound (RFC 5280) and is consistent
 * with every observation — but treat that as a working hypothesis, not an established cause.
 * Let's Encrypt omits the CN for long names and relies on SAN, which would argue against it,
 * so the real constraint may lie elsewhere in Vercel's issuance path.
 *
 * Erring low is deliberate. Rejecting a name that would have worked produces a clear,
 * immediate, recoverable error; accepting one that does not produces a silently unreachable
 * page whose record still reads `deployed` — the failure this ticket exists to stop, and one
 * that went unnoticed on live customer sites for months.
 *
 * If the boundary is ever measured properly, raise this and keep the asymmetry.
 */
const MAX_CERT_CN_LENGTH = 64;
const MAX_DNS_LABEL_LENGTH = 63;

/**
 * Longest label that still yields a certifiable FQDN under `base`.
 *
 * Parameterised because the base is NOT always SUBDOMAIN_BASE: setPageSubdomain issues certs
 * under the customer's own domain. Validating that path against SUBDOMAIN_BASE would both
 * miss over-length FQDNs on long customer domains and falsely reject legal ones on short
 * domains, with an error naming a domain the user never mentioned.
 *
 * Math.max(1, …) matters: a base of 63+ characters drives the CN term to zero or negative,
 * and a negative length would flow into String.slice, which treats it as an offset from the
 * end rather than erroring — silently producing a leading-hyphen label.
 */
function maxLabelLengthFor(base: string): number {
  return Math.max(
    1,
    Math.min(MAX_DNS_LABEL_LENGTH, MAX_CERT_CN_LENGTH - 1 - base.length)
  );
}

/** The ceiling for MANAGED subdomains (SUBDOMAIN_BASE). Other bases: maxLabelLengthFor. */
export const MAX_SUBDOMAIN_LABEL_LENGTH = maxLabelLengthFor(SUBDOMAIN_BASE);

/**
 * Truncate a label to `max`, dropping any trailing hyphen the cut leaves behind — a trailing
 * hyphen is rejected by validateSubdomain's own pattern.
 */
function truncateLabel(label: string, max: number = MAX_SUBDOMAIN_LABEL_LENGTH): string {
  return label.slice(0, Math.max(0, max)).replace(/-+$/, "");
}

/**
 * Generate a clean subdomain slug from a brand/page name.
 * Strips special characters, lowercases, and truncates to a length whose FQDN can be
 * certificated (see MAX_SUBDOMAIN_LABEL_LENGTH).
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

  return truncateLabel(slug) || `page-${uuidv4().slice(0, 8)}`;
}

/**
 * Validate a subdomain string (alphanumeric + hyphens, length bounded so the resulting
 * FQDN can actually receive a certificate).
 */
function validateSubdomain(subdomain: string, base: string = SUBDOMAIN_BASE): void {
  if (!subdomain || subdomain.length === 0) {
    throw new Error("Invalid subdomain: cannot be empty");
  }
  // Charset before length: a name typed with spaces or punctuation is the common mistake, and
  // reporting it as a length problem sends the user to fix the wrong thing.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
    throw new Error(
      "Invalid subdomain: must contain only lowercase letters, numbers, and hyphens"
    );
  }
  const maxLabel = maxLabelLengthFor(base);
  if (subdomain.length > maxLabel) {
    const fqdnLength = subdomain.length + 1 + base.length;
    // Bound the echo — this message is returned to the browser and logged, and the raw value
    // is unbounded user input.
    const shown = subdomain.length > 80 ? `${subdomain.slice(0, 80)}…` : subdomain;
    throw new Error(
      `Invalid subdomain: "${shown}.${base}" is ${fqdnLength} characters. ` +
        `Names above ${MAX_CERT_CN_LENGTH} characters have failed SSL certificate issuance, ` +
        `which leaves the site unreachable. Use at most ${maxLabel} characters.`
    );
  }
}

/**
 * Validate a custom domain format.
 */
/**
 * AgentWeb's own domains (the API's CORS list and the trusted report hosts). A customer can never attach one of these, or a host under
 * one, as a custom domain: every customer project lives in AgentWeb's own Vercel team, so Vercel reports a host under a domain the team
 * already holds as verified with no proof from the customer (and *.agentwebforms.com DNS already points at Vercel). Managed subdomains
 * (addSubdomain) and page subdomains (setPageSubdomain, which needs an attached main domain) do not come through here.
 */
export const RESERVED_PLATFORM_DOMAINS: readonly string[] = Object.freeze(['agentweb.pro', SUBDOMAIN_BASE, 'hireemma.ai']);

export function isReservedPlatformDomain(host: string): boolean {
  const h = String(host ?? '').toLowerCase().trim().replace(/\.+$/, '');
  return RESERVED_PLATFORM_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

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
          // Truncate the BASE to leave room for the suffix, rather than truncating the
          // joined string — the latter can cut into the suffix and destroy the uniqueness
          // it exists to provide, or leave a trailing hyphen that validateSubdomain rejects.
          // padEnd: Math.random() can yield a short or empty fractional part ((0).toString(16)
          // is "0", so .slice(2,6) is ""), which would otherwise emit a trailing hyphen.
          const suffix = Math.random().toString(16).slice(2, 6).padEnd(4, "0");
          const stem = truncateLabel(
            cleanSubdomain,
            MAX_SUBDOMAIN_LABEL_LENGTH - suffix.length - 1
          );
          finalSubdomain = stem ? `${stem}-${suffix}` : suffix;
          // Assert the rebuilt label BEFORE the next iteration hands it to Vercel. Validating
          // after the loop would run only once the POST had already succeeded, so a throw
          // would leave the domain attached to the project with no record written for it.
          validateSubdomain(finalSubdomain);
          continue;
        }
      }
      throw err; // Not a conflict or out of retries — propagate
    }
  }

  const fullDomain = `${finalSubdomain}.${SUBDOMAIN_BASE}`;

  // Reuse an existing record for this user+domain rather than writing a second row, matching
  // addCustomDomain. Without this, any re-add of the same host — a retried repair run, a
  // re-assignment after a partial failure — silently created a duplicate, and duplicates
  // perturb both `bestByOwnerProject` tie-breaking in the landing-pages list route and
  // `getProjectSubdomain`'s `find`, so which row wins becomes arbitrary.
  const existing = (await listDomains(userId, vercelProjectId)).find(
    (d) => d.type === "subdomain" && d.domain === fullDomain
  );

  const now = new Date().toISOString();
  const record: CustomDomainRecord = {
    id: existing?.id ?? uuidv4(),
    userId,
    domain: fullDomain,
    type: "subdomain",
    status: "active", // Subdomains are active immediately (DNS is pre-configured)
    vercelProjectId,
    // Carry reachability forward: it is owned by the sweep, and a re-add of the same host must
    // not silently reset a known-unreachable domain to looking unmonitored.
    reachabilityStatus: existing?.reachabilityStatus,
    reachabilityError: existing?.reachabilityError,
    lastReachabilityCheckAt: existing?.lastReachabilityCheckAt,
    consecutiveFailures: existing?.consecutiveFailures,
    createdAt: existing?.createdAt ?? now,
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
  // Refused before anything reaches Vercel. "Invalid" makes the route answer 400.
  if (isReservedPlatformDomain(cleanDomain)) {
    throw new Error(`Invalid domain: ${cleanDomain} is an AgentWeb domain and cannot be used as a custom domain. Use a domain you own.`);
  }

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
    // Carry reachability forward, exactly as addSubdomain does. This is a full-item put, so
    // omitting these ERASES them: a customer re-adding an already-confirmed-unreachable domain
    // would clear the warning and reset the failure count to zero, hiding a known-bad state
    // behind an ordinary user action.
    reachabilityStatus: existing?.reachabilityStatus,
    reachabilityError: existing?.reachabilityError,
    lastReachabilityCheckAt: existing?.lastReachabilityCheckAt,
    consecutiveFailures: existing?.consecutiveFailures,
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
  // Validate against the domain the cert will actually cover, not SUBDOMAIN_BASE — this path
  // issues under the customer's own `mainDomain`.
  validateSubdomain(cleanPrefix, mainDomain);

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
