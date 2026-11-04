/**
 * ENG-2113 (correctness review): the turn wrapper reads the tool manifest as a LENGTH-PREFIXED block with `dd`, not `IFS= read -r` (a pipe is read one byte at a time:
 * 0.60 s for 93 KB, 3.25 s for 503 KB and about 7 s at the 1 MiB cap under bash, spent against the unit's CPU quota on every relay turn). Driven with real shells.
 */
import { spawn } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MANIFEST_WIRE_MAX_BYTES, manifestLines, TOOL_LIMITS } from "../protocol";

const WRAPPER = join(__dirname, "..", "deploy", "claude-turn.sh");
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

interface Out {
  code: number | null;
  stdout: string;
  tools: Buffer | undefined;
  ms: number;
}
function runWrapper(shell: "sh" | "bash", input: Buffer, env: Record<string, string> = { AW_TURN_TOOLS: "1" }): Promise<Out> {
  const root = mkdtempSync(join(tmpdir(), "wrap-manifest-"));
  roots.push(root);
  const tmp = join(root, "tmp");
  mkdirSync(tmp);
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    // the wrapper then execs `cat` (the CLI\x27s place): what it prints is exactly the stdin left after the manifest block
    const c = spawn(shell, [WRAPPER, "/bin/cat"], { env: { PATH: "/usr/bin:/bin", TMPDIR: tmp, ...env }, stdio: ["pipe", "pipe", "ignore"] });
    let stdout = "";
    c.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    c.on("error", reject);
    c.on("exit", (code) => {
      let tools: Buffer | undefined;
      try {
        tools = readFileSync(join(tmp, "aw-cfg", "tools.json"));
      } catch {
        tools = undefined;
      }
      resolve({ code, stdout, tools, ms: Date.now() - t0 });
    });
    c.stdin.on("error", () => undefined);
    c.stdin.end(input);
  });
}
const manifest = (bytes: number): string => JSON.stringify([{ name: "t", description: "d".repeat(Math.max(0, bytes - 60)), inputSchema: { type: "object" } }]);
const stream = (lines: string[], rest = "REST-OF-STDIN\n") => Buffer.from('{"mcpServers":{}}\n' + lines.map((l) => l + "\n").join("") + rest);

describe.each(["sh", "bash"] as const)("claude-turn.sh manifest block (%s)", (shell) => {
  it.each([93 * 1024, 503 * 1024, 1024 * 1024])("MUTATION TARGET: a %i-byte manifest arrives byte for byte, 0600, the rest of stdin untouched, and fast (the old byte-at-a-time read took seconds)", async (size) => {
    const json = manifest(size);
    let o = await runWrapper(shell, stream(manifestLines(JSON.parse(json))));
    for (let retry = 0; retry < 2 && o.ms >= 2500; retry++) {
      const again = await runWrapper(shell, stream(manifestLines(JSON.parse(json)))); // the fastest of up to three: the old read is slow every time, a starved runner only once (the gate fails closed)
      if (again.ms < o.ms) o = again;
    }
    const expected = JSON.stringify(JSON.parse(json));
    expect(o.code).toBe(0);
    expect(o.tools!.toString("utf8")).toBe(expected);
    expect(o.stdout).toBe("REST-OF-STDIN\n");
    console.log(`wrapper ${shell} manifest ${size} bytes: ${o.ms} ms`);
    expect(o.ms).toBeLessThan(2500); // 3.25 s for 503 KB and ~7 s for 1 MiB with the old read, under bash
  });

  it("the file is private to the unit\x27s uid (umask 077)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wrap-mode-"));
    roots.push(root);
    const tmp = join(root, "tmp");
    mkdirSync(tmp);
    await new Promise<void>((res) => {
      const c = spawn(shell, [WRAPPER, "/bin/cat"], { env: { PATH: "/usr/bin:/bin", TMPDIR: tmp, AW_TURN_TOOLS: "1" }, stdio: ["pipe", "ignore", "ignore"] });
      c.on("exit", () => res());
      c.stdin.on("error", () => {});
      c.stdin.end(stream(manifestLines([{ name: "t" }])));
    });
    expect(statSync(join(tmp, "aw-cfg", "tools.json")).mode & 0o777).toBe(0o600);
  });

  it("a manifest with multi-byte characters is counted in BYTES", async () => {
    const tools = [{ name: "t", description: "é日本😀".repeat(50) }];
    const [len, json] = manifestLines(tools);
    expect(Number(len)).toBeGreaterThan(json.length);
    const o = await runWrapper(shell, stream([len, json]));
    expect(o.code).toBe(0);
    expect(o.tools!.toString("utf8")).toBe(json);
    expect(o.stdout).toBe("REST-OF-STDIN\n");
  });

  it("without AW_TURN_TOOLS the stdin shape is byte-identical to before (legacy): no manifest is read, nothing is written", async () => {
    const o = await runWrapper(shell, Buffer.from('{"mcpServers":{}}\nSTREAM-JSON-LINE\n'), {});
    expect(o.code).toBe(0);
    expect(o.stdout).toBe("STREAM-JSON-LINE\n");
    expect(o.tools).toBeUndefined();
  });

  it.each([
    ["non-digits", ["12abc", "{}"]],
    ["a minus sign", ["-5", "{}"]],
    ["a plus sign (dd would accept it)", ["+2", "{}"]],
    ["a leading zero", ["07", "{}"]],
    ["empty length", ["", "{}"]],
    ["a huge length (8 digits)", ["99999999", "{}"]],
    ["one over the bound", [String(MANIFEST_WIRE_MAX_BYTES + 1), "{}"]],
    ["a length larger than the data", ["500", "{}"]],
    ["a length smaller than the data (the block does not end in a newline)", ["1", "{}"]],
    ["data after the block on the same line", ["2", "{}junk"]],
    ["a space in the length", ["2 ", "{}"]],
  ] as Array<[string, string[]]>)("MUTATION TARGET: hostile prefix \x27%s\x27 is refused with exit 64 and the conversation is not consumed as a manifest", async (_name, lines) => {
    const o = await runWrapper(shell, stream(lines, ""));
    expect(o.code).toBe(64);
    expect(o.stdout).toBe(""); // the CLI never started
  });

  it("the largest accepted length works at the bound", async () => {
    const o = await runWrapper(shell, stream([String(MANIFEST_WIRE_MAX_BYTES), "x".repeat(MANIFEST_WIRE_MAX_BYTES)]));
    expect(o.code).toBe(0);
    expect(o.tools!.length).toBe(MANIFEST_WIRE_MAX_BYTES);
  });
});

it("the wrapper\x27s own bound is the protocol\x27s (TOOL_LIMITS.maxTotalBytes + 4096), and the host writes length-prefixed lines", () => {
  expect(MANIFEST_WIRE_MAX_BYTES).toBe(TOOL_LIMITS.maxTotalBytes + 4096);
  expect(readFileSync(WRAPPER, "utf8")).toContain(`-le ${MANIFEST_WIRE_MAX_BYTES} ]`);
  expect(manifestLines([{ a: 1 }])).toEqual(["9", '[{"a":1}]']);
});
