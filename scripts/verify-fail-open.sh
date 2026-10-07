#!/usr/bin/env bash
# hana-powercontext · Stage 1 fail-open verification.
#
# Proves the criterion "Server unreachable/timeout -> explicit error, no hang, no
# retry storm" WITHOUT needing to stop a Server you may be using: the App is
# pointed at a loopback port where nothing is listening, which is the same
# condition from the App's side.
#
# Usage: scripts/verify-fail-open.sh [--port 8099]
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${PROJECT_ROOT}/app/hana-powercontext"
OUT="${PROJECT_ROOT}/artifacts/stage1"
PORT="8099"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "${OUT}"

# Refuse to run against something that IS listening: a pass there would prove
# nothing about the unreachable path.
if curl -sS --noproxy '*' --max-time 2 -o /dev/null "http://127.0.0.1:${PORT}/health/live" 2>/dev/null; then
  echo "ERROR: something is already listening on 127.0.0.1:${PORT}; pick a free port with --port." >&2
  exit 1
fi

echo "Verifying fail-open against 127.0.0.1:${PORT} (expected: nothing listening)"
echo

cd "${APP_DIR}"
node lib/live-demo.mjs --base-url "http://127.0.0.1:${PORT}" --fail-open 2>&1 | tee "${OUT}/fail-open.txt"
STATUS="${PIPESTATUS[0]}"

echo
if [[ "${STATUS}" == "0" ]]; then
  echo "Fail-open verified. Evidence: ${OUT}/fail-open.txt"
else
  echo "Fail-open verification FAILED (exit ${STATUS})." >&2
fi
exit "${STATUS}"
