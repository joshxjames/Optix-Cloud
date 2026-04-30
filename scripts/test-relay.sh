#!/usr/bin/env bash
# Smoke-test the relay against the Firebase emulator.
#
# Pre-reqs:
#   1. `firebase emulators:start --only auth,functions,firestore` running
#      (this is what `pnpm emu` does from the repo root)
#   2. A test user created in the auth emulator + a corresponding
#      Firestore profile doc with `subscriptionStatus: 'active'`
#   3. A valid Firebase ID token for that user — easiest path is to log
#      in via the Auth emulator UI (http://localhost:4000/auth) and copy
#      the ID token from there.
#
# Pass the ID token as the first argument; the body of an Anthropic
# request as the second (or fall back to a tiny built-in test prompt).
#
# Usage:
#   ./scripts/test-relay.sh <ID_TOKEN>
#   ./scripts/test-relay.sh <ID_TOKEN> ./scripts/sample-request.json
#
# Note: the relay reads ANTHROPIC_API_KEY from `functions/.env.local` when
# running under the emulator. Set that file before running this test.

set -euo pipefail

ID_TOKEN="${1:-}"
BODY_FILE="${2:-}"

if [[ -z "${ID_TOKEN}" ]]; then
  echo "Usage: $0 <ID_TOKEN> [body.json]" >&2
  exit 1
fi

if [[ -z "${BODY_FILE}" ]]; then
  BODY=$(cat <<'EOF'
{
  "model": "claude-haiku-4-5",
  "max_tokens": 64,
  "stream": true,
  "messages": [
    { "role": "user", "content": "Say hi in one word." }
  ]
}
EOF
)
else
  BODY="$(cat "${BODY_FILE}")"
fi

# Emulator endpoint is http://localhost:5001/<project-id>/<region>/<function>
PROJECT_ID="$(node -e "console.log(JSON.parse(require('fs').readFileSync('.firebaserc','utf8')).projects.default)")"
URL="http://localhost:5001/${PROJECT_ID}/us-central1/relay/v1/messages"

echo "POST ${URL}"
echo "---"

curl -N -sS -X POST \
  -H "Authorization: Bearer ${ID_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  --data "${BODY}" \
  "${URL}"
echo
