## OPS: nginx timing log emits bare request_time for CloudWatch metric filter (2026-10-07)

- `main_timing` now ends with a bare `$request_time` as the last field (no `rt=` prefix; `$upstream_response_time` dropped because it can be `-` or a comma list) so the per-route p99 metric filter can use `$request_time` as a numeric metric value. Only `/var/log/nginx/access_timing.log` changes; `access.log` is untouched.
