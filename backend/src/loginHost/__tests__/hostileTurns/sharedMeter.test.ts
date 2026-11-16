/** ENG-2113 (security review): the relay socket's frame handling must be charged to the SAME per-turn CPU meter as the CLI's stdout (otherwise a turn gets two budgets). */
import { cleanup, makeRig } from "./rig";
import { CPU_BURST_MS } from "../../relay/cpuMeter";
import { runTurn } from "./harness";

afterAll(cleanup);
const frames = (n: number) => `module.exports = async (h) => {
  const s = h.net.createConnection(process.env.AW_FAKE_RELAY_MOUNT + "/relay.sock");
  s.on("error", () => {}); s.on("data", () => {});
  await new Promise((r) => s.once("connect", r));
  const args = JSON.stringify({a: Array.from({length: 20000}, (_, i) => ({k: "v" + i, n: [i, i + 1]}))});
  for (let i = 0; i < ${n}; i++) { s.write('{"type":"call","callId":"c' + i + '","name":"nonexistent","args":' + args + '}\\n'); await h.sleep(40); }
  await h.sleep(300);
  h.out({type:"result",is_error:false,result:"done"});
};`;

describe("sec14 shared meter", () => {
  it("socket frames charge the turn's meter (the one the CLI's stdout is metered by)", async () => {
    const control = await runTurn(makeRig(), frames(0));
    const loaded = await runTurn(makeRig(), frames(3));
    const spentControl = CPU_BURST_MS - control.meterRemaining;
    const spentLoaded = CPU_BURST_MS - loaded.meterRemaining;
    console.log(`SHARED METER control charged ${spentControl.toFixed(1)}ms; with 3 big frames ${spentLoaded.toFixed(1)}ms`);
    expect(spentLoaded - spentControl).toBeGreaterThan(8);
  }, 30_000);
});
