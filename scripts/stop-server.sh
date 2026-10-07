#!/usr/bin/env bash
# hana-powercontext · Stage 0 reproducible PowerContext Server stopper.
#
# Stops the background Server started by scripts/start-server.sh (SIGTERM, then
# SIGKILL after --grace seconds). Removes the PID file on success.
#
# Usage: scripts/stop-server.sh [--grace 15]
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARTIFACT_DIR="${PROJECT_ROOT}/artifacts/stage0"
PID_FILE="${ARTIFACT_DIR}/server.pid"
META_FILE="${ARTIFACT_DIR}/server.daemon.json"
GRACE="15"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --grace) GRACE="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -f "${PID_FILE}" ]]; then
  echo "No PID file at ${PID_FILE}; nothing to stop."
  exit 0
fi

PID="$(cat "${PID_FILE}")"
if ! kill -0 "${PID}" 2>/dev/null; then
  echo "Process ${PID} is not running; removing stale PID file."
  rm -f "${PID_FILE}" "${META_FILE}"
  exit 0
fi

echo "Stopping PowerContext Server (pid ${PID}) ..."
kill -TERM "${PID}" 2>/dev/null || true

DEADLINE=$(( SECONDS + GRACE ))
while (( SECONDS < DEADLINE )); do
  if ! kill -0 "${PID}" 2>/dev/null; then
    echo "Stopped."
    rm -f "${PID_FILE}" "${META_FILE}"
    exit 0
  fi
  sleep 1
done

echo "Process ${PID} ignored SIGTERM after ${GRACE}s; sending SIGKILL." >&2
kill -KILL "${PID}" 2>/dev/null || true
sleep 1
if kill -0 "${PID}" 2>/dev/null; then
  echo "ERROR: process ${PID} is still alive." >&2
  exit 1
fi
echo "Stopped (forced)."
rm -f "${PID_FILE}" "${META_FILE}"
