/**
 * ENG-2113 measurement (opt-in, AW_MEASURE_ECHOES=1; not a gate): what honest big tool-result echoes cost the per-turn CPU meter, with REAL child processes (a stand-in
 * CLI printing the echoes) through the real adapter, readline and JSON.parse. Printed as RESULT ECHO lines: wall time, the host process's true CPU time, and the ms the
 * meter charged. Run it under contention to see how the charge behaves: `taskset -c 3 env AW_MEASURE_ECHOES=1 npx jest <this file>` with N busy-loop competitors pinned
 * to the same core (`taskset -c 3 node -e "for(;;){}"`).
 *
 * The only assertions are the ones that must hold under ANY load: the honest turns are not killed and finish with their result.
 */
import { CPU_BURST_MS } from "../../relay/cpuMeter";
import { cleanup, makeRig } from "./rig";
import { runTurn } from "./harness";

afterAll(cleanup);
jest.setTimeout(120_000);
const RESULT = '{"type":"result","is_error":false,"result":"done","usage":{"input_tokens":1,"output_tokens":1}}\n';
const echoScript = (mb: number, n: number, gapMs: number) => `module.exports = async (h) => {
  const chunk = "a".repeat(1<<20);
  for (let i = 0; i < ${n}; i++) {
    const body = Array.from({length: ${mb}}, () => chunk).join("");
    h.out(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"toolu_"+i,content:body}]}}) + "\\n");
    if (${gapMs}) await h.sleep(${gapMs});
  }
  h.out(${JSON.stringify(RESULT)});
};`;

/** A tool result whose wire form is mb MiB where EVERY OTHER character is a backslash (a body of quote characters: each is escaped as \\"). The worst honest-looking string for JSON.parse. */
const escScript = (mb: number, n: number) => `module.exports = async (h) => {
  const body = '"'.repeat(${mb} * 512 * 1024);
  for (let i = 0; i < ${n}; i++) {
    h.out(JSON.stringify({type:"user",message:{content:[{type:"tool_result",tool_use_id:"toolu_"+i,content:body}]}}) + "\\n");
  }
  h.out(${JSON.stringify(RESULT)});
};`;

(process.env.AW_MEASURE_ECHOES ? describe : describe.skip)("honest echoes against the CPU meter (measurement)", () => {
  it.each([
    [6, 10, 0],
    [12, 5, 0],
    [15, 3, 0],
    [12, 3, 0],
  ])("%i MB echo x %i back to back", async (mb, n, gap) => {
    const r = await runTurn(makeRig(), echoScript(mb, n, gap));
    const charged = CPU_BURST_MS - r.meterRemaining;
    console.log(`RESULT ECHO ${mb}MB x${n}: wall ${r.wallMs.toFixed(0)}ms hostCpu ${r.cpuMs.toFixed(0)}ms charged ${charged.toFixed(0)}ms of ${CPU_BURST_MS} (${((100 * charged) / CPU_BURST_MS).toFixed(0)}%) exhausted=${r.meterExhausted} result=${JSON.stringify(r.result)} logs=${r.logs.map((l) => l.event).join(",")}`);
    expect(r.meterExhausted).toBe(false);
    expect(r.result).toMatchObject({ type: "result", ok: true });
  });

  it.each([
    [12, 1],
    [12, 2],
    [12, 5],
  ])("esc%i (every other character escaped) x %i back to back", async (mb, n) => {
    const r = await runTurn(makeRig(), escScript(mb, n));
    const charged = CPU_BURST_MS - r.meterRemaining;
    console.log(`RESULT ECHO esc${mb} x${n}: wall ${r.wallMs.toFixed(0)}ms hostCpu ${r.cpuMs.toFixed(0)}ms charged ${charged.toFixed(0)}ms of ${CPU_BURST_MS} (${((100 * charged) / CPU_BURST_MS).toFixed(0)}%) exhausted ${r.meterExhausted}`);
    expect(r.result).toBeDefined();
  });
});
