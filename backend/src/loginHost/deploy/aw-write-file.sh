#!/bin/sh
# ENG-2110 PR 1b-ii: host-owned helper run AS the customer's uid inside its hardened unit by the real filesystem
# port's `AsUser.writeFile`. Usage: aw-write-file.sh <umask> <absolute target>   (content on stdin)
# The target path is validated by the host (absolute, [A-Za-z0-9._/-], inside the unit's reference directory, no ..);
# the file is created EXCLUSIVELY (noclobber): an existing file, symlink or FIFO makes it refuse.
set -eu
umask "$1"
set -C
mkdir -p "$(dirname "$2")"
cat > "$2"
