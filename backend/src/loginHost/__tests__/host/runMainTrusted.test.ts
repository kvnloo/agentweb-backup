/**
 * ENG-2113 review fix: runMain itself must run the trusted-path checks over EVERY path the config names (not only the list being right): a host whose node
 * path has a symlink on it must refuse to start, before anything else is verified or started. The root-only and machine checks are mocked; the config is real.
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const trusted: string[] = [];
const NODE = "/opt/aw-node/v22.23.3/bin/node";
jest.mock("../../host/binary", () => ({
  assertTrustedPath: jest.fn((p: string) => {
    trusted.push(p);
    if (p === NODE) throw new Error(`${p} is a symlink`);
  }),
  verifyBinary: jest.fn(async () => {
    throw new Error("verifyBinary reached");
  }),
}));
jest.mock("../../host/startupChecks", () => ({ assertRoot: jest.fn(), assertHomesMount: jest.fn(), parseMounts: jest.fn(() => []) }));
jest.mock("../../host/ranges", () => ({ registerRange: jest.fn() }));

import { verifyBinary } from "../../host/binary";
import { hostTrustedPaths, runMain } from "../../host/main";
import { parseHostConfig } from "../../host/hostConfig";

const dir = mkdtempSync(join(tmpdir(), "runmain-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const config = {
  env: "test1",
  uidMin: 420000,
  uidMax: 430000,
  socket: { dir: "/run/aw-login-host-test1", gid: 1000 },
  egress: { allow: ["api.anthropic.com:443"] },
  claude: { binaryPath: "/opt/aw-claude/2.1.294/claude", expectedSha256: "a".repeat(64), version: "2.1.294", systemPromptFile: "/opt/aw-login-host/system-prompt.txt", bridgeUrl: "http://127.0.0.1:3991/mcp", nodePath: NODE },
};

it("MUTATION TARGET: runMain refuses a config without claude.nodePath (required: no default) with a fixed start failure, before any path check", async () => {
  const noNode = JSON.parse(JSON.stringify(config));
  delete noNode.claude.nodePath;
  const cfgPath = join(dir, "nonode.json");
  writeFileSync(cfgPath, JSON.stringify(noNode));
  const lines: string[] = [];
  const write = jest.spyOn(process.stdout, "write").mockImplementation(((s: string) => (lines.push(String(s)), true)) as never);
  const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const on = jest.spyOn(process, "on").mockImplementation((() => process) as never);
  try {
    await runMain(["node", "main.js", cfgPath]);
  } finally {
    write.mockRestore();
    exit.mockRestore();
    on.mockRestore();
  }
  expect(lines.map((l) => JSON.parse(l)).some((l) => l.event === "host_start_failed")).toBe(true);
  expect(lines.join("")).toMatch(/nodePath/);
  trusted.length = 0; // (the other test reads what was checked)
});

it("MUTATION TARGET: runMain checks every configured path (node included) and refuses to start on a failing one, before verifying the binary", async () => {
  const cfgPath = join(dir, "test1.json");
  writeFileSync(cfgPath, JSON.stringify(config));
  const lines: string[] = [];
  const write = jest.spyOn(process.stdout, "write").mockImplementation(((s: string) => (lines.push(String(s)), true)) as never);
  const exit = jest.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  const on = jest.spyOn(process, "on").mockImplementation((() => process) as never); // the real process must not get an exit-on-error handler from a unit test
  let exitCalls: unknown[][];
  let registered: unknown[] = [];
  try {
    await runMain(["node", "main.js", cfgPath]);
  } finally {
    exitCalls = [...exit.mock.calls];
    registered = on.mock.calls.map((c) => c[0]);
    write.mockRestore();
    exit.mockRestore();
    on.mockRestore();
  }
  // the last-resort handlers are installed first thing, before any check can fail
  expect([...registered].sort()).toEqual(["uncaughtException", "unhandledRejection"]);
  expect(exitCalls).toEqual([[1]]);
  const failed = lines.map((l) => JSON.parse(l)).find((l) => l.event === "host_start_failed");
  expect(failed?.reason).toBe(`${NODE} is a symlink`);
  expect(verifyBinary).not.toHaveBeenCalled();
  // the config file first, then the full shared list up to the failing entry
  const list = hostTrustedPaths(parseHostConfig(config));
  expect(trusted[0]).toBe(cfgPath);
  expect(trusted.slice(1)).toEqual(list.slice(0, list.indexOf(NODE) + 1));
});
