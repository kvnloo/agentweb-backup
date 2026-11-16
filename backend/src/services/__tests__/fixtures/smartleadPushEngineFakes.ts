import type { EngineDeps } from "../../smartleadPushEngine";
import { SmartleadApiError, type SmartleadAddLeadsResult, type SmartleadLeadInput } from "../../smartleadService";
import { analyseSequence } from "../../smartleadSequence";

export const SEQUENCE = [{ seq_number: 1, seq_delay_details: { delayInDays: 0 }, subject: "Hi {{first_name}}", email_body: "<p>Hello {{first_name}} at {{company_name}}</p>" }];
export const HASH = analyseSequence(SEQUENCE).hash;
export const CAMPAIGN = 77;

export const mkLead = (n: number, over: Record<string, any> = {}) => ({
  leadId: `lead_${String(n).padStart(5, "0")}`, email: `p${n}@example.com`, firstName: "Ann", company: "Acme", createdAt: "2026-01-01T00:00:00.000Z",
  customFields: { email_validation: { status: "deliverable" } }, ...over,
});

/** A Smartlead that remembers which emails it has, answering like the real one (live shapes, 2026-10-27). */
export class FakeSmartlead {
  emails = new Map<string, string>();
  posts: string[][] = [];
  status = "DRAFTED";
  /** The campaign's own add_unsubscribe_tag setting. */
  addUnsubscribeTag = true;
  sequences: unknown[] | null = SEQUENCE;
  campaignMissing = false;
  analyticsMissing = false;
  failNext: unknown[] = [];
  dropFromMap = new Set<string>();
  invalid = new Set<string>();
  omitMap = false;
  limitExhausted = false;
  tallies: Partial<SmartleadAddLeadsResult["skippedBy"]> = {};
  extraOther: Record<string, string> = {};
  /** Emails Smartlead lists under "existing in other campaigns" and does NOT add (verified live: what `skipped_in_other_campaign_count` counts). */
  skipButListOther = new Set<string>();
  /** Emails Smartlead skips WITHOUT adding or naming them (block list, bounce list...): only its tallies say why. */
  silentSkip = new Set<string>();
  onPost?: () => void | Promise<void>;
  async addLeads(leads: SmartleadLeadInput[]): Promise<SmartleadAddLeadsResult> {
    const failure = this.failNext.shift();
    if (failure) throw failure;
    await this.onPost?.();
    this.posts.push(leads.map(l => l.email));
    const newly: Record<string, string> = {}; const existing: Record<string, string> = {};
    let added = 0;
    const listedOther: Record<string, string> = {};
    for (const l of leads) {
      if (this.skipButListOther.has(l.email)) { listedOther[l.email] = "5000"; continue; }
      if (this.silentSkip.has(l.email)) continue;
      if (this.invalid.has(l.email)) continue;
      if (this.emails.has(l.email)) existing[l.email] = this.emails.get(l.email)!;
      else { const id = String(9000 + this.emails.size); this.emails.set(l.email, id); newly[l.email] = id; added++; }
    }
    // Counted BEFORE dropping names from the map: a dropped lead is still added or already there, Smartlead just does not name it.
    const alreadyInCampaign = Object.keys(existing).length;
    for (const e of this.dropFromMap) { delete newly[e]; delete existing[e]; }
    return {
      submitted: leads.length, added, alreadyInCampaign, skipped: leads.length - added,
      skippedBy: { invalidEmail: 0, alreadyInCampaign: 0, blockList: 0, duplicate: 0, inOtherCampaign: 0, unsubscribed: 0, bounced: 0, importStopped: 0, ...this.tallies },
      invalidEmails: [...this.invalid].filter(e => leads.some(l => l.email === e)), unsubscribedEmails: [], limitExhausted: this.limitExhausted,
      ...(this.omitMap ? {} : { leads: { newlyAdded: newly, existingInCampaign: existing, existingInOtherCampaigns: { ...this.extraOther, ...listedOther } } }),
    } as SmartleadAddLeadsResult;
  }
}


/** Engine dependencies over an in-memory lead list and a FakeSmartlead; the run store is passed in (a fake or the real one). */
export function makeDeps(leads: any[], sl: FakeSmartlead, store: any, extras: { sleeps?: number[]; errors?: unknown[] } = {}): EngineDeps {
  return {
    store,
    readLeads: async (_l, after, limit) => {
      const start = after ? leads.findIndex(l => l.leadId === after.leadId) + 1 : 0;
      return { items: leads.slice(start, start + limit), hasMore: start + limit < leads.length };
    },
    readLeadConsistent: async (_l, id) => leads.find(l => l.leadId === id) ?? null,
    writeMarker: async (_l, id, key, marker) => { const l = leads.find(x => x.leadId === id)!; l.system = { ...(l.system ?? {}), [key]: marker }; },
    smartlead: {
      addLeads: x => sl.addLeads(x),
      getCampaign: async () => (sl.campaignMissing ? null : ({ id: CAMPAIGN, name: "Q4", status: sl.status } as any)),
      getSequences: async () => { if (!sl.sequences) throw new SmartleadApiError("boom", 500); return sl.sequences; },
    },
    onSmartleadError: e => { extras.errors?.push(e); },
    sleep: async ms => { extras.sleeps?.push(ms); },
    now: () => new Date("2026-10-27T01:00:00.000Z"),
  };
}
