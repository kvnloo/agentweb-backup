# TEST-ONLY keys and certificates (P-256, 100-year validity) used by the TLS tests. They protect nothing and are never deployed.

Regenerate ALL of them (this directory and `../../deploy/fixtures/worker-server.pem`) with `bash generate.sh` (needs openssl). Keys are test-only and committed on purpose; `.gitignore` has negations for them after the `*.pem` rule. The script header lists each file's identity (client CN `agentweb-backend-test` is the pinned one; `other.pem` is CN `somebody-else`; `rogue-*` chain to an unrelated CA; `wrong-server.pem` names 10.9.8.7).
