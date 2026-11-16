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

  /** The jobs of the workflow, comments removed. */
  const jobsOf = () => {
    const code = WORKFLOW.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    const body = code.slice(code.indexOf("\njobs:\n"));
    const parts = body.split(/\n {2}([a-z]+):\n/); // ["", "test", text, "build", text, ...]
    const out: Record<string, string> = {};
    for (let i = 1; i < parts.length; i += 2) out[parts[i]] = parts[i + 1];
    return out;
  };

  it("four jobs, each trusting less than the next: only the last holds cloud credentials, and it runs no npm and parses no archive", () => {
    const j = jobsOf();
    expect(Object.keys(j)).toEqual(["test", "build", "verify", "deploy"]);
    for (const name of ["test", "build", "verify"]) {
      expect({ name, idToken: /id-token:\s*write/.test(j[name]) }).toEqual({ name, idToken: false });
      expect({ name, creds: /configure-aws-credentials|role-to-assume/.test(j[name]) }).toEqual({ name, creds: false });
      expect({ name, env: /environment:/.test(j[name]) }).toEqual({ name, env: false });
    }
    // test and build install without lifecycle scripts; the tests run ONLY in the test job and packaging ONLY in the build job
    expect(j.test).toContain("npm ci --ignore-scripts");
    expect(j.build).toContain("npm ci --ignore-scripts");
    expect(j.test).toContain("--tests-only");
    expect(j.build).toContain("--tests-run-elsewhere");
    expect(j.build).not.toMatch(/jest|--tests-only/);
    expect(j.test).not.toMatch(/upload-artifact/); // the job that runs dev-dependency code produces nothing that gets signed
    // verify has no npm either; deploy has the credentials, the environment, and no npm/tar parsing
    expect(j.verify).not.toMatch(/\bnpm\b|\bnpx\b/);
    expect(j.deploy).toMatch(/id-token:\s*write/);
    expect(j.deploy).toContain("environment: login-host-prod");
    expect(j.deploy).not.toMatch(/\bnpm\b|\bnpx\b|\btar\s+-|login-host-verify-build/); // (it never unpacks an archive)
    expect(WORKFLOW).not.toMatch(/pull_request/);
  });

  it("the chain: verify needs test and build; deploy needs all three; artifacts are fetched BY ID, never by name, and the signed file must be the verified one", () => {
    const j = jobsOf();
    expect(j.verify).toMatch(/needs: \[test, build\]/);
    expect(j.deploy).toMatch(/needs: \[test, build, verify\]/);
    for (const name of ["verify", "deploy"]) {
      expect(j[name]).toContain("artifact-ids: ${{ needs.build.outputs.artifact_id }}");
      expect(j[name]).not.toMatch(/download-artifact[\s\S]{0,120}\n\s+name:/);
    }
    expect(j.deploy).toContain("needs.verify.outputs.sha256");
    // the comparison itself is there and fails the job on a mismatch (not just the variable's name)
    expect(j.deploy).toMatch(/sha256sum "\$\{found\[0\]\}" \| cut -d' ' -f1\)" = "\$VERIFIED_SHA256" \] \|\| \{ echo "::error::[^"]*"; exit 1; \}/);
    // nothing is signed before the sha256 check, and credentials come after it
    const d = j.deploy;
    expect(d.indexOf("VERIFIED_SHA256")).toBeGreaterThan(0);
    expect(d.indexOf("VERIFIED_SHA256")).toBeLessThan(d.indexOf("configure-aws-credentials"));
    expect(d.indexOf("configure-aws-credentials")).toBeLessThan(d.indexOf('sign-login-host.sh "$TAR"'));
  });

  it("every job runs only from main AND only once someone has switched the pipeline on (so a merge before the one-time setup runs nothing at all)", () => {
    const j = jobsOf();
    for (const name of Object.keys(j)) expect({ name, gated: j[name].includes("if: github.ref == 'refs/heads/main' && vars.LOGIN_HOST_DEPLOY_ENABLED == 'true'") }).toEqual({ name, gated: true });
  });
});
