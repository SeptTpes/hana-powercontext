#!/usr/bin/env bash
# hana-powercontext · proxy-safe PowerContext CLI wrapper.
#
# Background: this machine runs an outbound proxy (ALL_PROXY=socks5://127.0.0.1:17891).
# The upstream powercontext CLI builds `httpx.AsyncClient(timeout=...)` with
# default `trust_env=True`; httpx has no SOCKS support, so parsing that
# ALL_PROXY value raises `httpx.InvalidURL: Invalid port: ':1]'`. With the SOCKS
# variable removed httpx instead forwards loopback traffic to the HTTP proxy and
# receives 502.
#
# This wrapper clears the SOCKS variables and forces a loopback NO_PROXY so the
# CLI always talks directly to 127.0.0.1. It only affects this wrapper's own
# process tree; nothing here is written to the user's shell profile.
#
# Usage: scripts/pc.sh ready
#        scripts/pc.sh capabilities
#        scripts/pc.sh --server-url http://127.0.0.1:8000 doctor
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export UV_TOOL_DIR="${UV_TOOL_DIR:-${PROJECT_ROOT}/.tools/uv-tools}"
export UV_TOOL_BIN_DIR="${UV_TOOL_BIN_DIR:-${PROJECT_ROOT}/.tools/uv-bin}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-${PROJECT_ROOT}/.tools/uv-cache}"
export UV_PYTHON_INSTALL_DIR="${UV_PYTHON_INSTALL_DIR:-${PROJECT_ROOT}/.tools/uv-python}"
export PATH="${PROJECT_ROOT}/.tools/uv/bin:${PROJECT_ROOT}/.tools/uv-bin:${PATH}"

LOOPBACK_NOPROXY="127.0.0.1,localhost,::1"

# Drop the SOCKS variables outright; httpx raises rather than ignore them.
unset ALL_PROXY all_proxy || true

# Drop NODE_USE_ENV_PROXY: urllib's getproxies() surfaces it as a bogus
# "node_use_env" proxy entry that httpx then tries to parse as a URL.
unset NODE_USE_ENV_PROXY || true

# Rebuild NO_PROXY from scratch with clean loopback entries only. The inherited
# DSH value contains a bracketed IPv6 literal ("[::1]"), which httpx's URLPattern
# parses as a URL and rejects with `Invalid port: ':1]'` — the crash happened while
# building the pattern list, before any no_proxy matching could skip it. Bare
# "::1" is safe, but it is dropped here too since httpx cannot match IPv6 hosts.
export NO_PROXY="127.0.0.1,localhost,::1"
export no_proxy="${NO_PROXY}"

if ! command -v powercontext >/dev/null 2>&1; then
  echo "ERROR: powercontext executable not found (looked in ${PROJECT_ROOT}/.tools/uv-bin)." >&2
  exit 1
fi

exec powercontext "$@"
