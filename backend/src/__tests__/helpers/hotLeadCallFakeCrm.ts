/**
 * In-memory stand-in for the crmDb/userDb/orgDb primitives the hot-lead call touches (ENG-2271 WP8), so the REAL
 * LeadCallStore, orchestrator and webhooks run on top of it. Imports nothing from services/: the test's
 * jest.mock('../services/db') factory loads this module, and a service import here would be circular.
 *
 * The conditional primitives follow the contract documented on crmDb.createLeadSystemRecordOnce and
 * crmDb.updateLeadSystemRecordIf (all conditions or nothing is written), and throw where the real UpdateItem
 * would reject the request (appending to a list or maxIn map the creator did not initialise).
 */

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

  addLead(lead: FakeLead): void {
    this.leads.set(this.key(lead.listId, lead.leadId), clone(lead));
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

  readonly orgDb = {
    getOrgById: async (orgId: string) => {
      this.calls.push('getOrgById');
      return clone(this.orgs.get(orgId));
    },
  };
}
