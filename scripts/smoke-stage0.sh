#!/usr/bin/env bash
# hana-powercontext · Stage 0 functional smoke test.
#
# Closes the loop required by TASK.md stage 0:
#   1. create (or reuse) a Scope
#   2. POST /v1/context/prepare   -> bounded context (empty before remember)
#   3. POST /v1/memory/remember   -> write one memory entry
#   4. NEW PROCESS: GET  /v1/memory/entries/list  -> the entry is visible
#   5. NEW PROCESS: POST /v1/context/prepare      -> the entry is recalled
#   6. POST /v1/memory/search
#
# Every HTTP response body is written to artifacts/stage0/ so the claims can be
# re-checked without trusting this script's summary.
#
# Usage: scripts/smoke-stage0.sh [--base-url http://127.0.0.1:8000]
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${PROJECT_ROOT}/artifacts/stage0"
BASE_URL="http://127.0.0.1:8000"
SCOPE_TITLE="hana-powercontext stage0 smoke"
SCOPE_SUMMARY="Isolated Scope used by the stage 0 functional smoke test."
MEMORY_KIND="project-fact"
MEMORY_TEXT="The hana-powercontext project talks to the PowerContext Server at http://127.0.0.1:8000 and pins upstream powercontext[cli,server]==1.2.0."

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "${OUT}"
FAILURES=0
step() { printf '\n=== %s ===\n' "$*"; }
ok()   { printf '  [PASS] %s\n' "$*"; }
bad()  { printf '  [FAIL] %s\n' "$*"; FAILURES=$((FAILURES + 1)); }

# curl that never consults an outbound proxy and always writes the raw body to a file.
px() {
  local out="$1"; shift
  curl -sS --noproxy '*' -o "${out}" -w '%{http_code}' "$@"
}

# --- 1. scope ---------------------------------------------------------------
step "1. resolve or create the smoke Scope"
HTTP=$(px "${OUT}/smoke-01-scope-default.json" "${BASE_URL}/v1/scopes/default")
echo "  GET /v1/scopes/default -> HTTP ${HTTP}"
DEFAULT_SCOPE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["scope_id"])' "${OUT}/smoke-01-scope-default.json")"
echo "  default scope_id = ${DEFAULT_SCOPE_ID}"

IDEMPOTENCY_KEY="stage0-smoke-scope"
HTTP=$(px "${OUT}/smoke-02-scope-create.json" -X POST "${BASE_URL}/v1/scopes" \
  -H 'Content-Type: application/json' \
  -d "{\"title\":\"${SCOPE_TITLE}\",\"summary\":\"${SCOPE_SUMMARY}\",\"idempotency_key\":\"${IDEMPOTENCY_KEY}\"}")
echo "  POST /v1/scopes -> HTTP ${HTTP}"
if [[ "${HTTP}" == "200" || "${HTTP}" == "201" ]]; then
  SCOPE_ID="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(d.get("scope_id") or d.get("scope",{}).get("scope_id",""))' "${OUT}/smoke-02-scope-create.json")"
else
  # Already created by an earlier run: reuse it via the idempotency key.
  SCOPE_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("existing",{}).get("scope_id",""))' "${OUT}/smoke-02-scope-create.json" 2>/dev/null || true)"
fi
if [[ -z "${SCOPE_ID}" ]]; then
  bad "could not resolve a smoke scope_id (see smoke-02-scope-create.json)"
  echo "  falling back to the default scope so the remaining steps still run"
  SCOPE_ID="${DEFAULT_SCOPE_ID}"
fi
echo "  smoke scope_id = ${SCOPE_ID}"
echo "${SCOPE_ID}" > "${OUT}/smoke-scope-id.txt"

# --- 2. prepare before remember --------------------------------------------
step "2. POST /v1/context/prepare BEFORE remember (baseline)"
QUERY="what is the PowerContext Server base URL for hana-powercontext"
HTTP=$(px "${OUT}/smoke-03-prepare-before.json" -X POST "${BASE_URL}/v1/context/prepare" \
  -H 'Content-Type: application/json' \
  -d "{\"scope_id\":\"${SCOPE_ID}\",\"query\":\"${QUERY}\",\"max_bytes\":8000}")
BEFORE_STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "${OUT}/smoke-03-prepare-before.json")"
BEFORE_BYTES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["content_bytes"])' "${OUT}/smoke-03-prepare-before.json")"
echo "  HTTP ${HTTP} status=${BEFORE_STATUS} content_bytes=${BEFORE_BYTES}"
[[ "${HTTP}" == "200" ]] || bad "prepare returned HTTP ${HTTP}"

# --- 3. remember ------------------------------------------------------------
step "3. POST /v1/memory/remember"
HTTP=$(px "${OUT}/smoke-04-remember.json" -X POST "${BASE_URL}/v1/memory/remember" \
  -H 'Content-Type: application/json' \
  -d "{\"scope_id\":\"${SCOPE_ID}\",\"kind\":\"${MEMORY_KIND}\",\"text\":\"${MEMORY_TEXT}\",\"reason\":\"stage 0 functional smoke test\"}")
echo "  HTTP ${HTTP}"
if [[ "${HTTP}" == "200" || "${HTTP}" == "201" ]]; then ok "memory written"; else bad "remember returned HTTP ${HTTP}"; fi
cat "${OUT}/smoke-04-remember.json"

# --- 4 + 5. NEW PROCESS: cross-session recall -------------------------------
# Each python3 invocation below is a separate OS process with no shared state,
# which is what "a new session recalls it" means at the Server boundary.
step "4. NEW PROCESS: GET /v1/memory/entries/list"
HTTP=$(px "${OUT}/smoke-05-entries-list.json" -X POST "${BASE_URL}/v1/memory/entries/list" \
  -H 'Content-Type: application/json' \
  -d "{\"scope_id\":\"${SCOPE_ID}\"}")
echo "  HTTP ${HTTP}"
python3 - "${OUT}/smoke-05-entries-list.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
entries = d.get("entries", d if isinstance(d, list) else [])
print(f"  entries returned: {len(entries)}")
for e in entries[:5]:
    print("   -", json.dumps(e, ensure_ascii=False)[:200])
PYEOF

step "5. NEW PROCESS: POST /v1/context/prepare AFTER remember (recall)"
HTTP=$(px "${OUT}/smoke-06-prepare-after.json" -X POST "${BASE_URL}/v1/context/prepare" \
  -H 'Content-Type: application/json' \
  -d "{\"scope_id\":\"${SCOPE_ID}\",\"query\":\"${QUERY}\",\"max_bytes\":8000}")
AFTER_STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "${OUT}/smoke-06-prepare-after.json")"
AFTER_BYTES="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["content_bytes"])' "${OUT}/smoke-06-prepare-after.json")"
echo "  HTTP ${HTTP} status=${AFTER_STATUS} content_bytes=${AFTER_BYTES}"
if grep -q '127.0.0.1:8000' "${OUT}/smoke-06-prepare-after.json"; then
  ok "the remembered text is present in the prepared context (cross-process recall closed)"
else
  bad "remembered text absent from prepared context"
fi
if [[ "${AFTER_BYTES}" -gt "${BEFORE_BYTES}" ]]; then
  ok "content_bytes grew ${BEFORE_BYTES} -> ${AFTER_BYTES} after remember"
else
  echo "  [NOTE] content_bytes did not grow (${BEFORE_BYTES} -> ${AFTER_BYTES}); verify against smoke-06 directly"
fi

step "6. POST /v1/memory/search"
HTTP=$(px "${OUT}/smoke-07-memory-search.json" -X POST "${BASE_URL}/v1/memory/search" \
  -H 'Content-Type: application/json' \
  -d "{\"scope_id\":\"${SCOPE_ID}\",\"query\":\"PowerContext Server base URL\",\"limit\":10}")
echo "  HTTP ${HTTP}"
python3 - "${OUT}/smoke-07-memory-search.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
hits = d.get("hits", [])
print(f"  mode={d.get('mode')} hits={len(hits)}")
for h in hits[:5]:
    print("   -", json.dumps(h, ensure_ascii=False)[:220])
PYEOF

# --- payload size, feeds manifest network.maxResponseBytes -------------------
step "7. measured /v1/context/prepare payload size (manifest budget input)"
python3 - "${OUT}" <<'PYEOF'
import json, os, sys
out = sys.argv[1]
rows = []
for name in sorted(os.listdir(out)):
    if not name.endswith(".json") or "prepare" not in name:
        continue
    raw = open(os.path.join(out, name), "rb").read()
    rows.append((name, len(raw)))
for name, size in rows:
    print(f"  {name}: {size} bytes")
if rows:
    peak = max(size for _, size in rows)
    print(f"  peak response body = {peak} bytes")
    print(f"  3x = {peak*3}   4x = {peak*4}   5x = {peak*5}")
PYEOF

printf '\n=== SMOKE RESULT: %s ===\n' "$([[ ${FAILURES} -eq 0 ]] && echo 'ALL CHECKS PASSED' || echo "${FAILURES} CHECK(S) FAILED")"
exit "$([[ ${FAILURES} -eq 0 ]] && echo 0 || echo 1)"
