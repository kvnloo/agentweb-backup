/**
 * AW-Deals — discrete selling motions (CRM Unification v1, A2).
 *
 * A Deal is a single sales opportunity. It has one primary Contact
 * (primaryContactId) and N participant Contacts (contactIds[]). The
 * Contact/Lead side mirrors membership via Lead.dealIds[] (see A1's
 * leadSchema.ts).
 *
 * Table schema:
 *   PK:  dealId (string)
 *   GSIs:
 *     - ownerUserId-heatScore-index  (PK: ownerUserId, SK: heatScore)
 *     - companyDomain-stage-index    (PK: companyDomain, SK: stage)
 *     - primaryContactId-index       (PK: primaryContactId)
 *
 * Auth invariant: only the deal's `ownerUserId` or `accountOwnerUserId`
 * may write. Callers enforce this via `assertCanWrite(deal, userId)`.
 *
 * Task: https://www.notion.so/34209247c95181eb940fc53f80300a1e (A2)
 */

import { dynamodb } from '../config/aws';
import { crmDb } from './db';
import { buildLeadCrmUpdateFragments } from '../utils/leadSchema';

const TABLE_PREFIX = process.env.NODE_ENV === 'development' ? 'Dev-' : '';
const TABLE_NAME = `${TABLE_PREFIX}AW-Deals`;

export const DEAL_STAGES = [
  'Lead',
  'Qualified',
  'Demo',
  'Proposal',
  'Negotiation',
  'Won',
  'Lost',
] as const;
export type DealStage = (typeof DEAL_STAGES)[number];

export interface Deal {
  dealId: string;
  ownerUserId: string;
  accountOwnerUserId?: string;
  primaryContactId: string;
  contactIds: string[];
  companyDomain?: string;
  stage: DealStage;
  dealValue?: number;
  dealCurrency?: string;
  expectedClose?: string; // ISO date
  closedDate?: string; // ISO date — auto-set on Won/Lost
  heatScore?: number; // 0-100
  source?: string;
  notes?: string;
  tenantId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDealInput {
  ownerUserId: string;
  primaryContactId: string;
  contactIds?: string[]; // defaults to [primaryContactId]
  accountOwnerUserId?: string;
  companyDomain?: string;
  stage?: DealStage; // defaults to 'Lead'
  dealValue?: number;
  dealCurrency?: string;
  expectedClose?: string;
  heatScore?: number;
  source?: string;
  notes?: string;
  tenantId?: string;
}

export interface UpdateDealInput {
  primaryContactId?: string;
  contactIds?: string[];
  accountOwnerUserId?: string | null;
  companyDomain?: string | null;
  stage?: DealStage;
  dealValue?: number | null;
  dealCurrency?: string | null;
  expectedClose?: string | null;
  closedDate?: string | null;
  heatScore?: number | null;
  source?: string | null;
  notes?: string | null;
}

/**
 * Ref to a contact/lead row — contacts live on AW-Leads keyed by (listId, leadId).
 * Callers pass these pairs so the Deal service can update Lead.dealIds[].
 */
export interface ContactRef {
  listId: string;
  leadId: string;
}

const VALID_STAGES: ReadonlySet<string> = new Set(DEAL_STAGES);

export class DealAuthError extends Error {
  constructor(message = 'Not authorized to modify this deal') {
    super(message);
    this.name = 'DealAuthError';
  }
}

export class DealNotFoundError extends Error {
  constructor(dealId: string) {
    super(`Deal ${dealId} not found`);
    this.name = 'DealNotFoundError';
  }
}

export function generateDealId(): string {
  return `deal_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * True when `userId` is the ownerUserId or the accountOwnerUserId of the deal.
 * The Deal service and every route handler should funnel writes through this.
 */
export function canWrite(deal: Deal, userId: string): boolean {
  return deal.ownerUserId === userId || deal.accountOwnerUserId === userId;
}

function assertStage(stage: string | undefined): void {
  if (stage === undefined) return;
  if (!VALID_STAGES.has(stage)) {
    throw new Error(`Invalid deal stage: ${stage}`);
  }
}

function assertHeatScore(n: number | undefined | null): void {
  if (n === undefined || n === null) return;
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    throw new Error(`heatScore must be 0-100, got ${n}`);
  }
}

class DealDb {
  async createDeal(input: CreateDealInput): Promise<Deal> {
    if (!input.ownerUserId?.trim()) throw new Error('createDeal: ownerUserId required');
    if (!input.primaryContactId?.trim()) throw new Error('createDeal: primaryContactId required');
    assertStage(input.stage);
    assertHeatScore(input.heatScore);

    const now = new Date().toISOString();
    const contactIds = input.contactIds && input.contactIds.length > 0
      ? Array.from(new Set(input.contactIds))
      : [input.primaryContactId];

    if (!contactIds.includes(input.primaryContactId)) {
      contactIds.push(input.primaryContactId);
    }

    const stage: DealStage = input.stage || 'Lead';
    const deal: Deal = {
      dealId: generateDealId(),
      ownerUserId: input.ownerUserId,
      primaryContactId: input.primaryContactId,
      contactIds,
      stage,
      createdAt: now,
      updatedAt: now,
      ...(input.accountOwnerUserId ? { accountOwnerUserId: input.accountOwnerUserId } : {}),
      ...(input.companyDomain ? { companyDomain: input.companyDomain.toLowerCase().trim() } : {}),
      ...(typeof input.dealValue === 'number' ? { dealValue: input.dealValue } : {}),
      ...(input.dealCurrency ? { dealCurrency: input.dealCurrency } : {}),
      ...(input.expectedClose ? { expectedClose: input.expectedClose } : {}),
      ...(typeof input.heatScore === 'number' ? { heatScore: input.heatScore } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.tenantId?.trim() ? { tenantId: input.tenantId.trim() } : {}),
      ...((stage === 'Won' || stage === 'Lost') ? { closedDate: now } : {}),
    };

    await dynamodb
      .put({
        TableName: TABLE_NAME,
        Item: deal,
        ConditionExpression: 'attribute_not_exists(dealId)',
      })
      .promise();

    return deal;
  }

  async getDeal(dealId: string): Promise<Deal | null> {
    const result = await dynamodb
      .get({ TableName: TABLE_NAME, Key: { dealId } })
      .promise();
    return (result.Item as Deal) || null;
  }

  async updateDeal(dealId: string, userId: string, updates: UpdateDealInput): Promise<Deal> {
    assertStage(updates.stage);
    assertHeatScore(updates.heatScore);

    const existing = await this.getDeal(dealId);
    if (!existing) throw new DealNotFoundError(dealId);
    if (!canWrite(existing, userId)) throw new DealAuthError();

    if (updates.primaryContactId !== undefined) {
      const nextContacts = updates.contactIds ?? existing.contactIds;
      if (!nextContacts.includes(updates.primaryContactId)) {
        throw new Error('primaryContactId must be a member of contactIds');
      }
    }

    const setExpressions: string[] = [];
    const removeExpressions: string[] = [];
    const values: Record<string, unknown> = {};
    const names: Record<string, string> = {};

    const push = (attr: string, placeholder: string, value: unknown, useName = false) => {
      if (useName) {
        names[`#${attr}`] = attr;
        setExpressions.push(`#${attr} = ${placeholder}`);
      } else {
        setExpressions.push(`${attr} = ${placeholder}`);
      }
      values[placeholder] = value;
    };

    const remove = (attr: string, useName = false) => {
      if (useName) {
        names[`#${attr}`] = attr;
        removeExpressions.push(`#${attr}`);
      } else {
        removeExpressions.push(attr);
      }
    };

    const nullable = <K extends keyof UpdateDealInput>(
      key: K,
      placeholder: string,
      useName = false
    ) => {
      const v = updates[key];
      if (v === undefined) return;
      if (v === null || v === '') {
        remove(String(key), useName);
      } else {
        push(String(key), placeholder, v, useName);
      }
    };

    if (updates.primaryContactId !== undefined) {
      push('primaryContactId', ':primaryContactId', updates.primaryContactId);
    }
    if (updates.contactIds !== undefined) {
      if (updates.contactIds.length === 0) {
        throw new Error('contactIds cannot be empty');
      }
      push('contactIds', ':contactIds', Array.from(new Set(updates.contactIds)));
    }
    nullable('accountOwnerUserId', ':accountOwnerUserId');
    nullable('companyDomain', ':companyDomain');
    // stage is an enum, never null
    if (updates.stage !== undefined) {
      push('stage', ':stage', updates.stage, true);
      // Auto-set closedDate on Won/Lost if not already set
      if ((updates.stage === 'Won' || updates.stage === 'Lost') && !existing.closedDate && updates.closedDate === undefined) {
        push('closedDate', ':closedDate', new Date().toISOString());
      }
    }
    nullable('dealValue', ':dealValue');
    nullable('dealCurrency', ':dealCurrency');
    nullable('expectedClose', ':expectedClose');
    nullable('closedDate', ':closedDate');
    nullable('heatScore', ':heatScore');
    nullable('source', ':source', true);
    nullable('notes', ':notes', true);

    // Always bump updatedAt
    push('updatedAt', ':updatedAt', new Date().toISOString());

    let updateExpression = '';
    if (setExpressions.length > 0) {
      updateExpression += 'SET ' + setExpressions.join(', ');
    }
    if (removeExpressions.length > 0) {
      updateExpression += (updateExpression ? ' ' : '') + 'REMOVE ' + removeExpressions.join(', ');
    }

    const params: any = {
      TableName: TABLE_NAME,
      Key: { dealId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    };
    if (Object.keys(names).length > 0) params.ExpressionAttributeNames = names;

    const result = await dynamodb.update(params).promise();
    return result.Attributes as Deal;
  }

  async deleteDeal(dealId: string, userId: string): Promise<void> {
    const existing = await this.getDeal(dealId);
    if (!existing) throw new DealNotFoundError(dealId);
    if (!canWrite(existing, userId)) throw new DealAuthError();

    await dynamodb
      .delete({ TableName: TABLE_NAME, Key: { dealId } })
      .promise();
  }

  async getDealsByOwner(
    ownerUserId: string,
    opts: { limit?: number; ascending?: boolean } = {}
  ): Promise<Deal[]> {
    const { limit = 100, ascending = false } = opts;
    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: 'ownerUserId-heatScore-index',
        KeyConditionExpression: 'ownerUserId = :uid',
        ExpressionAttributeValues: { ':uid': ownerUserId },
        Limit: limit,
        ScanIndexForward: ascending,
      })
      .promise();
    return (result.Items || []) as Deal[];
  }

  async getDealsByDomain(
    companyDomain: string,
    opts: { stage?: DealStage; limit?: number } = {}
  ): Promise<Deal[]> {
    const { stage, limit = 100 } = opts;
    const normalized = companyDomain.trim().toLowerCase();
    const keyCondition: string[] = ['companyDomain = :domain'];
    const values: Record<string, unknown> = { ':domain': normalized };
    const names: Record<string, string> = {};

    if (stage) {
      assertStage(stage);
      keyCondition.push('#s = :stage');
      values[':stage'] = stage;
      names['#s'] = 'stage';
    }

    const params: any = {
      TableName: TABLE_NAME,
      IndexName: 'companyDomain-stage-index',
      KeyConditionExpression: keyCondition.join(' AND '),
      ExpressionAttributeValues: values,
      Limit: limit,
    };
    if (Object.keys(names).length > 0) params.ExpressionAttributeNames = names;

    const result = await dynamodb.query(params).promise();
    return (result.Items || []) as Deal[];
  }

  async getDealsByPrimaryContact(primaryContactId: string): Promise<Deal[]> {
    const result = await dynamodb
      .query({
        TableName: TABLE_NAME,
        IndexName: 'primaryContactId-index',
        KeyConditionExpression: 'primaryContactId = :pcid',
        ExpressionAttributeValues: { ':pcid': primaryContactId },
      })
      .promise();
    return (result.Items || []) as Deal[];
  }

  /**
   * Rotate the primary contact on a deal. Updates `primaryContactId`, ensures
   * the new primary is in `contactIds`, and flips the Lead.isPrimary flag on
   * both the old and new primary rows when contact refs are supplied.
   *
   * Auth: ownerUserId / accountOwnerUserId only.
   */
  async rotatePrimary(
    dealId: string,
    userId: string,
    newPrimaryContactId: string,
    refs?: { oldPrimary?: ContactRef; newPrimary?: ContactRef }
  ): Promise<Deal> {
    const existing = await this.getDeal(dealId);
    if (!existing) throw new DealNotFoundError(dealId);
    if (!canWrite(existing, userId)) throw new DealAuthError();

    if (!newPrimaryContactId?.trim()) {
      throw new Error('rotatePrimary: newPrimaryContactId required');
    }
    if (newPrimaryContactId === existing.primaryContactId) {
      return existing;
    }

    const nextContacts = existing.contactIds.includes(newPrimaryContactId)
      ? existing.contactIds
      : [...existing.contactIds, newPrimaryContactId];

    const updated = await this.updateDeal(dealId, userId, {
      primaryContactId: newPrimaryContactId,
      contactIds: nextContacts,
    });

    // Flip isPrimary flag on both leads when refs are supplied. Best-effort:
    // if one fails we log and continue — the deal row is the source of truth.
    if (refs?.oldPrimary) {
      try {
        await updateLeadDealMembership(refs.oldPrimary, { isPrimary: false });
      } catch (err) {
        console.error('rotatePrimary: failed to clear old primary flag', err);
      }
    }
    if (refs?.newPrimary) {
      try {
        await updateLeadDealMembership(refs.newPrimary, {
          isPrimary: true,
          addDealId: dealId,
        });
      } catch (err) {
        console.error('rotatePrimary: failed to set new primary flag', err);
      }
    }

    return updated;
  }

  /**
   * Create a Deal from a set of Contacts and mirror membership onto each
   * Lead.dealIds[]. The first ref is treated as the primary unless
   * `primaryContactId` is supplied in `dealData`.
   *
   * Lead mirroring is best-effort per-contact — a failed per-lead update is
   * logged and does not roll back the Deal.
   */
  async promoteContactsToDeal(
    contactRefs: ContactRef[],
    dealData: Omit<CreateDealInput, 'primaryContactId' | 'contactIds'> & {
      primaryContactId?: string;
    }
  ): Promise<Deal> {
    if (!contactRefs || contactRefs.length === 0) {
      throw new Error('promoteContactsToDeal: contactRefs required');
    }
    if (!dealData.ownerUserId?.trim()) {
      throw new Error('promoteContactsToDeal: ownerUserId required');
    }

    const contactIds = contactRefs.map(r => r.leadId);
    const primaryContactId = dealData.primaryContactId || contactIds[0];

    const deal = await this.createDeal({
      ...dealData,
      primaryContactId,
      contactIds,
    });

    // Mirror membership onto each lead's dealIds[] and set isPrimary on primary.
    await Promise.all(
      contactRefs.map(ref =>
        updateLeadDealMembership(ref, {
          addDealId: deal.dealId,
          isPrimary: ref.leadId === primaryContactId,
        }).catch(err => {
          // Best-effort — log and continue.
          console.error(
            `promoteContactsToDeal: failed to mirror deal on lead ${ref.listId}/${ref.leadId}`,
            err
          );
        })
      )
    );

    return deal;
  }
}

/**
 * Append `dealId` to a Lead's `dealIds[]` (de-duped) and optionally set the
 * Lead's `isPrimary` flag. Exported for routes/tests; uses crmDb under the hood.
 */
export async function updateLeadDealMembership(
  ref: ContactRef,
  opts: { addDealId?: string; removeDealId?: string; isPrimary?: boolean }
): Promise<void> {
  const lead: any = await crmDb.getLeadById(ref.listId, ref.leadId);
  if (!lead) {
    throw new Error(`Lead not found: ${ref.listId}/${ref.leadId}`);
  }

  const currentDealIds: string[] = Array.isArray(lead.dealIds) ? [...lead.dealIds] : [];
  let nextDealIds = currentDealIds;

  if (opts.addDealId && !currentDealIds.includes(opts.addDealId)) {
    nextDealIds = [...currentDealIds, opts.addDealId];
  }
  if (opts.removeDealId) {
    nextDealIds = nextDealIds.filter(id => id !== opts.removeDealId);
  }

  const ext: { dealIds?: string[]; isPrimary?: boolean } = {};
  if (nextDealIds !== currentDealIds) ext.dealIds = nextDealIds;
  if (opts.isPrimary !== undefined) ext.isPrimary = opts.isPrimary;

  if (Object.keys(ext).length === 0) return;

  // Use buildLeadCrmUpdateFragments directly to apply just these two fields
  // without pulling in the full updateLead surface.
  const fragments = buildLeadCrmUpdateFragments(ext);
  if (fragments.setFields.length === 0 && fragments.removeFields.length === 0) return;

  const values: Record<string, unknown> = {};
  const names: Record<string, string> = {};
  const setParts: string[] = [];
  fragments.setFields.forEach(f => {
    values[f.placeholder] = f.value;
    setParts.push(`${f.attr} = ${f.placeholder}`);
  });

  let updateExpression = '';
  if (setParts.length > 0) updateExpression += 'SET ' + setParts.join(', ');
  if (fragments.removeFields.length > 0) {
    updateExpression += (updateExpression ? ' ' : '') + 'REMOVE ' + fragments.removeFields.join(', ');
  }

  await dynamodb
    .update({
      TableName: `${TABLE_PREFIX}AW-Leads`,
      Key: { listId: ref.listId, leadId: ref.leadId },
      UpdateExpression: updateExpression,
      ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
      ...(Object.keys(names).length > 0 ? { ExpressionAttributeNames: names } : {}),
    })
    .promise();
}

export const dealDb = new DealDb();
