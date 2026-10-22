/**
 * ENG-2110: the one-time AWS setup (deploy/aws/setup-once.sh + policies). It runs once, by a person with IAM rights, and cannot be tested against AWS
 * from here, so what is tested is what can be: the policies are valid and as narrow as the design says (nothing wildcard that should not be), the script
 * changes nothing without --apply, and with --apply it issues exactly the expected calls in a working order (fake `aws`, real openssl and renderer).
 */
import { spawnSync } from "child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync } from "crypto";

const AWS_DIR = join(__dirname, "../../deploy/aws");
const SETUP = join(AWS_DIR, "setup-once.sh");
const sub = (s: string) =>
  s
    .replace(/@@ACCOUNT@@/g, "992382574572")
    .replace(/@@REPO@@/g, "AgentWebPro/agentweb")
    .replace(/@@ENVIRONMENT@@/g, "login-host-prod")
    .replace(/@@BUCKET@@/g, "agentweb-login-host-992382574572")
    .replace(/@@REGION@@/g, "us-west-2")
    .replace(/@@DOCUMENT@@/g, "AW-LoginHost-Deploy-Prod")
    .replace(/@@INSTANCE@@/g, "i-033394e5467b48e94")
    .replace(/@@CI_ROLE@@/g, "aw-login-host-ci")
    .replace(/@@KEY_ARN@@/g, "arn:aws:kms:us-west-2:992382574572:key/1234abcd-12ab-34cd-56ef-1234567890ab");
const policy = (name: string) => JSON.parse(sub(readFileSync(join(AWS_DIR, "policies", name), "utf8")));

describe("the policies", () => {
  it("every template renders to valid JSON with no placeholder left", () => {
    for (const f of readdirSync(join(AWS_DIR, "policies"))) {
      const text = sub(readFileSync(join(AWS_DIR, "policies", f), "utf8"));
      expect({ f, left: text.match(/@@[A-Z_]+@@/g) }).toEqual({ f, left: null });
      expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  it("only the login-host-prod environment of THIS repo can assume the CI role, and only through the OIDC provider, for sts.amazonaws.com", () => {
    const st = policy("ci-role-trust.json.tpl").Statement;
    expect(st).toHaveLength(1);
    expect(st[0].Principal).toEqual({ Federated: "arn:aws:iam::992382574572:oidc-provider/token.actions.githubusercontent.com" });
    expect(st[0].Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(st[0].Condition).toEqual({ StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com", "token.actions.githubusercontent.com:sub": "repo:AgentWebPro/agentweb:environment:login-host-prod" } });
    expect(JSON.stringify(st)).not.toContain("StringLike"); // no wildcard in the subject
    expect(JSON.stringify(st)).not.toMatch(/\*/);
  });

  it("the CI role can write builds, sign with ONE key, and run ONE document on ONE instance; nothing else", () => {
    const st = policy("ci-role-permissions.json.tpl").Statement as Array<{ Sid: string; Action: string | string[]; Resource: string | string[] }>;
    const by = Object.fromEntries(st.map((s) => [s.Sid, s]));
    expect(by.WriteBuildsOnly).toMatchObject({ Action: "s3:PutObject", Resource: "arn:aws:s3:::agentweb-login-host-992382574572/prod/builds/*" });
    expect(by.SignWithTheOneKey.Resource).toMatch(/^arn:aws:kms:us-west-2:992382574572:key\/[0-9a-f-]+$/);
    expect(by.SignWithTheOneKey.Action).toEqual(["kms:Sign", "kms:GetPublicKey"]);
    expect(by.RunTheOneDocumentOnTheOneInstance.Resource).toEqual(["arn:aws:ssm:us-west-2:992382574572:document/AW-LoginHost-Deploy-Prod", "arn:aws:ec2:us-west-2:992382574572:instance/i-033394e5467b48e94"]);
    // the only statement with Resource "*" is reading a command's result; no action anywhere is a wildcard
    expect(st.filter((s) => s.Resource === "*").map((s) => s.Sid)).toEqual(["ReadTheResult"]);
    for (const s of st) for (const a of ([] as string[]).concat(s.Action)) expect(a).not.toMatch(/\*/);
    // it cannot read other builds back, or touch the worker's other resources, IAM, or the document itself
    const actions = st.flatMap((s) => ([] as string[]).concat(s.Action));
    expect(actions.sort()).toEqual(["kms:GetPublicKey", "kms:Sign", "s3:PutObject", "ssm:GetCommandInvocation", "ssm:SendCommand"]);
  });

  it("only the CI role may sign with the key; the account administers it but its own grant does not include signing", () => {
    const st = policy("kms-key-policy.json.tpl").Statement as Array<{ Sid: string; Principal: { AWS: string }; Action: string[]; Resource: string }>;
    const admin = st.find((s) => s.Sid.startsWith("AccountAdministers"))!;
    const signer = st.find((s) => s.Sid === "OnlyTheDeployPipelineSigns")!;
    expect(signer.Principal.AWS).toBe("arn:aws:iam::992382574572:role/aw-login-host-ci");
    expect(signer.Action).toEqual(["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]);
    expect(admin.Action.some((a) => a === "kms:*" || a === "kms:Sign" || a === "kms:Sign*")).toBe(false);
    expect(admin.Action).not.toContain("kms:Encrypt");
    expect(st).toHaveLength(2);
  });

  it("the worker may read the builds prefix and nothing else", () => {
    const st = policy("worker-builds-read.json.tpl").Statement;
    expect(st).toEqual([{ Sid: "ReadBuildsOnly", Effect: "Allow", Action: "s3:GetObject", Resource: "arn:aws:s3:::agentweb-login-host-992382574572/prod/builds/*" }]);
  });
});

describe("setup-once.sh", () => {
  let dir: string;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aws-setup-"));
    out = join(dir, "out");
    const k = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(join(dir, "pub.der.b64"), k.publicKey.export({ type: "spki", format: "der" }).toString("base64"));
    // the fake aws logs every call; reads answer like a fresh account (no provider, no role, no key, no document)
    writeFileSync(
      join(dir, "aws"),
      `#!/bin/bash
echo "$*" >> "${dir}/calls"
case "$1 $2" in
  "sts get-caller-identity") echo 992382574572 ;;
  "iam list-open-id-connect-providers") echo "" ;;
  "iam get-role") exit 254 ;;
  "kms describe-key") if [ -f "${dir}/key-created" ]; then echo arn:aws:kms:us-west-2:992382574572:key/1234abcd-12ab-34cd-56ef-1234567890ab; else exit 254; fi ;;
  "kms create-key") touch "${dir}/key-created"; echo 1234abcd-12ab-34cd-56ef-1234567890ab ;;
  "kms get-public-key") cat "${dir}/pub.der.b64" ;;
  "ssm describe-document") exit 254 ;;
esac
exit 0
`,
    );
    chmodSync(join(dir, "aws"), 0o755);
    writeFileSync(join(dir, "calls"), "");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A fake `gh api`: environment json, then the branch policies. Variants: good | unrestricted | extra | missing */
  const fakeGh = (variant: "good" | "unrestricted" | "extra" | "missing") => {
    const envJson = variant === "unrestricted" ? '{"deployment_branch_policy":null}' : '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}';
    const names = variant === "extra" ? "main\nrelease" : "main";
    writeFileSync(
      join(dir, "gh"),
      variant === "missing" ? "#!/bin/bash\nexit 1\n" : `#!/bin/bash\ncase "$*" in\n  *deployment-branch-policies*) printf '${names}\\n' ;;\n  *environments/login-host-prod*) echo '${envJson}' ;;\nesac\n`,
    );
    chmodSync(join(dir, "gh"), 0o755);
  };
  const run = (...args: string[]) => {
    if (!args.some((a) => a === "--none")) fakeGhDefault();
    return spawnSync("bash", [SETUP, ...args.filter((a) => a !== "--none")], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", AW_AWS: join(dir, "aws"), AW_GH: join(dir, "gh"), AW_SETUP_OUT: out } });
  };
  let fakeGhDefault = () => fakeGh("good");
  const calls = () => readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean);
  const MUTATING = /^(iam (create|update|put|delete|attach)|kms (create|put|schedule|disable)|ssm (create|update|send|delete)|s3 )/;

  it("a dry run PRINTS the plan and changes nothing", () => {
    mkdirOut();
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DRY RUN");
    expect(calls().filter((c) => MUTATING.test(c))).toEqual([]);
    for (const needle of ["create the GitHub OIDC provider", "create the CI role", "create the signing key", "give the CI role exactly", "let the worker read the builds prefix"]) expect(r.stdout).toContain(needle);
  });

  it("--apply creates things in an order that works: provider, role, key (the key policy names the role), permissions, then the document with the key's public half", () => {
    mkdirOut();
    const r = run("--apply");
    expect(r.status).toBe(0);
    const c = calls().filter((x) => MUTATING.test(x));
    const at = (needle: string) => c.findIndex((x) => x.includes(needle));
    expect(at("iam create-open-id-connect-provider")).toBeGreaterThanOrEqual(0);
    expect(at("iam create-role --role-name aw-login-host-ci")).toBeGreaterThan(at("iam create-open-id-connect-provider"));
    expect(at("kms create-key")).toBeGreaterThan(at("iam create-role"));
    expect(at("kms create-alias --alias-name alias/aw-login-host-signing")).toBeGreaterThan(at("kms create-key"));
    expect(at("iam put-role-policy --role-name aw-login-host-ci")).toBeGreaterThan(at("kms create-alias"));
    expect(at("iam put-role-policy --role-name eng1816-worker-role")).toBeGreaterThan(0);
    expect(at("ssm create-document --name AW-LoginHost-Deploy-Prod")).toBeGreaterThan(at("iam put-role-policy --role-name aw-login-host-ci"));
    expect(c.some((x) => x.includes("kms create-key") && x.includes("--key-spec ECC_NIST_P256") && x.includes("--key-usage SIGN_VERIFY"))).toBe(true);
    // it asked for the document to be rendered from the repo's body with a real public key
    const doc = JSON.parse(readFileSync(join(out, "doc.json"), "utf8"));
    expect(doc.mainSteps[0].inputs.runCommand.join("\n")).toContain("BEGIN PUBLIC KEY");
    // and it never issued anything that grants a person access, or touches the instance, or runs a deploy
    expect(c.filter((x) => /(attach-user-policy|put-user-policy|create-access-key|add-user-to-group|ssm send|ec2 )/.test(x))).toEqual([]);
  });

  it("the rendered CI trust policy it passes to AWS is the pinned one", () => {
    mkdirOut();
    run();
    expect(JSON.parse(readFileSync(join(out, "ci-trust.json"), "utf8")).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]).toBe("repo:AgentWebPro/agentweb:environment:login-host-prod");
  });

  describe("it refuses to create anything until the GitHub environment is restricted to main (else any branch could assume the role)", () => {
    it.each(["unrestricted", "extra", "missing"] as const)("environment variant %s: --apply creates NOTHING", (variant) => {
      mkdirOut();
      fakeGhDefault = () => fakeGh(variant);
      const r = run("--apply");
      fakeGhDefault = () => fakeGh("good");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("REFUSED");
      expect(calls().filter((c) => MUTATING.test(c))).toEqual([]);
      expect(calls().some((c) => c.startsWith("sts "))).toBe(false); // it did not even start
    });
    it("a restricted environment passes the check; --github-env-checked is the explicit manual override; a dry run needs neither", () => {
      mkdirOut();
      expect(run("--apply").stdout).toContain("accepts deployments from main only");
      fakeGhDefault = () => fakeGh("missing");
      expect(run("--apply", "--github-env-checked").status).toBe(0);
      expect(run().status).toBe(0);
      fakeGhDefault = () => fakeGh("good");
    });
  });

  it("refuses to run when it cannot tell which account it is in, and rejects unknown arguments", () => {
    writeFileSync(join(dir, "aws"), "#!/bin/bash\necho nonsense\n");
    expect(run().status).toBe(1);
    expect(run("--yolo").status).toBe(2);
  });

  function mkdirOut() {
    spawnSync("mkdir", ["-p", out]);
  }
});
