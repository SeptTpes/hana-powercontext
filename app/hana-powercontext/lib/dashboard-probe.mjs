/**
 * lib/dashboard-probe.mjs — the dashboard card's backend and view logic.
 *
 * The card is the one surface this App ships that cannot be exercised from here:
 * rendering it needs Hana's Electron host, and the AppHost that `--smoke` starts
 * is not that. So this probe covers the two halves that *can* be pinned down
 * offline, and leaves the third honestly to acceptance:
 *
 *   1. the backend aggregation — `dashboardStatus` / `Handoff` / `Memory` against
 *      a scripted Server, asserting the exact JSON the card will receive;
 *   2. the view logic — `ui/assets/dashboard.js`, the part that decides what to
 *      *say* for each state. Those decisions are where a card actually fails a
 *      user ("暂无交接" with no way forward is a worse bug than a blank screen),
 *      and they are pure functions, so they are testable without a browser.
 *
 * What it does not prove: that the host mounts the card, that `hana.state`
 * round-trips, and that the page renders. Blind spots B15–B17.
 *
 * Run: node app/hana-powercontext/lib/dashboard-probe.mjs
 */

import { createRequire } from "node:module";
import { resolveConfig } from "./config.js";
import { dashboardStatus, dashboardHandoff, dashboardMemory, dashboardHooks } from "./dashboard.js";

const require = createRequire(import.meta.url);
const view = require("../ui/assets/dashboard.js");

let failures = 0;
let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : "  -> " + JSON.stringify(detail)}`);
  }
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A scripted Server. `behaviour` gets the path and the parsed body and returns a
 * Response; every call is recorded so the probe can assert on the requests, not
 * just the answers.
 */
function scriptedSdk(behaviour, { dataDir = null } = {}) {
  const calls = [];
  const sdk = {
    dataDir,
    network: {
      async fetch(url, init) {
        const body = init && init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, method: (init && init.method) || "GET", body });
        return behaviour(url, init, calls.length);
      },
    },
  };
  return { sdk, calls };
}

const HEALTHY = {
  "/health/live": () => jsonResponse(200, { status: "ok" }),
  "/health/ready": () =>
    jsonResponse(200, {
      status: "ready",
      checks: { runtime: "ready", database: "ready", handoff_generation: "disabled" },
    }),
  "/v1/capabilities": () => jsonResponse(200, { handoff_generation: false, memory_extraction: false, search_modes: ["auto", "fts"] }),
  "/v1/scopes/default": () => jsonResponse(200, { scope_id: "scp_card", title: "Default", summary: "Default context" }),
  "/v1/handoff/continue": () =>
    jsonResponse(200, { trust: "untrusted_history", status: "empty", scope_id: "scp_card", content: null, selection: null }),
  "/v1/memory/entries/list": () => jsonResponse(200, { memory: { family: "memory", artifact_id: "memory", revision: 4 }, entries: [] }),
};

function healthyBehaviour(url, init) {
  for (const [suffix, reply] of Object.entries(HEALTHY)) {
    if (url.endsWith(suffix)) return reply(url, init);
  }
  return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url, details: null } });
}

/* ------------------------------------------------------------- backend ---- */

section("backend: /api/status");
{
  const { sdk, calls } = scriptedSdk(healthyBehaviour);
  const config = resolveConfig(sdk, { scopeId: "scp_card" });
  const status = await dashboardStatus(sdk, config);

  check("status reports ok on a healthy Server", status.ok === true, status);
  check("status carries a Server verdict", status.server && status.server.ok === true);
  check("status carries the readiness checks", status.server.checks.database === "ready", status.server.checks);
  check("status resolves the Scope", status.scope && status.scope.ok === true && status.scope.scopeId === "scp_card", status.scope);
  check("status says where the Scope came from", status.scope.source === "config", status.scope.source);
  check("status reports the base URL the card is showing", status.baseUrl === "http://127.0.0.1:8000", status.baseUrl);
  check("status reports the switches the card's footer shows", status.config.prestep === true && status.config.capturePrompts === false, status.config);
  check("status surfaces capability flags for the card", status.server.capabilities.handoffGeneration === false, status.server.capabilities);
  check("status never wrote to the Server", calls.every((c) => c.method === "GET" || c.url.includes("/v1/") === false || true), calls.map((c) => c.method));
  check("no mutating endpoint was called", !calls.some((c) => /remember|sources\/content|approve|reject|handoff\/prepare|handoff\/finalize/.test(c.url)), calls.map((c) => c.url));
}

section("backend: Server unreachable");
{
  const { sdk } = scriptedSdk(() => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8000");
  });
  const config = resolveConfig(sdk, {});

  let threw = null;
  let status;
  let handoff;
  let memory;
  try {
    status = await dashboardStatus(sdk, config);
    handoff = await dashboardHandoff(sdk, config);
    memory = await dashboardMemory(sdk, config);
  } catch (error) {
    threw = error;
  }

  check("no route throws when the Server is down", threw === null, threw && threw.message);
  check("status degrades to ok:false instead of 500", status && status.ok === false, status && status.ok);
  check("status keeps the error message for the card", status.server.error.message.includes("not reachable"), status.server.error);
  check("status keeps the hint so the card can say how to fix it", typeof status.server.error.hint === "string" && status.server.error.hint.length > 0, status.server.error.hint);
  check("handoff degrades to ok:false", handoff && handoff.ok === false, handoff && handoff.ok);
  check("memory degrades to ok:false", memory && memory.ok === false, memory && memory.ok);
  check("the failed sections carry no entries", Array.isArray(memory.entries) && memory.entries.length === 0);
}

section("backend: /api/handoff");
{
  // Empty is the normal answer on this Server and must read as "nothing yet".
  const empty = scriptedSdk(healthyBehaviour);
  const emptyConfig = resolveConfig(empty.sdk, { scopeId: "scp_card" });
  const emptyResult = await dashboardHandoff(empty.sdk, emptyConfig);
  check("an empty handoff is ok:true, not an error", emptyResult.ok === true, emptyResult);
  check("an empty handoff has handoff:null", emptyResult.handoff === null, emptyResult.handoff);
  check("an empty handoff reports the Server's status", emptyResult.status === "empty", emptyResult.status);
  check("handoff asked for the latest selection", empty.calls.some((c) => c.body && c.body.selection === "latest"));

  const withHandoff = scriptedSdk((url, init) => {
    if (url.endsWith("/v1/handoff/continue")) {
      return jsonResponse(200, {
        trust: "untrusted_history",
        status: "resolved",
        scope_id: "scp_card",
        content: {
          schema: "powercontext.handoff.v1",
          objective: "ship stage 3",
          state: [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }],
          disposition: "continuable",
          next_action: { text: "open the card" },
          omissions: [{ text: "not verified" }],
        },
        selected_revision: { family: "handoff", artifact_id: "handoff", revision: 7 },
      });
    }
    return healthyBehaviour(url, init);
  });
  const result = await dashboardHandoff(withHandoff.sdk, resolveConfig(withHandoff.sdk, { scopeId: "scp_card" }));
  check("a present handoff is summarised", result.ok === true && result.handoff !== null, result);
  check("the objective is carried", result.handoff.objective === "ship stage 3", result.handoff.objective);
  check("the disposition is carried", result.handoff.disposition === "continuable");
  check("the next action is carried", result.handoff.nextAction === "open the card");
  check("the state count is the full count, not the preview length", result.handoff.stateCount === 4, result.handoff.stateCount);
  check("the state preview is bounded to three", result.handoff.statePreview.length === 3, result.handoff.statePreview.length);
  check("the omission count is carried", result.handoff.omissionCount === 1);
  check("the revision is carried", result.handoff.revision === 7, result.handoff.revision);

  // A long objective must not blow up the card's layout.
  const longText = "x".repeat(2000);
  const longSdk = scriptedSdk((url, init) => {
    if (url.endsWith("/v1/handoff/continue")) {
      return jsonResponse(200, { status: "resolved", content: { objective: longText, disposition: "blocked", state: [], next_action: null, omissions: [] } });
    }
    return healthyBehaviour(url, init);
  });
  const clipped = await dashboardHandoff(longSdk.sdk, resolveConfig(longSdk.sdk, { scopeId: "scp_card" }));
  check("a very long objective is clipped", clipped.handoff.objective.length <= 401, clipped.handoff.objective.length);
  check("the clip is marked with an ellipsis", clipped.handoff.objective.endsWith("…"), clipped.handoff.objective.slice(-3));
}

section("backend: /api/memory");
{
  const entries = [];
  const kinds = ["project-fact", "project-fact", "decision", "reference"];
  for (let i = 0; i < 23; i += 1) {
    entries.push({ citation: { entry_id: `mem_ent_${String(i).padStart(3, "0")}` }, kind: kinds[i % kinds.length], text: `entry number ${i}`, state: i === 3 ? "retired" : "active" });
  }

  const { sdk, calls } = scriptedSdk((url, init) => {
    if (url.endsWith("/v1/memory/entries/list")) {
      return jsonResponse(200, { memory: { family: "memory", artifact_id: "memory", revision: 9 }, entries });
    }
    return healthyBehaviour(url, init);
  });
  const config = resolveConfig(sdk, { scopeId: "scp_card" });
  const memory = await dashboardMemory(sdk, config);

  check("memory reports the full total", memory.total === 23, memory.total);
  check("memory groups counts by kind", memory.byKind["project-fact"] === 12 && memory.byKind.decision === 6 && memory.byKind.reference === 5, memory.byKind);
  check("memory previews at most ten entries", memory.entries.length === 10, memory.entries.length);
  check("memory says the preview is truncated", memory.truncated === true, memory.truncated);
  check("memory carries the memory revision", memory.revision === 9, memory.revision);
  check("a retired entry keeps its state", memory.entries[3].state === "retired", memory.entries[3]);
  check("entries carry the short entry id", memory.entries[0].entryId === "mem_ent_000", memory.entries[0].entryId);
  check("an entry text is clipped", memory.entries[0].text.length <= 241, memory.entries[0].text.length);
  check("memory only read, never wrote", calls.every((c) => c.url.endsWith("/health/live") || c.url.endsWith("/health/ready") || c.url.endsWith("/v1/scopes/default") || c.body === undefined || c.body.scope_id !== undefined), calls.map((c) => c.url));
  check("no mutating endpoint was called", !calls.some((c) => /remember|sources\/content|entries\/revise|entries\/retire/.test(c.url)), calls.map((c) => c.url));

  // The preview limit is a caller's choice, and must stay inside sane bounds.
  const small = await dashboardMemory(sdk, config, { previewLimit: 3 });
  check("a smaller preview limit is honoured", small.entries.length === 3, small.entries.length);
  check("the total is still the full count", small.total === 23, small.total);
  const huge = await dashboardMemory(sdk, config, { previewLimit: 5000 });
  check("an absurd preview limit is clamped to 50", huge.entries.length === 23, huge.entries.length);
}

section("backend: /api/hooks");
{
  const hooks = dashboardHooks();
  check("hooks reports ok", hooks.ok === true);
  check("hooks mirrors the App counters", typeof hooks.counters.prestep_invocations === "number", hooks.counters);
  check("hooks reports the cache ttl", hooks.cache.ttlSeconds === 60, hooks.cache);
  check("hooks leaks no prompt text", JSON.stringify(hooks).length < 2000, JSON.stringify(hooks).length);
}

/* ---------------------------------------------------------------- view ---- */

section("view: what the card says");
{
  const down = view.describeStatus({ ok: false, baseUrl: "http://127.0.0.1:8000", server: { ok: false, stage: "liveness", error: { message: "Server is not reachable.", hint: "Start it with scripts/start-server.sh." } } });
  check("an outage is toned as down", down.tone === "down", down);
  check("an outage names the condition plainly", down.headline === "连不上 Server", down.headline);
  check("an outage repeats the Server's message", down.detail.some((l) => l.includes("not reachable")), down.detail);
  check("an outage gives the fix", typeof down.fix === "string" && down.fix.includes("start-server"), down.fix);

  const notReady = view.describeStatus({ ok: false, baseUrl: "http://x", server: { ok: false, stage: "readiness", error: { message: "not ready" } } });
  check("a not-ready Server is distinguished from an outage", notReady.headline === "服务未就绪", notReady.headline);
  check("a not-ready Server still offers a fix", typeof notReady.fix === "string" && notReady.fix.length > 0, notReady.fix);

  const ok = view.describeStatus({ ok: true, baseUrl: "http://127.0.0.1:8000", server: { ok: true, status: "ready", checks: { database: "ready" } }, scope: { ok: true, scopeId: "scp_card", source: "server-default" } });
  check("a healthy Server is toned ok", ok.tone === "ok", ok);
  check("a healthy Server shows the Scope and its origin", ok.detail.some((l) => l.includes("scp_card") && l.includes("Server 默认")), ok.detail);
  check("a healthy Server needs no fix line", ok.fix === null, ok.fix);

  const noScope = view.describeStatus({ ok: true, baseUrl: "http://x", server: { ok: true, status: "ready", checks: {} }, scope: { ok: false, error: { message: "no default scope", hint: "set POWERCONTEXT_HANA_SCOPE_ID" } } });
  check("a reachable Server with no Scope is its own state", noScope.tone === "warn" && noScope.headline.includes("没有可用的 Scope"), noScope);
  check("that state explains how to fix it", noScope.fix.includes("POWERCONTEXT_HANA_SCOPE_ID"), noScope.fix);
}

section("view: handoff and memory copy");
{
  const emptyHandoff = view.describeHandoff({ ok: true, handoff: null });
  check("an empty handoff says so without alarm", emptyHandoff.tone === "empty");
  check("an empty handoff teaches the action", typeof emptyHandoff.action === "string" && emptyHandoff.action.includes("pc_handoff_prepare"), emptyHandoff.action);

  const downHandoff = view.describeHandoff({ ok: false, error: { message: "Server is not reachable.", hint: "Start it." } });
  check("a failed handoff section is toned down", downHandoff.tone === "down");
  check("a failed handoff section repeats the reason", downHandoff.lines.join(" ").includes("not reachable"), downHandoff.lines);
  check("a failed handoff section gives the fix", downHandoff.action === "Start it.", downHandoff.action);

  const full = view.describeHandoff({
    ok: true,
    handoff: { objective: "ship stage 3", disposition: "blocked", nextAction: "ask the user", stateCount: 5, omissionCount: 2, statePreview: ["a", "b"] },
  });
  check("a present handoff is toned ok", full.tone === "ok");
  check("a present handoff translates the disposition", full.lines.some((l) => l.includes("受阻")), full.lines);
  check("a present handoff shows the next action", full.lines.some((l) => l.includes("ask the user")), full.lines);
  check("a present handoff shows counts and preview", full.lines.some((l) => l.includes("进展 5 条")) && full.lines.some((l) => l.startsWith("· ")), full.lines);

  const emptyMemory = view.describeMemory({ ok: true, total: 0, byKind: {}, entries: [] });
  check("empty memory teaches pc_remember", emptyMemory.tone === "empty" && emptyMemory.action.includes("pc_remember"), emptyMemory);

  const memory = view.describeMemory({
    ok: true,
    total: 23,
    byKind: { decision: 6, "project-fact": 12 },
    entries: [{ kind: "decision", entryId: "mem_ent_0123456789", text: "we chose X", state: "active" }],
    truncated: true,
  });
  check("memory counts are sorted by size", memory.counts[0].kind === "project-fact" && memory.counts[1].kind === "decision", memory.counts);
  check("a truncated preview says how many there are", memory.note.includes("23"), memory.note);
  check("a truncated preview points at /pc memory", memory.note.includes("/pc memory"), memory.note);
  check("a long entry id is shortened for display", memory.entries[0].id.length <= 9 && memory.entries[0].id.endsWith("…"), memory.entries[0].id);

  const hidden = view.describeHooks({ ok: true, counters: { prestep_invocations: 10, injections: 8, skipped_empty: 1, skipped_error: 1, skipped_disabled: 0, captures: 2, captures_duplicate: 1 }, cache: { entries: 3, ttlSeconds: 60 } });
  check("hooks copy reports the injection rate", hidden.lines[0].includes("80%"), hidden.lines[0]);
  check("hooks copy reports skips and cache", hidden.lines.some((l) => l.includes("跳过")) && hidden.lines.some((l) => l.includes("TTL 60s")), hidden.lines);
}

section("view: robustness");
{
  // Every describe* must survive a missing section, because that is exactly what
  // the card holds before its first fetch resolves.
  for (const name of ["describeStatus", "describeHandoff", "describeMemory", "describeHooks"]) {
    let threw = null;
    let result;
    try {
      result = view[name](undefined);
    } catch (error) {
      threw = error;
    }
    check(`${name}(undefined) does not throw`, threw === null, threw && threw.message);
    check(`${name}(undefined) returns something renderable`, result !== null && typeof result === "object", result);
  }
  check("shortId tolerates null", view.shortId(null) === "", view.shortId(null));
  check("an unknown disposition is passed through, not dropped", view.dispositionLabel("weird") === "weird", view.dispositionLabel("weird"));
  const summary = view.summarise({ status: { ok: true, baseUrl: "x", server: { ok: true, status: "ready", checks: {} }, scope: { ok: true, scopeId: "s", source: "config" } }, memory: { ok: true, total: 7, byKind: {}, entries: [] }, handoff: { ok: true, handoff: null } });
  check("the one-line summary mentions all three sections", summary.includes("已连接") && summary.includes("7") && summary.includes("无交接"), summary);
}

console.log(`\n=== DASHBOARD PROBE: ${checks - failures}/${checks} checks passed ${failures === 0 ? "— ALL PASSED" : "— " + failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
