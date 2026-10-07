## ENG-2268: Encode approved reads-only Meta Toolkit v1 (2026-10-07)

- Record Harsha's approved D1–D5 decisions in the product boundary, with pricing TBD and tier packaging documented only.
- Remove external CREATE/UPDATE advertisement and dispatch allowance. All external writes now fail locally with MetaToolkitRefusal; internal Emma handlers are unchanged.
- Keep launch_* and CUSTOM_AUDIENCE writes excluded. D2's blanket write refusal enforces D4 without scope/persistence changes.
- Verify negative write cases and allowed reads with scoped manifest/gateway/REST/MCP tests. Production read-only E2E requires an existing account-scoped credential and connected Meta account; no key provisioning is part of this change.
