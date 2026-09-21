/**
 * register-unipile-account-status-webhook.ts
 *
 * One-time provisioning: registers Unipile's `source: "account_status"` push
 * webhook (ENG-1197 fast-follow) so a LinkedIn session disconnect is detected
 * in near-real-time instead of only on the next polling cron cycle.
 *
 * Run once per environment (dev/staging/prod each have their own Unipile
 * credentials and their own UNIPILE_WEBHOOK_SECRET). Safe to re-run: lists
 * existing webhooks first and skips creation if one already targets the same
 * request_url.
 *
 * Usage:
 *   NODE_ENV=production UNIPILE_WEBHOOK_SECRET=<secret> \
 *     npx ts-node src/scripts/register-unipile-account-status-webhook.ts [request_url]
 *
 *   request_url defaults to `${BACKEND_URL}/api/webhooks/unipile/account-status`
 *   — override only to point at a non-default target (e.g. a cloud test env).
 */

import { linkedInOutreachService } from '../services/linkedInOutreachService';

async function main() {
  const secret = process.env.UNIPILE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('UNIPILE_WEBHOOK_SECRET must be set — this is the value Unipile will echo back on every delivery.');
    process.exit(1);
  }

  const requestUrl =
    process.argv[2] ||
    `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/webhooks/unipile/account-status`;

  const client = await linkedInOutreachService.getClient();

  const existing: any = await client.webhook.getAll();
  const duplicate = (existing?.items || []).find((w: any) => w.request_url === requestUrl);
  if (duplicate) {
    console.log(`A webhook already targets ${requestUrl} (id=${duplicate.id}). Not creating a duplicate.`);
    return;
  }

  const created = await client.webhook.create({
    source: 'account_status',
    request_url: requestUrl,
    name: 'AgentWeb LinkedIn session health (ENG-1197)',
    enabled: true,
    headers: [{ key: 'Unipile-Auth', value: secret }],
    // No account_ids filter — deliberately unscoped, so every current AND
    // future Unipile/LinkedIn account is covered without re-registering.
  });

  console.log(`Created webhook_id=${created.webhook_id} -> ${requestUrl}`);
  console.log('Save this webhook_id if you ever need to delete/update the subscription.');
}

main().catch((err) => {
  console.error('Webhook registration failed:', err);
  process.exit(1);
});
