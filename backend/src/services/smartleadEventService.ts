import { isDoNotContact } from "../utils/leadContactStatus";
import { getSmartleadMarker } from "./smartleadMarkers";
import type { SmartleadEvent } from "./smartleadEvents";

/**
 * Applies a Smartlead event (a reply, a bounce, an unsubscribe) to the CRM contact it is about (ENG-673, slice 3). All outside access is injected.
 *
 * FINDING THE CONTACT without any new storage: the leads table already has a global lookup by email (`EmailLookupIndex`). It spans EVERY
 * customer, so a hit is only trusted when it proves it was pushed to THIS campaign through THIS Smartlead account: the lead carries the
 * marker `system.smartlead_<campaignId>`, and the run that marker names recorded the same account and campaign. Anything else is skipped
 * (fails closed), the same rule the Calendly webhook applies to the same index.
 *
 * REPLAYS DO NOTHING TWICE without an event table: every effect is idempotent by state. A reply or bounce is recorded as an engagement carrying
 * the event key and skipped when that key is already on the contact (the append is compare-and-swapped on the lead's updatedAt, so two deliveries
 * racing cannot both append); do-not-contact is only set when the contact is not already blocked, so a second delivery, and the loop where our own
 * withdrawal sweep unsubscribes a blocked contact in Smartlead and Smartlead then reports that unsubscribe back, change nothing.
 */
type Lead = Record<string, any>;

export interface EventDeps {
  /** Every lead with this address across all lists (the global email lookup, all pages). */
  findLeadsByEmail(email: string): Promise<Lead[]>;
  getRun(runId: string): Promise<{ smartleadAccountId?: string; campaignId?: number; campaignName?: string } | null>;
  getList(listId: string): Promise<Lead | null>;
  readLeadConsistent(listId: string, leadId: string): Promise<Lead | null>;
  /** Appends one engagement. Throws an error with `preconditionFailed: true` when `expectedUpdatedAt` no longer matches. */
  addEngagement(listId: string, leadId: string, engagement: { eventType: string; eventData: any; createdAt: string }, opts: { expectedUpdatedAt?: string }): Promise<void>;
  setContactStatus(listId: string, leadId: string, fields: Record<string, unknown>): Promise<void>;
  /** The list owner's alert; best effort. */
  notify(list: Lead, lead: Lead, eventType: string, eventData: any, createdAt: string): Promise<void>;
  now(): Date;
  log(line: string): void;
}

export interface EventOutcome {
  /** Contacts that proved they belong to this account and campaign. */
  matched: number;
  /** Effects that changed something (an engagement added, a contact blocked). */
  changed: number;
  /** Effects skipped because the same event had already been applied. */
  duplicates: number;
}

const has = (lead: Lead, key: string): boolean =>
  Array.isArray(lead.engagements) && lead.engagements.some((e: any) => e?.eventData?.smartleadEventKey === key);

const isRace = (e: unknown): boolean => !!e && typeof e === "object" && (e as { preconditionFailed?: boolean }).preconditionFailed === true;

export class SmartleadEventService {
  constructor(private readonly deps: EventDeps) {}

  async handle(ctx: { accountId: string; campaignId: number }, event: SmartleadEvent): Promise<EventOutcome> {
    const out: EventOutcome = { matched: 0, changed: 0, duplicates: 0 };
    if (event.campaignId !== ctx.campaignId) return out; // the body names another campaign than the URL: not ours to act on

    const runOk = new Map<string, Promise<{ ok: boolean; name?: string }>>();
    const proven = (runId: string) => {
      let p = runOk.get(runId);
      if (!p) {
        p = this.deps.getRun(runId).then(r => ({ ok: !!r && r.smartleadAccountId === ctx.accountId && Number(r.campaignId) === ctx.campaignId, name: r?.campaignName }));
        runOk.set(runId, p);
      }
      return p;
    };

    // One event is about one contact: the first candidate address that matches wins, the rest are not tried.
    for (const address of event.candidateEmails) {
      const seen = new Set<string>();
      const matches: Array<{ lead: Lead; campaignName?: string }> = [];
      for (const lead of await this.deps.findLeadsByEmail(address)) {
        const id = `${lead?.listId}/${lead?.leadId}`;
        if (!lead?.listId || !lead?.leadId || seen.has(id)) continue;
        seen.add(id);
        const marker = getSmartleadMarker(lead, ctx.campaignId);
        if (!marker || typeof marker.runId !== "string" || !marker.runId) continue;
        const r = await proven(marker.runId);
        if (r.ok) matches.push({ lead, campaignName: r.name });
      }
      if (matches.length === 0) continue;
      for (const m of matches) {
        out.matched++;
        const r = await this.apply(event, m.lead, m.campaignName);
        out.changed += r.changed;
        out.duplicates += r.duplicate;
      }
      break;
    }
    return out;
  }

  private async apply(event: SmartleadEvent, lead: Lead, campaignName?: string): Promise<{ changed: number; duplicate: number }> {
    const now = this.deps.now().toISOString();
    const at = event.occurredAt ?? now;
    const base = { source: "smartlead", smartleadEventKey: event.eventKey, campaignId: event.campaignId, ...(campaignName ? { campaign: campaignName } : {}) };
    let changed = 0;
    let duplicate = 0;

    if (event.kind === "reply") {
      const data = { ...base, ...(event.subject ? { subject: event.subject } : {}), ...(event.from ? { from: event.from } : {}), ...(event.to ? { to: event.to } : {}) };
      const added = await this.record(lead, "email.received", data, at);
      if (!added.recorded) return { changed: 0, duplicate: 1 };
      changed++;
      try {
        const list = await this.deps.getList(lead.listId);
        // The alert goes out only for a reply that was newly recorded, through the list's own alert setting (email.received is its default event).
        if (list) await this.deps.notify(list, added.lead, "email.received", data, at);
      } catch (e) {
        this.deps.log(`[SmartleadEvents] reply alert failed for list ${lead.listId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { changed, duplicate };
    }

    const bounced = event.kind === "bounce";
    const added = await this.record(lead, bounced ? "email.bounced" : "email.unsubscribed", { ...base, ...(bounced && event.soft ? { soft: true } : {}), ...(event.reason ? { reason: event.reason } : {}) }, at);
    if (added.recorded) changed++; else duplicate++;
    if (bounced && event.soft) return { changed, duplicate }; // a temporary bounce is recorded, the contact is not blocked

    // Re-read before writing the status: an admin may have blocked this contact with their own reason, and that must not be overwritten.
    const current = (await this.deps.readLeadConsistent(lead.listId, lead.leadId)) ?? added.lead;
    if (isDoNotContact(current)) return { changed, duplicate };
    await this.deps.setContactStatus(lead.listId, lead.leadId, {
      contactStatus: bounced ? "do-not-contact" : "unsubscribed",
      contactStatusReason: bounced ? "bounced" : "opted-out",
      contactStatusNote: bounced ? `Bounced in Smartlead${event.reason ? `: ${event.reason}` : ""}` : "Unsubscribed in Smartlead",
      contactStatusUpdatedAt: now,
      contactStatusUpdatedBy: "system",
      unsubscribedFromGroupEmail: true,
      unsubscribedFromGroupEmailAt: now,
    });
    changed++;
    return { changed, duplicate };
  }

  /** Appends the engagement unless this event is already on the contact; one re-read and retry when another write got in between. */
  private async record(lead: Lead, eventType: string, eventData: Record<string, unknown>, createdAt: string): Promise<{ recorded: boolean; lead: Lead }> {
    let current = lead;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (has(current, String(eventData.smartleadEventKey))) return { recorded: false, lead: current };
      try {
        await this.deps.addEngagement(lead.listId, lead.leadId, { eventType, eventData, createdAt }, { expectedUpdatedAt: typeof current.updatedAt === "string" ? current.updatedAt : undefined });
        return { recorded: true, lead: current };
      } catch (e) {
        if (!isRace(e)) throw e;
        current = (await this.deps.readLeadConsistent(lead.listId, lead.leadId)) ?? current;
      }
    }
    throw new Error("could not record the event after a concurrent write"); // the route answers 5xx, Smartlead retries, state decides what is left to do
  }
}
