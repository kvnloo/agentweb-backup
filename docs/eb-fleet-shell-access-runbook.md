# EB fleet shell access (SSH closed — use SSM)

SSH (port 22) is closed on all Elastic Beanstalk-managed environments as of 2026-08-09 (ENG-1009):
production and all four other EB environments have zero `0.0.0.0/0:22` (or any) inbound SSH rules on
their security groups. Reaching an instance shell now goes through AWS Systems Manager (SSM) Session
Manager instead.

## Why

Every EB environment's security group had SSH open to the entire internet. Closing it removes a real
attack surface (credential-stuffing, 0-days in `sshd`) without losing operator shell access — SSM
Session Manager provides the same capability over an outbound-only, IAM-authenticated channel, with
every session logged.

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
installed locally (`session-manager-plugin`) and IAM `ssm:StartSession` on the caller — already
granted via `AmazonSSMManagedInstanceCore` on the shared `aws-elasticbeanstalk-ec2-role` instance
profile every EB environment uses, so no additional IAM grant is needed for existing operators.

## Verifying the fleet is actually closed

```bash
python3 ~/.agentweb-swarm/scripts/sg-guard.py --region us-west-2
```

Exits 0 with "clean — no world-open non-public ports" when the fleet is in the expected state. Any
regression (a redeployed environment somehow re-opening 22, a new environment created without this
runbook in mind) shows up here.

See ENG-1009 for the full incident/remediation history and CloudTrail evidence of the original revoke.
