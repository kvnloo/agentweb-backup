## ENG-2113: accept a protocol-4 login worker ahead of the relay backend (2026-10-28)

The backend now accepts login-host workers at protocol 4 (`ACCEPTED_WORKER_PROTOCOLS` = 2, 3, 4) so the relay worker can deploy before the backend that speaks it without every running backend logging `login_host_protocol_mismatch` and treating "no such connection" as unconfirmed. Backend-only; sign-in, revoke and plain turns are unchanged. Also fixes the stale comment above the set. Nothing sends protocol-4 fields yet (that needs `workerProtocol() >= 4`).
