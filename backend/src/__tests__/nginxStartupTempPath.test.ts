import fs from "fs";
import path from "path";

/**
 * Regression guard for the 2026-06-26 prod outage ("Failed to load users").
 *
 * A custom `client_body_temp_path /var/tmp/agentweb-nginx/...` plus a predeploy
 * hook that created it was added to "keep large bodies off disk". On the AL2023
 * platform nginx.service runs with PrivateTmp=true, so nginx gets a *private*
 * /var/tmp that does not contain the host-created dir. nginx's startup
 * `nginx -t` does a non-recursive mkdir of the temp leaf and fails with:
 *   nginx: [emerg] mkdir() "/var/tmp/agentweb-nginx/client_body" failed (ENOENT)
 * => `systemctl start nginx` exits 1 => every fresh EB deploy fails => the env
 * cannot self-heal. (nginx -t passes when EB runs it out-of-band in the host
 * namespace, which is why syntax checks looked fine.)
 *
 * The fix is to NOT override nginx's temp paths: stock paths live under
 * /var/lib/nginx/tmp, which PrivateTmp does not isolate. Large *responses*
 * (e.g. GET /admin/users ~1.9MB) are kept in memory by proxy_buffers.conf, not
 * by a custom temp dir. These tests pin that decision so it can't regress.
 */

const platformDir = path.join(process.cwd(), ".platform");
const clientBodyConf = path.join(
  platformDir,
  "nginx/conf.d/client_max_body_size.conf"
);
const proxyBuffersConf = path.join(
  platformDir,
  "nginx/conf.d/proxy_buffers.conf"
);
const predeployHooksDir = path.join(platformDir, "hooks/predeploy");

describe("nginx temp-path / startup safety on AL2023 (PrivateTmp)", () => {
  it("does NOT pin client_body_temp_path to a custom /var/tmp dir", () => {
    const conf = fs.readFileSync(clientBodyConf, "utf8");
    // Allow the explanatory comment, but no active directive.
    const activeLines = conf
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    expect(activeLines.some((l) => l.startsWith("client_body_temp_path"))).toBe(
      false
    );
    expect(activeLines.join("\n")).not.toMatch(/\/var\/tmp\/agentweb-nginx/);
  });

  it("does NOT ship a predeploy hook that creates a custom nginx temp dir", () => {
    if (!fs.existsSync(predeployHooksDir)) return; // no hooks dir at all is fine
    for (const file of fs.readdirSync(predeployHooksDir)) {
      const body = fs.readFileSync(path.join(predeployHooksDir, file), "utf8");
      expect(body).not.toMatch(/\/var\/tmp\/agentweb-nginx/);
      expect(body).not.toMatch(/nginx\.service\.d/);
    }
  });

  it("keeps the in-memory proxy buffering that holds the /admin/users response", () => {
    const conf = fs.readFileSync(proxyBuffersConf, "utf8");
    // ~4MB of in-memory proxy buffers so a ~1.9MB response never spills to disk.
    const buffers = conf.match(/^\s*proxy_buffers\s+(\d+)\s+(\d+)k;/m);
    expect(buffers).not.toBeNull();
    const totalKb = Number(buffers![1]) * Number(buffers![2]);
    expect(totalKb).toBeGreaterThanOrEqual(2048);
    expect(conf).toMatch(/^\s*proxy_max_temp_file_size\s+0;/m);
  });
});
