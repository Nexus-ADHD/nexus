#!/usr/bin/env bash
#
# Guard tests for scripts/deploy-edge-function.sh (NEX-135).
# The script is bash, not in the Node/vitest suite, so its SAFETY-CRITICAL guard is
# tested here by PATH-shimming `supabase`, `git`, and `curl` with stubs whose behavior
# is driven by FAKE_* env vars. Every refusing path must NOT invoke a prod deploy.
#
# Run: bash scripts/__tests__/deploy-edge-function.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SUT="$(cd "${SCRIPT_DIR}/.." && pwd -P)/deploy-edge-function.sh"
PROD_REF="prodref000000000000"
STAGING_REF="stagingref000000000"
export SUPABASE_PROD_REF="$PROD_REF" SUPABASE_STAGING_REF="$STAGING_REF"
REAL_FN="ai-proxy"   # a function that exists + is in the manifest

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BIN="$TMP/bin"
mkdir -p "$BIN"

cat > "$BIN/supabase" <<'EOF'
#!/usr/bin/env bash
echo "supabase $*" >> "$CALL_LOG"
exit "${FAKE_DEPLOY_RC:-0}"
EOF
cat > "$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >> "$CALL_LOG"
printf '%s' "${FAKE_SMOKE_CODE:-200}"
EOF
cat > "$BIN/git" <<'EOF'
#!/usr/bin/env bash
[ "${1:-}" = "-C" ] && shift 2
echo "git $*" >> "$CALL_LOG"
case "${1:-} ${2:-}" in
  "rev-parse --abbrev-ref") echo "${FAKE_BRANCH:-main}" ;;
  "rev-parse HEAD") echo "${FAKE_HEAD:-aaa111}" ;;
  "rev-parse origin/main") echo "${FAKE_ORIGIN:-aaa111}" ;;
  "status --porcelain") printf '%s' "${FAKE_DIRTY:-}" ;;
  "fetch origin") exit "${FAKE_FETCH_RC:-0}" ;;
  "log -1") echo "aaa111 fake commit" ;;
  *) : ;;
esac
exit 0
EOF
chmod +x "$BIN/supabase" "$BIN/curl" "$BIN/git"

PASS=0; FAIL=0
# run_case <desc> <expect-exit: 0|nonzero> <expect-prod: yes|no> -- ENV... -- ARGS...
run_case() {
  local desc="$1" expect_exit="$2" expect_prod="$3"; shift 3
  [ "$1" = "--" ] && shift
  local -a env_kv=()
  while [ "$1" != "--" ]; do env_kv+=("$1"); shift; done
  shift
  local -a args=("$@")

  CALL_LOG="$TMP/calls.$$.$RANDOM"; : > "$CALL_LOG"
  local rc
  ( export PATH="$BIN:$PATH" CALL_LOG; env "${env_kv[@]}" bash "$SUT" "${args[@]}" >/dev/null 2>&1 )
  rc=$?

  local ok=1
  if [ "$expect_exit" = "0" ]; then [ "$rc" -eq 0 ] || ok=0; else [ "$rc" -ne 0 ] || ok=0; fi

  local prod_called=no
  grep -q -- "--project-ref ${PROD_REF}" "$CALL_LOG" && prod_called=yes
  [ "$prod_called" = "$expect_prod" ] || ok=0

  if [ "$ok" = "1" ]; then
    PASS=$((PASS+1)); printf 'PASS  %s\n' "$desc"
  else
    FAIL=$((FAIL+1))
    printf 'FAIL  %s\n      exit=%s (want %s), prod_called=%s (want %s)\n' \
      "$desc" "$rc" "$expect_exit" "$prod_called" "$expect_prod"
    sed 's/^/      log: /' "$CALL_LOG"
  fi
  rm -f "$CALL_LOG"
}

# --- the cases -----------------------------------------------------------------
run_case "default run deploys staging, never prod" 0 no \
  -- FAKE_SMOKE_CODE=200 -- "$REAL_FN"

run_case "default run: staging smoke 5xx fails, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=503 -- "$REAL_FN"

run_case "--prod on non-main branch refuses, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=200 FAKE_BRANCH=feature -- "$REAL_FN" --prod --yes

run_case "--prod with dirty tree refuses, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=200 FAKE_DIRTY=" M x.ts" -- "$REAL_FN" --prod --yes

run_case "--prod behind origin/main refuses, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=200 FAKE_HEAD=aaa FAKE_ORIGIN=bbb -- "$REAL_FN" --prod --yes

run_case "--prod with failed git fetch refuses, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=200 FAKE_FETCH_RC=1 -- "$REAL_FN" --prod --yes

run_case "--prod but staging smoke 5xx stops before gate, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=503 -- "$REAL_FN" --prod --yes

run_case "--prod all-good deploys prod" 0 yes \
  -- FAKE_SMOKE_CODE=200 FAKE_BRANCH=main FAKE_HEAD=same FAKE_ORIGIN=same FAKE_FETCH_RC=0 -- "$REAL_FN" --prod --yes

run_case "unknown function refuses, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=200 -- "definitely-not-a-real-fn" --prod --yes

run_case "invalid function name refuses, no prod" nonzero no \
  -- FAKE_SMOKE_CODE=200 -- "Bad_Name" --prod --yes

echo "-----------------------------------------"
printf 'deploy-edge-function guard tests: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
