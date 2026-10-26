/** ENG-2113 PR H: which stops are HARD (revoke, hazard alarm) and which keep the login (disable, reconnect), and in what order (killers for mutants found in review). */
import { drain, makeRig, signIn, turnReq, type Rig } from "./helpers";

async function readyAttempt(rig: Rig, connectionId: string): Promise<string> {
  const start = await rig.mgr.loginStart({ connectionId, provider: "fake", reconnect: true });
  await rig.mgr.loginComplete({ connectionId, loginRef: start.loginRef, code: "abcdefgh#12345678" });
  return start.loginRef;
}

describe("K: hard vs graceful per reason", () => {
  let rig: Rig;
  afterEach(() => rig?.cleanup());

  it("the hazard alarm kills HARD", async () => {
    rig = makeRig();
    await signIn(rig, "conn1", 1);
    const uid = rig.store.get().connections.conn1.uid;
    rig.script.turnEvents = [{ type: "alarm", hazard: { kind: "hook_event" } }, { type: "result", ok: true, text: "x" }];
    await drain((await rig.mgr.runTurn(turnReq("conn1", 1))).events!);
    expect(rig.mgr.status({ connectionId: "conn1" })).toMatchObject({ state: "needs_attention" });
    expect(rig.fs.killedHard).toContain(uid);
  });

  it("a reconnect stops the OLD login gracefully (never hard)", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    const oldUid = rig.store.get().connections.c1.uid;
    const loginRef = await readyAttempt(rig, "c1");
    rig.fs.killed.length = 0;
    await rig.mgr.loginPromote({ connectionId: "c1", loginRef, epoch: 2 });
    expect(rig.fs.killed).toContain(oldUid);
    expect(rig.fs.killedHard).toEqual([]);
  });

  it("an alarm whose kills FAIL still reaches the consumer as an alarm event (then the failure)", async () => {
    rig = makeRig();
    await signIn(rig, "conn1", 1);
    rig.script.turnEvents = [{ type: "alarm", hazard: { kind: "hook_event" } }, { type: "result", ok: true, text: "x" }];
    rig.fs.failKills = 2; // the hard kill and the final kill both fail
    const events = await drain((await rig.mgr.runTurn(turnReq("conn1", 1))).events!);
    expect(events.some((e) => e.type === "alarm")).toBe(true);
    expect(rig.mgr.status({ connectionId: "conn1" })).toMatchObject({ state: "needs_attention" });
  });

  it("revoke: the hard kill happens BEFORE the sessions are closed", async () => {
    rig = makeRig();
    await signIn(rig, "c1", 1);
    const uid = rig.store.get().connections.c1.uid;
    await drain((await rig.mgr.runTurn(turnReq("c1", 1))).events!); // leaves a pooled session
    const closedBefore = rig.script.closed;
    const seen: Array<{ hard: boolean; closed: number }> = [];
    const real = rig.fs.killAll.bind(rig.fs);
    rig.fs.killAll = async (u: number, opts?: { hard?: boolean }) => {
      if (u === uid) seen.push({ hard: !!opts?.hard, closed: rig.script.closed });
      return real(u, opts);
    };
    await rig.mgr.revoke({ connectionId: "c1", epoch: 2 });
    expect(rig.script.closed).toBeGreaterThan(closedBefore); // a session really was closed by the revoke
    const firstHard = seen.find((s) => s.hard);
    expect(firstHard).toBeDefined();
    expect(firstHard!.closed).toBe(closedBefore); // ...but only AFTER the hard kill
    expect(seen[0].hard).toBe(true);
  });
});
