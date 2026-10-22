#!/usr/bin/env bash
# Regenerates the TEST-ONLY TLS fixtures (P-256, 36500-day validity) used by the loginHost jest suites.
# Usage: bash generate.sh      (needs openssl; run from anywhere; overwrites the files below)
# The keys protect nothing, are never deployed, and are committed on purpose (see the .gitignore negations).
#
# Output here:        ca.pem ca.key.pem            test CA (signs everything below except rogue-client.pem)
#                     server.pem server.key.pem    login-host server cert; SAN IP 127.0.0.1 + 172.31.30.50, EKU serverAuth
#                     wrong-server.pem             CA-signed, same server.key.pem, but SAN IP 10.9.8.7 only (names the wrong address)
#                     client.pem client.key.pem    the backend's pinned identity: CN=agentweb-backend-test, EKU clientAuth
#                     other.pem other.key.pem      CA-signed client with a different identity: CN=somebody-else
#                     rogue-ca.pem                 an unrelated CA (its key is discarded)
#                     rogue-client.pem/.key.pem    CN=agentweb-backend-test but signed by the rogue CA
# Output in ../../deploy/fixtures: worker-server.pem   server.key.pem's cert for SAN IP 172.31.30.50, EKU serverAuth, CN aw-login-worker-prod-test
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_FIXTURES="$HERE/../../deploy/fixtures"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
DAYS=36500
cd "$HERE"

key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }
ca() { # ca <key> <cert> <cn>
  key "$1"
  printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n' > "$W/ca.cnf"
  openssl req -x509 -new -key "$1" -subj "/CN=$3" -days $DAYS -sha256 -extensions x -config <(printf '[req]\ndistinguished_name=d\n[d]\n[x]\n'; cat "$W/ca.cnf") -out "$2"
}
leaf() { # leaf <key> <cn> <ext-lines> <cacert> <cakey> <out>
  printf '%b' "$3" > "$W/leaf.cnf"
  openssl req -new -key "$1" -subj "/CN=$2" -out "$W/leaf.csr"
  openssl x509 -req -in "$W/leaf.csr" -CA "$4" -CAkey "$5" -set_serial "0x$(openssl rand -hex 8)" -days $DAYS -sha256 -extfile "$W/leaf.cnf" -out "$6" 2>/dev/null
}
SRV='basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n'
CLI='basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\n'

ca ca.key.pem ca.pem aw-login-host-test-ca
ca "$W/rogue.key" rogue-ca.pem aw-rogue-test-ca

key server.key.pem
leaf server.key.pem aw-login-host-test "${SRV}subjectAltName=IP:127.0.0.1,IP:172.31.30.50\n" ca.pem ca.key.pem server.pem
leaf server.key.pem aw-login-host-wrong "${SRV}subjectAltName=IP:10.9.8.7\n" ca.pem ca.key.pem wrong-server.pem
mkdir -p "$DEPLOY_FIXTURES"
leaf server.key.pem aw-login-worker-prod-test "${SRV}subjectAltName=IP:172.31.30.50\n" ca.pem ca.key.pem "$DEPLOY_FIXTURES/worker-server.pem"

key client.key.pem;  leaf client.key.pem agentweb-backend-test "$CLI" ca.pem ca.key.pem client.pem
key other.key.pem;   leaf other.key.pem somebody-else "$CLI" ca.pem ca.key.pem other.pem
key rogue-client.key.pem; leaf rogue-client.key.pem agentweb-backend-test "$CLI" rogue-ca.pem "$W/rogue.key" rogue-client.pem
echo "generated TLS test fixtures in $HERE and $(cd "$DEPLOY_FIXTURES" && pwd)"
