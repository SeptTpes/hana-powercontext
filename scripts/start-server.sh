#!/usr/bin/env bash
# hana-powercontext · Stage 0 reproducible PowerContext Server launcher.
#
# Runs `powercontext server run` in the background against the project-local
# Basic-memory configuration, waits for /health/ready, and records log + PID
# under artifacts/stage0/.
#
# Usage:  scripts/start-server.sh [--port 8000] [--host 127.0.0.1] [--timeout 90] [--foreground]
# Stop:   scripts/stop-server.sh
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${PROJECT_ROOT}/artifacts/stage0"
ENV_FILE="${POWERCONTEXT_ENV_FILE:-${PROJECT_ROOT}/powercontext-config/.env}"
HOST="127.0.0.1"
PORT="8000"
TIMEOUT_S="90"
FOREGROUND="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --timeout) TIMEOUT_S="$2"; shift 2 ;;
    --foreground) FOREGROUND="1"; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

mkdir -p "${ARTIFACT_DIR}"
LOG_FILE="${ARTIFACT_DIR}/server.log"
PID_FILE="${ARTIFACT_DIR}/server.pid"
META_FILE="${ARTIFACT_DIR}/server.daemon.json"

# --- toolchain resolution (uv installs the powercontext entry point here) ---
export UV_TOOL_DIR="${UV_TOOL_DIR:-${PROJECT_ROOT}/.tools/uv-tools}"
export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-${PROJECT_ROOT}/.tools/uv-bin}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-${PROJECT_ROOT}/.tools/uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-${PROJECT_ROOT}/.tools/uv-python}"
export PATH="${PROJECT_ROOT}/.tools/uv/bin:${PROJECT_ROOT}/.tools/uv-bin:${PATH}"

# Keep the Server's SQLite database and cursor signing key inside the project
# tree (git-ignored) instead of the user data directory, unless the caller
# overrides POWERCONTEXT_HOME explicitly.
export POWERCONTEXT_HOME="${POWERCONTEXT_HOME:-${PROJECT_ROOT}/powercontext-data}"
mkdir -p "${POWERCONTEXT_HOME}"

if ! command -v powercontext >/dev/null 2>&1; then
  echo "ERROR: powercontext executable not found on PATH (looked in ${PROJECT_ROOT}/.tools/uv-bin)." >&2
  echo "       Install it with: uv tool install --force \"powercontext[cli,server]==1.2.0\"" >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "ERROR: config not found at ${ENV_FILE}" >&2
  echo "       Create it with: powercontext config init --template --output ${ENV_FILE}" >&2
  exit 1
fi

# --- refuse to double-start ---
if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "PowerContext Server already running (pid $(cat "${PID_FILE}"))."
  exit 0
fi

BASE_URL="http://${HOST}:${PORT}"

if [[ "${FOREGROUND}" == "1" ]]; then
  echo "Running PowerContext Server in the foreground on ${BASE_URL}"
  exec powercontext server run --host "${HOST}" --port "${PORT}" --env-file "${ENV_FILE}"
fi

echo "Starting PowerContext Server on ${BASE_URL} ..."
: > "${LOG_FILE}"
nohup powercontext server run --host "${HOST}" --port "${PORT}" --env-file "${ENV_FILE}" \
  >> "${LOG_FILE}" 2>&1 &
SERVER_PID=$!
echo "${SERVER_PID}" > "${PID_FILE}"

# --- wait for readiness ---
DEADLINE=$(( SECONDS + TIMEOUT_S ))
READY="0"
while (( SECONDS < DEADLINE )); do
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "ERROR: server process exited during startup; tail of ${LOG_FILE}:" >&2
    tail -n 30 "${LOG_FILE}" >&2
    rm -f "${PID_FILE}"
    exit 1
  fi
  if curl -fsS --max-time 3 "${BASE_URL}/health/ready" >/dev/null 2>&1; then
    READY="1"; break
  fi
  sleep 1
done

if [[ "${READY}" != "1" ]]; then
  echo "ERROR: timed out after ${TIMEOUT_S}s waiting for ${BASE_URL}/health/ready" >&2
  tail -n 30 "${LOG_FILE}" >&2
  echo "(server pid ${SERVER_PID} left running; stop it with scripts/stop-server.sh)" >&2
  exit 1
fi

cat > "${META_FILE}" <<JSON
{
  "pid": ${SERVER_PID},
  "baseUrl": "${BASE_URL}",
  "host": "${HOST}",
  "port": ${PORT},
  "envFile": "${ENV_FILE}",
  "logFile": "${LOG_FILE}",
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "PowerContext Server ready at ${BASE_URL} (pid ${SERVER_PID})"
echo "  log: ${LOG_FILE}"
echo "  pid: ${PID_FILE}"
