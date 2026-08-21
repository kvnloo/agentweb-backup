import express from 'express';
import crypto from 'crypto';

const router = express.Router();

/**
 * Linear webhook — two jobs:
 *
 * 1. Resolve bridge: fires the customer-facing resolve bridge
 *    (intakeService.notifyCanonicalResolved: Resend email to every reporter whose private
 *    Featurebase card is grouped onto the canonical, Featurebase card flip to Completed, Slack ship
 *    ping) ONLY when a bug-canonical Linear issue TRANSITIONS INTO the Done state. Two guards make
 *    this precise (ENG-222):
 *
 *  1. Gate by the Done state ID (`LINEAR_DONE_STATE_ID`), not by state category. The board runs
 *     Merged -> Verifying -> Done and all three are completed-type; only Done is customer-communicable,
 *     so gating on `state.type === 'completed'` would email reporters on Merged/Verifying. We match the
 *     state ID (not name) so a rename can't silently kill or misroute the bridge — if the ID is unset
 *     we fail loud rather than fire blindly.
 *  2. Fire only on the transition INTO Done, not on every edit while the issue sits in Done. Linear's
 *     `updatedFrom` carries the prior value of each changed field, so a real state change puts the old
 *     `stateId` there; a title/label edit on an already-Done issue (or an `action:'create'`) has no
 *     `stateId` in `updatedFrom` and must fire nothing (the email + card flip are not deduped).
 *
 * 2. FB-synced issue enrichment (ENG-187 contract #4): feature requests become Linear issues via
 *    Featurebase's own FB->Linear sync (never via this repo), marked with the "Featurebase" label.
 *    On their creation event we enrich them with the reporter's funnel-stage labels + "Needs PM"
 *    and settle them in Backlog (intakeService.enrichFeaturebaseSyncedIssue). Issues created by
 *    our own code (bug canonicals, Auto issues) never carry that label and are untouched.
 *
 * Mounted with express.raw() in app.ts (BEFORE express.json) so req.body is the raw Buffer —
 * required to verify Linear's HMAC-SHA256 `linear-signature` over the exact payload bytes.
 * Set LINEAR_WEBHOOK_SECRET to enforce the signature (skipped only if unset, e.g. local);
 * verification runs before ANY event handling, both jobs included.
 */
router.post('/linear/webhook', async (req, res) => {
  try {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));

    const secret = process.env.LINEAR_WEBHOOK_SECRET || '';
    if (secret) {
      const sig = req.header('linear-signature') || '';
      const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
      const ok =
        sig.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
      if (!ok) return res.status(401).json({ error: 'invalid signature' });
    }

    const payload = JSON.parse(raw.toString('utf8'));

    // Fail loud on missing config for issue updates: without the Done-state ID we cannot safely
    // decide whether customer comms should fire. Creation-only enrichment below does not need it.
    const doneStateId = process.env.LINEAR_DONE_STATE_ID || '';
    if (payload?.type === 'Issue' && payload?.action === 'update' && payload?.data?.id && !doneStateId) {
      console.error(
        '[linear-webhook] LINEAR_DONE_STATE_ID is not set — refusing to fire resolve bridge (config missing)',
      );
      return res.status(200).json({ ok: false, error: 'LINEAR_DONE_STATE_ID not configured' });
    }

    // Only an `update` whose new state IS the Done state AND whose `updatedFrom` shows the state
    // actually changed (from something other than Done) counts as a transition into Done.
    const stateChanged =
      payload?.updatedFrom &&
      Object.prototype.hasOwnProperty.call(payload.updatedFrom, 'stateId');
    const transitionedIntoDone =
      payload?.type === 'Issue' &&
      payload?.action === 'update' &&
      payload?.data?.state?.id === doneStateId &&
      stateChanged &&
      payload.updatedFrom.stateId !== doneStateId &&
      payload?.data?.id;

    if (transitionedIntoDone) {
      const { addIssueComment, getIssueCommentsDetailed, reopenIssue } = await import('../services/linearService');
      const comments = await getIssueCommentsDetailed(payload.data.id);
      const labels = Array.isArray(payload?.data?.labels) ? payload.data.labels : [];
      const hasCustomerLabels =
        labels.some((label: any) => label?.name === 'Bug') &&
        labels.some((label: any) => label?.name === 'Customer Reported');
      // The reporter-ticket marker is the actual private-canonical notification rail. Treat it as
      // authoritative even if a Linear webhook payload ever omits expanded labels.
      const hasReporterTicket = comments.some((comment) => /\[reporter-ticket #\d+\s+[^\]\s]+\]/i.test(comment.body));
      const isCustomerBug = hasCustomerLabels || hasReporterTicket;

      if (isCustomerBug) {
        const {
          CUSTOMER_VERIFICATION_BLOCK_MARKER,
          hasCustomerSymptomVerification,
        } = await import('../services/customerClosureVerification');

        if (!hasCustomerSymptomVerification(comments)) {
          await reopenIssue(payload.data.id, 'Verifying');
          if (!comments.some((comment) => comment.body.includes(CUSTOMER_VERIFICATION_BLOCK_MARKER))) {
            await addIssueComment(
              payload.data.id,
              [
                'Customer resolution blocked: independent verification of the actual customer-facing symptom is missing.',
                '',
                'Record the check with `<!-- customer-symptom-verification:v1 -->`, `Result: pass`, `Evidence type: customer-symptom`, `Checked`, `Method`, and `Verifier`, then retry the Done transition. A merged PR or successful deploy alone is not symptom proof.',
                '',
                CUSTOMER_VERIFICATION_BLOCK_MARKER,
              ].join('\n'),
            );
          }
          return res.json({ ok: false, blocked: 'customer verification required', notified: 0 });
        }
      }

      const { notifyCanonicalResolved } = await import('../services/intakeService');
      const r = await notifyCanonicalResolved(payload.data.id, payload.data.title || undefined);
      return res.json({ ok: true, notified: r.ticketNumbers.length, ticketNumbers: r.ticketNumbers });
    }

    // FB-synced issue creation -> funnel enrichment (ENG-187 contract #4). Creation-only: the
    // "Featurebase" label is the sync's marker, and our own issueCreate calls never attach it
    // (see linearService.createInternalLinearIssue), so everything else falls through untouched.
    const created = payload?.type === 'Issue' && payload?.action === 'create' && payload?.data?.id;
    if (created) {
      const labels = payload?.data?.labels;
      if (!Array.isArray(labels)) {
        // Contract-drift guard: Linear's Issue payloads carry an expanded `labels` array today
        // (same expansion the resolve bridge relies on for `data.state`). If that ever changes,
        // FB-synced issues would silently stop enriching — make it loud instead.
        if (Array.isArray(payload?.data?.labelIds) && payload.data.labelIds.length > 0) {
          console.error(`[linear-webhook] issue ${payload.data.id} created with labelIds but NO expanded labels array — cannot detect a Featurebase-synced issue; enrichment skipped. Did Linear's payload contract drift?`);
        }
      } else if (labels.some((l: any) => l?.name === 'Featurebase')) {
        const { enrichFeaturebaseSyncedIssue } = await import('../services/intakeService');
        const r = await enrichFeaturebaseSyncedIssue({ issueId: payload.data.id, title: payload.data.title || '' });
        return res.json({ ok: true, enriched: true, labels: r.labelNames });
      }
    }
    return res.json({ ok: true, notified: 0 });
  } catch (e) {
    // Return 200 so Linear doesn't retry-storm on our own errors; log for diagnosis.
    console.error('[linear-webhook] error:', e instanceof Error ? e.message : e);
    return res.status(200).json({ ok: false });
  }
});

/**
 * Featurebase webhook -> Slack ship notification.
 *
 * Feature requests never touch our resolve bridge (Featurebase flips the post +
 * emails upvoters natively when the synced Linear issue completes), so this is the
 * hook that lets us ALSO ping the requester in their own Slack channel. Listens for
 * `post.updated` events whose changes include `status` and whose new status type is
 * `completed`, then notifies the author + voters via shipNotifyService.
 *
 * Mounted with express.raw() in app.ts — Featurebase signs `${timestamp}.${rawBody}`
 * with HMAC-SHA256 (headers X-Webhook-Signature hex + X-Webhook-Timestamp unix
 * seconds, ±5 min freshness). DARK until FEATUREBASE_WEBHOOK_SECRET is set: unlike
 * the Linear route there is no skip-verification mode, because an unauthenticated
 * body here could trigger Slack messages to customers.
 */
const FB_SIGNATURE_MAX_AGE_S = 300;

router.post('/featurebase/webhook', async (req, res) => {
  try {
    const secret = process.env.FEATUREBASE_WEBHOOK_SECRET || '';
    if (!secret) return res.json({ ok: true, ignored: 'not configured' });

    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const sig = req.header('x-webhook-signature') || '';
    const ts = req.header('x-webhook-timestamp') || '';
    const age = Math.abs(Date.now() / 1000 - Number(ts));
    const expected = crypto.createHmac('sha256', secret).update(`${ts}.${raw.toString('utf8')}`).digest('hex');
    const ok =
      !!ts &&
      Number.isFinite(age) &&
      age <= FB_SIGNATURE_MAX_AGE_S &&
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (!ok) return res.status(401).json({ error: 'invalid signature' });

    const event = JSON.parse(raw.toString('utf8'));
    const item = event?.data?.item;
    // Live-verified payload shape (2026-07-02): status changes arrive as DOTTED change
    // entries — `status.id`/`status.name`/`status.type` — not a bare `status` field.
    // Accept both spellings in case Featurebase ever flattens it.
    const statusChanged =
      Array.isArray(event?.data?.changes) &&
      event.data.changes.some(
        (c: any) => typeof c?.field === 'string' && (c.field === 'status' || c.field.startsWith('status.')),
      );
    const completed =
      event?.topic === 'post.updated' && statusChanged && item?.status?.type === 'completed' && item?.id;
    if (!completed) return res.json({ ok: true, notified: 0 });

    const { notifyPostShippedRecipients } = await import('../services/shipNotifyService');
    // Respond 200 immediately and fan out detached: per-recipient Dynamo + Slack calls
    // (rate-limited ~1 msg/sec/channel) can outlast Featurebase's delivery timeout, and
    // a timed-out delivery is retried CONCURRENTLY — the exact duplicate-ping scenario
    // the idempotency claim exists to prevent. notifyPostShippedRecipients never throws;
    // the catch is a backstop against unhandled rejections.
    notifyPostShippedRecipients({
      postId: item.id,
      title: item.title || 'your request',
      url: item.postUrl || item.url,
      authorEmail: item.author?.email,
    }).catch((e) => console.error('[featurebase-webhook] fan-out error:', e instanceof Error ? e.message : e));
    return res.json({ ok: true, accepted: true });
  } catch (e) {
    // Return 200 so Featurebase doesn't retry-storm / auto-suspend the webhook on our own errors.
    console.error('[featurebase-webhook] error:', e instanceof Error ? e.message : e);
    return res.status(200).json({ ok: false });
  }
});

export default router;
