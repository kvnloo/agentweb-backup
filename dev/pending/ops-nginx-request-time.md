## OPS: nginx access log adds request timing for per-route p99 alarm (2026-10-07)

- New `backend/.platform/nginx/conf.d/access_log_timing.conf` defines `main_timing` = EB default `main` + `rt=$request_time urt=$upstream_response_time` (appended, so positional parsers keep working).
- `conf.d/elasticbeanstalk/access_log_timing.conf` switches the server's access_log to it (same file, logged once).
- Follow-up after deploy: CloudWatch metric filter + per-route p99 alarm excluding `/api/agent-mode/*` and `/mcp`; then retire interim 60s `prod3-p99-latency` threshold.
