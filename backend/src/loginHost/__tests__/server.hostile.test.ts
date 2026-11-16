/**
 * ENG-2113 (security review): the server's own callbacks cannot be made to throw out of a timer or a stream by data a customer's unit controls.
 */
import { request } from "http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startHostServer, type HostServerHandle } from "../server";
import { makeRig, signIn, turnReq, type Rig } from "./helpers";

let uncaught: unknown[];
const onU = (e: unknown) => void uncaught.push(e);
beforeEach(() => {
  uncaught = [];
  process.on("uncaughtException", onU);
});
afterEach(() => void process.off("uncaughtException", onU));

function post(sock: string, route: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: sock, method: "POST", path: `/v1/${route}`, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
  if (!cond()) throw new Error("until: timed out");
}

describe("server callbacks", () => {
  let rig: Rig;
  let dir: string;
  let handle: HostServerHandle | undefined;
  afterEach(async () => {
    await handle?.close();
    rig?.cleanup();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("MUTATION TARGET: a tick that throws is logged with a fixed code and does not become an uncaught exception; the next tick runs", async () => {
    rig = makeRig();
    dir = mkdtempSync(join(tmpdir(), "lh-hostile-"));
    const logs: string[] = [];
    let ticks = 0;
    rig.mgr.tick = () => {
      ticks++;
      throw new Error("boom: SECRET-TEXT");
    };
    handle = await startHostServer(rig.mgr, { socketPath: join(dir, "host.sock"), tickMs: 20, sweepMs: 60_000, log: { warn: (e) => void logs.push(e) } });
    await until(() => ticks >= 3);
    expect(uncaught).toEqual([]);
    expect(logs.filter((l) => l === "host_tick_failed").length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(logs)).not.toContain("SECRET");
  });

  it("MUTATION TARGET: an event that cannot be serialized ends the turn and the stream cleanly (no throw out of the stream, the turn is aborted, the host answers the next request)", async () => {
    rig = makeRig();
    dir = mkdtempSync(join(tmpdir(), "lh-hostile-"));
    handle = await startHostServer(rig.mgr, { socketPath: join(dir, "host.sock"), tickMs: 60_000, sweepMs: 60_000 });
    await signIn(rig, "c1", 1);
    // a bigint cannot be serialized: stands in for any value JSON.stringify refuses (a nesting that overflows the stack, a cycle)
    rig.script.turnEvents = [{ type: "tool-use", operationId: "o1", name: "t", input: { n: BigInt(1) } as never }, { type: "result", ok: true, text: "never reached" }];
    const r = await post(join(dir, "host.sock"), "turn.run", turnReq("c1", 1, { turnId: "t-ser" }));
    expect(r.status).toBe(200);
    expect(r.text).toContain('"type":"accepted"');
    expect(r.text).not.toContain("never reached");
    expect(uncaught).toEqual([]);
    await until(() => rig.script.interruptedTurns.includes("t-ser")); // the turn was ABORTED (provider told to stop), not just left to end
    const status = await post(join(dir, "host.sock"), "connection.status", { connectionId: "c1" });
    expect(status.status).toBe(200);
    expect(JSON.parse(status.text)).toMatchObject({ runningTurns: 0 });
  });
});
