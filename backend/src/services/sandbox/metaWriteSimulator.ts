import { shiftIso } from './dateShift';
import { graphErrors } from './graphError';
import { resolveObjects } from './objects';
import type { GraphReadContext } from './graphReads';
import type {
  ObjectStatus, SandboxAd, SandboxAdSet, SandboxCampaign, SandboxCreative, SandboxCustomAudience, SandboxOverlay, SimRequest, SimResponse,
} from './types';
import type { SandboxOverlayAudit } from './sandboxOverlayStore';
import { uploadFileToS3WithPath } from '../../utils/s3Utils';
import { createHash } from 'crypto';

/**
 * Meta Graph WRITE simulation (ENG-1909 AC 1/3). create/update/delete for campaign, adset, ad,
 * adcreative and customaudience, plus /adimages uploads — mutated into the per-account overlay
 * (sandboxOverlayStore.ts) under its existing CAS guard. Returns null for anything this handler
 * does not own (metaSimulator.ts falls through to the phase-2 sandboxWrite refusal for those).
 *
 * ids: a candidate-created object gets a 17-digit id starting with '9' — every seeded id in any
 * compiled dataset or test fixture starts with '1' (the recorder's '1200…' range, the fixture
 * dataset's '12021…' range), so a '9…' id can never collide with a seeded one by construction,
 * regardless of what a future dataset compiler chooses for its own range.
 *
 * timestamps: `now` here is a REAL current instant; the read side (graphReads.ts's Views.t())
 * always shifts a stored timestamp FORWARD by `ctx.shift` days so a frozen date reads as
 * recent. A timestamp for something happening RIGHT NOW must therefore be stored shifted
 * BACKWARD by the same amount, so the read-time forward-shift cancels out and the product sees
 * the real current time — storing `now` unshifted would read back `shift` days in the future.
 */

type Params = Record<string, unknown>;

function requestParams(req: SimRequest): Params {
  const json = req.json && typeof req.json === 'object' && !Array.isArray(req.json) ? (req.json as Params) : {};
  return { ...req.query, ...json, ...(req.form ?? {}), ...(req.multipart?.fields ?? {}) };
}

function str(params: Params, key: string): string | undefined {
  const value = params[key];
  return value === undefined || value === null ? undefined : String(value);
}
function num(params: Params, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw graphErrors.invalidParam(`${key} must be a number`);
  return n;
}
function jsonParam(params: Params, key: string): unknown {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { throw graphErrors.invalidParam(`${key} must be valid JSON`); }
}
const VALID_OBJECT_STATUSES: ReadonlySet<string> = new Set(['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED']);
/** Validates a caller-supplied `status`, falling back (never validating) when it's absent. */
function parseStatus(params: Params, fallback: ObjectStatus): ObjectStatus {
  const value = str(params, 'status');
  if (value === undefined) return fallback;
  if (!VALID_OBJECT_STATUSES.has(value)) throw graphErrors.invalidParam(`status must be one of ACTIVE, PAUSED, DELETED, ARCHIVED (got "${value}")`);
  return value as ObjectStatus;
}
function nextId(overlay: SandboxOverlay): { id: string; overlay: SandboxOverlay } {
  const id = `9${String(overlay.nextId).padStart(16, '0')}`;
  return { id, overlay: { ...overlay, nextId: overlay.nextId + 1 } };
}
function unshiftNow(now: Date, shift: number): string {
  return shiftIso(now.toISOString(), -shift);
}
function unshiftInput(iso: string, shift: number, field: string): string {
  try { return shiftIso(iso, -shift); } catch { throw graphErrors.invalidParam(`${field} is not a valid timestamp`); }
}

const ok = (body: unknown): SimResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

interface WriteTarget {
  /** 'account' when the edge sits under act_<id> (create-under-account); 'node' when it sits
   *  under a specific existing object id (create-under-adset for /ads, or a bare-id update). */
  kind: 'account' | 'node';
  id: string;
  edge?: string;
}
function parsePath(path: string): WriteTarget | null {
  const segments = path.split('/');
  if (segments.length === 1) return { kind: 'node', id: segments[0] };
  if (segments.length === 2) return { kind: segments[0].startsWith('act_') ? 'account' : 'node', id: segments[0], edge: segments[1] };
  return null;
}

export async function handleGraphWrite(
  ctx: GraphReadContext,
  req: SimRequest,
  mutate: (fn: (current: SandboxOverlay) => SandboxOverlay, audit?: SandboxOverlayAudit) => Promise<SandboxOverlay>,
): Promise<SimResponse | null> {
  const target = parsePath(req.path);
  if (!target) return null;
  const params = requestParams(req);

  if (req.method === 'POST' && target.kind === 'account' && target.id === ctx.dataset.account.id) {
    switch (target.edge) {
      case 'campaigns': return ok(await createCampaign(ctx, params, mutate));
      case 'adsets': return ok(await createAdSet(ctx, params, mutate));
      case 'ads': return ok(await createAd(ctx, params, mutate, str(params, 'adset_id')));
      case 'adcreatives': return ok(await createCreative(ctx, params, mutate));
      case 'customaudiences': return ok(await createAudience(ctx, params, mutate));
      case 'adimages': return ok(await uploadAdImage(ctx, req, mutate));
      default: return null;
    }
  }
  if (req.method === 'POST' && target.kind === 'node' && target.edge === 'ads') {
    // POST /<AD_SET_ID>/ads — the common real-Meta form; the adset must already exist.
    return ok(await createAd(ctx, params, mutate, target.id));
  }
  if (req.method === 'POST' && target.kind === 'node' && target.edge === undefined) {
    return ok(await updateNode(ctx, target.id, params, mutate));
  }
  if (req.method === 'DELETE' && target.kind === 'node' && target.edge === undefined) {
    return ok(await deleteNode(ctx, target.id, mutate));
  }
  return null;
}

// ---------- create ----------

async function createCampaign(ctx: GraphReadContext, params: Params, mutate: Parameters<typeof handleGraphWrite>[2]): Promise<{ id: string }> {
  const name = str(params, 'name');
  const objective = str(params, 'objective');
  if (!name || !objective) throw graphErrors.invalidParam('name and objective are required');
  let createdId = '';
  await mutate((current) => {
    const { id, overlay } = nextId(current);
    createdId = id;
    const now = unshiftNow(ctx.now, ctx.shift);
    const status = parseStatus(params, 'PAUSED');
    const campaign: SandboxCampaign = {
      id, account_id: ctx.dataset.account.account_id, name, status,
      effective_status: status, objective,
      daily_budget: num(params, 'daily_budget'), lifetime_budget: num(params, 'lifetime_budget'),
      budget_remaining: num(params, 'daily_budget') ?? num(params, 'lifetime_budget'), spend_cap: num(params, 'spend_cap'),
      bid_strategy: str(params, 'bid_strategy'),
      start_time: str(params, 'start_time') ? unshiftInput(str(params, 'start_time')!, ctx.shift, 'start_time') : now,
      stop_time: str(params, 'stop_time') ? unshiftInput(str(params, 'stop_time')!, ctx.shift, 'stop_time') : undefined,
      special_ad_categories: (jsonParam(params, 'special_ad_categories') as string[]) ?? [],
      created_time: now, updated_time: now,
    };
    return { ...overlay, campaigns: { ...overlay.campaigns, [id]: campaign } };
  }, { action: 'sandbox.create', details: { objectType: 'campaign', name } });
  return { id: createdId };
}

async function createAdSet(ctx: GraphReadContext, params: Params, mutate: Parameters<typeof handleGraphWrite>[2]): Promise<{ id: string }> {
  const name = str(params, 'name');
  const campaignId = str(params, 'campaign_id');
  if (!name || !campaignId) throw graphErrors.invalidParam('name and campaign_id are required');
  let createdId = '';
  await mutate((current) => {
    const resolved = resolveObjects(ctx.dataset, current, ctx.now);
    if (!resolved.campaigns.has(campaignId)) throw graphErrors.invalidParam(`campaign_id ${campaignId} does not exist`);
    const { id, overlay } = nextId(current);
    createdId = id;
    const now = unshiftNow(ctx.now, ctx.shift);
    const status = parseStatus(params, 'PAUSED');
    const adset: SandboxAdSet = {
      id, account_id: ctx.dataset.account.account_id, campaign_id: campaignId, name,
      status,
      effective_status: status,
      optimization_goal: str(params, 'optimization_goal') || 'LINK_CLICKS', billing_event: str(params, 'billing_event') || 'IMPRESSIONS',
      destination_type: str(params, 'destination_type'), promoted_object: jsonParam(params, 'promoted_object') as Record<string, unknown> | undefined,
      bid_strategy: str(params, 'bid_strategy'), bid_amount: num(params, 'bid_amount'),
      daily_budget: num(params, 'daily_budget'), lifetime_budget: num(params, 'lifetime_budget'),
      start_time: str(params, 'start_time') ? unshiftInput(str(params, 'start_time')!, ctx.shift, 'start_time') : now,
      end_time: str(params, 'end_time') ? unshiftInput(str(params, 'end_time')!, ctx.shift, 'end_time') : undefined,
      targeting: (jsonParam(params, 'targeting') as Record<string, unknown>) ?? {},
      pacing_type: (jsonParam(params, 'pacing_type') as string[]) ?? undefined,
    };
    return { ...overlay, adsets: { ...overlay.adsets, [id]: adset } };
  }, { action: 'sandbox.create', details: { objectType: 'adset', name } });
  return { id: createdId };
}

async function createAd(
  ctx: GraphReadContext, params: Params, mutate: Parameters<typeof handleGraphWrite>[2], adsetIdFromPath: string | undefined,
): Promise<{ id: string }> {
  const name = str(params, 'name');
  const adsetId = adsetIdFromPath ?? str(params, 'adset_id');
  const creativeParam = jsonParam(params, 'creative') as { creative_id?: string } | undefined;
  const creativeId = creativeParam?.creative_id ?? str(params, 'creative_id');
  if (!name || !adsetId || !creativeId) throw graphErrors.invalidParam('name, adset_id and creative{creative_id} are required');
  let createdId = '';
  const status = parseStatus(params, 'PAUSED');
  await mutate((current) => {
    const resolved = resolveObjects(ctx.dataset, current, ctx.now);
    const adset = resolved.adsets.get(adsetId);
    if (!adset) throw graphErrors.invalidParam(`adset_id ${adsetId} does not exist`);
    if (!resolved.creatives.has(creativeId)) throw graphErrors.invalidParam(`creative_id ${creativeId} does not exist`);
    const { id, overlay } = nextId(current);
    createdId = id;
    const now = unshiftNow(ctx.now, ctx.shift);
    const ad: SandboxAd = {
      id, account_id: ctx.dataset.account.account_id, adset_id: adsetId, campaign_id: adset.campaign_id, name, status,
      effective_status: status, creative: { id: creativeId }, created_time: now, updated_time: now,
    };
    let next: SandboxOverlay = { ...overlay, ads: { ...overlay.ads, [id]: ad } };
    // A newly created ad that is (or becomes) ACTIVE enters the same PENDING_REVIEW window a
    // real ad does — objects.ts's adEffectiveStatus already reads reviewUntil; this is the
    // only place that sets it.
    if (status === 'ACTIVE') next = { ...next, reviewUntil: { ...next.reviewUntil, [id]: new Date(ctx.now.getTime() + SANDBOX_REVIEW_WINDOW_MS).toISOString() } };
    return next;
  }, { action: 'sandbox.create', details: { objectType: 'ad', name } });
  return { id: createdId };
}

async function createCreative(ctx: GraphReadContext, params: Params, mutate: Parameters<typeof handleGraphWrite>[2]): Promise<{ id: string }> {
  const name = str(params, 'name');
  if (!name) throw graphErrors.invalidParam('name is required');
  let createdId = '';
  await mutate((current) => {
    const { id, overlay } = nextId(current);
    createdId = id;
    const now = unshiftNow(ctx.now, ctx.shift);
    const imageHash = str(params, 'image_hash');
    const image = imageHash ? resolveObjects(ctx.dataset, current, ctx.now).images.get(imageHash) : undefined;
    if (imageHash && !image) throw graphErrors.invalidParam(`image_hash ${imageHash} does not exist — upload it via /adimages first`);
    const objectStorySpec = jsonParam(params, 'object_story_spec') as Record<string, unknown> | undefined;
    const creative: SandboxCreative = {
      id, account_id: ctx.dataset.account.account_id, name, status: 'ACTIVE',
      body: str(params, 'body'), title: str(params, 'title'),
      image_url: image?.url, thumbnail_url: image?.url, image_hash: imageHash,
      object_type: str(params, 'object_type'), link_url: str(params, 'link_url'), url_tags: str(params, 'url_tags'),
      object_story_spec: objectStorySpec, asset_feed_spec: jsonParam(params, 'asset_feed_spec') as Record<string, unknown> | undefined,
      created_time: now,
    };
    return { ...overlay, adcreatives: { ...overlay.adcreatives, [id]: creative } };
  }, { action: 'sandbox.create', details: { objectType: 'adcreative', name } });
  return { id: createdId };
}

async function createAudience(ctx: GraphReadContext, params: Params, mutate: Parameters<typeof handleGraphWrite>[2]): Promise<{ id: string }> {
  const name = str(params, 'name');
  const subtype = str(params, 'subtype');
  if (!name || !subtype) throw graphErrors.invalidParam('name and subtype are required');
  let createdId = '';
  await mutate((current) => {
    const { id, overlay } = nextId(current);
    createdId = id;
    const now = unshiftNow(ctx.now, ctx.shift);
    const audience: SandboxCustomAudience = {
      id, name, description: str(params, 'description'), subtype,
      delivery_status: { code: 200, description: 'Normal' },
      customer_file_source: str(params, 'customer_file_source'), lookalike_spec: jsonParam(params, 'lookalike_spec') as Record<string, unknown> | null | undefined,
      approximate_count_lower_bound: undefined, time_created: now, time_updated: now,
    };
    return { ...overlay, customAudiences: { ...overlay.customAudiences, [id]: audience } };
  }, { action: 'sandbox.create', details: { objectType: 'customaudience', name } });
  return { id: createdId };
}

async function uploadAdImage(
  ctx: GraphReadContext, req: SimRequest, mutate: Parameters<typeof handleGraphWrite>[2],
): Promise<{ images: Record<string, { hash: string; url: string }> }> {
  const file = req.multipart?.files?.[0];
  if (!file || !file.bytes) throw graphErrors.invalidParam('adimages requires a multipart file upload');
  const hash = createHash('sha256').update(file.bytes).digest('hex');
  const filename = file.filename || `${hash}.jpg`;
  const upload = await uploadFileToS3WithPath(file.bytes, `${hash}.jpg`, file.contentType || 'image/jpeg', `sandbox/${ctx.userId}/adimages`);
  if (!upload.success || !upload.url) throw graphErrors.unknown();
  await mutate((overlay) => ({
    ...overlay,
    adimages: { ...overlay.adimages, [hash]: { hash, url: upload.url!, name: filename, width: 0, height: 0, status: 'ACTIVE' } },
  }), { action: 'sandbox.upload', details: { objectType: 'adimage', hash } });
  return { images: { [filename]: { hash, url: upload.url } } };
}

// ---------- update / delete ----------

function resolveExisting(ctx: GraphReadContext, overlay: SandboxOverlay, id: string):
  { kind: 'campaign' | 'adset' | 'ad' | 'creative' | 'audience'; obj: SandboxCampaign | SandboxAdSet | SandboxAd | SandboxCreative | SandboxCustomAudience } | null {
  const resolved = resolveObjects(ctx.dataset, overlay, ctx.now);
  if (resolved.campaigns.has(id)) return { kind: 'campaign', obj: resolved.campaigns.get(id)! };
  if (resolved.adsets.has(id)) return { kind: 'adset', obj: resolved.adsets.get(id)! };
  if (resolved.ads.has(id)) return { kind: 'ad', obj: resolved.ads.get(id)! };
  if (resolved.creatives.has(id)) return { kind: 'creative', obj: resolved.creatives.get(id)! };
  if (resolved.customAudiences.has(id)) return { kind: 'audience', obj: resolved.customAudiences.get(id)! };
  return null;
}

async function updateNode(ctx: GraphReadContext, id: string, params: Params, mutate: Parameters<typeof handleGraphWrite>[2]): Promise<{ success: true }> {
  await mutate((current) => {
    const found = resolveExisting(ctx, current, id);
    if (!found) throw graphErrors.unsupportedGet(id);
    const now = unshiftNow(ctx.now, ctx.shift);
    switch (found.kind) {
      case 'campaign': {
        const c = found.obj as SandboxCampaign;
        const updated: SandboxCampaign = {
          ...c,
          name: str(params, 'name') ?? c.name, status: parseStatus(params, c.status),
          daily_budget: params.daily_budget !== undefined ? num(params, 'daily_budget') : c.daily_budget,
          lifetime_budget: params.lifetime_budget !== undefined ? num(params, 'lifetime_budget') : c.lifetime_budget,
          spend_cap: params.spend_cap !== undefined ? num(params, 'spend_cap') : c.spend_cap,
          bid_strategy: str(params, 'bid_strategy') ?? c.bid_strategy,
          start_time: str(params, 'start_time') ? unshiftInput(str(params, 'start_time')!, ctx.shift, 'start_time') : c.start_time,
          stop_time: str(params, 'stop_time') ? unshiftInput(str(params, 'stop_time')!, ctx.shift, 'stop_time') : c.stop_time,
          updated_time: now,
        };
        return { ...current, campaigns: { ...current.campaigns, [id]: updated } };
      }
      case 'adset': {
        const a = found.obj as SandboxAdSet;
        const updated: SandboxAdSet = {
          ...a,
          name: str(params, 'name') ?? a.name, status: parseStatus(params, a.status),
          daily_budget: params.daily_budget !== undefined ? num(params, 'daily_budget') : a.daily_budget,
          lifetime_budget: params.lifetime_budget !== undefined ? num(params, 'lifetime_budget') : a.lifetime_budget,
          bid_amount: params.bid_amount !== undefined ? num(params, 'bid_amount') : a.bid_amount,
          bid_strategy: str(params, 'bid_strategy') ?? a.bid_strategy,
          targeting: params.targeting !== undefined ? ((jsonParam(params, 'targeting') as Record<string, unknown>) ?? a.targeting) : a.targeting,
        };
        return { ...current, adsets: { ...current.adsets, [id]: updated } };
      }
      case 'ad': {
        const ad = found.obj as SandboxAd;
        const nextStatus = parseStatus(params, ad.status);
        const updated: SandboxAd = { ...ad, name: str(params, 'name') ?? ad.name, status: nextStatus, updated_time: now };
        let next: SandboxOverlay = { ...current, ads: { ...current.ads, [id]: updated } };
        if (nextStatus === 'ACTIVE' && ad.status !== 'ACTIVE') {
          next = { ...next, reviewUntil: { ...next.reviewUntil, [id]: new Date(ctx.now.getTime() + SANDBOX_REVIEW_WINDOW_MS).toISOString() } };
        }
        return next;
      }
      case 'creative': {
        // Real Meta creatives are effectively immutable after creation; only status changes.
        const c = found.obj as SandboxCreative;
        const updated: SandboxCreative = { ...c, status: str(params, 'status') ?? c.status };
        return { ...current, adcreatives: { ...current.adcreatives, [id]: updated } };
      }
      case 'audience': {
        const a = found.obj as SandboxCustomAudience;
        const updated: SandboxCustomAudience = { ...a, name: str(params, 'name') ?? a.name, description: str(params, 'description') ?? a.description, time_updated: now };
        return { ...current, customAudiences: { ...current.customAudiences, [id]: updated } };
      }
    }
  }, { action: 'sandbox.update', details: { objectId: id } });
  return { success: true };
}

async function deleteNode(ctx: GraphReadContext, id: string, mutate: Parameters<typeof handleGraphWrite>[2]): Promise<{ success: true }> {
  await mutate((current) => {
    // Check idempotency BEFORE resolving: resolveExisting reads through the resolved (overlay
    // - deletedIds) view, so a repeated/concurrent delete on an already-deleted id would
    // otherwise throw unsupportedGet instead of the idempotent no-op a second DELETE should be.
    if (current.deletedIds.includes(id)) return current;
    const found = resolveExisting(ctx, current, id);
    if (!found) throw graphErrors.unsupportedGet(id);
    // Cascade: real Meta never leaves an ad set/ad pointing at a deleted parent, and
    // objects.ts's effective_status derivation only special-cases a PRESENT non-active
    // parent — a MISSING one (deleted) falls through and reads back ACTIVE. Deleting a
    // campaign or ad set therefore also deletes its children, using the same resolved view
    // so both seeded and overlay-created descendants are covered.
    const resolved = resolveObjects(ctx.dataset, current, ctx.now);
    const deletedIds = new Set(current.deletedIds);
    deletedIds.add(id);
    if (found.kind === 'campaign') {
      for (const adset of resolved.adsets.values()) if (adset.campaign_id === id) deletedIds.add(adset.id);
      for (const ad of resolved.ads.values()) if (ad.campaign_id === id) deletedIds.add(ad.id);
    } else if (found.kind === 'adset') {
      for (const ad of resolved.ads.values()) if (ad.adset_id === id) deletedIds.add(ad.id);
    }
    return { ...current, deletedIds: [...deletedIds] };
  }, { action: 'sandbox.delete', details: { objectId: id } });
  return { success: true };
}

/** Candidate-friendly review window — NOT Meta's real multi-hour review. */
export const SANDBOX_REVIEW_WINDOW_MS = 60_000;
