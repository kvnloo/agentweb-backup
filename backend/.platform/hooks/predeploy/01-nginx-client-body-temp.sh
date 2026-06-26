#!/bin/bash
set -euo pipefail

mkdir -p /var/tmp/agentweb-nginx/client_body
chown -R nginx:nginx /var/tmp/agentweb-nginx
chmod 700 /var/tmp/agentweb-nginx /var/tmp/agentweb-nginx/client_body
