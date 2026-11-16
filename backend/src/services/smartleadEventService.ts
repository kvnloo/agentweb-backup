import { isDoNotContact } from "../utils/leadContactStatus";
import { getSmartleadMarker } from "./smartleadMarkers";
import type { SmartleadEvent } from "./smartleadEvents";
import type { ContactEventKind } from "./smartleadPushRunDb";

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
  /**
   * Counts one contact of a push run as replied, bounced or unsubscribed, for the run view. Display only: a failure here is logged and never
   * changes what happens to the contact. Optional so the handler works without a run store.
   */
  countContactEvent?(runId: string, kind: ContactEventKind): Promise<void>;
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

interface PendingCount { runId: string; kind: ContactEventKind }
/** The most a response waits for the run counters (see flushCounts). */
const COUNT_WAIT_MS = 2000;

const has = (lead: Lead, key: string): boolean =>
  Array.isArray(lead.engagements) && lead.engagements.some((e: any) => e?.eventData?.smartleadEventKey === key);

const isRace = (e: unknown): boolean => !!e && typeof e === "object" && (e as { preconditionFailed?: boolean }).preconditionFailed === true;

export class SmartleadEventService {
  constructor(private readonly deps: EventDeps) {}

  async handle(ctx: { accountId: string; campaignId: number }, event: SmartleadEvent): Promise<EventOutcome> {
    const out: EventOutcome = { matched: 0, changed: 0, duplicates: 0 };
    if (event.campaignId !== ctx.campaignId) return out; // the body names another campaign than the URL: not ours to act on

    const pending: PendingCount[] = [];
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
    try {
      for (const address of event.candidateEmails) {
        const seen = new Set<string>();
        const matches: Array<{ lead: Lead; campaignName?: string; runId: string }> = [];
        const found = await this.deps.findLeadsByEmail(address);
        // The Smartlead lead behind a contact is ONE lead across all of the account's campaigns, and our withdrawal unsubscribes it account-wide
        // (verified on a real account, 2026-10-30: unsubscribing it in one campaign shows it unsubscribed and blocked in the others too). So once
        // ANY marker of ANY of these leads is withdrawn, the poll must not read that opt-out back as news in another campaign or list either.
        // The index spans every customer, so a withdrawn marker counts only when its own run belongs to THIS Smartlead account: another customer's marker
        // that happens to carry the same id text must never suppress ours.
        const withdrawnSmartleadIds = new Set<string>();
        if (event.polled && event.kind !== "reply") {
          const runAccount = new Map<string, Promise<string | undefined>>();
          const accountOf = (runId: string) => {
            let p = runAccount.get(runId);
            if (!p) { p = this.deps.getRun(runId).then(r => r?.smartleadAccountId); runAccount.set(runId, p); }
            return p;
          };
          for (const l of found) {
            for (const [key, value] of Object.entries((l?.system ?? {}) as Record<string, any>)) {
              if (!key.startsWith("smartlead_") || !value || typeof value.smartleadLeadId !== "string" || typeof value.runId !== "string") continue;
              if (!(value.state === "withdrawn" || !!value.withdrawnAt)) continue;
              if ((await accountOf(value.runId)) === ctx.accountId) withdrawnSmartleadIds.add(value.smartleadLeadId);
            }
          }
        }
        for (const lead of found) {
          const id = `${lead?.listId}/${lead?.leadId}`;
          if (!lead?.listId || !lead?.leadId || seen.has(id)) continue;
          seen.add(id);
          const marker = getSmartleadMarker(lead, ctx.campaignId);
          if (!marker || typeof marker.runId !== "string" || !marker.runId) continue;
          // Once our own withdrawal has unsubscribed a blocked contact in Smartlead (`withdrawn`, or `released` afterwards, which keeps `withdrawnAt`),
          // Smartlead lists that contact as unsubscribed for good: reading it back would re-block a contact a user has since resubscribed in the CRM.
          // A reply has no such risk, and a contact released without a withdrawal is still live in Smartlead, so both are still read.
          if (event.polled && event.kind !== "reply" && (marker.state === "withdrawn" || !!marker.withdrawnAt || (!!marker.smartleadLeadId && withdrawnSmartleadIds.has(marker.smartleadLeadId)))) continue;
          const r = await proven(marker.runId);
          if (r.ok) matches.push({ lead, campaignName: r.name, runId: marker.runId });
        }
        if (matches.length === 0) continue;
        for (const m of matches) {
          out.matched++;
          const r = await this.apply(event, m.lead, m.campaignName, m.runId, pending);
          out.changed += r.changed;
          out.duplicates += r.duplicate;
        }
        break;
      }
    } finally {
      // The run counters are for display and are written only now: after every contact's reply, alert and block is done, so no counter can
      // come before or hold up another contact's opt-out (a contact in two lists is two blocks), and the wait itself is capped.
      await this.flushCounts(pending);
    }
    return out;
  }

  private async apply(event: SmartleadEvent, lead: Lead, campaignName: string | undefined, runId: string, pending: PendingCount[]): Promise<{ changed: number; duplicate: number }> {
    const now = this.deps.now().toISOString();
    // Never later than our own clock: this time is compared with the stamp of a status change made here (a user's Resubscribe), and Smartlead's
    // clock running ahead would otherwise make an old opt-out look newer than the Resubscribe that followed it.
    const at = event.occurredAt && Date.parse(event.occurredAt) < Date.parse(now) ? event.occurredAt : now;
    const base = { source: "smartlead", smartleadEventKey: event.eventKey, campaignId: event.campaignId, ...(campaignName ? { campaign: campaignName } : {}) };
    let changed = 0;
    let duplicate = 0;

    // Set when the poll finds the opt-out or bounce already on the contact but the block never landed: only the status is left to write.
    let engagementOnFile = false;
    if (event.polled) {
      // The poll cannot tell whether the webhook already delivered this event (it has no event id, and Smartlead keeps listing a contact for good),
      // so it applies only what the contact does not already show.
      const here: any[] = (Array.isArray(lead.engagements) ? lead.engagements : []).filter((e: any) => e?.eventData?.source === "smartlead" && Number(e?.eventData?.campaignId) === event.campaignId);
      if (event.kind === "reply") {
        // A SECOND reply missed by the webhook is not seen by the poll; a missed first one is.
        if (here.some(e => e?.eventType === "email.received")) return { changed: 0, duplicate: 1 };
      } else {
        // Only the SAME kind of event counts as "already shown": a temporary bounce never blocked the contact, and after a bounce, a
        // Resubscribe and a corrected address, a later opt-out (or the other way round) is a new event that must still land.
        const blocking = here.filter(e => event.kind === "unsubscribe" ? e?.eventType === "email.unsubscribed" : e?.eventType === "email.bounced" && e?.eventData?.soft !== true);
        if (blocking.length > 0) {
          // On file: either the block landed and a user has since lifted it (the status was written at or after the event: leave a Resubscribe
          // alone), or the status write failed after the engagement was recorded (finish it). Read fresh: a stale read here would undo a Resubscribe.
          const fresh = (await this.deps.readLeadConsistent(lead.listId, lead.leadId)) ?? lead;
          const latest = Math.max(...blocking.map(e => Date.parse(e?.createdAt) || 0));
          const stamped = Date.parse(fresh.contactStatusUpdatedAt) || 0;
          if (isDoNotContact(fresh) || stamped >= latest) return { changed: 0, duplicate: 1 };
          engagementOnFile = true;
        } else if (isDoNotContact(lead) || (event.kind === "bounce" && here.some(e => e?.eventType === "email.bounced"))) {
          // Already blocked by other means, or the bounce on file is the temporary one the poll is now listing (it cannot tell them apart).
          return { changed: 0, duplicate: 1 };
        }
      }
    }

    if (event.kind === "reply") {
      const data = { ...base, ...(event.subject ? { subject: event.subject } : {}), ...(event.from ? { from: event.from } : {}), ...(event.to ? { to: event.to } : {}) };
      const added = await this.record(lead, "email.received", data, at);
      if (!added.recorded) return { changed: 0, duplicate: 1 };
      changed++;
      try {
        const list = await this.deps.getList(lead.listId);
        // The alert goes out only for a reply that was newly recorded, through the list's own alert setting (email.received is its default event).
        // The reply's own words go to the owner's alert only: `data` above is what is stored on the contact, and the full reply stays in Smartlead.
        if (list) await this.deps.notify(list, added.lead, "email.received", event.replyText ? { ...data, replyText: event.replyText } : data, at);
      } catch (e) {
        this.deps.log(`[SmartleadEvents] reply alert failed for list ${lead.listId}: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.wantCount(pending, runId, "replied", event, added.lead, "email.received");
      return { changed, duplicate };
    }

    const bounced = event.kind === "bounce";
    // No free text here (the campaign's name, Smartlead's reason): the CRM scans event data for words like "received" to decide a contact is
    // engaged, and a bounced or opted-out contact must never look engaged. The reason goes only into the status note below.
    const added = engagementOnFile ? { recorded: false, lead } : await this.record(lead, bounced ? "email.bounced" : "email.unsubscribed", { source: "smartlead", smartleadEventKey: event.eventKey, campaignId: event.campaignId, ...(bounced && event.soft ? { soft: true } : {}) }, at);
    if (added.recorded) changed++; else duplicate++;
    if (bounced && event.soft) return { changed, duplicate }; // a temporary bounce is recorded, the contact is not blocked

    // Re-read before writing the status: an admin may have blocked this contact with their own reason, and that must not be overwritten.
    const current = (await this.deps.readLeadConsistent(lead.listId, lead.leadId)) ?? added.lead;
    // Already blocked (by an admin, an earlier bounce, or our own withdrawal that Smartlead reports back as an unsubscribe): nothing to write, and
    // not a contact's own act, so it is not counted.
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
    // Counted when THIS call wrote the block (so a retry after a failed write still counts, and an echo of our own withdrawal does not).
    this.wantCount(pending, runId, bounced ? "bounced" : "unsubscribed", event, added.lead, bounced ? "email.bounced" : "email.unsubscribed");
    return { changed, duplicate };
  }

  /**
   * Notes that this contact is to be counted once per kind for its run, unless `before` (the contact as it stood before this event was recorded)
   * already showed an event of the same kind from this campaign: a second reply, or the poll finding what a webhook had delivered. This
   * event's own engagement is ignored, so it does not matter whether the snapshot has been updated since. A hard bounce only: a temporary
   * one is not a contact lost. Does no I/O.
   */
  private wantCount(pending: PendingCount[], runId: string, kind: ContactEventKind, event: SmartleadEvent, before: Lead, eventType: string): void {
    if (!this.deps.countContactEvent) return;
    const seen = (Array.isArray(before.engagements) ? before.engagements : []).some(
      (e: any) => e?.eventData?.smartleadEventKey !== event.eventKey && e?.eventType === eventType && e?.eventData?.source === "smartlead" && Number(e?.eventData?.campaignId) === event.campaignId && !(kind === "bounced" && e?.eventData?.soft === true),
    );
    if (!seen) pending.push({ runId, kind });
  }

  /** A log line that can never throw: the counters must not be able to replace the error of the loop they follow. */
  private safeLog(line: string): void {
    try {
      this.deps.log(line);
    } catch {
      // nothing left to do with a broken logger
    }
  }

  /** Writes the counters noted by wantCount. Never throws, and gives up waiting after COUNT_WAIT_MS: a slow run table must not hold the response. */
  private async flushCounts(pending: PendingCount[]): Promise<void> {
    if (pending.length === 0 || !this.deps.countContactEvent) return;
    const count = this.deps.countContactEvent.bind(this.deps);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      for (const p of pending) {
        try {
          await count(p.runId, p.kind);
        } catch (e) {
          this.safeLog(`[SmartleadEvents] run counter (${p.kind}) failed for run ${p.runId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    })();
    const gaveUp = new Promise<void>(resolve => { timer = setTimeout(() => { this.safeLog(`[SmartleadEvents] run counters still pending after ${COUNT_WAIT_MS} ms, not waiting`); resolve(); }, COUNT_WAIT_MS); });
    try {
      await Promise.race([work, gaveUp]);
    } finally {
      if (timer) clearTimeout(timer);
    }
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
