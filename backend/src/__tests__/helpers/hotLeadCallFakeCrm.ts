/**
 * In-memory stand-in for the crmDb/userDb/orgDb primitives the hot-lead call touches (ENG-2271), so the REAL
 * LeadCallStore, orchestrator and webhooks run on top of it. Imports nothing from services/: the test's
 * jest.mock('../services/db') factory loads this module, and a service import here would be circular.
 *
 * The conditional primitives follow the contract documented on crmDb.createLeadSystemRecordOnce and
 * crmDb.updateLeadSystemRecordIf (all conditions or nothing is written), and throw where the real UpdateItem
 * would reject the request (appending to a list or maxIn map the creator did not initialise).
 */

import { callConsentRecord } from './hotLeadCallFixtures';

/** The digits of a US test phone as E.164 (what consentPhoneDigits yields for the numbers these tests use). */
const usDigits = (phone: unknown): string => {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length === 10 ? `1${d}` : d;
};

type Json = Record<string, unknown>;
const clone = <T>(v: T): T => structuredClone(v);

export interface FakeLead extends Json {
  listId: string;
  leadId: string;
  system?: Record<string, unknown>;
  engagements?: Array<{ eventType: string; eventData: unknown; createdAt: string; eventId: string }>;
}

interface UpdateOp {
  stateIn: string[];
  set?: Json;
  remove?: string[];
  whenEquals?: Record<string, string | number>;
  whenAbsent?: string[];
  maxIn?: Record<string, Record<string, number>>;
  appendNew?: Record<string, string[]>;
}

export class FakeCrm {
  readonly leads = new Map<string, FakeLead>();
  readonly lists = new Map<string, Json>();
  readonly users = new Map<string, Json>();
  readonly orgs = new Map<string, Json>();
  /** Every primitive call, in order: lets a test prove that a path did no I/O at all. */
  readonly calls: string[] = [];

  private readonly key = (listId: string, leadId: string): string => `${listId}\u0000${leadId}`;
  private leadOf = (listId: string, leadId: string): FakeLead | undefined => this.leads.get(this.key(listId, leadId));

  addOrg(org: Json & { orgId: string }, users: Array<{ userId: string }>, lists: Array<{ listId: string; userId: string }>): void {
    this.orgs.set(org.orgId, org);
    for (const u of users) this.users.set(u.userId, { ...u, orgId: org.orgId });
    for (const l of lists) this.lists.set(l.listId, { ...l, name: 'Inbound' });
  }

  /** ENG-2783: a lead carries a call-consent record unless `consent: false` (the gate `no_call_consent` refuses one without). */
  addLead(lead: FakeLead, opts: { consent?: boolean } = {}): void {
    const withConsent: FakeLead = opts.consent === false ? lead : { ...lead, system: { callConsent: callConsentRecord({ phoneDigits: usDigits(lead.phone) }), ...lead.system } };
    this.leads.set(this.key(lead.listId, lead.leadId), clone(withConsent));
  }

  /** Changes a lead's phone and re-binds its consent record to the new number (a test about what happens AFTER the gates, e.g. lead_phone_changed). */
  rePhone(listId: string, leadId: string, phone: string): void {
    const lead = this.lead(listId, leadId);
    lead.phone = phone;
    if (lead.system?.callConsent) lead.system.callConsent = { ...(lead.system.callConsent as Json), phoneDigits: usDigits(phone) };
  }

  hasLead(listId: string, leadId: string): boolean {
    return this.leads.has(this.key(listId, leadId));
  }

  lead(listId: string, leadId: string): FakeLead {
    const lead = this.leadOf(listId, leadId);
    if (!lead) throw new Error(`no lead ${leadId}`);
    return lead;
  }

  /** Event types on a lead's timeline, oldest first. */
  timeline(listId: string, leadId: string): string[] {
    return (this.lead(listId, leadId).engagements ?? []).map((e) => e.eventType);
  }

  callsTo(name: string): number {
    return this.calls.filter((c) => c === name).length;
  }

  readonly crmDb = {
    getLeadListById: async (listId: string) => {
      this.calls.push('getLeadListById');
      return clone(this.lists.get(listId));
    },
    getLeadById: async (listId: string, leadId: string) => {
      this.calls.push('getLeadById');
      return clone(this.leadOf(listId, leadId));
    },
    /** The top-level fields of the lead row are merged, like UpdateItem SET (only what the hot-lead call writes: contact status). */
    updateLead: async (listId: string, leadId: string, updates: Record<string, unknown>) => {
      this.calls.push('updateLead');
      const lead = this.leadOf(listId, leadId);
      if (!lead) throw new Error('no such lead');
      Object.assign(lead, clone(updates));
    },
    getLeadListsByUserId: async (userId: string) => {
      this.calls.push('getLeadListsByUserId');
      return [...this.lists.values()].filter((l) => l.userId === userId).map(clone);
    },
    /** Newest leadId first, like the real query; `read` counts the leads examined, as DynamoDB's ScannedCount does. */
    findLeadsBySystemRecord: async (
      listId: string, key: string, op: { states: string[]; updatedBefore: string; maxRead: number; has?: string[]; lacks?: string[] },
    ) => {
      this.calls.push('findLeadsBySystemRecord');
      const inList = [...this.leads.values()].filter((l) => l.listId === listId).sort((a, b) => b.leadId.localeCompare(a.leadId));
      const examined = inList.slice(0, op.maxRead);
      const leadIds = examined.filter((l) => {
        const rec = l.system?.[key] as Json | undefined;
        return !!rec && op.states.includes(rec.state as string) && (rec.updatedAt as string) < op.updatedBefore
          && (op.has ?? []).every((f) => rec[f] !== undefined) && (op.lacks ?? []).every((f) => rec[f] === undefined);
      }).map((l) => l.leadId);
      return { leadIds, read: examined.length, truncated: inList.length > examined.length };
    },
    claimLeadStepOnce: async (listId: string, leadId: string, step: string) => {
      this.calls.push('claimLeadStepOnce');
      const lead = this.leadOf(listId, leadId);
      if (!lead) return false;
      lead.system ??= {};
      if (step in lead.system) return false;
      lead.system[step] = { status: 'in_progress', claimedAt: new Date().toISOString() };
      return true;
    },
    setLeadFields: async (listId: string, leadId: string, fields: { system?: Json; removeSystemKeys?: string[] }) => {
      this.calls.push('setLeadFields');
      const lead = this.lead(listId, leadId);
      lead.system = { ...lead.system, ...clone(fields.system ?? {}) };
      for (const k of fields.removeSystemKeys ?? []) delete lead.system[k];
    },
    addLeadEngagement: async (listId: string, leadId: string, engagement: { eventType: string; eventData: unknown; createdAt: string }) => {
      this.calls.push('addLeadEngagement');
      const lead = this.lead(listId, leadId);
      (lead.engagements ??= []).push({ ...clone(engagement), eventId: `custom_${lead.engagements.length}` });
    },
    createLeadSystemRecordOnce: async (listId: string, leadId: string, key: string, record: Json) => {
      this.calls.push('createLeadSystemRecordOnce');
      const lead = this.leadOf(listId, leadId);
      if (!lead) return false;
      lead.system ??= {};
      if (key in lead.system) return false;
      lead.system[key] = clone(record);
      return true;
    },
    updateLeadSystemRecordIf: async (listId: string, leadId: string, key: string, op: UpdateOp) => {
      this.calls.push('updateLeadSystemRecordIf');
      const rec = this.leadOf(listId, leadId)?.system?.[key] as Json | undefined;
      if (!rec || op.stateIn.length === 0 || !op.stateIn.includes(rec.state as string)) return false;
      // Check every condition before writing anything, like one conditional UpdateItem.
      for (const [field, expected] of Object.entries(op.whenEquals ?? {})) if (rec[field] !== expected) return false;
      for (const field of op.whenAbsent ?? []) if (rec[field] !== undefined) return false;
      for (const [field, entries] of Object.entries(op.maxIn ?? {})) {
        if (Object.keys(entries).length && (typeof rec[field] !== 'object' || rec[field] === null)) throw new Error(`maxIn map ${field} was not initialised`);
        for (const [entry, n] of Object.entries(entries)) {
          const stored = (rec[field] as Record<string, number>)[entry];
          if (stored !== undefined && !(stored < n)) return false;
        }
      }
      for (const [field, items] of Object.entries(op.appendNew ?? {})) {
        if (items.length && !Array.isArray(rec[field])) throw new Error(`list ${field} was not initialised`);
        if (items.some((i) => (rec[field] as string[]).includes(i))) return false;
      }
      for (const [field, v] of Object.entries(op.set ?? {})) if (v !== undefined) rec[field] = clone(v);
      for (const field of op.remove ?? []) delete rec[field];
      for (const [field, entries] of Object.entries(op.maxIn ?? {})) Object.assign(rec[field] as object, entries);
      for (const [field, items] of Object.entries(op.appendNew ?? {})) (rec[field] as string[]).push(...items);
      return true;
    },
  };

  readonly userDb = {
    getUserById: async (userId: string) => {
      this.calls.push('getUserById');
      return clone(this.users.get(userId));
    },
  };

  /** Makes the org-number scan throw, like a throttled DynamoDB. */
  listFails = false;

  readonly orgDb = {
    getOrgById: async (orgId: string) => {
      this.calls.push('getOrgById');
      return clone(this.orgs.get(orgId));
    },
    getOrgMembers: async (orgId: string) => {
      this.calls.push('getOrgMembers');
      return [...this.users.values()].filter((u) => u.orgId === orgId).map(clone);
    },
    listHotLeadCallOrgIds: async () => {
      this.calls.push('listHotLeadCallOrgIds');
      return [...this.orgs.entries()].filter(([, org]) => org.hotLeadCall !== undefined).map(([orgId]) => orgId);
    },
    listHotLeadCallNumbers: async () => {
      this.calls.push('listHotLeadCallNumbers');
      if (this.listFails) throw new Error('scan failed');
      return [...this.orgs.entries()].flatMap(([orgId, org]) => {
        const twilioNumber = (org.hotLeadCall as { twilioNumber?: unknown } | undefined)?.twilioNumber;
        return typeof twilioNumber === 'string' ? [{ orgId, twilioNumber }] : [];
      });
    },
  };
}

/**
 * What the test files' `jest.mock('../services/db')` factory returns: the three db objects delegate to whichever
 * FakeCrm the current test installed in `crmHolder`.
 */
export const crmHolder: { current?: FakeCrm } = {};
type Primitives = Record<string, (...args: unknown[]) => unknown>;
const delegate = (pick: 'crmDb' | 'userDb' | 'orgDb') =>
  new Proxy({}, { get: (_target, name) => (...args: unknown[]) => (crmHolder.current![pick] as unknown as Primitives)[String(name)](...args) });
export const dbMock = { crmDb: delegate('crmDb'), userDb: delegate('userDb'), orgDb: delegate('orgDb') };
