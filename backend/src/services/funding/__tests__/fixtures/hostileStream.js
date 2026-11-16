// Hostile / honest worker stream for the transport lag tests (a SEPARATE process, so the test's event loop is the only one measured). Usage: node hostileStream.js <socketPath> <attack>
// Hostile "worker" for local lag measurement. Usage: node attackServer.js <socketPath> <attack>
const http = require('http');
const fs = require('fs');
const [,, sock, attack] = process.argv;
try { fs.unlinkSync(sock); } catch {}
const NL = Buffer.from('\n');
const accepted = Buffer.from('{"type":"accepted","turnId":"t","duplicate":false}\n');
const line = (o) => Buffer.from(JSON.stringify(o) + '\n');
const MAXTOOL = Number(process.env.LINE || 1536 * 1024);
const MiB = 1024 * 1024;

function repeatStr(unit, targetBytes) { return unit.repeat(Math.floor(targetBytes / unit.length)); }

function build(attack) {
  switch (attack) {
    case 'usage20000': { const l = line({ type: 'usage', inputTokens: 1, outputTokens: 1 }); return [Buffer.concat(Array(20000).fill(l))]; }
    case 'usage20001': { const l = line({ type: 'usage', inputTokens: 1, outputTokens: 1 }); return [Buffer.concat(Array(20001).fill(l))]; }
    case 'wideArr': { // 42 tool-use lines, each ~1.5MiB array of zeros
      const body = '0,'.repeat(Math.floor((MAXTOOL - 120) / 2) - 1) + '0';
      const l = Buffer.from('{"type":"tool-use","operationId":"a","name":"x","input":[' + body + ']}\n');
      return Array(Math.floor(64 * MiB / l.length) - 1).fill(l);
    }
    case 'wideObj': {
      let s = ''; let i = 0; const parts = [];
      let size = 0;
      while (size < MAXTOOL - 200) { const p = '"k' + (i++) + '":0'; parts.push(p); size += p.length + 1; }
      const l = Buffer.from('{"type":"tool-use","operationId":"a","name":"x","input":{' + parts.join(',') + '}}\n');
      return Array(Math.floor(64 * MiB / l.length) - 1).fill(l);
    }
    case 'wideNested': { // many small nested arrays
      const unit = '[[[0]]],';
      const body = unit.repeat(Math.floor((MAXTOOL - 200) / unit.length)) + '0';
      const l = Buffer.from('{"type":"tool-use","operationId":"a","name":"x","input":[' + body + ']}\n');
      return Array(Math.floor(64 * MiB / l.length) - 1).fill(l);
    }
    case 'wideObjNested': { // many small objects with keys
      const unit = '{"a":{"b":1}},';
      const body = unit.repeat(Math.floor((MAXTOOL - 200) / unit.length)) + '0';
      const l = Buffer.from('{"type":"tool-use","operationId":"a","name":"x","input":[' + body + ']}\n');
      return Array(Math.floor(64 * MiB / l.length) - 1).fill(l);
    }
    case 'textPlain8': { const l = Buffer.from('{"type":"text","delta":"' + 'a'.repeat(8 * MiB - 100) + '"}\n'); return Array(7).fill(l); }
    case 'textEsc8': { const l = Buffer.from('{"type":"text","delta":"' + '\\u00e9'.repeat(Math.floor((8 * MiB - 100) / 6)) + '"}\n'); return Array(7).fill(l); }
    case 'textNl8': { const l = Buffer.from('{"type":"text","delta":"' + '\\n'.repeat(Math.floor((8 * MiB - 100) / 2)) + '"}\n'); return Array(7).fill(l); }
    case 'textQuotes8': { const l = Buffer.from('{"type":"text","delta":"' + '\\"'.repeat(Math.floor((8 * MiB - 100) / 2)) + '"}\n'); return Array(7).fill(l); }
    case 'textBackslash8': { const l = Buffer.from('{"type":"text","delta":"' + '\\\\'.repeat(Math.floor((8 * MiB - 100) / 2)) + '"}\n'); return Array(7).fill(l); }
    case 'textUtf8x3': { const l = Buffer.from('{"type":"text","delta":"' + '€'.repeat(Math.floor((8 * MiB - 100) / 3)) + '"}\n'); return Array(7).fill(l); }
    case 'resultBig': { const l = Buffer.from('{"type":"result","ok":true,"text":"' + 'a'.repeat(8 * MiB - 100) + '"}\n'); return [l]; }
    case 'unknownBig': { const l = Buffer.from('{"type":"zzz","x":"' + 'a'.repeat(8 * MiB - 100) + '"}\n'); return Array(7).fill(l); }
    case 'blank300': return [Buffer.from('\n'.repeat(300))];
    case 'blank255': return [Buffer.concat([Buffer.from('\n'.repeat(255)), line({ type: 'usage', inputTokens: 1 })])];
    case 'noNewline64': return Array(64).fill(Buffer.alloc(MiB, 0x61));
    case 'tinyChunks': { const l = line({ type: 'usage', inputTokens: 1, outputTokens: 1 }); return { chunks: Array(20000).fill(l), split: 1 }; }
    case 'deep64x': { // depth 64 nested arrays repeated to fill the tool line cap
      const unit = '['.repeat(60) + ']'.repeat(60) + ',';
      const body = unit.repeat(Math.floor((MAXTOOL - 200) / unit.length)) + '0';
      const l = Buffer.from('{"type":"tool-use","operationId":"a","name":"x","input":[' + body + ']}\n');
      return Array(Math.floor(64 * MiB / l.length) - 1).fill(l);
    }
    case 'toolCallWide': { // tool-call envelope with a wide input (what the dispatcher gets)
      const body = '0,'.repeat(Math.floor((MAXTOOL - 200) / 2) - 1) + '0';
      const arr = [];
      for (let i = 0; i < 40; i++) arr.push(Buffer.from('{"type":"tool-call","operationId":"op' + i + '","messageId":"m","name":"get_leads","input":{"a":[' + body + ']}}\n'));
      return arr;
    }
    case 'wideEntitle': { // 'entitlement' is a known event with an object; wide array of windows (cap 64 KiB line)
      const w = '{"name":"a","utilization":1,"resetsAtMs":1},'.repeat(1400) + '{"name":"a"}';
      return [Buffer.from('{"type":"entitlement","observation":{"windows":[' + w + ']}}\n')];
    }
    case 'toolCallNested': { // tool-call envelope with a deeply branching input (what the dispatcher would execute)
      const unit = '[[[0]]],';
      const body = unit.repeat(Math.floor((MAXTOOL - 300) / unit.length)) + '0';
      const arr = [];
      for (let i = 0; i < 40; i++) arr.push(Buffer.from('{"type":"tool-call","operationId":"op' + i + '","messageId":"m","name":"get_leads","input":{"a":[' + body + ']}}\n'));
      return arr;
    }
    case 'honest': { // the biggest events an honest turn can produce on a relay turn
      const big = (n) => 'x'.repeat(n);
      return [
        line({ type: 'usage', inputTokens: 5, outputTokens: 7 }),
        line({ type: 'text', delta: big(100 * 1024) }), // a long assistant text block (over the text cap: discarded)
        line({ type: 'tool-use', operationId: 'u1', name: 'search', input: { q: big(50 * 1024) } }),
        line({ type: 'tool-call', operationId: 'op1', messageId: 'm1', name: 'search', input: { q: big(200 * 1024) } }),
        line({ type: 'tool-result', operationId: 'u1', ok: true }),
        line({ type: 'result', ok: true, text: big(300 * 1024) }),
      ];
    }
    case 'bigToolUseRelay': return [line({ type: 'tool-use', operationId: 'u2', name: 'search', input: { q: 'y'.repeat(300 * 1024) } })];
    case 'bigToolCallRelay': return [Buffer.from(JSON.stringify({ type: 'tool-call', operationId: 'op2', messageId: 'm1', name: 'save_note', input: { note: 'z'.repeat(600 * 1024) } }) + '\n')];
    case 'toolCallNestedUnderCap': { // under the 320 KiB line cap, but 100,000 brackets
      const body = '[[[0]]],'.repeat(Math.floor(300 * 1024 / 8)) + '0';
      return [Buffer.from('{"type":"tool-call","operationId":"op9","messageId":"m","name":"get_leads","input":{"a":[' + body + ']}}\n')];
    }
    case 'legacyToolUse1M': return [line({ type: 'tool-use', operationId: 'u3', name: 'search', input: { q: 'w'.repeat(1024 * 1024) } })];
    case 'twoResults': return [line({ type: 'result', ok: true, text: 'first' }), Buffer.from('{"type":"result","ok":true,"text":"' + 'a'.repeat(900 * 1024) + '"}\n'), line({ type: 'result', ok: true, text: 'third' })];
    case 'usage200': { const l = line({ type: 'usage', inputTokens: 1, outputTokens: 1 }); return [Buffer.concat(Array(200).fill(l))]; }
    default: throw new Error('unknown attack ' + attack);
  }
}

const pre = build(attack);
let chunks = Array.isArray(pre) ? pre : pre.chunks;
const GAP = Number(process.env.GAP || 0); const REPS = Number(process.env.REPS || 0);
if (REPS) chunks = chunks.slice(0, REPS);
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const split = Array.isArray(pre) ? 0 : pre.split;

const srv = http.createServer((req, res) => {
  req.resume();
  req.on('end', async () => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(accepted);
    const t0 = Date.now();
    const writeAll = async (buf) => { if (!res.write(buf)) await new Promise((r) => res.once('drain', r)); };
    try {
      for (const c of chunks) {
        if (res.destroyed) break;
        if (split) { for (let i = 0; i < c.length; i += 1) await writeAll(c.subarray(i, i + 1)); }
        else { await writeAll(c); if (GAP) await sleepMs(GAP); }
      }
      if (!res.destroyed) { if (attack !== 'honest' && attack !== 'twoResults') res.write(line({ type: 'result', ok: true, text: 'done' })); res.end(); }
    } catch {}
  });
});
srv.listen(sock, () => console.log('ready'));
process.on('SIGTERM', () => { srv.close(); process.exit(0); });
