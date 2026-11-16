#!/bin/bash
# ENG-2110 PR 2: host-owned launcher that runs inside EVERY customer unit (PrivateNetwork=yes: loopback only).
#
#   aw-net.sh <socat> <program> <args...>
#
# The unit has no network except what this script gives it: a loopback TCP port that forwards, byte for byte, to the host's egress
# proxy over the unix socket bound at /run/aw-egress. The proxy decides what may be reached (an allowlist of host:port, and never a
# private address). The program is told to use it through the standard proxy variables. Nothing here reads stdin (the caller's
# stdin is the program's), and a socat that dies is not restarted: the program then simply has no network.
set -eu
socat_bin=$1
shift
sock=/run/aw-egress/proxy.sock
[ -S "$sock" ] || { echo "aw-net: egress socket missing" >&2; exit 70; }
"$socat_bin" TCP-LISTEN:3128,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:"$sock" </dev/null >/dev/null 2>&1 &
# Wait (at most ~2 s) until the listener is up, so the program's first connection cannot race it.
i=0
while [ "$i" -lt 40 ]; do
  if (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 0.05
done
export HTTPS_PROXY=http://127.0.0.1:3128 HTTP_PROXY=http://127.0.0.1:3128
export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY NO_PROXY= no_proxy=
# Nothing the CLI sends to telemetry/error-reporting vendors is needed (and the proxy would refuse it anyway).
export DISABLE_TELEMETRY=1 DISABLE_ERROR_REPORTING=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
exec "$@"
