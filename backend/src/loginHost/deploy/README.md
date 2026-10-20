# Login host deploy files (ENG-2110) — NOT installed by CI; DARK

Files: `aw-login-host@.service` (host, one instance per env), `aw-env.slice.example`, `host-config.example.json`,
`claude-turn.sh` (per-turn wrapper), `aw-write-file.sh` (root helper that writes a file as a customer uid).

Install checklist (test instance first; production needs the network-isolation PR before any external customer):
1. node 22 at `/usr/bin/node`; host build under `/opt/aw-login-host/dist`; `claude-turn.sh`, `aw-write-file.sh` there, root-owned, mode 0755.
2. Pinned Claude binary under `/opt/aw-claude/<version>/claude`, root-owned, not group/other-writable; put its sha256 in the config.
3. Homes filesystem: a fixed-size loop image mounted at `/var/lib/aw-login-host/<env>/u` with `nosuid,nodev,usrquota` (the host refuses to start otherwise); run `quotacheck`/`quotaon`.
4. `/etc/aw-login-host/<env>.json` root-owned 0600, uid range disjoint from every other env and `/etc/subuid` (the host enforces both).
5. `systemctl enable --now aw-login-host@<env>`; the socket dir `/run/aw-login-host-<env>` is the access gate (group = the backend's gid).
Config is a CLOSED schema: unknown keys fail start-up. See `host/hostConfig.ts`.
