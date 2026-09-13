import { computeShiftDays } from './dateShift';
import { fbtraceId, GraphError, graphErrors } from './graphError';
import { handleGraphRead } from './graphReads';
import { handleGraphWrite } from './metaWriteSimulator';
import { createInsightsReport, parseInsightsParams } from './insightsEngine';
import type { SandboxDataset, SandboxOverlay, SimRequest, SimResponse } from './types';
import type { SandboxOverlayAudit } from './sandboxOverlayStore';

/**
 * The simulator router (ENG-1908/ENG-1909). Given a parsed Graph request for a sandbox
 * principal it resolves policy → dataset → overlay, answers reads from graphReads, runs the
 * async insights POST, dispatches everything else to the write simulator, and never throws:
 * every failure is a Graph error envelope with the headers the product's Meta callers read.
 */
export interface SandboxPolicyRef { datasetId: string; datasetVersion: number }

export interface MetaSimulatorDeps {
  /** Active policy for the principal, or null when revoked/expired/unknown → 190. */
  loadPolicy(userId: string): Promise<SandboxPolicyRef | null>;
  loadDataset(datasetId: string, version: number): Promise<SandboxDataset>;
  loadOverlay(userId: string): Promise<SandboxOverlay>;
  /**
   * Phase 3 (ENG-1909): applies a write to the account's overlay under its CAS guard.
   * Optional so a read-only test harness (or a real deps object built before phase 3, none
   * exist) can omit it — every write attempt without it is graphErrors.sandboxWrite, the same
   * refusal phase 2 shipped with.
   */
  mutateOverlay?(userId: string, mutate: (current: SandboxOverlay) => SandboxOverlay, audit?: SandboxOverlayAudit): Promise<SandboxOverlay>;
  now?: () => Date;
}

export interface MetaSimulator { handle(req: SimRequest): Promise<SimResponse> }

function usageHeaders(accountId: string | null): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-fb-trace-id': fbtraceId(), 'x-fb-rev': '1010000000' };
  if (accountId) {
    headers['x-business-use-case-usage'] = JSON.stringify({ [accountId]: [{ type: 'ads_management', call_count: 1, total_cputime: 1, total_time: 1, estimated_time_to_regain_access: 0 }] });
  }
  return headers;
}

/** Params for a write-shaped request live in the form body, the JSON body, or the query. */
function requestParams(req: SimRequest): Record<string, unknown> {
  const json = req.json && typeof req.json === 'object' && !Array.isArray(req.json) ? (req.json as Record<string, unknown>) : {};
  return { ...req.query, ...json, ...(req.form ?? {}), ...(req.multipart?.fields ?? {}) };
}

export function createMetaSimulator(deps: MetaSimulatorDeps): MetaSimulator {
  const clock = deps.now ?? (() => new Date());
  return {
    async handle(req: SimRequest): Promise<SimResponse> {
      let accountId: string | null = null;
      try {
        const now = clock();
        const policy = await deps.loadPolicy(req.userId);
        if (!policy) throw graphErrors.invalidToken();
        const dataset = await deps.loadDataset(policy.datasetId, policy.datasetVersion);
        const overlay = await deps.loadOverlay(req.userId);
        accountId = dataset.account.account_id;
        const shift = computeShiftDays(dataset.meta.frozenWindow.until, now);
        const ctx = { dataset, overlay, shift, now, userId: req.userId, token: req.token };

        const read = handleGraphRead(ctx, req);
        if (read) return { ...read, headers: { ...usageHeaders(accountId), ...read.headers } };

        if (req.method === 'GET') throw graphErrors.unsupportedGet(req.path);

        // Async insights: POST /<node>/insights → report_run_id (rows are read back via graphReads).
        const segments = req.path.split('/');
        if (req.method === 'POST' && segments.length === 2 && segments[1] === 'insights') {
          const params = parseInsightsParams(requestParams(req), insightsNodeFor(segments[0], dataset));
          return { status: 200, headers: usageHeaders(accountId), body: JSON.stringify(createInsightsReport(dataset, overlay, params, shift, now)) };
        }

        if (deps.mutateOverlay) {
          const mutate = (fn: (current: SandboxOverlay) => SandboxOverlay, audit?: SandboxOverlayAudit) => deps.mutateOverlay!(req.userId, fn, audit);
          const write = await handleGraphWrite(ctx, req, mutate);
          if (write) return { ...write, headers: { ...usageHeaders(accountId), ...write.headers } };
        }

        throw graphErrors.sandboxWrite(req.path);
      } catch (error) {
        if (error instanceof GraphError) return error.toResponse(usageHeaders(accountId));
        console.error('[metaSimulator] unexpected failure', { path: req.path, method: req.method, userId: req.userId, error });
        return graphErrors.unknown().toResponse(usageHeaders(accountId));
      }
    },
  };
}

function insightsNodeFor(head: string, dataset: SandboxDataset): Parameters<typeof parseInsightsParams>[1] {
  if (head.startsWith('act_')) {
    if (head !== dataset.account.id) throw graphErrors.unsupportedGet(head);
    return { kind: 'account', id: dataset.account.account_id };
  }
  if (dataset.campaigns.some((c) => c.id === head)) return { kind: 'campaign', id: head };
  if (dataset.adsets.some((a) => a.id === head)) return { kind: 'adset', id: head };
  if (dataset.ads.some((a) => a.id === head)) return { kind: 'ad', id: head };
  throw graphErrors.unsupportedGet(head);
}
