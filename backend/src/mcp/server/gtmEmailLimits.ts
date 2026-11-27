/**
 * ENG-2840 (W2-4 follow-up): the limits on `send_gtm_status_report`, the one MCP tool that emails people.
 *
 * The scope `gtm:email` decides WHICH keys may send. These decide how much a key that may send can send, so an outside agent that loops
 * cannot turn a status report into a mail-bomb from AgentWeb's system sender:
 *
 *  - a call emails at most GTM_EMAIL_MAX_RECIPIENTS distinct people (enforced where the recipients are resolved, in the report service);
 *  - an ACCOUNT may send at most GTM_EMAIL_HOURLY_BUDGET emails in any rolling hour, all of its keys together (the tool counts by the
 *    account that owns the key, so minting more keys does not buy more). A call RESERVES the most it could send before it starts and
 *    settles to what was actually attempted afterwards, so parallel calls cannot overshoot the budget together;
 *  - the same report (same plan, phase, people chosen and message) from the same account is refused for GTM_EMAIL_COOLDOWN_MS, so an
 *    agent that retries after an ambiguous failure does not mail everyone twice.
 *
 * These bound the VOLUME, not the audience: a key that may email can email any address that is on a plan it can edit, including a contact
 * it wrote there itself with `manage_gtm_plan` (that needs only `tools:execute`). Grant `gtm:email` to an agent you trust with that.
 *
 * State is in memory and per process. Production runs ONE backend instance (Elastic Beanstalk MinSize=MaxSize=1, checked 2026-11-24), so
 * the numbers are exact there; if the backend ever scales out, each instance counts separately and the real limit is the instance count
 * times these (the audit line makes that visible). A restart empties the counters, which can only let one more hour of budget through.
 * The limiter itself only counts whatever string it is given ("key" below); the tool gives it the account.
 */
import { createHash } from 'crypto';

export const GTM_EMAIL_MAX_RECIPIENTS = 10;
export const GTM_EMAIL_HOURLY_BUDGET = 50;
export const GTM_EMAIL_WINDOW_MS = 60 * 60 * 1000;
export const GTM_EMAIL_COOLDOWN_MS = 10 * 60 * 1000;
export const GTM_EMAIL_MAX_MESSAGE_CHARS = 2000;

/** Memory bound: keys tracked at once, and identical-report fingerprints remembered per key. */
const MAX_TRACKED_KEYS = 1000;
const MAX_FINGERPRINTS_PER_KEY = 200;

interface Entry {
  at: number;
  /** Emails this call may still count against the budget: the reservation, then what was actually attempted. */
  count: number;
}

interface KeyState {
  entries: Entry[];
  /** fingerprint -> when the same report was last started */
  cooldowns: Map<string, number>;
}

export interface Ticket {
  keyId: string;
  fingerprint: string;
  entry: Entry;
}

export type Reservation =
  | { ok: true; ticket: Ticket }
  | { ok: false; reason: 'budget' | 'cooldown' | 'capacity'; retryAfterMs: number; message: string };

/** A stable fingerprint of one report: what it is about, who it goes to, and what it says. The message is hashed, never stored. */
export function reportFingerprint(parts: { planId: string; phaseId?: string; flags: Record<string, boolean>; message?: string }): string {
  const flags = Object.keys(parts.flags).sort().map((k) => [k, parts.flags[k]]);
  return createHash('sha256').update(JSON.stringify([parts.planId, parts.phaseId ?? null, flags, parts.message ?? ''])).digest('hex');
}

const minutes = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

export class GtmEmailLimiter {
  private readonly keys = new Map<string, KeyState>();

  constructor(private readonly clock: () => number = Date.now) {}

  /** Start a send: refuse it (cooldown or budget), or reserve `amount` emails against the key's hour and hand back a ticket. */
  reserve(keyId: string, fingerprint: string, amount: number): Reservation {
    const now = this.clock();
    let state = this.keys.get(keyId);
    if (!state) {
      if (this.keys.size >= MAX_TRACKED_KEYS) this.sweep(now);
      if (this.keys.size >= MAX_TRACKED_KEYS) {
        // Never evict a key that is being counted (that would reset its limits): refuse until one of them goes quiet.
        return { ok: false, reason: 'capacity', retryAfterMs: 60_000, message: 'Too many accounts are emailing right now. Nothing was emailed. Try again in about a minute.' };
      }
      state = { entries: [], cooldowns: new Map() };
      this.keys.set(keyId, state);
    }
    this.prune(state, now);

    const last = state.cooldowns.get(fingerprint);
    if (last !== undefined && now - last < GTM_EMAIL_COOLDOWN_MS) {
      const retryAfterMs = GTM_EMAIL_COOLDOWN_MS - (now - last);
      return {
        ok: false, reason: 'cooldown', retryAfterMs,
        message: `An identical report (same plan, phase, people chosen and message) was started from this account less than ${minutes(GTM_EMAIL_COOLDOWN_MS)} minutes ago. Nothing was emailed. To send it again, change the message or wait about ${minutes(retryAfterMs)} minutes.`,
      };
    }

    const used = state.entries.reduce((sum, e) => sum + e.count, 0);
    if (used + amount > GTM_EMAIL_HOURLY_BUDGET) {
      // when enough of the oldest sends have left the hour for this one to fit
      let freed = 0;
      let retryAfterMs = GTM_EMAIL_WINDOW_MS;
      for (const e of [...state.entries].sort((a, b) => a.at - b.at)) {
        freed += e.count;
        if (used - freed + amount <= GTM_EMAIL_HOURLY_BUDGET) { retryAfterMs = e.at + GTM_EMAIL_WINDOW_MS - now; break; }
      }
      return {
        ok: false, reason: 'budget', retryAfterMs: Math.max(0, retryAfterMs),
        message: `This account has already sent, or has in flight, ${used} of the ${GTM_EMAIL_HOURLY_BUDGET} emails it may send in an hour (all of its API keys together), and this report could send up to ${amount} more. Nothing was emailed. Try again in about ${minutes(retryAfterMs)} minutes.`,
      };
    }

    const entry: Entry = { at: now, count: amount };
    state.entries.push(entry);
    state.cooldowns.set(fingerprint, now);
    if (state.cooldowns.size > MAX_FINGERPRINTS_PER_KEY) {
      // oldest first: a Map iterates in insertion order and the fingerprint just set is last
      for (const stale of state.cooldowns.keys()) {
        if (state.cooldowns.size <= MAX_FINGERPRINTS_PER_KEY) break;
        state.cooldowns.delete(stale);
      }
    }
    return { ok: true, ticket: { keyId, fingerprint, entry } };
  }

  /**
   * The send finished: only what was actually attempted counts against the hour (never more than was reserved). A number that is not
   * finite (NaN would turn every later budget check into "fits") leaves the whole reservation in place, the cautious reading.
   */
  settle(ticket: Ticket, attempted: number): void {
    if (typeof attempted !== 'number' || !Number.isFinite(attempted)) return;
    ticket.entry.count = Math.max(0, Math.min(Math.floor(attempted), ticket.entry.count));
  }

  /** Nothing was sent (the route refused before sending): give the whole reservation back and allow the same report to be retried at once. */
  release(ticket: Ticket): void {
    ticket.entry.count = 0;
    const state = this.keys.get(ticket.keyId);
    if (state?.cooldowns.get(ticket.fingerprint) === ticket.entry.at) state.cooldowns.delete(ticket.fingerprint);
  }

  /** Emails counted against `keyId` in the last hour, reservations included. For the audit line and tests. */
  used(keyId: string): number {
    const state = this.keys.get(keyId);
    if (!state) return 0;
    this.prune(state, this.clock());
    return state.entries.reduce((sum, e) => sum + e.count, 0);
  }

  private prune(state: KeyState, now: number): void {
    // an entry that has settled or been released to 0 counts for nothing: drop it, so refused calls cannot pile up entries or keep a key tracked
    state.entries = state.entries.filter((e) => e.count > 0 && now - e.at < GTM_EMAIL_WINDOW_MS);
    for (const [fingerprint, at] of state.cooldowns) {
      if (now - at >= GTM_EMAIL_COOLDOWN_MS) state.cooldowns.delete(fingerprint);
    }
  }

  private sweep(now: number): void {
    for (const [keyId, state] of this.keys) {
      this.prune(state, now);
      if (state.entries.length === 0 && state.cooldowns.size === 0) this.keys.delete(keyId);
    }
  }
}

/** The limiter the tool uses: one per process. */
export const gtmEmailLimiter = new GtmEmailLimiter();
