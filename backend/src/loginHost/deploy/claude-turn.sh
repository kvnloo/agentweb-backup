#!/bin/sh
# ENG-2110 PR 1b: host-owned wrapper that starts ONE `claude -p` turn inside its hardened unit.
#
# The login host's Claude adapter starts every turn as:   claude-turn.sh <claude binary> <claude args...>
# and writes the turn's MCP config (it holds the bridge token) as the FIRST line on stdin. This script
# reads that one line, places it in the unit's private tmp (0600), creates the scratch HOME, and execs
# the CLI with the rest of stdin untouched (the stream-json conversation). The token is therefore in
# no argv, no environment and no persistent file, and it disappears with the unit's private tmp.
#
# ENG-2113 (tool relay): when AW_TURN_TOOLS=1 the next stdin lines are the turn's tool manifest, written by the host as a LENGTH-PREFIXED block: one line with the
# decimal byte length n, then exactly n bytes of JSON, then the newline that ends that block. It is placed next to the MCP config as aw-cfg/tools.json (0600) for the relay
# shim. (POSIX `read` takes a pipe one byte at a time: 0.6 s for 93 KB, 3.3 s for 503 KB, about 7 s at the 1 MiB cap under bash; `dd` with a block size of n reads it in
# a few system calls and, unlike `head`, takes exactly n bytes, so the stream-json conversation after it is untouched.) The variable is removed from the environment
# before the CLI starts. Without it nothing changes.
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
  IFS= read -r tools_len || exit 64
  # digits only, no leading zero, 1 to 7 of them, and at most MAX_MANIFEST_BYTES (TOOL_LIMITS.maxTotalBytes + 4096; a test keeps the two equal)
  case $tools_len in '' | *[!0-9]* | 0*) exit 64 ;; esac
  [ "${#tools_len}" -le 7 ] || exit 64
  [ "$tools_len" -le 1052672 ] || exit 64
  dd bs="$tools_len" count=1 iflag=fullblock of="$TMPDIR/aw-cfg/tools.json" 2>/dev/null || exit 64
  # a short read (the stream ended early) is refused: the file must hold exactly n bytes
  [ "$(wc -c < "$TMPDIR/aw-cfg/tools.json")" -eq "$tools_len" ] || exit 64
  # the newline that ends the block, and nothing else on that line
  IFS= read -r tools_rest || exit 64
  [ -z "$tools_rest" ] || exit 64
  unset tools_len tools_rest
fi
unset AW_TURN_TOOLS
exec "$@"
