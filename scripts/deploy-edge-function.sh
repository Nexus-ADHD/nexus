#!/usr/bin/env bash
#
# deploy-edge-function.sh — the guarded runbook for deploying a Supabase edge function.
#
# Requires SUPABASE_STAGING_REF and SUPABASE_PROD_REF in the environment.
#
#   Default run:  deploy to STAGING + boot-smoke only. Cannot touch prod.
#   With --prod:  staging + smoke, then a merged-main gate + typed confirm, then prod.
#
# Usage:
#   scripts/deploy-edge-function.sh <function-name> [--prod] [--yes]
#
#     --prod   also deploy to prod, after staging passes and the merged-main gate passes.
#     --yes    skip the interactive prod confirmation (the gate still applies).
#
# The verify_jwt flag per function comes from scripts/edge-functions.manifest (mirrors prod).
# Portability: darwin-first, POSIX-ish bash; no flock, no GNU-only flags.
set -euo pipefail

STAGING_REF="${SUPABASE_STAGING_REF:?set SUPABASE_STAGING_REF to your staging project ref}"
PROD_REF="${SUPABASE_PROD_REF:?set SUPABASE_PROD_REF to your production project ref}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
MANIFEST="${SCRIPT_DIR}/edge-functions.manifest"
FUNCTIONS_DIR="${REPO_ROOT}/supabase/functions"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
info() { printf '%s\n' "$*" >&2; }
# Trim leading + trailing whitespace (incl. a CRLF \r). bash 3.2 safe.
trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

# --- arg parsing ---------------------------------------------------------------
FN=""
DO_PROD=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --prod) DO_PROD=1 ;;
    --yes) ASSUME_YES=1 ;;
    -*) die "unknown flag: $arg" ;;
    *)
      [ -z "$FN" ] || die "only one function name may be given (got '$FN' and '$arg')"
      FN="$arg"
      ;;
  esac
done
[ -n "$FN" ] || die "usage: $(basename "$0") <function-name> [--prod] [--yes]"
[ -f "$MANIFEST" ] || die "manifest not found: $MANIFEST"

# --- name validation -----------------------------------------------------------
case "$FN" in
  *[!a-z0-9-]*) die "invalid function name '$FN' (allowed: lowercase letters, digits, hyphen)" ;;
esac
[ -d "${FUNCTIONS_DIR}/${FN}" ] || die "no such function directory: supabase/functions/${FN}"

# --- manifest helpers ----------------------------------------------------------
# Print the verify_jwt value ('true'/'false') for $1, or empty if absent.
manifest_verify_jwt() {
  local want="$1" name vjwt
  while IFS='|' read -r name vjwt || [ -n "$name" ]; do
    name="$(trim "$name")"
    case "$name" in ''|\#*) continue ;; esac
    vjwt="$(trim "$vjwt")"
    if [ "$name" = "$want" ]; then printf '%s' "$vjwt"; return 0; fi
  done < "$MANIFEST"
  return 0
}

# Fail if the manifest and supabase/functions/ disagree (missing or extra rows).
check_manifest_completeness() {
  local name vjwt dir base
  local -a manifest_names=()
  while IFS='|' read -r name vjwt || [ -n "$name" ]; do
    name="$(trim "$name")"
    case "$name" in ''|\#*) continue ;; esac
    vjwt="$(trim "$vjwt")"
    [ "$vjwt" = "true" ] || [ "$vjwt" = "false" ] || die "manifest: '$name' has invalid verify_jwt '$vjwt' (want true|false)"
    manifest_names+=("$name")
    [ -d "${FUNCTIONS_DIR}/${name}" ] || die "manifest lists '$name' but supabase/functions/${name} does not exist"
  done < "$MANIFEST"
  [ "${#manifest_names[@]}" -gt 0 ] || die "manifest has no function rows"

  for dir in "${FUNCTIONS_DIR}"/*/; do
    base="$(basename "$dir")"
    [ "$base" = "_shared" ] && continue
    [ -f "${dir}index.ts" ] || continue
    local found=0 m
    for m in "${manifest_names[@]}"; do [ "$m" = "$base" ] && { found=1; break; }; done
    [ "$found" = "1" ] || die "function supabase/functions/${base} is not in the manifest (record its verify_jwt before deploying)"
  done
}

# --- deploy + smoke ------------------------------------------------------------
deploy_to() {
  local ref="$1" vjwt="$2"
  local -a args=(functions deploy "$FN" --project-ref "$ref")
  [ "$vjwt" = "false" ] && args+=(--no-verify-jwt)
  info ">> supabase ${args[*]}"
  supabase "${args[@]}"
}

# Boot/reachability smoke: a side-effect-free OPTIONS preflight. A booted function answers
# (200 CORS / 405 / other 4xx); a deploy that failed to boot returns 5xx or fails to connect.
# This is NOT an authorization test (see the policy doc) — it proves the deploy boots.
smoke() {
  local ref="$1"
  local url="https://${ref}.supabase.co/functions/v1/${FN}"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -X OPTIONS "$url" --max-time 20 || true)"
  case "$code" in
    ''|000) die "smoke FAILED: no response from $url (function did not boot / unreachable)" ;;
    *[!0-9]*) die "smoke FAILED: unexpected response '$code' from $url" ;;
  esac
  if [ "$code" -ge 500 ]; then
    die "smoke FAILED: $url returned HTTP $code (boot error)"
  fi
  info "smoke OK: OPTIONS $url -> HTTP $code (booted)"
}

# --- main ----------------------------------------------------------------------
check_manifest_completeness
VJWT="$(manifest_verify_jwt "$FN")"
[ -n "$VJWT" ] || die "function '$FN' is not in the manifest"

# Informational: the local Supabase link points at prod; we never rely on it (always --project-ref).
LINK_FILE="${REPO_ROOT}/supabase/.temp/project-ref"
if [ -f "$LINK_FILE" ] && [ "$(cat "$LINK_FILE")" = "$PROD_REF" ]; then
  info "note: supabase/.temp is linked to PROD; this script ignores the link and passes --project-ref explicitly."
fi

info "== Deploying '${FN}' (verify_jwt=${VJWT}) to STAGING (${STAGING_REF}) =="
deploy_to "$STAGING_REF" "$VJWT"
smoke "$STAGING_REF"

if [ "$DO_PROD" != "1" ]; then
  info "== Staging done. Re-run with --prod to deploy to prod. =="
  exit 0
fi

# --- prod gate: merged main only -----------------------------------------------
info "== Prod gate: verifying this is clean, up-to-date, merged main =="
branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
[ "$branch" = "main" ] || die "prod deploy refused: on branch '$branch', not 'main'"
[ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] || die "prod deploy refused: working tree is dirty"
git -C "$REPO_ROOT" fetch origin main >/dev/null 2>&1 || die "prod deploy refused: 'git fetch origin main' failed (offline?) — refusing to trust a stale origin/main"
head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
origin_sha="$(git -C "$REPO_ROOT" rev-parse origin/main)"
[ "$head_sha" = "$origin_sha" ] || die "prod deploy refused: HEAD ($head_sha) != origin/main ($origin_sha) — deploy only the exact merged commit"
info "merged-main OK: deploying commit $(git -C "$REPO_ROOT" log -1 --oneline HEAD)"

if [ "$ASSUME_YES" != "1" ]; then
  printf 'Deploy %s to PROD (%s)? type "yes" to proceed: ' "$FN" "$PROD_REF" >&2
  read -r reply
  [ "$reply" = "yes" ] || die "aborted by user"
fi

info "== Deploying '${FN}' (verify_jwt=${VJWT}) to PROD (${PROD_REF}) =="
deploy_to "$PROD_REF" "$VJWT"
smoke "$PROD_REF"
info "== Done: ${FN} deployed to staging and prod. =="
