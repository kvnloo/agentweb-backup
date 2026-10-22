# Automatic login-worker deploy: one-time setup (ENG-2110)

After this is done ONCE, every merge to `main` that touches the login host deploys to the prod worker by itself: no person approves it, no vendor is
involved, and no customer is cut off. This folder is everything the person with AWS administration needs to apply, and everything a reviewer needs to read.

## How a deploy works (so you know what you are enabling)

```
merge to main (changes host CODE: backend/src/loginHost/** except tests and docs, the build/sign scripts, the lockfile, this workflow)
  -> .github/workflows/login-host-deploy.yml  (runs only if the repo variable LOGIN_HOST_DEPLOY_ENABLED is 'true'; environment `login-host-prod`, main only)
       job 1 test         the gate tests (runs every dev dependency's code). Produces nothing that is signed. NO cloud credentials.
       job 2 build        npm ci --ignore-scripts, esbuild, lockfile check, packaging; no jest. NO cloud credentials. Uploads the tarball.
       job 3 verify       parses the untrusted tarball and checks it against THIS commit (the scripts that will run as root must be the reviewed files;
                          commit, run id, tests ran in the test job, clean tree). NO cloud credentials. Outputs the tarball's sha256.
       job 4 deploy       has the credentials, parses nothing, runs no npm: re-fetches the artifact BY ID, checks the sha256, KMS-signs, uploads to
                          s3://agentweb-login-host-992382574572/prod/builds/<build>.tar.gz(+.sig), runs the SSM document AW-LoginHost-Deploy-Signed on
                          i-033394e5467b48e94 (.github/scripts/login-host-run-deploy.sh).
  -> on the worker, as root (prod/ssm-run.sh, the document body):
       verify the signature BEFORE unpacking; only plain files and directories; then the build's prod/deploy.sh:
         prepare (downloads, packages, node, claude: harmless to the running host)
         wait until nothing is running and nobody is mid sign-in (never forced; gives up with exit 75 and changes nothing)
         refuse new work for the seconds of the switch + restart (the backend retries it), health-check
         on any failure: roll back by itself (code, config, unit, slice)
```

What this does NOT do: it does not make a hostile merge to `main` harmless. Whatever is merged to `main` under those paths runs as root on the machine that holds
customers' Claude logins. The deploy removes the human click, not the need for the merge to be trustworthy. See "Residual risk" below.

## Step 1: GitHub (a repository admin, once, FIRST)

Create the environment `login-host-prod` and allow deployments from `main` only. No required reviewers: that is the point.

**Do this before step 2, and do not skip the branch restriction.** GitHub creates an unrestricted environment on the fly when a workflow names one that does not exist, and
the AWS role trusts that environment's NAME. With the role in place and the environment unrestricted, a workflow on any branch (push access is enough) could assume the
role, sign and deploy. `setup-once.sh --apply` refuses until it has checked the restriction with `gh`.

```
gh api -X PUT repos/AgentWebPro/agentweb/environments/login-host-prod \
  -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/AgentWebPro/agentweb/environments/login-host-prod/deployment-branch-policies -f name=main -f type=branch
```

(The role's trust policy is pinned to `repo:AgentWebPro/agentweb:environment:login-host-prod`; GitHub only issues that token to a job that is allowed to use the
environment, and the environment only accepts runs from `main`.)

## Step 2: AWS (a person with IAM, KMS and SSM administration, once, AFTER step 1)

```
bash backend/src/loginHost/deploy/aws/setup-once.sh            # dry run: prints every command
bash backend/src/loginHost/deploy/aws/setup-once.sh --apply
```

It first checks the GitHub environment (step 1). It creates, idempotently: the GitHub OIDC provider (if the account has none); the role `aw-login-host-ci`, assumable ONLY by this repo's `login-host-prod`
environment; one KMS key (`alias/aw-login-host-signing`, ECC_NIST_P256, sign/verify) that ONLY that role can sign with; read access to
`prod/builds/*` for the worker's instance role; and the SSM document `AW-LoginHost-Deploy-Signed`, rendered from `prod/ssm-run.sh` with the key's public half.
The policies are the files in `policies/`; tests pin their exact actions and resources.

Not verified from here (no IAM read access; the next three are things the rehearsal on the worker will show): whether the bucket uses default SSE-S3 (then nothing more is needed) or SSE-KMS with a customer key (then the CI role also needs `kms:GenerateDataKey` and the worker `kms:Decrypt`); whether `ssm:GetCommandInvocation` can be scoped to a resource (it is `*` today, so the CI role can read any command output in the account: accepted); whether `can_admins_bypass` on the environment applies to deployment branch policies. Also not verified: whether the account already has the GitHub OIDC provider, whether a document of that name exists (a document with the new name is created or updated), and whether `iam create-open-id-connect-provider` still wants an explicit
`--thumbprint-list` on the installed CLI (GitHub's providers are validated by AWS's trusted CAs now; if the CLI insists, add GitHub's published thumbprint).

Then set the repository variable `LOGIN_HOST_DEPLOY_ENABLED` to `true` (Settings -> Secrets and variables -> Actions -> Variables; until it is `true` the workflow runs nothing at all) and run the workflow once by hand (Actions -> Login host deploy -> Run workflow) and watch it. The first run formats the data disk, so do it when nobody
is using the worker. Until `/etc/aw-login-host/bridge-url` exists on the worker (decided with the turn path) the install stops with exit 3 and the workflow fails with
"bridge url missing": that is expected, and nothing is started.

## Step 3: tidy (optional, recommended)

- Add an S3 lifecycle rule that expires objects under `prod/builds/` after ~30 days: every signed build stays callable otherwise, and the worker's no-downgrade mark (a state file) is the only
  thing that stops an old one being replayed by someone who can call SendCommand.

- The temporary policy `AWLoginWorkerProvisionTemp` can go.
- The earlier hand-run document `AW-LoginHost-Deploy-Prod` (it took a sha256 typed by a person, with no signature) is NOT used and NOT reachable by the pipeline: this setup creates a
  NEW document, `AW-LoginHost-Deploy-Signed`, and the CI role may only send that one. Delete the old one when convenient; nothing depends on it.
- `vendor-argusoft-access` does not need to change. The signing key's policy denies `kms:Sign` and `kms:CreateGrant` to everyone but the CI role, whatever IAM says elsewhere.

## Residual risk (read this before you rely on it)

1. **`main` is not protected today** (checked 2026-10-22: no branch protection and no rulesets). Anyone with push access can push straight to `main`,
   and that now ends in root on the login worker. Closing this needs a repository ruleset (admin): require a pull request for `main`, block force pushes, and
   ideally require a CODEOWNERS review for `backend/src/loginHost/**`, `backend/scripts/*login-host*`, `.github/workflows/login-host-deploy.yml` and
   `.github/scripts/login-host-run-deploy.sh`. A CODEOWNERS review means a second person for those paths only; every other path keeps shipping as today.
   That is a policy decision, not a code change, and it is NOT made here.
2. Autonomous agents that can merge to `main` can change the host. The build's gate tests and the worker's health check and rollback catch breakage,
   not intent.
3. The workflow file and the document are the trust root. Changing the document needs AWS administration; changing the workflow needs a merge to `main`
   (item 1).
4. The role can only be assumed by a job GitHub lets use the `login-host-prod` environment, and that environment only accepts runs from `main`. So only code
   already on `main` can sign a build. Item 1 is what decides who can put code there.
5. The signing key, the CI role and the document are all in the one AWS account; whoever can edit the key policy or the document (IAM/KMS/SSM administrators) remains the root of trust.
6. `build_seq` is the GitHub run id (repository-wide, supplied by GitHub, checked by the signing job against its own `GITHUB_RUN_ID`), so renaming the workflow does not reset it. Moving to
   another repository would: then reset `/var/lib/aw-login-host/deployed-build-seq` by hand. Losing that file instead allows one old signed build to be deployed. A run that is skipped as
   'older' shows as a WARNING in the workflow; if the newest run on main shows it, deploys are not reaching the worker.
7. The OIDC trust is pinned to the environment name only. Pinning the exact workflow file and branch into the token's subject (customizing the repository's OIDC subject claim) would let AWS
   enforce it too, but the exact subject format could not be verified without a real account; do it during the rehearsal if wanted.

## Operating it

- **A deploy failed / rolled back:** the workflow turns red with the worker's output; the previous build is serving. Fix forward with a new merge.
- **Not deployed because the host was busy:** exit 75, nothing changed; the workflow retried for up to ~3 hours. Re-run it later.
- **A newer build is already on the worker:** the run is skipped (a signed old build is refused; this is what stops downgrades).
- **Emergency (a security fix that cannot wait for an idle moment):** a person on a Session Manager shell runs `deploy.sh --force` from the extracted build.
  It cuts running turns off and says so loudly. The document and the pipeline never do this.
- **Rotate the signing key:** create a new key and alias, point `KEY_ALIAS` in `setup-once.sh` and `KMS_KEY` in the workflow at it, and re-run `setup-once.sh --apply`
  (it re-renders the document with the new public half). Until the document is updated the worker refuses builds signed with the new key, by design.
