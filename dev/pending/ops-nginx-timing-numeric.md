## OPS: nginx timing log emits bare request_time for CloudWatch metric filter (2026-10-07)

- `main_timing` now ends with `$request_time $upstream_response_time` (no `rt=`/`urt=` prefixes) so the per-route p99 metric filter can use `$request_time` as a numeric metric value. Only `/var/log/nginx/access_timing.log` changes; `access.log` is untouched.
