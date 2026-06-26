#!/usr/bin/env bash
set -euo pipefail

install -d -m 0755 -o nginx -g nginx /var/tmp/agentweb-nginx
for dir in client_body proxy fastcgi uwsgi scgi; do
  install -d -m 0755 -o nginx -g nginx "/var/tmp/agentweb-nginx/${dir}"
done

# AL2023's nginx systemd unit runs with a private /var/tmp namespace. Create the
# temp path again inside that namespace immediately before nginx starts.
install -d -m 0755 /etc/systemd/system/nginx.service.d
cat >/etc/systemd/system/nginx.service.d/agentweb-temp-dirs.conf <<'EOF'
[Service]
ExecStartPre=/usr/bin/install -d -m 0755 -o nginx -g nginx /var/tmp/agentweb-nginx
ExecStartPre=/usr/bin/install -d -m 0755 -o nginx -g nginx /var/tmp/agentweb-nginx/client_body
ExecStartPre=/usr/bin/install -d -m 0755 -o nginx -g nginx /var/tmp/agentweb-nginx/proxy
ExecStartPre=/usr/bin/install -d -m 0755 -o nginx -g nginx /var/tmp/agentweb-nginx/fastcgi
ExecStartPre=/usr/bin/install -d -m 0755 -o nginx -g nginx /var/tmp/agentweb-nginx/uwsgi
ExecStartPre=/usr/bin/install -d -m 0755 -o nginx -g nginx /var/tmp/agentweb-nginx/scgi
EOF

systemctl daemon-reload
