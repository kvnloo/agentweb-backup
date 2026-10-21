/**
 * The host's write helper (deploy/aw-write-file.sh) run for real as the current user: the port builds its
 * arguments, but what the SHELL does with a hostile or broken target can only be tested by running it.
 */
import { spawn, execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const HELPER = join(__dirname, "..", "..", "deploy", "aw-write-file.sh");
const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "write-helper-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(umask: string, target: string, content: string, timeoutMs = 3000): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const c = spawn(HELPER, [umask, target], { env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "ignore", "ignore"] });
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      c.kill("SIGKILL");
    }, timeoutMs);
    c.stdin.on("error", () => undefined);
    c.stdin.end(content);
    c.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, timedOut });
    });
  });
}

describe("aw-write-file.sh", () => {
  it("creates nested directories searchable by the owner and the file with the requested mode (a 0177 umask must not break the directories)", async () => {
    const d = fresh();
    const target = join(d, "a", "b", "config.toml");
    expect(await run("0177", target, "x = 1\n")).toEqual({ code: 0, timedOut: false });
    expect(readFileSync(target, "utf8")).toBe("x = 1\n");
    expect((statSync(target).mode & 0o777).toString(8)).toBe("600");
    expect((statSync(join(d, "a", "b")).mode & 0o777).toString(8)).toBe("700");
    expect(readdirSync(join(d, "a", "b"))).toEqual(["config.toml"]); // no temp file left behind
  });
  it("refuses ANY existing entry, without blocking and without touching it: file, symlink, FIFO, directory", async () => {
    const d = fresh();
    writeFileSync(join(d, "file"), "original");
    expect((await run("0177", join(d, "file"), "new")).code).not.toBe(0);
    expect(readFileSync(join(d, "file"), "utf8")).toBe("original");
    writeFileSync(join(d, "victim"), "victim");
    symlinkSync(join(d, "victim"), join(d, "link"));
    expect((await run("0177", join(d, "link"), "new")).code).not.toBe(0);
    expect(readFileSync(join(d, "victim"), "utf8")).toBe("victim"); // not written through
    execFileSync("mkfifo", [join(d, "fifo")]);
    const fifo = await run("0177", join(d, "fifo"), "new");
    expect(fifo.timedOut).toBe(false); // a FIFO must not make it block
    expect(fifo.code).not.toBe(0);
    mkdirSync(join(d, "dir"));
    expect((await run("0177", join(d, "dir"), "new")).code).not.toBe(0);
  });
  it("a failure creating the directories leaves nothing and reports it", async () => {
    const d = fresh();
    writeFileSync(join(d, "afile"), "x"); // a FILE where a directory component is needed
    expect((await run("0177", join(d, "afile", "inner", "f"), "x")).code).not.toBe(0);
    expect(readdirSync(d)).toEqual(["afile"]);
  });
  it("never leaves a partial target: the content is written to a temporary name and moved into place", () => {
    const src = readFileSync(HELPER, "utf8");
    expect(src).toMatch(/tmp="\$target\.tmp\.\$\$"/);
    expect(src).toMatch(/mv -n "\$tmp" "\$target"/);
    expect(src).toMatch(/trap 'rm -f "\$tmp"' EXIT/);
  });
  it("an empty file is written too (the content may legitimately be empty)", async () => {
    const d = fresh();
    expect((await run("0177", join(d, "empty"), "")).code).toBe(0);
    expect(existsSync(join(d, "empty"))).toBe(true);
    expect(statSync(join(d, "empty")).size).toBe(0);
  });
});
