## OPS: nginx request-timing access log for per-route p99 alarm (2026-10-07)

- `backend/.platform/nginx/conf.d/access_log_timing.conf` defines `main_timing` = EB default `main` + `rt=$request_time urt=$upstream_response_time`.
- `conf.d/elasticbeanstalk/access_log_timing.conf` writes it to a separate `/var/log/nginx/access_timing.log`. EB's nginx.conf already has a server-level `access_log access.log main`, so reusing access.log would double-log. access.log is unchanged.
- `.ebextensions/07-nginx-timing-log.config` appends the file to the CloudWatch agent (log group `/aws/elasticbeanstalk/<env>/var/log/nginx/access_timing.log`).
- Follow-up after deploy: per-route p99 alarm excluding `/api/agent-mode/*` and `/mcp`, then retire the interim 60s `prod3-p99-latency` threshold.
