## ENG-2113: tool bridge hardening for Claude subscription runs (2026-10-24)

Dark: no production caller, the funding flag stays off. Findings from live probes against the pinned `claude` 2.1.294 on the test host:

- **SSE mode breaks the CLI.** The MCP SDK's default streamable-HTTP transport answers `initialize` as an event stream; the CLI's handshake then fails and every turn dies in under a second (`errorKind: transient`). `toolBridgeMcp.ts` now sets `enableJsonResponse: true` (pinned by a test). Consequence: no progress keepalive over HTTP; long tools belong to the stdio shim / relay.
- **A cut call is not an aborted call.** The CLI cuts a silent HTTP tool call at ~60 s, the server handler keeps running and `extra.signal` never fires; the model retries 2-4 s later with identical args and a new tool-use id. A write executed twice. The bridge now joins an identical call that arrives while the first is still executing, and returns the original outcome for an identical strict-effect call after completion in the same turn.
- **Stop does not interrupt a running tool** (production behaviour, unchanged); `cancelSession` refuses everything not yet started and closes the session's runs, never touching a pending halt.
- **Login safety (host, not the bridge):** killing the CLI with SIGKILL while it refreshes an expired access token destroys the login (the server rotates the refresh token, the new pair is never written). SIGTERM with a grace period kept the login in 5/5 forced-expiry rounds. Any stop/cancel/deadline/drain path must send SIGTERM first.
- `call_*` tools are classified explicitly in `bridgeToolClassification.ts`; a test fails when one is added without a rule.
