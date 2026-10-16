import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AdapterContext, AsUser, ProviderEvent, SubscriptionProviderAdapter } from "../adapter";
import { ConnectionManager, type ManagerConfig } from "../connectionManager";
import type { Clock, IdGen, UserFsPort } from "../ports";
import { StateStore } from "../stateStore";
import { createFakeAdapter, newScript, type FakeOptions, type FakeScript } from "../adapters/fakeAdapter";

export class ManualClock implements Clock {
  private wall = 1_700_000_000_000;
  private mono = 1_000;
  nowMs = () => this.wall;
  monotonicMs = () => this.mono;
  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }
}

export class CounterIds implements IdGen {
  private n = 0;
  next(prefix: string): string {
    return `${prefix}-${++this.n}`;
  }
}

/** In-memory stand-in for the real per-uid file operations; records what happened. */
export class FakeFs implements UserFsPort {
  dirs = new Set<string>();
  killed: number[] = [];
  wipes: string[] = [];
  residue = new Map<number, number>();
  failWipes = false;
  /** killAll throws once. */
  failKillOnce = false;
  /** promoteAttempt throws before doing anything. */
  failPromote = false;
  /** promoteAttempt moves the directory and THEN throws: the shape of a crash between the rename and the save. */
  crashAfterPromote = false;
  /** wipeHome never returns. */
  hangWipe = false;
  /** wipeHome waits for this. */
  wipeGate?: Promise<void>;
  /** Runs after every successful wipe: lets a test queue another cleanup entry while a drain is in progress. */
  onWipe?: () => void;
  writes: Array<{ uid: number; home: string; kind: "attempt" | "home"; rel: string }> = [];
  /** Ordered log of destructive operations: kill:<uid>, wipe:<kind>:<uid>. */
  log: string[] = [];

  contextFor(connectionId: string, uid: number, ref: string, kind: "attempt" | "home"): AdapterContext {
    return {
      connectionId,
      uid,
      homeDir: `/fake/${kind}/${uid}/${ref}`,
      workDir: `/fake/${kind}/${uid}/${ref}/work`,
      tmpDir: `/fake/${kind}/${uid}/${ref}/tmp`,
      spawnAs: () => {
        throw new Error("fake fs does not spawn");
      },
    };
  }
  async createAttemptDir(uid: number, ref: string): Promise<void> {
    this.dirs.add(`attempt:${uid}:${ref}`);
  }
  /** When set, promoteAttempt waits for it: lets a test interleave other operations mid-promote. */
  promoteGate?: Promise<void>;
  async promoteAttempt(uid: number, attemptRef: string, homeRef: string): Promise<void> {
    if (this.promoteGate) await this.promoteGate;
    if (this.failPromote) throw new Error("promote failed");
    this.dirs.delete(`attempt:${uid}:${attemptRef}`);
    this.dirs.add(`home:${uid}:${homeRef}`);
    if (this.crashAfterPromote) throw new Error("crash after rename");
  }
  asUser(uid: number, homeRef: string, kind: "attempt" | "home"): AsUser {
    return {
      writeFile: async (rel: string) => {
        this.writes.push({ uid, home: homeRef, kind, rel });
      },
    };
  }
  async wipeAttempt(uid: number, ref: string): Promise<void> {
    if (this.failWipes) throw new Error("wipe failed");
    this.dirs.delete(`attempt:${uid}:${ref}`);
    this.wipes.push(`attempt:${uid}:${ref}`);
    this.log.push(`wipe:attempt:${uid}`);
    this.onWipe?.();
  }
  async wipeHome(uid: number, ref: string): Promise<void> {
    if (this.hangWipe) await new Promise<void>(() => undefined);
    if (this.wipeGate) await this.wipeGate;
    if (this.failWipes) throw new Error("wipe failed");
    this.dirs.delete(`home:${uid}:${ref}`);
    this.wipes.push(`home:${uid}:${ref}`);
    this.log.push(`wipe:home:${uid}`);
    this.onWipe?.();
  }
  async killAll(uid: number): Promise<void> {
    if (this.failKillOnce) {
      this.failKillOnce = false;
      throw new Error("kill failed");
    }
    this.killed.push(uid);
    this.log.push(`kill:${uid}`);
  }
  async residueCount(uid: number): Promise<number> {
    return this.residue.get(uid) ?? 0;
  }
}

export interface Rig {
  mgr: ConnectionManager;
  store: StateStore;
  fs: FakeFs;
  clock: ManualClock;
  script: FakeScript;
  adapter: SubscriptionProviderAdapter;
  dir: string;
  restart(): ConnectionManager;
  cleanup(): void;
}

export function makeRig(opts: { adapter?: FakeOptions; config?: Partial<ManagerConfig>; script?: Partial<FakeScript> } = {}): Rig {
  const dir = mkdtempSync(join(tmpdir(), "login-host-test-"));
  const clock = new ManualClock();
  const fs = new FakeFs();
  const script = { ...newScript(), ...(opts.script ?? {}) };
  const adapter = createFakeAdapter(script, opts.adapter);
  const ids = new CounterIds();
  let store = new StateStore(dir);
  store.open();
  const build = () =>
    new ConnectionManager({ store, clock, fs, ids, adapters: new Map([[adapter.id, adapter]]), config: { uidMin: 400_000, uidMax: 400_009, ...opts.config } });
  const rig: Rig = {
    mgr: build(),
    store,
    fs,
    clock,
    script,
    adapter,
    dir,
    restart() {
      store.close();
      store = new StateStore(dir);
      store.open();
      rig.store = store;
      rig.mgr = build();
      return rig.mgr;
    },
    cleanup() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return rig;
}

/** Cross-checks the host's bookkeeping against the (fake) disk: no live directory on a free uid, no owned uid without a directory or a pending wipe. */
export function assertConsistent(rig: Rig): void {
  const st = rig.store.get();
  const pendingUids = new Set<number>();
  for (const c of Object.values(st.connections)) for (const w of c.wipePending ?? []) pendingUids.add(w.uid);
  const dirUids = new Set([...rig.fs.dirs].map((d) => Number(d.split(":")[1])));
  for (const uid of dirUids) {
    if (st.uidOwners[String(uid)] === undefined) throw new Error(`a directory exists for uid ${uid}, which is marked free`);
  }
  for (const uid of Object.keys(st.uidOwners)) {
    const n = Number(uid);
    if (!dirUids.has(n) && !pendingUids.has(n)) throw new Error(`uid ${uid} is owned but has no directory and no pending wipe`);
  }
}

export async function drain(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** Sign a connection in all the way to `active` at epoch 1. */
export async function signIn(rig: Rig, connectionId = "conn1", epoch = 1): Promise<void> {
  const start = await rig.mgr.loginStart({ connectionId, provider: rig.adapter.id });
  if (rig.adapter.ceremony === "paste_code") await rig.mgr.loginComplete({ connectionId, loginRef: start.loginRef, code: "abcdefgh#12345678" });
  else await rig.mgr.loginStatus({ connectionId, loginRef: start.loginRef });
  await rig.mgr.loginPromote({ connectionId, loginRef: start.loginRef, epoch });
}

let turnN = 0;
export function turnReq(connectionId: string, epoch: number, extra: Record<string, unknown> = {}) {
  turnN++;
  return {
    connectionId,
    epoch,
    idempotencyKey: `idem-${turnN}`,
    turnId: `turn-${turnN}`,
    prompt: "hello",
    model: "fast",
    bridgeToken: "bridge-token-0123456789",
    ...extra,
  };
}
