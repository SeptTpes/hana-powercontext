/**
 * lib/dashboard.js — the read-only aggregation behind the dashboard card.
 *
 * The card never talks to the PowerContext Server itself. It asks this App's own
 * backend, and the backend uses the same `lib/` functions the tools and commands
 * already use — so the card inherits the App's network declaration, its timeout,
 * its Scope resolution and its fail-open behaviour instead of reimplementing a
 * second, weaker copy of all four.
 *
 * Two rules shape every function here:
 *
 *   * **Read-only.** Nothing in this module writes to the Server. The card shows
 *     state; changing state is a user command.
 *   * **A failed section is data, not an exception.** If the Server is down, the
 *     card still has to render — it has to render the fact that the Server is
 *     down, with enough detail to act on. So each section resolves to
 *     `{ ok: false, error }` and the route answers 200 with that inside it. A 500
 *     would give the card nothing to explain.
 */

import { request, probe } from "./powercontext.js";
import { resolveScope } from "./tools.js";
import { counters, CACHE_TTL_MS, recallCacheSize, CAPTURE_LRU_SIZE } from "./hooks.js";

/**
 * Fix-4: which failures may be rendered as "the Server is down"?
 *
 * Only these. They are the kinds `lib/powercontext.js` produces when the *network
 * call itself* could not be made — the socket refused, the host allow-list said no,
 * localhost was not permitted, or the host-side timeout fired. Nothing else earns
 * the down banner.
 *
 * The distinction matters because the opposite mistake is expensive: during T14 a
 * stale asset plus an internal error produced "连不上 Server / 地址：未知" while the
 * Server was alive and serving hook traffic the whole time. A user who is told to
 * start a Server that is already running has been sent to fix the wrong thing.
 *
 * Anything not in this set (`http_error`, `not_json`, `read_failed`, a thrown
 * exception, a malformed response) means **the request was made and the answer was
 * not usable** — that is this App's problem, not the Server's reachability, and it
 * is reported as `backend_error`.
 */
const NETWORK_FAILURE_KINDS = new Set(["unreachable", "network_not_declared"]);

/** True when a failure kind means "the network call itself failed". */
export function isNetworkFailure(kind) {
  return NETWORK_FAILURE_KINDS.has(kind);
}

/**
 * Fix-4: normalise any internal failure into the one shape the card renders.
 *
 * `origin` records where it came from ("config", "scope", "server-response") so a
 * reader — and the route log — can tell an App bug from a Server answer without
 * guessing from the prose.
 */
function backendError(message, { origin = "internal", hint = null, cause = null } = {}) {
  return {
    kind: "backend_error",
    origin,
    message: clip(String(message || "未知的后端错误"), 300),
    hint,
    cause: cause ? clip(String(cause), 200) : null,
  };
}

/**
 * Classify a failure that came back from `request()`/`probe()`.
 *
 * Network-layer kinds pass through untouched (they keep the right to the down
 * banner); everything else becomes `backend_error` with the original kinds folded
 * into the metadata, so nothing is lost and nothing is mislabelled.
 */
function classifyFailure(failure, origin) {
  const source = failure || {};
  if (isNetworkFailure(source.kind)) {
    return {
      kind: source.kind,
      message: clip(source.message, 300),
      hint: source.hint || null,
      serverCode: source.serverCode || null,
      status: source.status === undefined ? null : source.status,
    };
  }
  return {
    ...backendError(source.message || "后端调用失败", {
      origin,
      hint: source.hint || null,
      cause: source.kind ? `原始类别：${source.kind}` : null,
    }),
    serverCode: source.serverCode || null,
    status: source.status === undefined ? null : source.status,
  };
}

/**
 * Fix-4: resolve configuration without ever throwing.
 *
 * Takes either a config object or a resolver function, so the routes can hand in
 * `configNow` and let the failure be reported as data. Returns
 * `{ config } | { configError }`; the caller decides how to degrade.
 */
function configOr(configOrResolver) {
  try {
    const config = typeof configOrResolver === "function" ? configOrResolver() : configOrResolver;
    if (!config || typeof config.baseUrl !== "string") {
      return {
        configError: backendError("配置解析没有返回可用的 baseUrl。", {
          origin: "config",
          hint: "检查 App 的 config.json 与 POWERCONTEXT_HANA_* 环境变量。",
        }),
      };
    }
    return { config };
  } catch (error) {
    return {
      configError: backendError(`配置解析抛错：${error && error.message ? error.message : String(error)}`, {
        origin: "config",
        hint: "检查 App 的 config.json 与 POWERCONTEXT_HANA_* 环境变量。",
      }),
    };
  }
}

/** Trim a string to a display-safe length without cutting a surrogate pair. */
function clip(text, max) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut) + "…";
}

/** The Scope, or a structured reason why there is none. */
async function scopeOf(sdk, config) {
  const scope = await resolveScope(sdk, config, undefined);
  if (!scope.ok) return { ok: false, error: scope };
  return { ok: true, scopeId: scope.scopeId, source: scope.source, title: scope.scope ? scope.scope.title : null };
}

/**
 * `/api/status` — Server reachability, readiness and the effective Scope.
 *
 * This is the section the card draws first, and the one that explains every other
 * section's failure. It reports the configuration it is using, because "which
 * Server am I even looking at" is the first question a user has when a card looks
 * wrong.
 */
export async function dashboardStatus(sdk, configOrResolver) {
  const checkedAt = new Date().toISOString();

  // Fix-4: configuration resolution happens INSIDE the section, in a try/catch.
  // It used to happen in the route wrapper, which meant a throw there produced no
  // payload at all: the card fell back to its "status unknown" skeleton with no
  // address and no kind, which reads as an outage and diagnoses nothing. Now a
  // config failure is a first-class `backend_error` the card can show.
  const resolvedConfig = configOr(configOrResolver);
  const config = resolvedConfig.config || null;
  const configError = resolvedConfig.configError || null;

  if (configError) {
    return {
      ok: false,
      checkedAt,
      baseUrl: null,
      configError,
      // The card renders the backend_error branch, which is what carries this.
      server: { ok: false, stage: "config", error: configError },
      scope: null,
      config: null,
    };
  }

  let verdict;
  try {
    verdict = await probe(sdk, config);
  } catch (error) {
    // probe() is documented never to throw; if it ever does, that is an App bug and
    // must not be dressed up as an unreachable Server.
    verdict = { ok: false, stage: "probe", error: backendError(`探活抛错：${error && error.message ? error.message : String(error)}`, { origin: "probe" }) };
  }

  // Scope resolution is a second, independent question: a reachable Server can
  // still have no usable Scope, and the card should be able to say which of the
  // two is broken.
  let scope = null;
  if (verdict.ok) {
    try {
      const resolved = await scopeOf(sdk, config);
      scope = resolved.ok
        ? { ok: true, scopeId: resolved.scopeId, source: resolved.source, title: resolved.title }
        : { ok: false, error: classifyFailure(resolved.error, "scope") };
    } catch (error) {
      scope = {
        ok: false,
        error: backendError(`Scope 解析抛错：${error && error.message ? error.message : String(error)}`, { origin: "scope" }),
      };
    }
  }

  const serverError = verdict.ok ? null : classifyFailure(verdict.error, verdict.stage === "readiness" ? "readiness" : "liveness");

  return {
    ok: verdict.ok === true,
    checkedAt,
    baseUrl: config.baseUrl,
    configError: null,
    server: verdict.ok
      ? {
          ok: true,
          status: verdict.status,
          checks: verdict.checks || {},
          contextVersion: verdict.contextVersion || null,
          /** The card shows this as a plain-language capability line. */
          capabilities: verdict.capabilities
            ? {
                handoffGeneration: verdict.capabilities.handoff_generation === true,
                memoryExtraction: verdict.capabilities.memory_extraction === true,
                searchModes: verdict.capabilities.search_modes || [],
              }
            : null,
        }
      : {
          ok: false,
          stage: verdict.stage,
          error: serverError,
        },
    scope,
    config: {
      prestep: config.prestep,
      prestepMaxBytes: config.prestepMaxBytes,
      prestepTimeoutMs: config.prestepTimeoutMs,
      capturePrompts: config.capturePrompts,
      beforeStart: config.beforeStart,
      timeoutMs: config.timeoutMs,
    },
  };
}

/**
 * Fix-4 + Fix-3: run a route handler with its own bounded failure semantics.
 *
 * Any throw becomes a `backend_error` payload rather than a 500, so the card always
 * has something specific to render, and the caller gets metadata for the route log
 * without the caller having to know each section's shape.
 */
export async function runSection(name, resolveConfig, work) {
  const startedAt = Date.now();
  try {
    const payload = await work(resolveConfig);
    return { payload, meta: sectionMeta(name, payload), durationMs: Date.now() - startedAt, thrown: null };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    const payload = {
      ok: false,
      error: backendError(`${name} 处理时抛错：${message}`, {
        origin: "handler",
        hint: "这是看板后端自身的错误，与 PowerContext Server 无关。",
      }),
    };
    return { payload, meta: sectionMeta(name, payload), durationMs: Date.now() - startedAt, thrown: message };
  }
}

/**
 * Fix-3: the metadata one route call contributes to the host log.
 *
 * Metadata ONLY — route name, outcome kind, HTTP status, duration, and booleans.
 * Never the payload body, never the Scope id, never a credential. The point is to
 * make a card request attributable in the host log (the "79 requests" question
 * could not be answered from logs that did not exist), and that is achievable
 * without logging anything a user would mind seeing.
 */
export function sectionMeta(name, payload) {
  // The three sections nest their failure differently, so the kind has to be read
  // from the right place per shape rather than assumed:
  //   * hooks   — never fails, always `ok: true`
  //   * handoff — `error.kind` at the top level
  //   * memory  — `error.kind` at the top level
  //   * status  — `server.error.kind`, plus a top-level `configError`
  // Getting this wrong does not corrupt the response (the card reads the body, not
  // the log) but it would make the log lie about which branch ran — and a log that
  // lies about the branch is worse than no log, because Fix-3 exists precisely to
  // make card requests attributable.
  const kind = detectKind(payload);
  return {
    route: name,
    ok: Boolean(payload && payload.ok === true),
    kind,
    // A boolean, not the value: says "there was an address" without recording it.
    hasAddress: Boolean(payload && typeof payload.baseUrl === "string" && payload.baseUrl),
    failedSections: countFailedSections(payload),
  };
}

/** The failure kind of any section payload, wherever that section puts it. */
function detectKind(payload) {
  if (!payload || typeof payload !== "object") return "unknown";
  if (payload.ok === true) return "ok";
  // A throw-through from runSection(): a bare descriptor with its own kind.
  if (typeof payload.kind === "string" && !payload.ok) return payload.kind;
  if (payload.error && typeof payload.error.kind === "string") return payload.error.kind;
  if (payload.configError && typeof payload.configError.kind === "string") return payload.configError.kind;
  if (payload.server && payload.server.error && typeof payload.server.error.kind === "string") return payload.server.error.kind;
  if (payload.scope && payload.scope.error && typeof payload.scope.error.kind === "string") return payload.scope.error.kind;
  return payload.ok === false ? "backend_error" : "ok";
}

/** Count how many sub-parts of a payload are failures, for the exit log. */
function countFailedSections(payload) {
  if (!payload || typeof payload !== "object") return 0;
  let count = 0;
  if (payload.server && payload.server.ok === false) count += 1;
  if (payload.scope && payload.scope.ok === false) count += 1;
  if (payload.configError) count += 1;
  return count;
}

/**
 * `/api/handoff` — the latest transferable Handoff for the effective Scope.
 *
 * `status: "empty"` is a normal, expected answer on a basic-memory Server (the
 * draft step needs a generation provider), so it is returned as `ok: true` with
 * `handoff: null`. Only a real transport or Server failure is `ok: false`. The
 * card needs that distinction: "nothing here yet, here is how to make one" reads
 * very differently from "the Server did not answer".
 */
export async function dashboardHandoff(sdk, configOrResolver) {
  const resolvedConfig = configOr(configOrResolver);
  if (resolvedConfig.configError) {
    return { ok: false, scope: null, handoff: null, error: resolvedConfig.configError };
  }
  const config = resolvedConfig.config;

  const scope = await scopeOf(sdk, config);
  if (!scope.ok) return { ok: false, scope: null, handoff: null, error: classifyFailure(scope.error, "scope") };

  const response = await request(
    sdk,
    config,
    "/v1/handoff/continue",
    { scope_id: scope.scopeId, selection: "latest" },
    { timeoutMs: config.timeoutMs },
  );
  if (!response.ok) {
    return {
      ok: false,
      scope: { scopeId: scope.scopeId, source: scope.source },
      handoff: null,
      error: classifyFailure(response, "handoff-response"),
    };
  }

  const resolution = response.data || {};
  const content = resolution.content || null;
  return {
    ok: true,
    scope: { scopeId: scope.scopeId, source: scope.source },
    status: resolution.status || "unknown",
    handoff: content
      ? {
          objective: clip(content.objective, 400),
          disposition: content.disposition || null,
          nextAction: content.next_action && content.next_action.text ? clip(content.next_action.text, 300) : null,
          stateCount: Array.isArray(content.state) ? content.state.length : 0,
          omissionCount: Array.isArray(content.omissions) ? content.omissions.length : 0,
          /** Up to three state lines, so the card can show the shape of the work. */
          statePreview: (Array.isArray(content.state) ? content.state : []).slice(0, 3).map((item) => clip(item && item.text, 200)),
          revision: resolution.selected_revision ? resolution.selected_revision.revision : null,
        }
      : null,
    error: null,
  };
}

/**
 * `/api/memory` — the memory inventory for the effective Scope.
 *
 * Returns counts by kind plus a bounded preview. The bound is deliberate: a card
 * is a glanceable surface, not a memory browser, and shipping 500 entries into an
 * iframe to render ten of them would be a worse experience than not showing the
 * other 490.
 */
export async function dashboardMemory(sdk, configOrResolver, { previewLimit = 10 } = {}) {
  const resolvedConfig = configOr(configOrResolver);
  if (resolvedConfig.configError) {
    return { ok: false, scope: null, entries: [], total: 0, byKind: {}, truncated: false, error: resolvedConfig.configError };
  }
  const config = resolvedConfig.config;

  const scope = await scopeOf(sdk, config);
  if (!scope.ok) return { ok: false, scope: null, entries: [], error: classifyFailure(scope.error, "scope") };

  const response = await request(
    sdk,
    config,
    "/v1/memory/entries/list",
    { scope_id: scope.scopeId },
    { timeoutMs: config.timeoutMs },
  );
  if (!response.ok) {
    return {
      ok: false,
      scope: { scopeId: scope.scopeId, source: scope.source },
      entries: [],
      error: classifyFailure(response, "memory-response"),
    };
  }

  const all = (response.data && response.data.entries) || [];
  const byKind = {};
  for (const entry of all) {
    const kind = entry && typeof entry.kind === "string" ? entry.kind : "unknown";
    byKind[kind] = (byKind[kind] || 0) + 1;
  }

  const limit = Math.max(0, Math.min(50, previewLimit));
  const entries = all.slice(0, limit).map((entry) => ({
    entryId: entry.citation ? entry.citation.entry_id : null,
    kind: entry.kind || "unknown",
    state: entry.state || "active",
    text: clip(entry.text, 240),
  }));

  return {
    ok: true,
    scope: { scopeId: scope.scopeId, source: scope.source },
    total: all.length,
    byKind,
    entries,
    /** So the card can say "showing 10 of 43" rather than implying it shows all. */
    truncated: all.length > entries.length,
    revision: response.data && response.data.memory ? response.data.memory.revision : null,
    error: null,
  };
}

/** `/api/hooks` — the same counts `/pc hooks` renders, for the card footer. */
export function dashboardHooks() {
  return {
    ok: true,
    counters: { ...counters },
    cache: { entries: recallCacheSize(), ttlSeconds: CACHE_TTL_MS / 1000, captureDedupeWindow: CAPTURE_LRU_SIZE },
  };
}
