/**
 * ENG-2110 PR 3: how the production backend finds and authenticates to the login worker.
 *
 * Production (Elastic Beanstalk) cannot take new environment variables (ENG-2071), so the configuration comes from two places, both
 * read at run time:
 *   - the AW-Settings row `eng1816_login_host` (the worker's private address; changing it is a PutItem, not a deploy), read the same
 *     way as the funding flags (cached, last good value kept on a failed or malformed read, fail closed when never loaded);
 *   - the backend's CLIENT certificate material in Secrets Manager (`<prod|dev>/AgentWeb/LoginHost/client`: {cert,key,ca}), read as
 *     the EC2 instance role EXPLICITLY (its resource policy names only that role; the SDK default chain may pick static keys).
 *
 * ONE WORKER. The setting's `workers` array holds exactly one entry (the array shape is kept for the future). Connection records do not
 * say which worker holds their login, so changing the address or `defaultWorker` while hosted connections exist ORPHANS their logins
 * (they live on the worker's disk): the sweeper would find "no such connection" on the new worker for every customer. The address is
 * only for replacing a worker that has the SAME disk (e.g. a new instance with the data volume re-attached). A second worker needs a
 * `subHostWorkerId` on the record (a DynamoDB model change, tracked in ENG-2114) and routing by it.
 *
 * Versions. The row may carry `v` (currently 1). Unknown extra keys are IGNORED (so a newer backend can add a field without darkening
 * older instances during a rolling deploy), but a `v` this build does not understand fails closed with a logged code. Backend and worker
 * speak the protocol in loginHost/protocol.ts: after (re)building its client the provider asks `host.info` and records whether the
 * worker's PROTOCOL_VERSION matches (`protocolStatus()`); a mismatch is logged, never fatal. Deploy order: see PROTOCOL_VERSION.
 *
 * The material lives only in this module's memory: never logged, never in an error message. `client()` is synchronous (the hosted
 * service's dependency is): until the first refresh completes it returns undefined and the callers answer `host_unavailable`.
 */
import AWS from "aws-sdk";
import { createHash } from "crypto";
import { z } from "zod";
import { settingsService } from "../settingsService";
import { CERT_WARN_DAYS, certNotAfterMs, daysUntil } from "../../loginHost/certExpiry";
import { isRfc1918 } from "../../loginHost/ipv4";
import { PROTOCOL_VERSION } from "../../loginHost/protocol";
import { LoginHostClient, LoginHostError, MutualTlsTransport } from "./loginHostClient";

export const LOGIN_HOST_SETTING_NAME = "eng1816_login_host";

/** The secret is re-read at most this often (the setting is re-read on every refresh). */
export const SECRET_TTL_MS = 10 * 60 * 1000;
export const REFRESH_INTERVAL_MS = 60 * 1000;
/** After a failed refresh triggered by a caller, the next caller-triggered attempt waits this long (no hammering). */
export const RETRY_AFTER_FAILURE_MS = 5_000;

/** RFC 1918 only (shared with the host's config check via loginHost/ipv4.ts): the worker is reached over the VPC, never a public, loopback or link-local address. */
export const isPrivateIPv4 = isRfc1918;

/** The row's schema version this build understands. */
export const SETTING_VERSION = 1;

// Unknown keys are stripped, not rejected (see "Versions" above).
const workerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
  host: z.string().refine(isPrivateIPv4, "private IPv4 literal"),
  port: z.number().int().min(1024).max(65535),
});

const settingSchema = z
  .object({
    v: z.literal(SETTING_VERSION).optional(),
    workers: z.array(workerSchema).min(1).max(1),
    defaultWorker: z.string(),
  })
  .refine((s) => s.workers.some((w) => w.id === s.defaultWorker), "defaultWorker must be the worker");

export type LoginHostSetting = z.infer<typeof settingSchema>;

const PEM = (kind: string) => new RegExp(`^-----BEGIN ${kind}-----[\\s\\S]{20,20000}-----END ${kind}-----\\s*$`);
const materialSchema = z
  .object({
    cert: z.string().regex(PEM("CERTIFICATE")),
    key: z.string().regex(PEM("(?:EC |RSA )?PRIVATE KEY")),
    ca: z.string().regex(PEM("CERTIFICATE")),
  })
  .strict();

export type ClientMaterial = z.infer<typeof materialSchema>;

export type SettingParse = { ok: true; value: LoginHostSetting } | { ok: false; reason: "json" | "version" | "shape" };

/** Parses the row. Never throws, never echoes the value; the reason is a code a log line can carry. */
export function parseLoginHostSettingDetailed(text: string): SettingParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "json" };
  }
  const v = (raw as { v?: unknown } | null)?.v;
  if (raw && typeof raw === "object" && v !== undefined && v !== SETTING_VERSION) return { ok: false, reason: "version" };
  const r = settingSchema.safeParse(raw);
  return r.success ? { ok: true, value: r.data } : { ok: false, reason: "shape" };
}

/** Returns the parsed setting, or null if the JSON is not the documented shape (or a version this build does not understand). */
export function parseLoginHostSetting(text: string): LoginHostSetting | null {
  const r = parseLoginHostSettingDetailed(text);
  return r.ok ? r.value : null;
}

export function parseClientMaterial(text: string): ClientMaterial | null {
  try {
    const r = materialSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export interface LoginHostProviderDeps {
  getSetting: (name: string) => Promise<{ settingValue: string } | null>;
  /** The secret's SecretString. */
  getSecret: (name: string) => Promise<string>;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  secretName?: string;
  /** Start the background timer on the first `client()` call (the process singleton does; unit tests drive `refresh()` themselves). */
  autoStart?: boolean;
  /** Test seam: builds the client for a worker (default: mutual TLS to host:port). */
  buildClient?: (worker: { host: string; port: number }, material: ClientMaterial) => LoginHostClient;
}

interface State {
  client: LoginHostClient;
  fingerprint: string;
}

/** Builds the mutual-TLS client for a worker: the backend's certificate and key as ITS identity, the CA as the only trust anchor for the worker. */
export const defaultBuild = (worker: { host: string; port: number }, m: ClientMaterial) => new LoginHostClient(new MutualTlsTransport({ host: worker.host, port: worker.port, cert: m.cert, key: m.key, ca: m.ca }));

export { CERT_WARN_DAYS };
/** The expiry warning is logged at most this often (the provider refreshes every minute). */
export const CERT_WARN_EVERY_MS = 60 * 60 * 1000;
/** `invalidateProtocol` acts at most this often. */
export const INVALIDATE_COOLDOWN_MS = 30_000;
/** The worker's protocol version is re-verified this often (a redeployed worker flips to "match" without a backend restart). */
export const PROTOCOL_RECHECK_MS = 10 * 60 * 1000;
/**
 * Worker protocol versions this backend works with for sign-in, revoke and the plain turn path (explicit, not derived from PROTOCOL_VERSION, so a bump of the
 * constant cannot silently stop accepting the worker that is still running). Versions up to one AHEAD of PROTOCOL_VERSION are accepted so a worker
 * can deploy FIRST (a new request field needs the worker first, see PROTOCOL_VERSION) without every running backend reporting a mismatch: a mismatch
 * makes `workerSpeaksOurProtocol` false, which stops a "no such connection" answer from counting as a confirmed wipe. Protocol 4 (the tool relay) is
 * accepted here, ahead of the backend that speaks it, for that reason. Code that needs a specific newer feature (the tool relay) must test
 * `workerProtocol()` itself, not `protocolStatus()`.
 */
export const ACCEPTED_WORKER_PROTOCOLS: ReadonlySet<number> = new Set([2, 3, 4]);

/** Whole days until a certificate's notAfter (negative once expired). Pure; shared with the host. */
export { daysUntil };

/** The client certificate's notAfter (ms), or undefined if it cannot be parsed. */
export const clientCertNotAfterMs = (certPem: string): number | undefined => certNotAfterMs(certPem);

export type ProtocolStatus = "match" | "mismatch" | "unknown";

const code = (e: unknown) => (e as { code?: string })?.code || (e as Error)?.name || "error";

export function defaultSecretName(): string {
  return `${process.env.NODE_ENV === "production" ? "prod" : "dev"}/AgentWeb/LoginHost/client`;
}

export class LoginHostProvider {
  private state: State | undefined;
  /** Bumped by `invalidateProtocol`: the answer of a check that started before it is ignored. */
  private protocolGeneration = 0;
  private material: { value: ClientMaterial; at: number } | undefined;
  private inflight: Promise<void> | undefined;
  private lastFailureAt = 0;
  private timer: unknown;
  private protocol: { status: ProtocolStatus; worker?: number; checkedAt: number } = { status: "unknown", checkedAt: 0 };
  private protocolChecking = false;
  private lastInvalidatedAt = Number.NEGATIVE_INFINITY;
  private protocolUnknownLogged = false;
  private certNotAfterMs: number | undefined;
  private lastCertWarnAt = 0;
  private readonly now: () => number;
  private readonly secretName: string;

  constructor(private readonly deps: LoginHostProviderDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.secretName = deps.secretName ?? defaultSecretName();
  }

  /**
   * The client for the default worker, or undefined while nothing usable has been loaded (callers answer `host_unavailable`).
   * The first call starts a refresh in the background and returns undefined; the client object only changes when the setting or the
   * certificate material does.
   */
  client(): LoginHostClient | undefined {
    if (this.deps.autoStart) this.start();
    if (!this.state && !this.inflight && this.now() - this.lastFailureAt >= RETRY_AFTER_FAILURE_MS) void this.refresh();
    return this.state?.client;
  }

  /** Reads the setting (always) and the secret (when missing or older than SECRET_TTL_MS), then swaps the state atomically. Never throws. */
  refresh(): Promise<void> {
    this.inflight ??= this.refreshInner()
      .catch((e) => {
        this.lastFailureAt = this.now();
        console.error(`[loginHostProvider] refresh failed: ${code(e)}`);
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  private async refreshInner(): Promise<void> {
    // 1. the setting. A missing row means "off" (like the funding flags); a failed or malformed read keeps the last good value.
    let setting: LoginHostSetting | null;
    try {
      const row = await this.deps.getSetting(LOGIN_HOST_SETTING_NAME);
      if (!row) {
        this.state = undefined;
        return;
      }
      const parsed = parseLoginHostSettingDetailed(row.settingValue);
      if (!parsed.ok) {
        console.error(`[loginHostProvider] setting rejected (${parsed.reason === "version" ? "login_host_setting_version_unsupported" : "login_host_setting_malformed"}): keeping the last good value`);
        this.lastFailureAt = this.now();
        return;
      }
      setting = parsed.value;
    } catch (e) {
      console.error(`[loginHostProvider] setting read failed: ${code(e)}`);
      this.lastFailureAt = this.now();
      return;
    }

    // 2. the client certificate material.
    if (!this.material || this.now() - this.material.at >= SECRET_TTL_MS) {
      try {
        const parsed = parseClientMaterial(await this.deps.getSecret(this.secretName));
        if (parsed) {
          this.material = { value: parsed, at: this.now() };
          this.certNotAfterMs = clientCertNotAfterMs(parsed.cert);
        }
        else {
          console.error("[loginHostProvider] client certificate secret is malformed: keeping the last good value");
          this.lastFailureAt = this.now();
        }
      } catch (e) {
        console.error(`[loginHostProvider] client certificate read failed: ${code(e)}`);
        this.lastFailureAt = this.now();
      }
    }
    if (!this.material) return; // never loaded: fail closed
    this.warnAboutCertExpiry();

    // 3. swap, rebuilding the client only if the address or the material changed.
    const worker = setting.workers.find((w) => w.id === setting.defaultWorker)!;
    const m = this.material.value;
    const fingerprint = createHash("sha256").update(JSON.stringify([worker.host, worker.port, m.cert, m.key, m.ca])).digest("hex");
    if (this.state?.fingerprint === fingerprint) {
      this.maybeCheckProtocol();
      return;
    }
    this.state = { client: (this.deps.buildClient ?? defaultBuild)({ host: worker.host, port: worker.port }, m), fingerprint };
    this.protocol = { status: "unknown", checkedAt: 0 }; // a new client may talk to a new worker
    this.protocolUnknownLogged = false;
    this.maybeCheckProtocol();
  }

  /** Whole days left on the backend's client certificate (negative once expired), or undefined if not loaded / unparseable. For an alarm. */
  clientCertDaysLeft(): number | undefined {
    return this.certNotAfterMs === undefined ? undefined : daysUntil(this.certNotAfterMs, this.now());
  }

  /** Logs (codes and a day count only) when the client certificate is about to expire or has: every call fails as UNREACHABLE the day it does. */
  private warnAboutCertExpiry(): void {
    const days = this.clientCertDaysLeft();
    if (days === undefined || days >= CERT_WARN_DAYS) return;
    if (this.now() - this.lastCertWarnAt < CERT_WARN_EVERY_MS) return;
    this.lastCertWarnAt = this.now();
    if (days < 0) console.error(`[loginHostProvider] login_host_client_cert_expired daysAgo=${-days}`);
    else console.warn(`[loginHostProvider] login_host_client_cert_expires_soon daysLeft=${days}`);
  }

  /**
   * The worker did something that contradicts the cached protocol (an older worker refused a relay `turn.run` after a ROLLBACK): forget the cached answer now
   * and ask `host.info` again, instead of trusting "match / 4" for up to PROTOCOL_RECHECK_MS. Until the answer arrives the status is "unknown", so the next
   * turn is refused as retryable (fail closed), then decided on the fresh protocol.
   */
  invalidateProtocol(): void {
    // At most once per cool-down: a compromised worker that keeps refusing relay turns must not flap the whole fleet to "unknown" and flood host.info.
    if (this.now() - this.lastInvalidatedAt < INVALIDATE_COOLDOWN_MS) return;
    this.lastInvalidatedAt = this.now();
    this.protocol = { status: "unknown", checkedAt: 0 };
    this.protocolUnknownLogged = false;
    // A check already in flight started BEFORE this (it may be about to report the stale "match"): its answer is ignored, and a fresh check is started.
    this.protocolGeneration++;
    this.protocolChecking = false;
    this.maybeCheckProtocol();
  }

  /** Whether the worker speaks the protocol version this build was written for (see PROTOCOL_VERSION). Unknown until `host.info` answered. */
  protocolStatus(): ProtocolStatus {
    return this.protocol.status;
  }
  workerProtocol(): number | undefined {
    return this.protocol.worker;
  }

  private maybeCheckProtocol(): void {
    if (!this.state || this.protocolChecking) return;
    if (this.protocol.status === "match" && this.now() - this.protocol.checkedAt < PROTOCOL_RECHECK_MS) return;
    this.protocolChecking = true;
    const client = this.state.client;
    const generation = this.protocolGeneration;
    void (async () => {
      try {
        const info = await client.hostInfo();
        if (generation !== this.protocolGeneration) return; // invalidated while this was in flight: a newer check decides
        const status: ProtocolStatus = ACCEPTED_WORKER_PROTOCOLS.has(info.protocol) ? "match" : "mismatch";
        if (status === "mismatch" && this.protocol.status !== "mismatch") console.error(`[loginHostProvider] login_host_protocol_mismatch worker=${info.protocol} backend=${PROTOCOL_VERSION} accepted=${[...ACCEPTED_WORKER_PROTOCOLS].join(",")}`);
        this.protocol = { status, worker: info.protocol, checkedAt: this.now() };
      } catch (e) {
        if (generation !== this.protocolGeneration) return;
        // An older worker answers EINVALID/route (or, before that change, ENOTFOUND) to a route it does not have; anything else is just "cannot tell yet".
        const detail = e instanceof LoginHostError ? `${e.code}${e.detail ? `/${e.detail}` : ""}` : code(e);
        const changed = this.protocol.status !== "unknown";
        if (changed) this.protocol = { status: "unknown", checkedAt: this.now() };
        if (changed || !this.protocolUnknownLogged) console.error(`[loginHostProvider] login_host_protocol_unknown cause=${detail}`); // once per client, not once a minute
        this.protocolUnknownLogged = true;
      } finally {
        if (generation === this.protocolGeneration) this.protocolChecking = false;
      }
    })();
  }

  start(): void {
    if (this.timer) return;
    const set = this.deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    this.timer = set(() => void this.refresh(), REFRESH_INTERVAL_MS);
    (this.timer as { unref?: () => void })?.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    (this.deps.clearInterval ?? ((h: unknown) => clearInterval(h as NodeJS.Timeout)))(this.timer);
    this.timer = undefined;
  }
}

/**
 * Secrets Manager as the EC2 instance role, explicitly: the secret's resource policy allows only that role, and the SDK's default chain
 * would use the backend's static access keys if they are set (the same reason AwsKmsPort does this). Outside production a developer
 * machine has no instance metadata service; the opt-in below lets it use its own profile. Never honoured in production.
 */
function realGetSecret(): (name: string) => Promise<string> {
  let client: AWS.SecretsManager | null = null;
  return async (name) => {
    if (!client) {
      const useLocalProfile = process.env.NODE_ENV !== "production" && process.env.ENG1816_LOGIN_HOST_LOCAL_CREDENTIALS === "1";
      client = new AWS.SecretsManager({
        region: process.env.AWS_REGION || "us-west-2",
        ...(useLocalProfile
          ? { credentials: new AWS.SharedIniFileCredentials() }
          : { credentials: new AWS.EC2MetadataCredentials({ httpOptions: { timeout: 5000 }, maxRetries: 3 }) }),
      });
    }
    const r = await client.getSecretValue({ SecretId: name }).promise();
    if (!r.SecretString) throw Object.assign(new Error("empty"), { code: "EmptySecret" });
    return r.SecretString;
  };
}

let singleton: LoginHostProvider | null = null;
export function getLoginHostProvider(): LoginHostProvider {
  if (!singleton) singleton = new LoginHostProvider({ getSetting: (n) => settingsService.getSetting(n), getSecret: realGetSecret(), autoStart: true });
  return singleton;
}
