# EB fleet shell access (SSH closed — use SSM)

SSH (port 22) is closed on all Elastic Beanstalk-managed environments as of 2026-08-09 (ENG-1009):
production and all four other EB environments have zero `0.0.0.0/0:22` (or any) inbound SSH rules on
their security groups. Reaching an instance shell now goes through AWS Systems Manager (SSM) Session
Manager instead.

## Why

Every EB environment's security group had SSH open to the entire internet. Closing it removes a real
attack surface (credential-stuffing, 0-days in `sshd`) without losing operator shell access — SSM
Session Manager provides the same capability over an outbound-only, IAM-authenticated channel.
Session start/stop is always recorded in CloudTrail; command-level shell content is only captured if
the account has Session Manager logging (S3/CloudWatch) configured separately — check
`aws ssm get-document --region us-west-2 --name SSM-SessionManagerRunShell` for the active preferences before relying on
command-level forensic evidence.

## Getting a shell

1. Find the instance ID for the environment you need:
   ```bash
   aws elasticbeanstalk describe-environment-resources \
     --environment-name <env-name> \
     --query "EnvironmentResources.Instances[].Id" --output text
   ```
   (`<env-name>` is one of `Agentweb-backend-env-prod-3`, `Agentweb-backend-env-1` (staging), or the
   other EB-managed environments.)

2. Start a session:
   ```bash
   aws ssm start-session --region us-west-2 --target <instance-id>
   ```

Requires the [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
installed locally (`session-manager-plugin`) and, on the **caller's own IAM identity** (user or role),
an attached policy granting at minimum:
- `ssm:StartSession` on the target instance (`arn:aws:ec2:us-west-2:*:instance/*`)
- `ssm:StartSession` on the session document used to open the shell's data channel
  (`arn:aws:ssm:us-west-2:*:document/SSM-SessionManagerRunShell`) — omitting this grant fails the
  session establishment even though the instance-targeted grant above is present
- `ssm:TerminateSession`/`ssm:ResumeSession` on the caller's own session resource
  (`arn:aws:ssm:us-west-2:*:session/${aws:userid}-*`) — use `${aws:userid}`, not `${aws:username}`:
  an assumed IAM role's session does not populate `aws:username`, so a role-based caller's resource
  would silently fail to match

This is separate from the instance side: `AmazonSSMManagedInstanceCore` on the shared
`aws-elasticbeanstalk-ec2-role` instance profile only lets the *instance* register with SSM and
receive sessions — it grants nothing to the operator calling `aws ssm start-session`. If
`start-session` fails with an authorization error, the caller's identity is missing one of the three
grants above; request it before assuming the instance is unreachable.

## Verifying the fleet is actually closed

Raw check (works for any operator, no extra setup):

```bash
aws ec2 describe-security-groups --region us-west-2 \
  --query "SecurityGroups[].{Group:GroupId,Rules:IpPermissions[?IpProtocol=='-1' || (FromPort<=\`22\` && ToPort>=\`22\`)]}" \
  --output json | jq '[.[] | select(.Rules | length > 0)]'
```

**Do not filter on `ip-permission.to-port,Values=22`** — that only matches rules whose `ToPort` is
exactly 22 and silently misses a broader range (e.g. `FromPort=0, ToPort=65535`, or any range like
`20-25`) that also permits port 22. The query above instead pulls every rule on each group and
filters for any range that covers port 22 (`FromPort<=22 AND ToPort>=22`), which catches both an
exact `22-22` rule and a wider range that includes it — **plus** an all-protocol rule
(`IpProtocol: "-1"`), which AWS returns with no `FromPort`/`ToPort` at all, so the numeric range
check alone would silently miss it even though it exposes port 22.

An empty result (`[]`) means no security group in the region has any inbound rule covering port 22 —
the expected state. Any group listed here is a regression (a redeployed environment somehow
re-opening 22, a new environment created without this runbook in mind) and needs the rule removed.

On the swarm box, `python3 ~/.agentweb-swarm/scripts/sg-guard.py --region us-west-2` runs the
equivalent check across all world-open non-public ports (not just 22) and exits 0/clean or 1/findings.
That script lives under `~/.agentweb-swarm/scripts/` on the swarm box only — it is not part of this
repo, so it is not available to an operator working from a plain checkout.

See ENG-1009 for the full incident/remediation history and CloudTrail evidence of the original revoke.
