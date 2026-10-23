#!/bin/sh
# ENG-2110 PR 1b-ii: host-owned helper run AS the customer's uid inside its hardened unit by the real filesystem
# port's `AsUser.writeFile`. Usage: aw-write-file.sh <umask> <absolute target>   (content on stdin)
# The target path is validated by the host (absolute, [A-Za-z0-9._/-], inside the unit's reference directory, no ..);
# the file is created EXCLUSIVELY (noclobber): an existing file, symlink or FIFO makes it refuse.
set -eu
target=$2
umask 077                       # directories are created searchable by the owner only (a 0600 mask would make them unusable)
mkdir -p "$(dirname "$target")"
umask "$1"                      # the requested mode applies to the FILE
# Refuse ANY existing entry (file, symlink, FIFO, device): noclobber alone does not stop a write through a FIFO or a symlink.
if [ -e "$target" ] || [ -L "$target" ]; then
  echo "target exists" >&2
  exit 1
fi
# Write a temporary file next to the target, then move it into place without ever replacing: a failure part-way leaves no
# partial target (a retry would otherwise find "target exists").
tmp="$target.tmp.$$"
trap 'rm -f "$tmp"' EXIT
set -C
cat > "$tmp"
mv -n "$tmp" "$target"
[ ! -e "$tmp" ]
