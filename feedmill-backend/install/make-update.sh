#!/usr/bin/env bash
#
# Build + sign a web-update bundle (run on the dev machine, from the repo):
#   install/make-update.sh <private-key.pem> [out.zip]
# Upload the resulting zip in the HMI: Settings -> Update.
#
# One-time key setup (keep update-key.pem OFF the machines and OUT of git):
#   openssl genpkey -algorithm ed25519 -out update-key.pem
#   openssl pkey -in update-key.pem -pubout -out feedmill-backend/install/update-pubkey.pem
# then commit update-pubkey.pem and run install.sh on each machine once so it
# lands in /etc/feedmill-update/. Needs OpenSSL 3 (-rawin) and git.
set -euo pipefail

KEY="${1:?usage: $0 <private-key.pem> [out.zip]}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$(realpath -m "${2:-feedmill-update-$(date +%Y%m%d%H%M%S).zip}")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$REPO"
[[ -z "$(git status --porcelain -- feedmill-backend hmi-prototype)" ]] || echo "WARNING: uncommitted changes are NOT in the bundle (it is built from HEAD)" >&2
git archive --format=zip -o "$TMP/release.zip" HEAD feedmill-backend hmi-prototype
openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$TMP/release.zip" -out "$TMP/release.sig"

# self-check against the committed public key before shipping
PUB="$REPO/feedmill-backend/install/update-pubkey.pem"
[[ -f "$PUB" ]] && openssl pkeyutl -verify -pubin -inkey "$PUB" -rawin -in "$TMP/release.zip" -sigfile "$TMP/release.sig" >/dev/null \
  || { echo "ERROR: signature does not verify against $PUB" >&2; exit 1; }

rm -f "$OUT"
if command -v zip >/dev/null; then (cd "$TMP" && zip -q "$OUT" release.zip release.sig)
else (cd "$TMP" && python3 -m zipfile -c "$OUT" release.zip release.sig); fi
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
