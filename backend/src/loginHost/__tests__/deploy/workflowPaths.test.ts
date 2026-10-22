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
const covered = (file: string, patterns: string[]) => patterns.some((p) => (p.endsWith("/**") ? file.startsWith(p.slice(0, -2)) : file === p));

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
    expect(WORKFLOW.match(/if: github\.ref == 'refs\/heads\/main'/g)).toHaveLength(2);
  });
});
