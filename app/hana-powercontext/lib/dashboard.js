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
export async function dashboardStatus(sdk, config) {
  const checkedAt = new Date().toISOString();
  const verdict = await probe(sdk, config);

  // Scope resolution is a second, independent question: a reachable Server can
  // still have no usable Scope, and the card should be able to say which of the
  // two is broken.
  let scope = null;
  if (verdict.ok) {
    const resolved = await scopeOf(sdk, config);
    scope = resolved.ok
      ? { ok: true, scopeId: resolved.scopeId, source: resolved.source, title: resolved.title }
      : { ok: false, error: { kind: resolved.error.kind, message: resolved.error.message, hint: resolved.error.hint || null } };
  }

  return {
    ok: verdict.ok === true,
    checkedAt,
    baseUrl: config.baseUrl,
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
          error: {
            kind: verdict.error.kind,
            message: verdict.error.message,
            hint: verdict.error.hint || null,
          },
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
 * `/api/handoff` — the latest transferable Handoff for the effective Scope.
 *
 * `status: "empty"` is a normal, expected answer on a basic-memory Server (the
 * draft step needs a generation provider), so it is returned as `ok: true` with
 * `handoff: null`. Only a real transport or Server failure is `ok: false`. The
 * card needs that distinction: "nothing here yet, here is how to make one" reads
 * very differently from "the Server did not answer".
 */
export async function dashboardHandoff(sdk, config) {
  const scope = await scopeOf(sdk, config);
  if (!scope.ok) return { ok: false, scope: null, handoff: null, error: scope.error };

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
      error: { kind: response.kind, message: response.message, hint: response.hint || null, serverCode: response.serverCode || null },
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
export async function dashboardMemory(sdk, config, { previewLimit = 10 } = {}) {
  const scope = await scopeOf(sdk, config);
  if (!scope.ok) return { ok: false, scope: null, entries: [], error: scope.error };

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
      error: { kind: response.kind, message: response.message, hint: response.hint || null, serverCode: response.serverCode || null },
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
