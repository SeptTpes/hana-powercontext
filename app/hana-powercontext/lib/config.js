/**
 * lib/config.js — effective PowerContext Server settings.
 *
 * Resolution order, highest priority first:
 *   1. explicit per-call overrides
 *   2. the App's own app-data config file  (`<dataDir>/config.json`)
 *   3. POWERCONTEXT_HANA_* environment variables
 *   4. defaults below
 *
 * The environment is read lazily on every call rather than cached at module
 * load: `defineApp` runs before the first tool invocation, and a cache built
 * there would freeze whatever the AppHost child happened to inherit.
 */

export const ENV_PREFIX = "POWERCONTEXT_HANA_";

export const DEFAULTS = Object.freeze({
  /** PowerContext Server base URL. Loopback by default; see manifest.network. */
  baseUrl: "http://127.0.0.1:8000",
  /** Per-request budget for Server calls. Kept well under a turn's patience. */
  timeoutMs: 5000,
  /** Scope used when a tool call does not name one. */
  scopeId: "",
  /** Response cap for prepare; must stay inside the Server's 512..32768 range. */
  maxBytes: 8000,
  /** Responses larger than this are refused by the host network door. */
  maxResponseBytes: 32768,
});

/** Environment variable name for one config key, e.g. baseUrl -> POWERCONTEXT_HANA_BASE_URL. */
export function envNameFor(key) {
  return ENV_PREFIX + key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();
}

function coerce(key, raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const fallback = DEFAULTS[key];
  if (typeof fallback === "number") {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return String(raw);
}

function readEnv(env) {
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = coerce(key, env[envNameFor(key)]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Read the App-data config file. `sdk.dataDir` is documented to survive
 * uninstall, which is exactly where a base URL override belongs. Any failure
 * (missing file, bad JSON, unreadable directory) is reported as `null` rather
 * than thrown: a broken config file must not stop the App from loading, and the
 * caller can still fall back to environment and defaults.
 */
export function readAppDataConfig(sdk) {
  const dir = sdk && typeof sdk.dataDir === "string" ? sdk.dataDir : null;
  if (!dir) return null;
  try {
    // Lazy require: keeps module load free of filesystem work.
    const fs = require("node:fs");
    const path = require("node:path");
    const raw = fs.readFileSync(path.join(dir, "config.json"), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      const value = coerce(key, parsed[key]);
      if (value !== undefined) out[key] = value;
    }
    return out;
  } catch {
    // Absent or unparseable config is the normal case, not an error.
    return null;
  }
}

/**
 * Resolve the effective configuration.
 * @returns {{baseUrl: string, timeoutMs: number, scopeId: string, maxBytes: number,
 *            maxResponseBytes: number, dataDir: string|null, sources: string[]}}
 */
export function resolveConfig(sdk, overrides = {}) {
  const fromFile = readAppDataConfig(sdk);
  const fromEnv = readEnv(typeof process !== "undefined" && process.env ? process.env : {});
  const explicit = {};
  for (const key of Object.keys(DEFAULTS)) {
    const value = coerce(key, overrides[key]);
    if (value !== undefined) explicit[key] = value;
  }

  const effective = {
    ...DEFAULTS,
    ...fromEnv,
    ...(fromFile || {}),
    ...explicit,
  };

  // A trailing slash double-slashes every path below it.
  effective.baseUrl = String(effective.baseUrl).replace(/\/+$/, "");
  effective.dataDir = sdk && typeof sdk.dataDir === "string" ? sdk.dataDir : null;
  effective.sources = {
    env: fromEnv,
    appData: fromFile || {},
    explicit,
  };

  return effective;
}
