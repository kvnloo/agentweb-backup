# Cycle 120 — git never chooses among 3001 / 8080 / 5000

**UTC:** 2026-09-11T23:19:00Z
**Kind:** mapping
**Do not un-ready:** Q-001, Q-014, Q-003
**Do not revive:** A-006.

## Question

Cycle 119: we cannot name the `/mcp` nginx.conf; AWS docs default
upstream is **5000**. `websocket.conf` hardcodes **8080**. Node
defaults **3001**. Does any in-tree Node.js platform / solution
stack / saved EB config pick among those three, or is live
`PORT` still console-only?

## Finding

**Git never picks.** There is no solution-stack string, no
Procfile, no `.elasticbeanstalk/` saved config, and **zero**
`aws:elasticbeanstalk:application:environment` in
`backend/.ebextensions/` (that is the namespace AWS’s proxy
page says would set `PORT`). `.github/scripts/` and
`deploy.yml` have zero `PORT=`. Partner-portal has no `.platform/`
and no 8080/5000.

The namespace appears only as **test fixtures** in
`eb-config-conflict.test.sh` L304 `SOME_FLAG`, L325 `CHROME`,
L350 `RENAMED` — not `PORT`. Production `.ebextensions` use
other namespaces (`timeout.config` L5 is `aws:elbv2:loadbalancer`;
`rolling.config` is `aws:elasticbeanstalk:command`). ENG-823
already stopped declaring DeregistrationDelay there.

What git *does* pin, independently:

| Number | Where | What it governs |
|---|---|---|
| 3001 | `server.ts` L55 `PORT \|\| 3001`; `.env.example` L1; `package.json` L7 `npm start`; CLAUDE.md L201; mcpFetch tests | Local / fallback. EB Node.js platform **overwrites** `PORT` to the proxy upstream. |
| 8080 | `websocket.conf` L6 only | `/socket.io/` `proxy_pass`. Does **not** read `$PORT`. |
| 5000 | AWS proxy docs (`dev.md` L6235), not this tree | Default catch-all if the platform still uses the generic default. |

`eb-config-conflict.sh` L190–193 classifies `.platform/*` as
instance config. It never classifies a platform ARN. Live
Socket.IO working means today’s injected `PORT` is 8080; that
is still not a git choice. A platform move to 5000 would make
Hermes `/mcp` follow Node (injected) while `/socket.io/` stayed
hardcoded 8080. Do not add `option_settings PORT` from this
cycle (ENG-823) and do not instead of Q-014. Hermes/OMP: one
listen, no second hardcoded proxy port.

## Queue effect

A-020 stays **park**. A-019 stays **park**. A-006 stays
**discard**. Q-001 stays **ready**. Q-014 stays **ready**.

## Next

Cycle 121: cheapest remaining. Candidate: would a `/mcp`
`location` (copy `websocket.conf`, still hardcoded 8080) be the
git pin — and does ENG-836 treat that `.platform` edit as
instance config that cannot ship with a resource `.ebextensions`
change in the same PR?
Do not un-ready Q-001 / Q-014 / Q-003. Unsubscribe after
`2026-09-12T06:00:00Z`.
