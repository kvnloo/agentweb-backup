/**
 * ENG-2411 (code half of ENG-2405): post-merge cross-tenant probe for the
 * ENG-2403 project-ownership guard on POST /api/domains/custom.
 *
 * Tenant B attempts to attach a domain to tenant A's Vercel project. The only
 * passing outcome is HTTP 403 — the guard must refuse before any Vercel call,
 * so no domain is ever attached. Any 2xx is a cross-tenant write (FAIL); any
 * other status is unproven (FAIL). Missing fixtures SKIP, never PASS.
 *
 * Env (fixtures are provisioned under ENG-2405, not here):
 *   XTENANT_API_BASE            e.g. https://api.agentweb.pro (no trailing slash)
 *   XTENANT_B_TOKEN             bearer token for tenant B
 *   XTENANT_A_VERCEL_PROJECT_ID vercelProjectId owned by tenant A
 *   XTENANT_PROBE_DOMAIN        optional, defaults to a reserved .invalid name
 *
 * Run: npx ts-node src/verification/crossTenantDomainProbe.ts
 * Exit: 0 PASS, 1 FAIL, 2 SKIP.
 */

export type ProbeVerdict = "PASS" | "FAIL" | "SKIP";

export interface ProbeResult {
  verdict: ProbeVerdict;
  status?: number;
  reason: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ status: number }>;

export const REQUIRED_ENV = [
  "XTENANT_API_BASE",
  "XTENANT_B_TOKEN",
  "XTENANT_A_VERCEL_PROJECT_ID",
] as const;

export const DEFAULT_PROBE_DOMAIN = "eng-2405-xtenant-probe.invalid";

export async function runCrossTenantDomainProbe(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike
): Promise<ProbeResult> {
  const missing = REQUIRED_ENV.filter((k) => !env[k]?.trim());
  if (missing.length > 0) {
    return { verdict: "SKIP", reason: `missing env: ${missing.join(", ")}` };
  }

  const base = env.XTENANT_API_BASE!.trim().replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/api/domains/custom`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.XTENANT_B_TOKEN!.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      vercelProjectId: env.XTENANT_A_VERCEL_PROJECT_ID!.trim(),
      domain: env.XTENANT_PROBE_DOMAIN?.trim() || DEFAULT_PROBE_DOMAIN,
    }),
  });

  if (res.status === 403) {
    return { verdict: "PASS", status: 403, reason: "ownership guard refused cross-tenant attach" };
  }
  if (res.status >= 200 && res.status < 300) {
    return {
      verdict: "FAIL",
      status: res.status,
      reason: "CROSS-TENANT WRITE ACCEPTED: tenant B attached a domain to tenant A's project",
    };
  }
  return {
    verdict: "FAIL",
    status: res.status,
    reason: `expected 403, got ${res.status} (guard not proven; 401 means B's token is invalid)`,
  };
}

const EXIT: Record<ProbeVerdict, number> = { PASS: 0, FAIL: 1, SKIP: 2 };

if (require.main === module) {
  runCrossTenantDomainProbe(process.env, (url, init) => fetch(url, init))
    .then((r) => {
      console.log(`[xtenant-domain-probe] ${r.verdict}${r.status ? ` (${r.status})` : ""}: ${r.reason}`);
      process.exit(EXIT[r.verdict]);
    })
    .catch((e) => {
      console.error(`[xtenant-domain-probe] FAIL: ${e?.message ?? e}`);
      process.exit(1);
    });
}
