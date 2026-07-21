/**
 * Reusable-twin session helper for the opt-in Arga twin suites (ENG-401/ENG-402).
 *
 * WHY THIS EXISTS (the reusable-twin pattern, per Arga founder Akira's guidance):
 * the free plan meters provisioning against a small monthly quota (10 runs). The
 * original suites provisioned a FRESH twin inside each `beforeAll`, so every test
 * run burned quota. Instead we provision ONE session out-of-band via
 * `npm run test:twins:setup`, persist its coordinates to a gitignored
 * `.env.twins.json`, and let the suites REUSE it — resetting to baseline between
 * tests for isolation. Teardown is `npm run test:twins:teardown`.
 *
 * This module consolidates what used to live in `twinAvailability.ts` (deleted):
 * the quota/auth pre-flight (`resolveTwinRunner`, now used by the setup script)
 * plus the new config-driven session accessors the suites consume.
 *
 * Not a `*.test.ts` file, so Jest never treats it as a suite. It lives under the
 * `/__tests__/twins/` dir that default Jest ignores (jest.config.js
 * `testPathIgnorePatterns`), but it is still importable as a plain module — its
 * unit tests run in the DEFAULT suite at `src/__tests__/twinSession.test.ts`.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Persisted config shape (.env.twins.json)
// ---------------------------------------------------------------------------

export type TwinService = 'slack' | 'stripe';

/**
 * Coordinates for one reusable twin, as persisted in `.env.twins.json`.
 *
 * Field names mirror what the suites already consume; the source values come
 * from the provision response (`base_url`, `admin_url`, `proxy_token`,
 * `env_vars.SLACK_BOT_TOKEN`) and are copied into these camelCase keys by the
 * setup script.
 */
export interface TwinCoords {
  /** Public base URL of the twin (provision response `base_url`). */
  baseUrl: string;
  /** Admin base URL (`admin_url`) — Slack only; drives the twin's `/admin/*` API. */
  adminUrl?: string;
  /** JWT bearer for the twin's admin API (`proxy_token`) — Slack only. */
  proxyToken?: string;
  /** Seeded bot token (`env_vars.SLACK_BOT_TOKEN`) — Slack only; sets `SLACK_BOT_TOKEN`. */
  botToken?: string;
}

export interface TwinConfig {
  /** Provisioning run id (`run_id`) — the reset/teardown handle for the whole session. */
  runId: string;
  /** Per-service coordinates. A session may hold a subset of services. */
  twins: Partial<Record<TwinService, TwinCoords>>;
}

/** Default persisted-config location: `backend/.env.twins.json`. */
export const DEFAULT_TWIN_CONFIG_PATH = path.resolve(__dirname, '../../../.env.twins.json');

/** Resolve the config path: `ARGA_TWIN_CONFIG` override, else the default. */
export function resolveConfigPath(): string {
  return process.env.ARGA_TWIN_CONFIG || DEFAULT_TWIN_CONFIG_PATH;
}

/**
 * The clear skip message shown when no reusable twin is configured.
 * Kept as a function so the exact copy has one source of truth (asserted in tests).
 */
export function describeTwinSkip(): string {
  return 'No reusable twin configured — run `npm run test:twins:setup` (needs Arga quota). Suite skipped.';
}

// ---------------------------------------------------------------------------
// Config loading + accessors
// ---------------------------------------------------------------------------

/**
 * Load the persisted twin config, or `null` when none is present (→ suite skips).
 *
 * A MISSING file returns null (the normal "no twin configured" path). A PRESENT
 * but corrupt/invalid file THROWS — a dev hand-edited it wrong and should hear
 * about it loudly (fail-loud, not a silent skip). This can never happen in CI,
 * which has no config file and takes the null → skip path.
 */
export function loadTwinConfig(): TwinConfig | null {
  const configPath = resolveConfigPath();
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return null; // no config present → the suite skips cleanly
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Twin config at ${configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const cfg = parsed as TwinConfig;
  if (
    !cfg ||
    typeof cfg !== 'object' ||
    typeof cfg.runId !== 'string' ||
    !cfg.runId ||
    typeof cfg.twins !== 'object' ||
    cfg.twins === null
  ) {
    throw new Error(`Twin config at ${configPath} is missing required fields (runId, twins).`);
  }
  return cfg;
}

/** Return the coordinates for one service, or `null` when it is not configured. */
export function getTwin(service: TwinService): TwinCoords | null {
  const cfg = loadTwinConfig();
  const coords = cfg?.twins?.[service];
  if (!coords || typeof coords.baseUrl !== 'string' || !coords.baseUrl) {
    return null;
  }
  return coords;
}

// ---------------------------------------------------------------------------
// Arga CLI plumbing
// ---------------------------------------------------------------------------

const ARGA_CANDIDATES = ['arga', path.join(process.env.HOME || '', '.local/bin/arga')];

/** Pick an Arga binary: `ARGA_BIN` override, then a user-local install, else `arga` on PATH. */
export function resolveArgaBin(): string {
  if (process.env.ARGA_BIN) return process.env.ARGA_BIN;
  const local = path.join(process.env.HOME || '', '.local/bin/arga');
  try {
    if (fs.existsSync(local)) return local;
  } catch {
    /* fall through to PATH lookup */
  }
  return 'arga';
}

/**
 * Reset the reusable twin session to its baseline seed state (best-effort).
 *
 * Called from `beforeEach` so a state-mutating test starts from a known baseline
 * and never leaks into the next one. A failed reset MUST NOT crash the suite: we
 * warn loudly (so a dev knows state may carry over) and let the test proceed.
 *
 * LIVE BEHAVIOR UNVERIFIED — the account is at 0/10 quota, so an actual reset
 * has not been exercised end-to-end. The CLI form (`arga previews twins reset
 * <run_id>`) matches `arga previews twins reset --help`.
 */
export function resetTwinToBaseline(runId: string, bin: string = resolveArgaBin()): void {
  if (!runId) return;
  try {
    execFileSync(bin, ['previews', 'twins', 'reset', runId], { stdio: 'ignore' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[twinSession] resetTwinToBaseline(${runId}) failed — twin state may carry over ` +
        `between tests: ${(err as Error).message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Test-facing resolver
// ---------------------------------------------------------------------------

export interface TwinSessionResolution {
  /** The loaded config, or null when the suite should skip. */
  config: TwinConfig | null;
  /** Non-null → the suite must skip; the string explains why. */
  skipReason: string | null;
}

/**
 * Resolve whether a suite for `service` can run against a reusable twin.
 *
 * Returns a skip reason (never throws for the common "no config" case) when the
 * config is absent or lacks the requested service. A present-but-corrupt config
 * still throws via `loadTwinConfig` (fail-loud) — that only happens on a bad
 * hand-edit, never in CI.
 */
export function resolveTwinSession(service: TwinService): TwinSessionResolution {
  const config = loadTwinConfig();
  if (!config) {
    return { config: null, skipReason: describeTwinSkip() };
  }
  const coords = config.twins?.[service];
  if (!coords || !coords.baseUrl) {
    return {
      config: null,
      skipReason:
        `Reusable twin config present but has no '${service}' twin — ` +
        're-run `npm run test:twins:setup`. Suite skipped.',
    };
  }
  return { config, skipReason: null };
}

// ---------------------------------------------------------------------------
// Quota/auth pre-flight (used by the SETUP script, not the suites)
// ---------------------------------------------------------------------------

export interface TwinRunner {
  /** Path to an authenticated Arga CLI, or null if none is available. */
  arga: string | null;
  /** Non-null → provisioning must be skipped; the string explains why. */
  skipReason: string | null;
}

const NO_ARGA = 'Arga CLI not authenticated (run `arga login`)';

/**
 * Locate an authenticated Arga CLI and decide whether a twin can be provisioned.
 * Runs `arga whoami` once and inspects the plan + remaining validation-run quota.
 * Consulted by `npm run test:twins:setup` before it spends a provision, so the
 * quota/auth-aware behavior from the old `twinAvailability.ts` is preserved.
 */
export function resolveTwinRunner(): TwinRunner {
  for (const bin of ARGA_CANDIDATES) {
    let out: string;
    try {
      out = execFileSync(bin, ['whoami'], { encoding: 'utf8' });
    } catch {
      continue; // not this binary / not authenticated — try the next
    }
    const plan = (/Plan:\s*(\w+)/i.exec(out)?.[1] ?? 'unknown').toLowerCase();
    // Paid/team plans are not capped by the free monthly quota — attempt provisioning.
    if (plan !== 'free' && plan !== 'unknown') {
      return { arga: bin, skipReason: null };
    }
    const m = /Validation runs:\s*(\d+)\s*\/\s*(\d+)\s*remaining/i.exec(out);
    if (!m) {
      // whoami format changed — don't guess; attempt provisioning and let it fail loud.
      return { arga: bin, skipReason: null };
    }
    const remaining = parseInt(m[1], 10);
    return remaining > 0
      ? { arga: bin, skipReason: null }
      : {
          arga: bin,
          skipReason: `Arga free-plan monthly validation-run quota exhausted (0/${m[2]}) — cannot provision a twin`,
        };
  }
  return { arga: null, skipReason: NO_ARGA };
}
