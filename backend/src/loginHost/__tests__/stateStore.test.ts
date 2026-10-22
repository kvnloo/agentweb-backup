import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HostError } from "../protocol";
import { StateLockedError, StateStore, processStartTime, type HostState } from "../stateStore";
import { UidAllocator } from "../uidAllocator";

describe("StateStore", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "lh-state-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("saves atomically and reloads exactly, leaving no temp file behind", () => {
    const a = new StateStore(dir);
    const st = a.open();
    st.connections.c1 = { connectionId: "c1", provider: "fake", uid: 400001, homeRef: "h1", epoch: 4, state: "active", createdAtMs: 1, updatedAtMs: 2 };
    st.uidOwners["400001"] = "c1";
    st.idempotency.k = { requestHash: "h", outcome: { status: "finished" }, atMs: 3 };
    a.save();
    a.close();
    expect(readdirSync(dir).filter((f) => f.includes(".tmp"))).toEqual([]);
    const b = new StateStore(dir);
    const again = b.open();
    expect(again.connections.c1.epoch).toBe(4);
    expect(again.uidOwners["400001"]).toBe("c1");
    expect(again.idempotency.k.outcome).toEqual({ status: "finished" });
    b.close();
  });

  it("refuses a second live host on the same directory and releases the lock on close", () => {
    const a = new StateStore(dir);
    a.open();
    expect(() => new StateStore(dir, () => true).open()).toThrow(StateLockedError);
    a.close();
    expect(existsSync(join(dir, "host.lock"))).toBe(false);
    const c = new StateStore(dir);
    expect(() => c.open()).not.toThrow();
    c.close();
  });

  it("takes over a lock left by a dead host, but not one held by a live pid", () => {
    writeFileSync(join(dir, "host.lock"), "999999");
    const dead = new StateStore(dir, () => false);
    expect(() => dead.open()).not.toThrow();
    dead.close();
    writeFileSync(join(dir, "host.lock"), "999999");
    expect(() => new StateStore(dir, () => true).open()).toThrow(StateLockedError);
  });

  it("a recycled pid (same pid, different process start time) does not keep a dead host's lock; a matching start time does", () => {
    writeFileSync(join(dir, "host.lock"), `${process.pid}:1`);
    const recycled = new StateStore(dir);
    expect(() => recycled.open()).not.toThrow();
    recycled.close();
    const start = processStartTime(process.pid);
    if (start === undefined) return; // not Linux: the start time is unavailable
    writeFileSync(join(dir, "host.lock"), `${process.pid}:${start}`);
    expect(() => new StateStore(dir).open()).toThrow(StateLockedError);
  });

  it("refuses a state file of an unknown version", () => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 2 }));
    expect(() => new StateStore(dir).open()).toThrow(/version/);
  });
});

describe("UidAllocator", () => {
  const mk = (min = 400_000, max = 400_002) => {
    const st: HostState = { version: 1, connections: {}, uidOwners: {}, idempotency: {} };
    return { st, a: new UidAllocator(() => st, min, max) };
  };

  it("hands out the lowest free uid, never one in use, and reuses a uid only after free()", () => {
    const { a } = mk();
    expect(a.allocate("x")).toBe(400_000);
    expect(a.allocate("y")).toBe(400_001);
    expect(a.free(400_000, "x")).toBe(true);
    expect(a.allocate("z")).toBe(400_000);
    expect(a.ownerOf(400_000)).toBe("z");
  });

  it("free() is a no-op unless the named owner still owns the uid (a late cleanup cannot free a re-allocated uid)", () => {
    const { a } = mk();
    const uid = a.allocate("old");
    expect(a.free(uid, "someone-else")).toBe(false);
    expect(a.ownerOf(uid)).toBe("old");
    expect(a.free(uid, "old")).toBe(true);
    const again = a.allocate("new");
    expect(again).toBe(uid);
    expect(a.free(uid, "old")).toBe(false); // the late second cleanup of the OLD owner
    expect(a.ownerOf(uid)).toBe("new");
  });

  it("is EBUSY when the range is exhausted", () => {
    const { a } = mk(400_000, 400_001);
    a.allocate("a");
    a.allocate("b");
    expect(() => a.allocate("c")).toThrow(HostError);
  });

  it("transfers ownership only from the current owner", () => {
    const { a } = mk();
    const uid = a.allocate("attempt:1");
    expect(() => a.transfer(uid, "attempt:other", "c1")).toThrow(HostError);
    a.transfer(uid, "attempt:1", "c1");
    expect(a.ownerOf(uid)).toBe("c1");
  });

  it("rejects a dangerous range (system uids)", () => {
    expect(() => new UidAllocator(() => ({ version: 1, connections: {}, uidOwners: {}, idempotency: {} }), 0, 10)).toThrow(/range/);
    expect(() => new UidAllocator(() => ({ version: 1, connections: {}, uidOwners: {}, idempotency: {} }), 999, 2000)).toThrow(/range/);
  });
});
