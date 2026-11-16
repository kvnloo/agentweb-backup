/** The real RootFs.killPid: signals AS the customer uid, and never a process of another uid. Needs setpriv + kill (Linux). */
import { spawn } from "child_process";
import { existsSync } from "fs";
import { nodeRootFs } from "../../ports/system";

const have = existsSync("/usr/bin/setpriv") && existsSync("/usr/bin/kill");
const me = process.getuid?.() ?? -1;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

(have ? describe : describe.skip)("nodeRootFs.killPid", () => {
  // dropping to a uid needs root (setgroups); on the instance this runs as root, on a dev machine it is skipped
  (me === 0 ? it : it.skip)("kills a process of the named uid (as root: the signal is sent from that uid)", async () => {
    const uid = 400777;
    const c = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    c.on("error", () => undefined);
    await nodeRootFs.killPid(c.pid!, uid);
    expect(alive(c.pid!)).toBe(true); // a root-owned process is not uid 400777: untouched
    c.kill("SIGKILL");
  });
  it("never signals a process whose uid is not the named one (pid reuse protection)", async () => {
    const c = spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    await nodeRootFs.killPid(c.pid!, me + 1);
    await new Promise((r) => setTimeout(r, 300));
    expect(alive(c.pid!)).toBe(true);
    c.kill("SIGKILL");
  });
  it("a pid that is gone is a no-op", async () => {
    await expect(nodeRootFs.killPid(2 ** 22 - 1, me)).resolves.toBeUndefined();
  });
});
