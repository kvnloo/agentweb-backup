/**
 * ENG-2113 measurement (not a gate; opt-in with AW_MEASURE_CONCURRENT=1, about 90 s): eight hostile turns at once next to one honest turn, with real child processes:
 * host RSS peak, loop busy time, longest stall and the honest turn's event delay. Printed as RESULT C lines; there are no timing assertions (they would flake on a
 * loaded machine). Ported from the final security review's C series.
 */
import { performance } from "perf_hooks";
import { cleanup, drainTurn, makeRig } from "./rig";

jest.setTimeout(230_000);
afterAll(cleanup);
const HOSTILE_N = 8; // maxTurnsPerHost in the prod template

function stats(a: number[]) {
  const s = [...a].sort((x, y) => x - y);
  const q = (p: number) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : 0);
  return { n: s.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1) };
}

async function scenario(label: string, hostileJs: string, honestEventsPerSec = 10) {
  const hostile = Array.from({ length: HOSTILE_N }, () => {
    const r = makeRig({ killWaitMs: 8000 });
    r.script(`module.exports = async (h) => { process.stdout.on("error",()=>{}); ${hostileJs} };`);
    return r;
  });
  const honest = makeRig({ killWaitMs: 8000 });
  honest.script(`module.exports = async (h) => { const end=Date.now()+8000; while(Date.now()<end){ h.out({type:"assistant",message:{id:"m"+Date.now(),content:[{type:"text",text:String(Date.now())}]}}); await h.sleep(${Math.round(1000 / honestEventsPerSec)}); } h.out({type:"result",subtype:"success",is_error:false,result:"done"}); };`);
  let peakRss = 0;
  const rss0 = process.memoryUsage().rss;
  let last = performance.now();
  let stall = 0;
  const stalls: number[] = [];
  const tick = setInterval(() => {
    const n = performance.now();
    const d = n - last;
    stall = Math.max(stall, d);
    if (d > 100) stalls.push(d);
    last = n;
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 5);
  const lat: number[] = [];
  const elu0 = performance.eventLoopUtilization();
  const t0 = performance.now();
  const honestRun = drainTurn(honest, {
    maxMs: 30_000,
    onEvent: (e) => {
      if (e.type === "text") lat.push(Date.now() - Number(e.delta));
    },
  });
  const hostileRuns = hostile.map((r) => drainTurn(r, { maxMs: 40_000 }));
  const hostileEvents = await Promise.all(hostileRuns);
  const hostileDoneMs = performance.now() - t0;
  const eluHostile = performance.eventLoopUtilization(elu0);
  const honestEvents = await honestRun;
  clearInterval(tick);
  const res = {
    label,
    hostileAllDoneMs: Math.round(hostileDoneMs),
    hostileKinds: [...new Set(hostileEvents.map((e) => e.map((x) => x.type + (x.type === "result" ? ":" + ((x as { errorKind?: string }).errorKind ?? "ok") : "")).join("+").replace(/(\+?tool-use)+/g, "+tool-use*")))].join(" | ").slice(0, 160),
    hostileLoopActiveMs: Math.round(eluHostile.active),
    maxStallMs: Math.round(stall),
    stallsOver100ms: stalls.length,
    peakRssGrowthMB: Math.round((peakRss - rss0) / 1e6),
    honestLatencyMs: stats(lat),
    honestResult: JSON.stringify(honestEvents[honestEvents.length - 1]),
  };
  console.log("RESULT C", JSON.stringify(res));
  return res;
}

(process.env.AW_MEASURE_CONCURRENT ? describe : describe.skip)("concurrent hostile turns (measurement)", () => {
  it("8 turns, each: 15.5 MB non-ASCII text line (valid event) x2", async () => {
    await scenario("8x 15.5MB lines", `const l=JSON.stringify({type:"assistant",message:{id:"m",content:[{type:"text",text:"é".repeat(7_000_000)}]}})+"\\n"; h.out(l); await h.sleep(200); h.out(l); await h.sleep(20000);`);
  });
  it("8 turns, each: 100k-key tool_use inputs (0.6 s of loop per line), paced to stay under the junk buckets", async () => {
    await scenario("8x manyKeys", `const al="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";const o={};let n=0;for(let a=0;a<62&&n<100000;a++)for(let b=0;b<62&&n<100000;b++)for(let c=0;c<62&&n<100000;c++){o[al[a]+al[b]+al[c]]=1;n++;}const l=JSON.stringify({type:"assistant",message:{id:"m",content:[{type:"tool_use",id:"t",name:"mcp__emma__search",input:o}]}})+"\\n"; for(let i=0;i<40;i++){ h.out(l); await h.sleep(50);} await h.sleep(20000);`);
  });
  it("8 turns, each paced at ~4% of a loop (the accepted never-killed case) for 8 s", async () => {
    // each iteration: ~one 20k-key tool_use line (~60-70 ms of loop) every 1.5 s
    await scenario("8x paced 4%", `const o={};for(let i=0;i<20000;i++)o["k"+i]=1;const l=JSON.stringify({type:"assistant",message:{id:"m",content:[{type:"tool_use",id:"t",name:"mcp__emma__search",input:o}]}})+"\\n"; const end=Date.now()+8000; while(Date.now()<end){ h.out(l); await h.sleep(1500);} h.out({type:"result",subtype:"success",is_error:false,result:"done"});`);
  });
});
