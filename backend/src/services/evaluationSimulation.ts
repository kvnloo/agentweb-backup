import { randomUUID } from 'crypto';
import { EvaluationDenied } from './evaluationPolicy';

export const SIMULATION_DISCLOSURE = 'Simulation complete — not sent to Meta';
const kinds = ['campaign', 'adset', 'ad', 'creative'] as const;
type Kind = typeof kinds[number];
type Fields = Record<string, any>;
export interface SimulationObject extends Fields { id: string; kind: Kind; name: string; status: string; published: boolean }
export interface SimulationState { seed: SimulationObject[]; objects: SimulationObject[] }
export interface SimulationCommand { operation: 'query' | 'inspect' | 'create' | 'update' | 'pause' | 'activate' | 'publish' | 'reset'; kind?: Kind; id?: string; fields?: Fields; source?: 'approved' | 'current' }
export interface SimulationPacket { approved: true; objects: Fields[] }
const common = ['name', 'budget', 'budgetType', 'startTime', 'endTime'];
const fieldsByKind: Record<Kind, string[]> = {
  campaign: [...common, 'objective'], adset: [...common, 'parentId', 'targeting'],
  ad: ['name', 'parentId', 'creativeId'], creative: ['name', 'text', 'upload', 'artifactId'],
};
const plain = (x: unknown): x is Fields => !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
const safeText = (x: unknown, max: number) => typeof x === 'string' && !!x.trim() && x.length <= max &&
  !/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\bBearer\s|access_token|-----BEGIN|\bEA[A-Za-z0-9]{20,})/i.test(x);
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

function validateObject(object: SimulationObject, objects: SimulationObject[], artifactIds: string[]): string[] {
  const errors: string[] = [];
  if (!safeText(object.name, 120)) errors.push('A name of 1–120 characters without URLs or credentials is required.');
  if (object.kind === 'campaign' && !['AWARENESS', 'TRAFFIC', 'LEADS', 'SALES'].includes(object.objective)) errors.push('Choose AWARENESS, TRAFFIC, LEADS, or SALES.');
  if (object.budget !== undefined && (!Number.isSafeInteger(object.budget) || object.budget < 100 || object.budget > 100000000)) errors.push('Budget must be integer USD cents between 100 and 100000000.');
  if (object.budgetType !== undefined && !['daily', 'lifetime'].includes(object.budgetType)) errors.push('Budget type must be daily or lifetime.');
  if ((object.budget !== undefined) !== (object.budgetType !== undefined)) errors.push('Supply both budget and budgetType.');
  for (const key of ['startTime', 'endTime']) if (object[key] !== undefined &&
    (typeof object[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(object[key]) || !Number.isFinite(Date.parse(object[key])) || new Date(object[key]).toISOString() !== object[key])) errors.push('Schedule timestamps must be valid UTC ISO timestamps (with .000Z).');
  if ((object.startTime === undefined) !== (object.endTime === undefined) ||
    (object.startTime !== undefined && Date.parse(object.endTime) <= Date.parse(object.startTime))) errors.push('Supply a start and end with end later than start.');
  if (object.budgetType === 'lifetime' && !object.endTime) errors.push('Lifetime budgets require a start and end.');
  if (object.kind === 'adset' || object.kind === 'ad') {
    const parentKind = object.kind === 'adset' ? 'campaign' : 'adset';
    if (!objects.some(o => o.id === object.parentId && o.kind === parentKind)) errors.push(`A ${parentKind} in this evaluation is required.`);
  }
  if (object.kind === 'adset' && !safeText(object.targeting, 2000)) errors.push('Supply a sanitized audience description (up to 2000 characters).');
  if (object.kind === 'ad' && !objects.some(o => o.id === object.creativeId && o.kind === 'creative')) errors.push('A creative in this evaluation is required.');
  if (object.kind === 'creative') {
    if (object.text !== undefined && !safeText(object.text, 8000)) errors.push('Creative text must be 1–8000 characters without URLs or credentials.');
    if (object.artifactId !== undefined && (typeof object.artifactId !== 'string' || !artifactIds.includes(object.artifactId))) errors.push('Artifact must belong to this evaluation.');
    if (object.upload !== undefined) {
      const u = object.upload;
      if (!plain(u) || Object.keys(u).some(k => !['mime', 'base64'].includes(k)) ||
          !['text/plain', 'image/png', 'image/jpeg', 'application/octet-stream'].includes(u.mime) ||
          typeof u.base64 !== 'string' || !u.base64.length || u.base64.length > 32000 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(u.base64) ||
          Buffer.from(u.base64, 'base64').toString('base64') !== u.base64) errors.push('Upload must be canonical base64, at most 24 KB, with a supported inert MIME type.');
    }
    if (!object.text && !object.upload && !object.artifactId) errors.push('A creative needs text, an upload, or an evaluation artifact.');
  }
  return errors;
}

/** Validate every persisted element before exposing or reusing network-boundary data. */
export function validateSimulation(userId: string, state: unknown): asserts state is SimulationState {
  if (!plain(state) || Object.keys(state).some(k => !['seed', 'objects'].includes(k)) ||
    !Array.isArray(state.seed) || !Array.isArray(state.objects) || state.seed.length > 30 || state.objects.length > 50 ||
    Buffer.byteLength(JSON.stringify(state)) > 150000) throw new EvaluationDenied();
  for (const collection of [state.seed, state.objects]) {
    const ids = new Set<string>();
    for (const object of collection) {
      if (!plain(object) || typeof object.id !== 'string' || !object.id.startsWith(`sim_${userId}_`) ||
        ids.has(object.id) || !kinds.includes(object.kind) || !['DRAFT', 'PAUSED', 'ACTIVE'].includes(object.status) ||
        typeof object.published !== 'boolean' || Object.keys(object).some(k => ![...fieldsByKind[object.kind as Kind], 'id', 'kind', 'status', 'published', 'metrics'].includes(k))) throw new EvaluationDenied();
      ids.add(object.id);
      if (object.metrics !== undefined && (!plain(object.metrics) || Object.keys(object.metrics).some(k => !['impressions', 'clicks', 'spend', 'conversions'].includes(k)) ||
        Object.values(object.metrics).some(v => !Number.isSafeInteger(v) || v < 0 || v > 1000000000))) throw new EvaluationDenied();
    }
    for (const object of collection) if (validateObject(object as SimulationObject, collection as SimulationObject[],
      typeof object.artifactId === 'string' ? [object.artifactId] : []).length) throw new EvaluationDenied();
  }
}

/** Pure, bounded domain model. No connector, provider, URL resolver, or production persistence. */
export function applySimulation(userId: string, state: SimulationState, input: SimulationCommand, artifactIds: string[] = []) {
  validateSimulation(userId, state);
  if (!plain(input) || Object.keys(input).some(k => !['operation', 'kind', 'id', 'fields', 'source'].includes(k)) ||
      !['query', 'inspect', 'create', 'update', 'pause', 'activate', 'publish', 'reset'].includes(input.operation)) throw new EvaluationDenied();
  const allowed: Record<string, string[]> = {
    query: ['operation', 'kind', 'source'], inspect: ['operation', 'id', 'source'], create: ['operation', 'kind', 'fields'],
    update: ['operation', 'id', 'fields'], pause: ['operation', 'id'], activate: ['operation', 'id'], publish: ['operation', 'id'], reset: ['operation'],
  };
  if (Object.keys(input).some(k => !allowed[input.operation].includes(k))) throw new EvaluationDenied();
  const next = clone(state);
  const errors: string[] = []; const warnings: string[] = [];
  let object: SimulationObject | undefined;
  let objects: SimulationObject[] | undefined;
  if (input.source !== undefined && !['approved', 'current'].includes(input.source)) errors.push('Source must be approved or current.');
  if (input.kind !== undefined && !kinds.includes(input.kind)) errors.push('Choose campaign, adset, ad, or creative.');
  const source = input.source === 'approved' ? next.seed : next.objects;
  if (input.operation === 'query') objects = source.filter(o => !input.kind || o.kind === input.kind);
  else if (input.operation === 'reset') { next.objects = clone(next.seed); objects = next.objects; }
  else if (input.operation === 'create') {
    if (!input.kind || !kinds.includes(input.kind) || !plain(input.fields)) errors.push('Create requires a kind and fields.');
    else if (Object.keys(input.fields).some(k => !fieldsByKind[input.kind!].includes(k))) errors.push('Unsupported fields; external IDs, destinations, URLs, and credentials are not accepted.');
    else {
      object = { ...clone(input.fields), id: `sim_${userId}_${randomUUID()}`, kind: input.kind, status: 'DRAFT', published: false } as SimulationObject;
      errors.push(...validateObject(object, next.objects, artifactIds));
      if (next.objects.length >= 50) errors.push('The evaluation supports at most 50 simulated objects. Reset to clear disposable state.');
      if (!errors.length) next.objects.push(object);
    }
  } else {
    object = typeof input.id === 'string' ? source.find(o => o.id === input.id) : undefined;
    if (!object) errors.push('Object not found in this evaluation.');
    else if (input.operation === 'update') {
      if (!plain(input.fields) || !Object.keys(input.fields).length || Object.keys(input.fields).some(k => !fieldsByKind[object!.kind].includes(k))) errors.push('Supply supported editable fields only.');
      else {
        const proposed = { ...object, ...clone(input.fields) };
        errors.push(...validateObject(proposed, next.objects, artifactIds));
        if (!errors.length) { Object.assign(object, proposed); }
      }
    } else if (input.operation !== 'inspect') {
      if (object.kind === 'creative') errors.push('Creative records do not have delivery transitions.');
      else if (input.operation === 'pause') object.status = 'PAUSED';
      else {
        errors.push(...validateObject(object, next.objects, artifactIds));
        const parent = next.objects.find(o => o.id === object!.parentId);
        const campaign = object.kind === 'campaign' ? object : object.kind === 'adset' ? parent : next.objects.find(o => o.id === parent?.parentId);
        if (!object.budget && !parent?.budget && !campaign?.budget) errors.push('Delivery requires a campaign or ad set budget.');
        if ([object, parent, campaign].some(o => o?.endTime && Date.parse(o.endTime) <= Date.now())) errors.push('This object or a parent schedule has ended. Update it before delivery.');
        if (input.operation === 'activate' && !object.published) errors.push('Publish the simulated object before activating it.');
        if (!errors.length) {
          if (input.operation === 'publish') { object.published = true; object.status = 'PAUSED'; }
          else object.status = 'ACTIVE';
        }
      }
    }
  }
  if (Buffer.byteLength(JSON.stringify(next)) > 150000) errors.push('Simulation storage limit reached. Reset to clear disposable state.');
  const finalState = errors.length ? clone(state) : next;
  // Derive effective delivery from ancestors; no scheduling or delivery job is created.
  function visible(o: SimulationObject): SimulationObject {
    const ancestors = input.source === 'approved' ? finalState.seed : finalState.objects;
    let parent = ancestors.find(p => p.id === o.parentId);
    let parentPaused = false;
    let scheduled = !!o.startTime && Date.parse(o.startTime) > Date.now();
    let ended = !!o.endTime && Date.parse(o.endTime) <= Date.now();
    for (let depth = 0; parent && depth < 2; depth++) {
      parentPaused ||= parent.status !== 'ACTIVE';
      scheduled ||= !!parent.startTime && Date.parse(parent.startTime) > Date.now();
      ended ||= !!parent.endTime && Date.parse(parent.endTime) <= Date.now();
      parent = ancestors.find(p => p.id === parent!.parentId);
    }
    return { ...o, effectiveStatus: o.status !== 'ACTIVE' ? o.status : ended ? 'COMPLETED' : parentPaused ? 'PARENT_PAUSED' : scheduled ? 'SCHEDULED' : 'ACTIVE' };
  }
  if (object && errors.length) object = state.objects.find(o => o.id === input.id);
  if (object) {
    object = visible(object);
    if (object.effectiveStatus === 'PARENT_PAUSED') warnings.push('A parent is paused or unpublished; this object would not deliver.');
    if (object.budget && object.budget < 500) warnings.push('A small budget may limit delivery.');
  }
  if (['publish', 'activate'].includes(input.operation)) warnings.push('No Meta review, auction, delivery, or spend occurs in this evaluation.');
  return { state: finalState, result: { ok: errors.length === 0, disclosure: SIMULATION_DISCLOSURE, errors, warnings,
    ...(object ? { object } : {}), ...(objects ? { objects: objects.map(visible) } : {}) } };
}

/** Approved packet is a positive schema, not raw Meta JSON or remotely fetched material. */
export function createSimulation(userId: string, packet?: SimulationPacket): SimulationState {
  if (packet === undefined) return { seed: [], objects: [] };
  if (!plain(packet) || packet.approved !== true || Object.keys(packet).some(k => !['approved', 'objects'].includes(k)) ||
      !Array.isArray(packet.objects) || packet.objects.length > 30 || Buffer.byteLength(JSON.stringify(packet)) > 50000) throw new EvaluationDenied();
  const keys = new Map<string, string>();
  for (const item of packet.objects) {
    if (!plain(item) || typeof item.key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(item.key) || keys.has(item.key) || !kinds.includes(item.kind)) throw new EvaluationDenied();
    keys.set(item.key, `sim_${userId}_seed_${item.key}`);
  }
  const objects = packet.objects.map(item => {
    const { key, kind, parentKey, creativeKey, metrics, status = 'DRAFT', ...fields } = item;
    if (!['DRAFT', 'PAUSED', 'ACTIVE'].includes(status) || (parentKey !== undefined && !['adset', 'ad'].includes(kind)) || (creativeKey !== undefined && kind !== 'ad')) throw new EvaluationDenied();
    if (Object.keys(fields).some(k => !fieldsByKind[kind as Kind].includes(k)) || fields.parentId || fields.creativeId || fields.artifactId) throw new EvaluationDenied();
    if (parentKey !== undefined) { if (!keys.has(parentKey)) throw new EvaluationDenied(); fields.parentId = keys.get(parentKey); }
    if (creativeKey !== undefined) { if (!keys.has(creativeKey)) throw new EvaluationDenied(); fields.creativeId = keys.get(creativeKey); }
    if (metrics !== undefined && (!plain(metrics) || Object.keys(metrics).some(k => !['impressions', 'clicks', 'spend', 'conversions'].includes(k)) ||
        Object.values(metrics).some(v => !Number.isSafeInteger(v) || v < 0 || v > 1000000000))) throw new EvaluationDenied();
    return { ...fields, ...(metrics ? { metrics: clone(metrics) } : {}), id: keys.get(key)!, kind, status, published: status !== 'DRAFT' } as SimulationObject;
  });
  for (const object of objects) if (validateObject(object, objects, []).length) throw new EvaluationDenied();
  return { seed: clone(objects), objects: clone(objects) };
}
