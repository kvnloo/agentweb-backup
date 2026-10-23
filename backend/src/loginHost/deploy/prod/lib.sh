#!/bin/bash
# ENG-2110: functions of the production installer that are worth EXECUTING in tests (disk classification, fstab edit, quota check, TLS material
# validation, worker address rules). Sourced by install.sh; has no side effects when sourced. Everything here is plain bash plus the
# standard tools (lsblk wipefs blkid findmnt mount openssl), so jest can drive it with fake tools first on PATH and with the real openssl.
#
# Callers may set DRY=1 (print instead of mutate). FAILED counts reported failures.

: "${DRY:=0}"
: "${FAILED:=0}"

log() { printf '%s\n' "install: $*"; }
ok() { log "OK   $*"; }
skip() { log "SKIP $*"; }
doing() { if [ "$DRY" = 1 ]; then log "WOULD $*"; else log "DO   $*"; fi; }
fail() { log "FAIL $*" >&2; FAILED=$((FAILED + 1)); }
die() { log "FATAL $*" >&2; exit 1; }
# Run a mutating command (printed instead of run in --dry-run).
mut() { if [ "$DRY" = 1 ]; then log "  + $*"; else "$@"; fi; }

# ───────────────────────────── the data disk ─────────────────────────────

# Prints the one non-root disk (the data disk). Refuses if there is not exactly one.
find_data_disk() {
  local root_src root_disk d
  root_src=$(findmnt -n -o SOURCE /)
  root_disk=$(lsblk -no PKNAME "$root_src" 2>/dev/null | head -n1 || true)
  [ -n "$root_disk" ] || root_disk=$(basename "$root_src")
  local found=()
  while read -r d; do
    [ "$d" = "$root_disk" ] && continue
    found+=("/dev/$d")
  done < <(lsblk -dno NAME,TYPE | awk '$2 == "disk" { print $1 }')
  [ "${#found[@]}" -eq 1 ] || { log "disks other than the root disk: ${#found[@]} (${found[*]:-none}); expected exactly 1" >&2; return 1; }
  printf '%s\n' "${found[0]}"
}

# classify_disk <device> <label> <mountpoint>: prints blank | ours | other.
#   blank = no signature of any kind, no partitions, not mounted anywhere.
#   ours  = a whole-disk ext4 filesystem with <label>; if it is mounted, it is mounted at EXACTLY <mountpoint> and nowhere else
#           (a redeploy, a rollback and a certificate rotation all run with the disk already mounted).
#   other = anything else: another filesystem or label, partitions, any signature, mounted elsewhere or in several places, swap.
classify_disk() {
  local dev=$1 want_label=$2 mp=$3 mounts nmounts parts sigs fstype label
  mounts=$(lsblk -rno MOUNTPOINT "$dev" 2>/dev/null | grep -v '^$' || true)
  nmounts=0
  [ -z "$mounts" ] || nmounts=$(printf '%s\n' "$mounts" | wc -l)
  parts=$(lsblk -no TYPE "$dev" 2>/dev/null | awk '$1 == "part"' | wc -l)
  sigs=$( (wipefs --no-act --parsable "$dev" 2>/dev/null || true) | grep -v '^#' | grep -c . || true)
  if [ "$nmounts" -gt 0 ]; then
    if [ "$nmounts" -eq 1 ] && [ "$mounts" = "$mp" ] && [ "$parts" -eq 0 ]; then
      fstype=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || true)
      label=$(blkid -p -s LABEL -o value "$dev" 2>/dev/null || true)
      if [ "$fstype" = ext4 ] && [ "$label" = "$want_label" ]; then echo ours; return; fi
    fi
    echo other
    return
  fi
  if [ "$parts" -eq 0 ] && [ "$sigs" -eq 0 ]; then echo blank; return; fi
  fstype=$(blkid -p -s TYPE -o value "$dev" 2>/dev/null || true)
  label=$(blkid -p -s LABEL -o value "$dev" 2>/dev/null || true)
  if [ "$parts" -eq 0 ] && [ "$fstype" = ext4 ] && [ "$label" = "$want_label" ]; then echo ours; return; fi
  echo other
}

# fstab_set <fstab> <label> <mountpoint> <line>: afterwards the file has exactly ONE line that mounts <mountpoint> (the given one) and no other
# line for <label>. Every other line (comments included) is kept byte for byte. A backup of the previous file is saved first, the new file is
# written atomically. Returns 0 and prints "unchanged" when nothing needed to change.
fstab_set() {
  local fstab=$1 label=$2 mp=$3 line=$4 tmp
  if [ -f "$fstab" ] && grep -qxF "$line" "$fstab" \
    && [ "$(awk -v mp="$mp" -v lab="LABEL=$label" '!/^[[:space:]]*#/ && NF >= 2 && ($2 == mp || $1 == lab) { n++ } END { print n + 0 }' "$fstab")" = 1 ]; then
    echo unchanged
    return 0
  fi
  [ ! -f "$fstab" ] || cp -p "$fstab" "$fstab.aw-backup"
  tmp=$(mktemp "$fstab.XXXXXX")
  {
    if [ -f "$fstab" ]; then awk -v mp="$mp" -v lab="LABEL=$label" '(!/^[[:space:]]*#/ && NF >= 2 && ($2 == mp || $1 == lab)) { next } { print }' "$fstab"; fi
    printf '%s\n' "$line"
  } >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$fstab"
  echo changed
}

# quota_is_on <mountpoint>: `quotaon -pu` PRINTS the state and exits 1 when quotas are on (found live 2026-10-22), so never use its exit status
# (under pipefail a pipe through grep would turn "on" into a failure).
quota_is_on() {
  local out
  out=$(quotaon -pu "$1" 2>/dev/null || true)
  case "$out" in *" is on"*) return 0 ;; *) return 1 ;; esac
}

# ensure_quota <mountpoint>: user quotas ON and the quota file present, or fail LOUDLY (a host without quotas lets one customer fill the disk).
ensure_quota() {
  local mp=$1 out
  if [ ! -e "$mp/aquota.user" ]; then
    # quotacheck counts the existing blocks; on AL2023 it also remounts the filesystem, which drops nosuid/nodev (the caller re-asserts them AFTER this).
    out=$(quotacheck -cu "$mp" 2>&1) || true
    [ -e "$mp/aquota.user" ] || die "quotacheck did not create $mp/aquota.user: $out"
    [ -z "$out" ] || log "NOTE quotacheck: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"
  fi
  if ! quota_is_on "$mp"; then
    quotaon -u "$mp" || die "quotaon failed on $mp"
    quota_is_on "$mp" || die "user quotas are NOT on for $mp after quotaon"
  fi
  ok "user quotas are on for $mp"
}

# ensure_data_disk <device> <mountpoint> <label> <fstab>
ensure_data_disk() {
  local dev=$1 mp=$2 label=$3 fstab=$4 kind opts need src
  kind=$(classify_disk "$dev" "$label" "$mp")
  case "$kind" in
    blank)
      doing "data disk $dev is blank: mkfs.ext4 -L $label"
      mut mkfs.ext4 -q -L "$label" "$dev"
      ;;
    ours) skip "data disk $dev is already ext4 with label $label" ;;
    *)
      # Never format a disk that holds anything else (or is mounted somewhere else).
      die "data disk $dev is NOT blank and is not ours (a filesystem/partition/signature is present, or it is mounted somewhere other than $mp): refusing to touch it"
      ;;
  esac

  local line="LABEL=$label $mp ext4 defaults,nofail,nosuid,nodev,usrquota 0 2"
  if [ "$DRY" = 1 ]; then
    log "  + fstab: make $fstab mount $mp with exactly this line: $line"
  else
    case "$(fstab_set "$fstab" "$label" "$mp" "$line")" in
      unchanged) skip "fstab already has exactly the $label line for $mp" ;;
      *) ok "fstab updated (backup: $fstab.aw-backup)" ;;
    esac
  fi

  mut mkdir -p "$mp"
  if findmnt -rn "$mp" >/dev/null 2>&1; then
    src=$(findmnt -rn -o SOURCE "$mp")
    [ "$src" = "$dev" ] || [ "$DRY" = 1 ] || die "$mp is mounted from $src, not from $dev: refusing to continue"
    skip "$mp already mounted from $dev"
  else
    doing "mount $dev on $mp"
    # By device, not by LABEL: the label is not unique while two disks (e.g. a self-test copy) carry it.
    mut mount -o defaults,nosuid,nodev,usrquota "$dev" "$mp"
  fi
  if [ "$DRY" != 1 ]; then
    # Quota work first, the full flag set LAST: quotacheck remounts and drops nosuid/nodev on AL2023 (found live, 2026-10-21).
    # The host refuses to start without nosuid,nodev,usrquota; the unit re-asserts the flags in ExecStartPre after every reboot.
    ensure_quota "$mp"
    mount -o remount,nosuid,nodev,usrquota "$mp"
    opts=$(findmnt -rn -o OPTIONS "$mp")
    for need in nosuid nodev usrquota; do
      case ",$opts," in *",$need,"*) ;; *) die "mount options of $mp lack $need (have: $opts)" ;; esac
    done
    ok "data disk mounted at $mp with nosuid,nodev,usrquota"
  fi
}

# ───────────────────────────── the worker's address ─────────────────────────────

# is_private_ipv4 <string>: canonical dotted quad (no leading zeros) inside 10/8, 172.16/12 or 192.168/16.
is_private_ipv4() {
  local ip=$1 a b c d
  [[ "$ip" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  a=${BASH_REMATCH[1]}; b=${BASH_REMATCH[2]}; c=${BASH_REMATCH[3]}; d=${BASH_REMATCH[4]}
  [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ] || return 1
  [ "$a" = 10 ] && return 0
  [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 0
  [ "$a" = 192 ] && [ "$b" = 168 ] && return 0
  return 1
}

# ───────────────────────────── TLS material ─────────────────────────────

# validate_tls_dir <dir> <ip>: <dir> holds server.crt, server.key and ca.crt. Returns 0 only if the certificate is a certificate, NAMES <ip> in its
# subjectAltName, its key matches, it chains to ca.crt, and it is not expired. Prints one FAIL line to stderr on the first problem.
validate_tls_dir() {
  local dir=$1 ip=$2 ipre
  ipre=${ip//./\\.}
  local f
  for f in server.crt server.key ca.crt; do
    [ -s "$dir/$f" ] || { log "FAIL TLS set is missing $f" >&2; return 1; }
  done
  openssl x509 -in "$dir/server.crt" -noout >/dev/null 2>&1 || { log "FAIL server.crt is not a certificate" >&2; return 1; }
  openssl x509 -in "$dir/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -Eq "IP Address:$ipre(,| |$)" \
    || { log "FAIL server certificate does not name IP $ip" >&2; return 1; }
  [ "$(openssl x509 -in "$dir/server.crt" -noout -pubkey 2>/dev/null | openssl sha256)" = "$(openssl pkey -in "$dir/server.key" -pubout 2>/dev/null | openssl sha256)" ] \
    || { log "FAIL server key does not match the server certificate" >&2; return 1; }
  # Expiry first: `openssl verify` also fails for an expired certificate, and "does not chain" would be the wrong thing to tell the operator.
  openssl x509 -in "$dir/server.crt" -noout -checkend 0 >/dev/null 2>&1 || { log "FAIL server certificate is expired" >&2; return 1; }
  openssl verify -CAfile "$dir/ca.crt" "$dir/server.crt" >/dev/null 2>&1 || { log "FAIL server certificate does not chain to the CA" >&2; return 1; }
  if ! openssl x509 -in "$dir/server.crt" -noout -checkend 2592000 >/dev/null 2>&1; then log "WARN server certificate expires within 30 days: reissue it"; fi
  return 0
}
