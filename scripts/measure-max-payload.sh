#!/usr/bin/env bash
# Derive an upper bound for manifest network.maxResponseBytes from a
# worst-case-shaped /v1/context/prepare response.
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${PROJECT_ROOT}/artifacts/stage0"
B=http://127.0.0.1:8000
SCOPE_ID="${1:-$(cat "${OUT}/smoke-scope-id.txt")}"

px() { local out="$1"; shift; curl -sS --noproxy '*' -o "${out}" -w '%{http_code}' "$@"; }

# Fill the scope with several maximum-size entries so recall has real content.
for i in 1 2 3 4 5 6; do
  LONG="$(python3 -c "
import json,sys
i=sys.argv[1]
filler=' PowerContext recall sizing probe %s: '%i + ('. '*900)
text=('Finding %s about the hana-powercontext integration. '%i + filler)
text=text[:7900]
print(json.dumps({'scope_id':sys.argv[2],'kind':'project-fact','text':text,'reason':'max_bytes sizing probe'}))
" "$i" "${SCOPE_ID}")"
  code=$(px "${OUT}/sizing-remember-${i}.json" -X POST "$B/v1/memory/remember" -H 'Content-Type: application/json' -d "${LONG}")
  echo "  remember #${i} -> HTTP ${code}"
done

echo
echo "=== prepare at max_bytes=32768 (largest legal budget) ==="
code=$(px "${OUT}/sizing-prepare-max.json" -X POST "$B/v1/context/prepare" -H 'Content-Type: application/json' \
  -d "{\"scope_id\":\"${SCOPE_ID}\",\"query\":\"hana-powercontext PowerContext recall sizing probe project fact\",\"max_bytes\":32768}")
echo "  HTTP ${code}"
python3 - "${OUT}/sizing-prepare-max.json" <<'PYEOF'
import json, sys
d = json.load(open(sys.argv[1]))
c = d.get("content") or ""
print(f"  status={d['status']}  content_bytes(field)={d['content_bytes']}  content chars={len(c)}")
print(f"  raw body bytes on disk   = {len(open(sys.argv[1],'rb').read())}")
print(f"  declared max_bytes budget= 32768")
print()
print("  --- content preview (first 700 chars) ---")
print("  " + c[:700].replace("\n", "\n  "))
PYEOF
