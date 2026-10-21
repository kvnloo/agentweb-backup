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
 * The material lives only in this module's memory: never logged, never in an error message. `client()` is synchronous (the hosted
 * service's dependency is): until the first refresh completes it returns undefined and the callers answer `host_unavailable`.
 */
import AWS from "aws-sdk";
import { createHash } from "crypto";
import { z } from "zod";
import { settingsService } from "../settingsService";
import { LoginHostClient, MutualTlsTransport } from "./loginHostClient";

export const LOGIN_HOST_SETTING_NAME = "eng1816_login_host";

/** The secret is re-read at most this often (the setting is re-read on every refresh). */
export const SECRET_TTL_MS = 10 * 60 * 1000;
export const REFRESH_INTERVAL_MS = 60 * 1000;
/** After a failed refresh triggered by a caller, the next caller-triggered attempt waits this long (no hammering). */
export const RETRY_AFTER_FAILURE_MS = 5_000;

const OCTET = "(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

/** RFC 1918 only: 10/8, 172.16/12, 192.168/16. The worker is reached over the VPC; never a public, loopback or link-local address. */
export function isPrivateIPv4(host: string): boolean {
  if (!IPV4.test(host)) return false;
  const [a, b] = host.split(".").map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

const workerSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9]{0,15}$/),
    host: z.string().refine(isPrivateIPv4, "private IPv4 literal"),
    port: z.number().int().min(1024).max(65535),
  })
  .strict();

const settingSchema = z
  .object({
    workers: z.array(workerSchema).min(1).max(8),
    defaultWorker: z.string(),
  })
  .strict()
  .refine((s) => s.workers.some((w) => w.id === s.defaultWorker), "defaultWorker must be one of the workers")
  .refine((s) => new Set(s.workers.map((w) => w.id)).size === s.workers.length, "worker ids must be unique");

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

/** Returns the parsed setting, or null if the JSON is not exactly the documented shape. Never throws, never echoes the value. */
export function parseLoginHostSetting(text: string): LoginHostSetting | null {
  try {
    const r = settingSchema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
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

const defaultBuild = (worker: { host: string; port: number }, m: ClientMaterial) => new LoginHostClient(new MutualTlsTransport({ host: worker.host, port: worker.port, cert: m.cert, key: m.key, ca: m.ca }));

const code = (e: unknown) => (e as { code?: string })?.code || (e as Error)?.name || "error";

export function defaultSecretName(): string {
  return `${process.env.NODE_ENV === "production" ? "prod" : "dev"}/AgentWeb/LoginHost/client`;
}

export class LoginHostProvider {
  private state: State | undefined;
  private material: { value: ClientMaterial; at: number } | undefined;
  private inflight: Promise<void> | undefined;
  private lastFailureAt = 0;
  private timer: unknown;
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
      setting = parseLoginHostSetting(row.settingValue);
      if (!setting) {
        console.error("[loginHostProvider] setting is malformed: keeping the last good value");
        this.lastFailureAt = this.now();
        return;
      }
    } catch (e) {
      console.error(`[loginHostProvider] setting read failed: ${code(e)}`);
      this.lastFailureAt = this.now();
      return;
    }

    // 2. the client certificate material.
    if (!this.material || this.now() - this.material.at >= SECRET_TTL_MS) {
      try {
        const parsed = parseClientMaterial(await this.deps.getSecret(this.secretName));
        if (parsed) this.material = { value: parsed, at: this.now() };
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

    // 3. swap, rebuilding the client only if the address or the material changed.
    const worker = setting.workers.find((w) => w.id === setting.defaultWorker)!;
    const m = this.material.value;
    const fingerprint = createHash("sha256").update(JSON.stringify([worker.host, worker.port, m.cert, m.key, m.ca])).digest("hex");
    if (this.state?.fingerprint === fingerprint) return;
    this.state = { client: (this.deps.buildClient ?? defaultBuild)({ host: worker.host, port: worker.port }, m), fingerprint };
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
