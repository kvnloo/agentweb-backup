# External Integration Contracts

This folder is the integration-memory layer for AgentWeb.

Use these contracts before changing code that talks to an external API. They
capture what the current code believes is true about each vendor, where that
belief lives in the repo, and which assumptions have already caused bugs.

These files are not a replacement for vendor documentation. They are the bridge
between vendor documentation and AgentWeb's implementation.

## Why This Exists

External APIs are where coding agents hallucinate most often:

- They invent enum values because another ads platform has a similar field.
- They flatten IDs that must stay nested.
- They remove "legacy" fallback paths that still serve real users.
- They confuse dollars, cents, account IDs, page IDs, and creative IDs.
- They treat a fixed bug as a one-off patch instead of a rule.

The contract files make those boundaries explicit.

## Agent Rules

Before editing an integration:

1. Read the contract for that integration.
2. Read every code pointer listed in the contract.
3. Search tests for the vendor and the changed entity names.
4. Check recent PRs/commits named in the contract.
5. If the vendor API shape is unclear, verify against the vendor docs before
   coding. Do not infer external fields from memory.

When changing an integration:

1. Update the code.
2. Add or update tests for the contract behavior.
3. Update the relevant contract file in the same PR.
4. Add a "What changed in the contract" note to the PR description.

If a production bug happens:

1. Capture the exact vendor response, including code/subcode where available.
2. Add the failure mode to the contract.
3. Add a deterministic guard, validator, or test when possible.

## Current Contracts

| Integration | Contract | Status | Notes |
| --- | --- | --- | --- |
| Meta Ads / Facebook Marketing API | [meta-ads-contract.md](./meta-ads-contract.md) | Filled | Highest priority. Many shipped bugs came from payload shape, account resolution, and creative semantics. |
| PR research index | [pr-research-index.md](./pr-research-index.md) | Filled | Traceability from shipped integration PRs to contract rules. |
| Other integrations | [external-integrations-map.md](./external-integrations-map.md) | Map only | Source files and risks are identified; full contracts should be added as those areas are touched. |

## Template

Use [integration-contract-template.md](./integration-contract-template.md) for
new or expanded contracts.

## Contract Quality Bar

A useful contract should answer these questions quickly:

- What do we use the vendor for?
- Which internal tools/routes call it?
- What internal shape do we store?
- What payload shape do we send?
- Which fields are required, optional, mutually exclusive, or unit-sensitive?
- Which fallbacks must not be removed?
- Which failure modes have already happened?
- Which tests prove the behavior?
- Which PRs caused or proved the rule?
- What should a coding agent never guess?
