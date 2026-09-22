/**
 * ENG-1238: register an already-deployed canonical URL as an imported Landing Pages
 * record — no generation, no clone, no deploy, no site mutation.
 *
 * Pure record-creation over the AW-LandingPages table via the caller's own userId
 * partition: the record carries sourceType 'external' + canonicalUrl + repo/project
 * reference + leadListId, reads as deployed, and is excluded from every build,
 * deploy, poller, janitor, and reachability path (those key on status/siteId/
 * v0/vercel fields the imported record never sets).
 */
import AWS from "aws-sdk";
import { randomUUID } from "crypto";

const dynamodb = new AWS.DynamoDB.DocumentClient({
  region: process.env.AWS_REGION || "us-west-2",
  httpOptions: { timeout: 30_000, connectTimeout: 5_000 },
});

const TABLE_PREFIX = process.env.NODE_ENV === "development" ? "Dev-" : "";
const TABLE_NAME = `${TABLE_PREFIX}AW-LandingPages`;

export interface RegisterExternalLandingPageInput {
  userId: string;
  name: string;
  canonicalUrl: string;
  context?: string;
  repoRef?: string;
  projectRef?: string;
  leadListId?: string;
}

export interface RegisterExternalLandingPageResult {
  ok: true;
  page: {
    id: string;
    userId: string;
    name: string;
    status: "deployed";
    sourceType: "external";
    canonicalUrl: string;
    context?: string;
    repoRef?: string;
    projectRef?: string;
    leadListId?: string;
    deployedUrl: string;
  };
}

export class ExternalLandingPageValidationError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "ExternalLandingPageValidationError";
    this.reason = reason;
  }
}

/** Normalize + validate a canonical URL. Returns the normalized form. */
export function normalizeCanonicalUrl(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new ExternalLandingPageValidationError("canonicalUrl is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new ExternalLandingPageValidationError("canonicalUrl is not a valid URL");
  }
  if (parsed.protocol !== "https:") {
    throw new ExternalLandingPageValidationError("canonicalUrl must be an https URL");
  }
  if (!parsed.hostname.includes(".")) {
    throw new ExternalLandingPageValidationError("canonicalUrl host is not valid");
  }
  // Normalize: lowercase host (preserve non-default port), drop trailing slash (root) only for dedup.
  const normalized =
    `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ""}` +
    (parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "")) +
    (parsed.search || "") +
    (parsed.hash || "");
  return normalized;
}

/** Validate display name. Returns the trimmed name. */
export function normalizeExternalPageName(raw: string): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) {
    throw new ExternalLandingPageValidationError("name is required");
  }
  if (trimmed.length > 200) {
    throw new ExternalLandingPageValidationError("name must be 200 characters or fewer");
  }
  return trimmed;
}

/**
 * Build the DynamoDB record for an externally-deployed page. Pure function of
 * (input, id, now) — no I/O — so the no-deploy/no-clone/no-side-effect contract
 * is unit-testable without AWS.
 *
 * Deliberately omits every build/deploy field (v0ProjectId, v0ChatId,
 * vercelProjectId, githubRepoUrl, templateHtml, siteId, originatingSessionId,
 * iterations behavior): status 'deployed' + sourceType 'external' is the full
 * identity, and build/deploy/poller/janitor paths never match a record without
 * those fields.
 */
export function buildExternalLandingPageRecord(
  input: RegisterExternalLandingPageInput,
  id: string,
  now: string
): Record<string, any> {
  const name = normalizeExternalPageName(input.name);
  const canonicalUrl = normalizeCanonicalUrl(input.canonicalUrl);
  const boundedContext = input.context?.trim().slice(0, 2000);
  const record: Record<string, any> = {
    id,
    userId: input.userId,
    name,
    prompt: boundedContext ? `Imported externally-deployed page: ${boundedContext}` : "Imported externally-deployed page",
    status: "deployed",
    sourceType: "external",
    canonicalUrl,
    deployedUrl: canonicalUrl,
    createdAt: now,
    updatedAt: now,
  };
  if (input.context?.trim()) record.context = input.context.trim().slice(0, 2000);
  if (input.repoRef?.trim()) record.repoRef = input.repoRef.trim().slice(0, 300);
  if (input.projectRef?.trim()) record.projectRef = input.projectRef.trim().slice(0, 300);
  if (input.leadListId?.trim()) record.leadListId = input.leadListId.trim();
  return record;
}

/**
 * True when a stored page record is an externally-imported page (ENG-1238).
 * Build/deploy/poller/janitor/reachability code paths use this to skip
 * imported records that have no build behind them.
 */
export function isExternalLandingPageRecord(page: { sourceType?: string }): boolean {
  return (page as { sourceType?: string }).sourceType === "external";
}

/**
 * Persist an externally-deployed page record — a single PutItem, no generation,
 * no clone, no deploy, no site/repo mutation. Idempotency is caller-managed via
 * the returned id (UUID per call); duplicate canonical URLs are allowed as
 * separate records so re-registration never overwrites an existing row.
 */
export async function registerExternalLandingPage(
  input: RegisterExternalLandingPageInput
): Promise<RegisterExternalLandingPageResult> {
  if (!input.userId?.trim()) {
    throw new ExternalLandingPageValidationError("userId is required");
  }
  const now = new Date().toISOString();
  const record = buildExternalLandingPageRecord(input, randomUUID(), now);
  await dynamodb.put({ TableName: TABLE_NAME, Item: record }).promise();
  return {
    ok: true,
    page: {
      id: record.id,
      userId: record.userId,
      name: record.name,
      status: "deployed",
      sourceType: "external",
      canonicalUrl: record.canonicalUrl,
      context: record.context,
      repoRef: record.repoRef,
      projectRef: record.projectRef,
      leadListId: record.leadListId,
      deployedUrl: record.deployedUrl,
    },
  };
}
