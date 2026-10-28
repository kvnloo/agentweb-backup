#!/bin/sh
# ENG-2110 PR 1b: host-owned wrapper that starts ONE `claude -p` turn inside its hardened unit.
#
# The login host's Claude adapter starts every turn as:   claude-turn.sh <claude binary> <claude args...>
# and writes the turn's MCP config (it holds the bridge token) as the FIRST line on stdin. This script
# reads that one line, places it in the unit's private tmp (0600), creates the scratch HOME, and execs
# the CLI with the rest of stdin untouched (the stream-json conversation). The token is therefore in
# no argv, no environment and no persistent file, and it disappears with the unit's private tmp.
#
# ENG-2113 (tool relay): when AW_TURN_TOOLS=1 the SECOND stdin line is the turn's tool manifest (JSON, written by the host); it is placed next to the MCP config as
# aw-cfg/tools.json (0600) for the relay shim. The variable is removed from the environment before the CLI starts. Without it nothing changes.
#
# Requirements: TMPDIR is the unit-private tmp; stdin is a pipe (POSIX `read` consumes byte by byte on a
# pipe, so nothing after the first newline is lost).
set -eu
umask 077
: "${TMPDIR:?TMPDIR must be the unit-private tmp}"
IFS= read -r mcp_config || exit 64
# `mkdir` (no -p) is an exclusive create: it fails if ANYTHING (a directory, a file, a symlink, a FIFO) already sits at the
# path, so the config is only ever written into a directory this script has just created itself. (`set -C` noclobber alone
# does not stop a write through a planted FIFO or device.)
mkdir "$TMPDIR/aw-home"
mkdir "$TMPDIR/aw-cfg"
printf '%s\n' "$mcp_config" > "$TMPDIR/aw-cfg/mcp.json"
unset mcp_config
if [ "${AW_TURN_TOOLS:-}" = 1 ]; then
  IFS= read -r tools_json || exit 64
  printf '%s\n' "$tools_json" > "$TMPDIR/aw-cfg/tools.json"
  unset tools_json
fi
unset AW_TURN_TOOLS
exec "$@"
