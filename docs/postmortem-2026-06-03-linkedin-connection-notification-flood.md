# Post-mortem: LinkedIn "Invitation Accepted" Notification Flood

- **Date of incident:** 2026-06-03
- **Window:** ~16:33–16:42 UTC (≈9 minutes)
- **Author:** Rui Wang (with Claude Code)
- **Status:** Mitigated (self-terminated + kill-switch added); fixes pending in PR #1752
- **Severity:** High — client-facing notification spam; risk of outbound message spam to clients' prospects

## Summary

A LinkedIn connection-sync cron sent a burst of ~86 "X accepted your LinkedIn
invitation" notifications (email + Slack) to a single account owner
(`murray.newlands@gmail.com`) over ~9 minutes. The notifications were for
**old, already-accepted** connections — not new acceptances. They were triggered
when a Unipile account ran a **one-time full backfill** of its ~3,447 historical
connections into our cache, and the cron treated every backfilled connection as
a freshly-accepted invitation.

No connection *invites* were sent to prospects during this incident (the cron
only reacts to already-accepted connections; it does not send invites). However,
the same code path also **auto-enrolls** accepted leads into drip sequences,
which *can* send outbound messages to prospects — so the blast radius was larger
than the visible emails.

## Impact

- **~86** acceptance notifications (email + Slack) to **one** owner in 9 minutes.
- Affected list: `list_1776558909356_4e0g4dxrt` ("Master Contact Data with
  Enrichment") — **132,363 leads, 32,298 with LinkedIn URLs**, freshly imported.
- Affected Unipile account: `LIBGE2pYS1eckwgo7wUIGQ` (**3,447 cached connections**).
- Owner user: `9fde4157-e73f-4f0e-9d3a-ac8fe97b35ec`.
- The flood **self-terminated** at 16:42 once the backfill completed and the
  cache watermark advanced past all connections. Per-lead de-dup
  (`lead.system.linkedInConnectionNotifiedAt`) was working, so each lead fired
  exactly once — it was a one-time burst, not a per-cron repeat.

## Timeline (UTC, 2026-06-03)

| Time  | Event |
|-------|-------|
| 14:26 | Commit `570dc302` ("backfill partial LinkedIn connection caches…") authored and later merged/deployed to `main`. |
| 16:33 | First acceptance notification fires. |
| 16:33–16:42 | ~86 notifications sent to `murray.newlands@gmail.com`. |
| 16:42 | Last notification; backfill complete, watermark advanced. Flood stops on its own. |
| ~16:45+ | Incident investigated; confirmed stopped across multiple 10-min cron cycles. |
| 17:xx | Root-cause fixes (PR #1752) + kill-switch added. |

## Root cause

The connection-sync cron (`backend/src/cron/linkedInConnectionSyncCron.ts`)
runs every 10 minutes. For each Unipile account it:
1. Syncs recent connections into the `AW-UnipileConnections` cache.
2. For each **newly detected** connection, calls `notifyNewConnections`
   (owner email/Slack) and `enrollNewConnections` (drip-sequence enrollment).

The notion of "newly detected" is whatever `syncConnectionsForAccount` returns.
On a **full backfill** that is *every connection in the account*, including ones
accepted months ago.

Two changes combined to cause the flood:

1. **Pre-existing bug:** `notifyNewConnections` / `enrollNewConnections` never
   distinguished a one-time historical backfill from genuinely-new acceptances.
   Backfilled connections were treated as fresh acceptances.

2. **Trigger — commit `570dc302`:** to fix a separate problem ("Send Invite"
   shown for already-connected leads), this commit extended the forced full
   backfill from *empty* caches to *partial* caches as well, gated on a new
   `__fullsync__` marker. Every pre-existing account therefore performs a
   one-time full backfill. For an account with thousands of connections mapped
   to a freshly-imported 132k-lead list, that backfill produced ~thousands of
   "new" connections at once → the notification burst.

### Contributing factors

- **No sender gate.** The affected list had **no** assigned LinkedIn sender
  (`linkedInAccountId`), yet it was still notified. Notifications should only
  fire for lists whose assigned sender matches the connection's account.
- **Slack coupling.** Acceptance alerts also posted to Slack, doubling the noise.
- **No kill-switch.** There was no way to mute the behavior without a code change.

## What went right

- Per-lead de-dup prevented an infinite per-cron repeat.
- The backfill is one-time per account (marker-gated), so it self-terminated.
- Read-only investigation (DynamoDB queries + EB log retrieval) confirmed scope
  quickly without touching prod data.

## What went wrong

- Historical backfill was indistinguishable from real-time acceptance.
- Side effects (owner alerts + outbound enrollment) ran with no global off-switch.
- The notification lacked a sender-scoping guard, so it fired for an unrelated list.

## Resolution & action items

### Immediate mitigation (this change)

- **Kill-switch (default OFF):** `notifyNewConnections` and `enrollNewConnections`
  now no-op unless `LINKEDIN_CONNECTION_NOTIFY=true` / `LINKEDIN_CONNECTION_ENROLL=true`
  respectively. Connection caching (the "already connected" detection other CRM
  features depend on) is unaffected. To re-enable after verification, set the env
  vars in the Elastic Beanstalk environment and redeploy.

### Root-cause fixes (PR #1752)

1. **Backfill suppression** — `runLinkedInConnectionSync` checks the
   `__fullsync__` marker (`getFullSyncCompletedAt`) *before* syncing each
   account. On the one-time backfill (marker absent — covers BOTH empty and
   partial caches), connections are cached **silently**: no notify, no enroll.
2. **Sender gate** — notify only when the lead's list has an assigned LinkedIn
   sender (`linkedInAccountId`) that equals the connection's `accountId`.
3. **Email-only** — removed Slack from acceptance alerts.
4. **URL-variant matching** — query both slash / no-slash LinkedIn URL variants
   so genuine acceptances match the stored lead (the original "stopped sending"
   bug).

Regression tests cover the empty-cache backfill, the **partial-cache** backfill
(the exact flood scenario), the sender gate, URL-variant matching, and the
kill-switch defaults.

### Follow-ups (tracked separately)

- [ ] Re-enable `LINKEDIN_CONNECTION_NOTIFY` / `LINKEDIN_CONNECTION_ENROLL` only
      after PR #1752 is deployed and verified in prod.
- [ ] Consider a per-owner/per-window rate limit on owner notifications as a
      backstop against any future bulk-detection bug.
- [ ] Consider an admin runtime toggle (DB setting) instead of env-var + redeploy
      for faster future mitigation.
- [ ] Audit other cron side effects (enrollment, drips) for "bulk historical
      data treated as real-time events" patterns.

## Lessons

- Any code that turns cached/imported data into **real-time events** (emails,
  messages, enrollments) must distinguish a one-time backfill from live activity.
- Outbound, client-facing side effects deserve a **default-safe kill-switch** from
  day one.
- A fix for one symptom (full backfill for partial caches) can expose a latent
  bug elsewhere — review the downstream consumers of any data-volume change.
