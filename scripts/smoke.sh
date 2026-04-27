#!/usr/bin/env bash
# Post-deploy smoke test. Run after every API deploy:
#   API_URL=https://api.example.com SEED_PASSWORD=... ./scripts/smoke.sh
#
# Exits non-zero on any failed assertion. Designed to be wired into a
# Railway "post-deploy" hook or run manually from CI.
set -euo pipefail

API_URL="${API_URL:-http://localhost:4000}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
SEED_PASSWORD="${SEED_PASSWORD:-Admin123!@#456}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

fail() {
  red "FAIL: $*"
  exit 1
}

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    fail "$label — expected $expected, got $actual"
  fi
  green "OK   $label ($actual)"
}

echo "─── Smoke-testing $API_URL ───"

# 1. /health
status=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health")
check "GET /health" 200 "$status"

# 2. /health/ready
status=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health/ready")
check "GET /health/ready" 200 "$status"

# 3. POST /v1/auth/login
login_body=$(curl -s -H 'content-type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$SEED_PASSWORD\"}" \
  "$API_URL/v1/auth/login")
token=$(echo "$login_body" | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')
if [[ -z "$token" ]]; then
  fail "login did not return accessToken; body was: $login_body"
fi
green "OK   POST /v1/auth/login (got access token)"

# 4. GET /v1/auth/me with the token
status=$(curl -s -o /dev/null -w "%{http_code}" -H "authorization: Bearer $token" "$API_URL/v1/auth/me")
check "GET /v1/auth/me" 200 "$status"

# 5. POST /v1/sessions
session_body=$(curl -s -H 'content-type: application/json' -H "authorization: Bearer $token" \
  -d '{"clientEmail":"smoke@example.com","clientName":"Smoke","expiresInDays":1}' \
  "$API_URL/v1/sessions")
session_id=$(echo "$session_body" | sed -E 's/.*"session":\{"id":"([^"]+)".*/\1/')
url_token=$(echo "$session_body" | sed -E 's/.*"chatUrl":"[^"]*\/c\/([^"]+)".*/\1/')
if [[ -z "$session_id" || -z "$url_token" ]]; then
  fail "session create did not return session.id and chatUrl; body was: $session_body"
fi
green "OK   POST /v1/sessions (id ${session_id:0:8}…)"

# 6. POST /v1/chat/verify
status=$(curl -s -o /dev/null -w "%{http_code}" -H 'content-type: application/json' \
  -d "{\"token\":\"$url_token\"}" \
  "$API_URL/v1/chat/verify")
check "POST /v1/chat/verify" 200 "$status"

green "─── All smoke checks passed ───"
