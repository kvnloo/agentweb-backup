/**
 * ENG-2110: the login-host deploy workflow only runs when a path in its filter changes. If the worker bundle imports a file the filter does not cover, a change
 * to that file ships to the backend but silently never to the worker. This bundles the worker the way the build does and checks every input is covered.
 */
import { readFileSync } from "fs";
import { join, relative } from "path";
import { buildSync } from "esbuild";

const BACKEND = join(__dirname, "../../../..");
const WORKFLOW = readFileSync(join(BACKEND, "../.github/workflows/login-host-deploy.yml"), "utf8");

function pushPaths(): string[] {
  const m = /on:\n {2}push:\n[\s\S]*?paths:\n((?: {6}- '.*'\n)+)/.exec(WORKFLOW);
  if (!m) throw new Error("cannot find the push paths filter in the workflow");
  return [...m[1].matchAll(/- '(.*)'/g)].map((x) => x[1]);
}
const matches = (file: string, p: string) => (p.endsWith("/**") ? file.startsWith(p.slice(0, -2)) : p.includes("**/*.") ? file.startsWith(p.split("**/*.")[0]) && file.endsWith("." + p.split("**/*.")[1]) : file === p);
/** GitHub's rule: a path triggers when it matches a positive pattern and no LATER negated pattern. */
const covered = (file: string, patterns: string[]) => {
  let hit = false;
  for (const p of patterns) if (p.startsWith("!") ? matches(file, p.slice(1)) && (hit = false) : matches(file, p)) hit = true;
  return hit;
};

describe("login-host-deploy.yml path filter", () => {
  it("covers every source file the worker's bundles import", () => {
    const patterns = pushPaths();
    const inputs = new Set<string>();
    for (const entry of ["src/loginHost/host/start.ts", "src/loginHost/deploy/prod/check-config.ts", "src/loginHost/deploy/prod/deployCtl.ts"]) {
      const r = buildSync({ entryPoints: [join(BACKEND, entry)], bundle: true, platform: "node", target: "node22", write: false, metafile: true, logLevel: "error", external: ["@react-email/render", "*.node"] });
      for (const f of Object.keys(r.metafile!.inputs)) if (!f.includes("node_modules")) inputs.add(relative(join(BACKEND, ".."), join(BACKEND, f)));
    }
    const uncovered = [...inputs].filter((f) => f.startsWith("backend/") && !covered(f, patterns));
    expect(uncovered).toEqual([]);
    expect(inputs.size).toBeGreaterThan(20); // it really looked at the bundle
  });

  it("test files and docs under the host do NOT trigger a worker deploy (a restart for nothing), but code does", () => {
    const p = pushPaths();
    expect(covered("backend/src/loginHost/__tests__/deploy/deployScript.test.ts", p)).toBe(false);
    expect(covered("backend/src/loginHost/deploy/prod/README.md", p)).toBe(false);
    expect(covered("backend/src/loginHost/deploy/aws/README.md", p)).toBe(false);
    expect(covered("backend/src/loginHost/connectionManager.ts", p)).toBe(true);
    expect(covered("backend/src/loginHost/deploy/prod/deploy.sh", p)).toBe(true);
    expect(covered("backend/src/loginHost/deploy/prod/versions.env", p)).toBe(true);
  });

  it("the filter itself includes the workflow, the scripts it runs and the lockfile", () => {
    const p = pushPaths();
    for (const f of [".github/workflows/login-host-deploy.yml", ".github/scripts/login-host-run-deploy.sh", "backend/scripts/build-login-host.sh", "backend/scripts/sign-login-host.sh", "backend/package-lock.json"]) expect(p).toContain(f);
  });

  it("the deploy job runs no npm and the build job holds no cloud credentials", () => {
    const code = WORKFLOW.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n"); // comments may mention npm
    const [build, deploy] = code.split(/\n {2}deploy:\n/);
    expect(build).not.toMatch(/id-token:\s*write/);
    expect(build).not.toMatch(/configure-aws-credentials|role-to-assume/);
    expect(build).toContain("npm ci --ignore-scripts");
    expect(deploy).toMatch(/id-token:\s*write/);
    expect(deploy).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(deploy).toContain("environment: login-host-prod");
    expect(WORKFLOW).not.toMatch(/pull_request/);
    // both jobs: only from main AND only once someone has switched the pipeline on (so a merge before the one-time setup runs nothing at all)
    expect(WORKFLOW.match(/if: github\.ref == 'refs\/heads\/main' && vars\.LOGIN_HOST_DEPLOY_ENABLED == 'true'/g)).toHaveLength(2);
    // nothing is signed before the build is checked against this commit, and credentials come after the check
    const iVerify = deploy.indexOf("login-host-verify-build.sh");
    expect(iVerify).toBeGreaterThan(0);
    expect(iVerify).toBeLessThan(deploy.indexOf("configure-aws-credentials"));
    expect(deploy.indexOf("configure-aws-credentials")).toBeLessThan(deploy.indexOf("sign-login-host.sh \"$tar_file\""));
  });
});
