/**
 * One-off migration: temporarily bump every tier's monthlyTokenAllowance by a
 * multiplier (default 3x) so users don't hit token exhaustion when this PR starts
 * counting previously-uncharged LLM spend (coding-agent, deep research, image/video,
 * social engagement, agent sub-tools) against the token cap.
 *
 * Only FINITE allowances are scaled — unlimited tiers (null/undefined) are left
 * untouched (never turned into NaN). Cost is not gated yet, so an over-generous
 * token cap carries no runaway-cost risk; this is a stopgap until real spend data
 * lets us right-size the token cap and set the cost cap.
 *
 * Usage (dev):
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/bumpTokenAllowance.ts dry-run
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/bumpTokenAllowance.ts apply
 *   NODE_ENV=development npx ts-node --transpile-only src/scripts/bumpTokenAllowance.ts restore
 * Prod: same commands with NODE_ENV=production. ALWAYS run dry-run first.
 *
 * Idempotency: `apply` refuses to run if a backup already exists (i.e. already
 * bumped) — run `restore` first. `restore` writes the pre-bump values back.
 */
import { settingsService } from '../services/settingsService';

const SETTING = 'subscription_types';
const BACKUP = 'subscription_types_token_bump_backup';
const MULTIPLIER = Number(process.env.BUMP_MULTIPLIER || 3);

interface Tier { name: string; monthlyTokenAllowance?: number | null; [k: string]: unknown }

function scale(tiers: Tier[], factor: number): { next: Tier[]; changes: string[] } {
  const changes: string[] = [];
  const next = tiers.map((t) => {
    const cur = t.monthlyTokenAllowance;
    if (typeof cur === 'number' && Number.isFinite(cur) && cur > 0) {
      const bumped = Math.round(cur * factor);
      changes.push(`  ${t.name}: ${cur.toLocaleString()} -> ${bumped.toLocaleString()}`);
      return { ...t, monthlyTokenAllowance: bumped };
    }
    changes.push(`  ${t.name}: ${cur == null ? 'unlimited' : cur} (unchanged)`);
    return t;
  });
  return { next, changes };
}

async function readTiers(): Promise<Tier[]> {
  const s = await settingsService.getSetting(SETTING);
  if (!s) throw new Error(`Setting "${SETTING}" not found`);
  return JSON.parse(s.settingValue) as Tier[];
}

async function main() {
  const mode = process.argv[2] || 'dry-run';
  const env = process.env.NODE_ENV || 'development';

  if (mode === 'restore') {
    const b = await settingsService.getSetting(BACKUP);
    const parsed = b?.settingValue ? JSON.parse(b.settingValue) : null;
    if (!parsed?.original) throw new Error('No pre-bump backup found — nothing to restore.');
    await settingsService.setSetting(SETTING, parsed.original, undefined, 'token-bump-restore');
    // Invalidate the backup so a future apply is allowed again.
    await settingsService.setSetting(BACKUP, JSON.stringify({ restored: true }), undefined, 'token-bump-restore');
    console.log(`[${env}] restored ${SETTING} to pre-bump values.`);
    return;
  }

  const tiers = await readTiers();
  const { next, changes } = scale(tiers, MULTIPLIER);
  console.log(`[${env}] ${SETTING} — ${MULTIPLIER}x token allowance (finite tiers only):`);
  changes.forEach((c) => console.log(c));

  if (mode === 'dry-run') {
    console.log('\n(dry-run — no changes written. Re-run with "apply" to persist.)');
    return;
  }
  if (mode !== 'apply') throw new Error(`Unknown mode "${mode}" (use dry-run | apply | restore)`);

  const existingBackup = await settingsService.getSetting(BACKUP);
  const backupParsed = existingBackup?.settingValue ? JSON.parse(existingBackup.settingValue) : null;
  if (backupParsed?.original) {
    throw new Error('A pre-bump backup already exists — already bumped. Run "restore" first to avoid compounding (would become 9x).');
  }

  const current = await settingsService.getSetting(SETTING);
  await settingsService.setSetting(
    BACKUP,
    JSON.stringify({ original: current!.settingValue, multiplier: MULTIPLIER }),
    'pre-bump snapshot for bumpTokenAllowance restore',
    'token-bump'
  );
  await settingsService.setSetting(SETTING, JSON.stringify(next), current?.description, 'token-bump');
  console.log(`\n[${env}] applied ${MULTIPLIER}x. Backup saved under "${BACKUP}". Undo with: ...bumpTokenAllowance.ts restore`);
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
