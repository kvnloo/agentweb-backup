/**
 * ENG-2523: read-only operator readback for the ENG-1922 Search serving-chain verifier.
 *
 * Thin wrapper around the production `googleAdsService.getServingChainStatus` — no chain
 * logic lives here. Emits one JSON summary (IDs, states, blockers, TODAY telemetry) and maps
 * the verdict to an exit code. Raw Google readback (ads/keywords/campaign objects) is never
 * printed, and any token-shaped string is redacted, so output is safe to paste into Linear.
 *
 * Entry point: backend/scripts/verify-google-ads-serving-chain.ts
 */
import type { GoogleAdsServingReport, GoogleAdsServingState } from './googleAdsService';

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NOT_SERVING = 2;

export interface ServingChainVerifier {
  getServingChainStatus(userId: string, customerId: string, campaignIds?: string[]): Promise<GoogleAdsServingReport>;
}

export interface ServingChainCliArgs {
  userId: string;
  customerId: string;
  campaignIds?: string[];
}

export const USAGE = 'usage: verify-google-ads-serving-chain --user-id <id> --customer-id <google ads id> [--campaign-id <id>]...';

export function parseServingChainArgs(argv: string[]): ServingChainCliArgs {
  let userId: string | undefined;
  let customerId: string | undefined;
  const campaignIds: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    const value = inline !== undefined ? inline : argv[++i];
    if (value === undefined || value === '' || (inline === undefined && value.startsWith('-'))) throw new Error(`missing value for ${flag}`);
    if (flag === '--user-id') userId = value;
    else if (flag === '--customer-id') customerId = value.replace(/-/g, '');
    else if (flag === '--campaign-id') campaignIds.push(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!userId || !customerId) throw new Error('--user-id and --customer-id are required');
  return { userId, customerId, ...(campaignIds.length ? { campaignIds } : {}) };
}

// OAuth access/refresh tokens, JWTs and Bearer headers. Numeric Google Ads IDs never match.
const SECRET_PATTERNS = [/Bearer\s+[\w.~+/=-]+/gi, /ya29\.[\w.-]+/g, /1\/\/[\w.-]{10,}/g, /eyJ[\w-]+\.[\w-]+\.[\w-]+/g];
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((out, re) => out.replace(re, '[REDACTED]'), text);
}

export function summarizeServingReport(report: GoogleAdsServingReport) {
  return {
    verdict: report.state,
    customerId: report.customerId,
    checkedAt: report.checkedAt,
    timeZone: report.timeZone,
    currency: report.currency,
    window: report.window,
    blockers: report.blockers,
    campaigns: report.campaigns.map(c => ({
      campaignId: c.campaignId,
      budgetId: (c.budget as { id?: string } | undefined)?.id ?? null,
      state: c.state,
      blockers: c.blockers,
      adGroups: c.adGroups.map(g => ({
        adGroupId: g.adGroupId,
        state: g.state,
        blockers: g.blockers,
        adIds: g.ads.map((a: any) => a?.ad?.id).filter(Boolean),
        keywordIds: g.keywords.map((k: any) => k?.criterionId).filter(Boolean),
        telemetry: g.telemetry,
      })),
    })),
  };
}

export function exitCodeFor(state: GoogleAdsServingState): number {
  return state === 'DELIVERING' || state === 'READY' ? EXIT_OK : EXIT_NOT_SERVING;
}

/** JSON with every string value redacted (redacting serialized text could break quoting). */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === 'string' ? redact(v) : v));
}

export async function runServingChainCli(
  argv: string[],
  verifier: ServingChainVerifier,
  out: (line: string) => void = line => process.stdout.write(`${line}\n`),
): Promise<number> {
  try {
    const args = parseServingChainArgs(argv);
    const report = await verifier.getServingChainStatus(args.userId, args.customerId, args.campaignIds);
    out(safeJson(summarizeServingReport(report)));
    return exitCodeFor(report.state);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out(safeJson({ verdict: 'ERROR', error: message, usage: USAGE }));
    return EXIT_ERROR;
  }
}
