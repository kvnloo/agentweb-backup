#!/bin/sh
# ENG-2110 PR 1b: host-owned wrapper that starts ONE `claude -p` turn inside its hardened unit.
#
# The login host's Claude adapter starts every turn as:   claude-turn.sh <claude binary> <claude args...>
# and writes the turn's MCP config (it holds the bridge token) as the FIRST line on stdin. This script
# reads that one line, places it in the unit's private tmp (0600), creates the scratch HOME, and execs
# the CLI with the rest of stdin untouched (the stream-json conversation). The token is therefore in
# no argv, no environment and no persistent file, and it disappears with the unit's private tmp.
#
# Requirements: TMPDIR is the unit-private tmp; stdin is a pipe (POSIX `read` consumes byte by byte on a
# pipe, so nothing after the first newline is lost).
set -eu
umask 077
: "${TMPDIR:?TMPDIR must be the unit-private tmp}"
IFS= read -r mcp_config || exit 64
mkdir -p "$TMPDIR/aw-home"
printf '%s\n' "$mcp_config" > "$TMPDIR/aw-mcp.json"
unset mcp_config
exec "$@"
