#!/usr/bin/env node
/**
 * ENG-2110: renders the SSM document AW-LoginHost-Deploy-Signed from ../prod/ssm-run.sh. Plain Node, no dependencies, so the person who installs the
 * document once can run it from a checkout:
 *
 *   node render-ssm-doc.js --public-key signer.pub.pem --bucket agentweb-login-host-992382574572 > doc.json
 *
 * The public key must be an EC P-256 key (the pipeline signs with a KMS ECC_NIST_P256 key). Refuses anything else, and refuses to render a script
 * that still contains a placeholder or any `{{ }}` other than the two parameters (SSM would substitute those as text).
 */
"use strict";
const { readFileSync } = require("fs");
const { createPublicKey } = require("crypto");
const { join } = require("path");

const SCRIPT = join(__dirname, "../prod/ssm-run.sh");
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{2,62}$/;

function render({ publicKeyPem, bucket, script = readFileSync(SCRIPT, "utf8"), workBase = "/root", aws = "/usr/bin/aws", openssl = "/usr/bin/openssl" }) {
  if (!BUCKET_RE.test(bucket)) throw new Error("bucket name is not valid");
  let key;
  try {
    key = createPublicKey(publicKeyPem);
  } catch {
    throw new Error("the public key is not a readable PEM public key");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error("the signing key must be an EC P-256 key");
  const pem = key.export({ type: "spki", format: "pem" }).toString().trim(); // re-exported: exactly a public key, nothing smuggled around it
  let body = script
    .replace("@@BUCKET@@", bucket)
    .replace("@@WORK_BASE@@", workBase)
    .replace("@@AWS@@", aws)
    .replace("@@OPENSSL@@", openssl)
    .replace("@@PUBLIC_KEY@@", pem);
  if (/@@[A-Z_]+@@/.test(body)) throw new Error("an unfilled placeholder is left in the script");
  const params = body.match(/\{\{[^}]*\}\}/g) || [];
  if (!params.every((p) => p === "{{ BuildKey }}" || p === "{{ MaxWait }}")) throw new Error("the script contains a {{ }} that is not one of the two parameters");
  // The shebang stays: SSM runs a script that starts with one by that interpreter, and the script needs bash (=~, pipefail), not whatever /bin/sh is.
  return {
    schemaVersion: "2.2",
    description: "ENG-2110: deploy a signed login-host build to the prod worker. Verifies the pipeline's signature, then runs the build's deploy.sh (idle gate, health check, rollback). Source: backend/src/loginHost/deploy/prod/ssm-run.sh in the repo.",
    parameters: {
      BuildKey: { type: "String", description: "S3 key of the signed build", allowedPattern: "^prod/builds/login-host-[0-9a-f]{12}\\.tar\\.gz$" },
      MaxWait: { type: "String", description: "Seconds the deploy may wait for the host to be idle", default: "1800", allowedPattern: "^(0|[1-9][0-9]{0,3})$" },
    },
    mainSteps: [{ action: "aws:runShellScript", name: "deploy", inputs: { timeoutSeconds: "14400", runCommand: body.split("\n") } }],
  };
}

module.exports = { render };

if (require.main === module) {
  const arg = (n) => {
    const i = process.argv.indexOf(n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    const pubPath = arg("--public-key");
    const bucket = arg("--bucket");
    if (!pubPath || !bucket) throw new Error("usage: render-ssm-doc.js --public-key signer.pub.pem --bucket <bucket>");
    process.stdout.write(JSON.stringify(render({ publicKeyPem: readFileSync(pubPath, "utf8"), bucket }), null, 2) + "\n");
  } catch (e) {
    console.error(`render-ssm-doc: ${e.message}`);
    process.exit(1);
  }
}
