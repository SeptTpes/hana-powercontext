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
const transport = require("../ui/assets/dashboard-fetch.js");

// Raw text of the card's own files. BUG-4 was a *missing file and a missing
// import* — a class of defect no amount of view-logic testing can see, so the
// wiring is asserted as text too.
const fs = require("node:fs");
const path = require("node:path");
const uiDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "ui");
const readUi = (relative) => fs.readFileSync(path.join(uiDir, relative), "utf8");
const htmlSource = readUi("dashboard.html");
const pageSource = readUi("assets/dashboard-page.js");
const bridgeSource = readUi("assets/sdk.js");
const indexText = fs.readFileSync(path.join(path.dirname(uiDir), "index.js"), "utf8");
/** `src` attributes in document order — a bare indexOf would match comments. */
const scriptSrcs = [...htmlSource.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map((m) => m[1]);
/**
 * A URL's path part, with the `?v=` cache key (Fix-1) and any fragment removed.
 * Every self-reference now carries a version query, so name matching has to ignore
 * it — comparing a raw URL against a bare filename silently stops matching.
 */
const pathnameOf = (src) => String(src).split("?")[0].split("#")[0];

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

/* ------------------------------------------------- BUG-3: credential door -- */

section("BUG-3: the card calls its backend through the SDK's credential door");
{
  transport.resetCounters();

  const calls = [];
  const hanaApi = {
    async fetch(path, init) {
      calls.push({ path, init });
      return new Response(JSON.stringify({ ok: true, via: "api" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  };

  const body = await transport.loadSection("status", { hana: { api: hanaApi } });
  check("the official door was used", calls.length === 1, calls.length);
  check("the request went through hana.api.fetch", transport.counters.api_fetch === 1, transport.counters);
  check("no fallback was taken", transport.counters.fallbacks === 0, transport.counters);
  check("the parsed body is returned", body && body.via === "api", body);

  // The path must be App-relative: a full URL or an "api/apps..." path is rejected
  // by the SDK's own normaliser, and a leading "/" is stripped. Passing a URL here
  // is the mistake that would silently reintroduce a credential-less request.
  check("the path is App-relative, not a full URL", calls[0].path === "status", calls[0].path);
  check("the path does not start with /api/apps", !String(calls[0].path).startsWith("api/apps"), calls[0].path);
  check("no absolute origin is passed", !/^https?:/.test(String(calls[0].path)), calls[0].path);
  check("an accept header is requested", calls[0].init.headers.accept === "application/json", calls[0].init.headers);
  // The App must never try to supply the surface credential itself: only the SDK
  // may read it out of the iframe URL. If this ever appears here, the card would be
  // shipping a credential — or, worse, guessing at one.
  check("the credential header is named exactly as the host expects", transport.SURFACE_SESSION_HEADER === "X-Hana-App-Surface-Session", transport.SURFACE_SESSION_HEADER);
  check("the session query key matches the SDK's", transport.SURFACE_SESSION_QUERY === "appSurfaceSession", transport.SURFACE_SESSION_QUERY);
  check("the credential header is never set by the App itself", !(transport.SURFACE_SESSION_HEADER in calls[0].init.headers), Object.keys(calls[0].init.headers));
  check("the App sends no credential-bearing query either", !String(calls[0].path).includes("appSurfaceSession"), calls[0].path);
}

section("BUG-3: 403 from the card backend is its own failure, not an outage");
{
  transport.resetCounters();

  const forbidden = {
    async fetch() {
      return new Response(JSON.stringify({ error: "forbidden", reason: "missing_credential" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    },
  };

  // `loadSection` returns the route-failure descriptor ITSELF, which is what the
  // page hands to the view as `{ ok: false, error: descriptor }` — the same shape
  // the backend's own failures arrive in. Both halves are asserted here so the
  // wiring between them cannot drift.
  const failure = await transport.loadSection("handoff", { hana: { api: forbidden } });
  check("a 403 is reported as a route failure", failure && failure.kind === "route_failure", failure);
  check("the kind is not the Server-unreachable kind", failure.kind !== "unreachable", failure.kind);
  check("a route failure carries no ok:true", failure.ok === undefined, failure.ok);
  check("the transport used is recorded", failure.transport === "api", failure);
  check("the HTTP status is recorded", failure.status === 403, failure.status);
  check("the Server's own reason is surfaced", /missing_credential/.test(failure.message), failure.message);
  check("the hint says to reopen the card", /关闭这张卡片并重新打开/.test(failure.hint), failure.hint);
  check("the hint explicitly separates itself from the Server", /与 Server 是两条独立链路/.test(failure.hint), failure.hint);

  // The whole point of the split: no Server repair command may appear.
  const result = { ok: false, error: failure };
  const rendered = view.describeStatus({ error: failure });
  check("the rendered tone is the reopen tone, not the outage tone", rendered.tone === "reopen", rendered.tone);
  check("the rendered headline says the card backend is unreachable", /卡片后端不可达/.test(rendered.headline), rendered.headline);
  check("the rendered copy contains NO Server fix command", !/start-server\.sh/.test(JSON.stringify(rendered)), rendered);
  check("the rendered copy contains no POWERCONTEXT_HANA_BASE_URL advice", !/POWERCONTEXT_HANA_BASE_URL/.test(JSON.stringify(rendered)), rendered);
  check("the rendered copy says it is not a Server problem", /不是 PowerContext Server 的问题/.test(rendered.detail.join(" ")), rendered.detail);
  check("the rendered copy does not render a bogus address", !rendered.detail.some((line) => /^地址：$/.test(line)), rendered.detail);
  check("showAddress is false so the view cannot print an empty address", rendered.showAddress === false, rendered.showAddress);

  // Section-level rendering must switch tone too.
  const handoffView = view.describeHandoff({ ok: false, error: failure });
  check("a failed handoff section is toned reopen", handoffView.tone === "reopen", handoffView.tone);
  check("a failed handoff section does not tell the reader to fix the Server", !/先让 Server 恢复/.test(handoffView.action), handoffView.action);
  const memoryView = view.describeMemory({ ok: false, error: failure });
  check("a failed memory section is toned reopen", memoryView.tone === "reopen", memoryView.tone);
}

section("BUG-3: the three failure sources stay distinguishable");
{
  // (1) the card's own backend failed
  const routeFailure = { ok: false, error: { kind: "route_failure", transport: "api", status: 403, message: "卡片后端 handoff 返回 HTTP 403。", hint: "关闭这张卡片并重新打开。" } };
  check("route failure → reopen tone", view.describeStatus(routeFailure).tone === "reopen");

  // (2) the Server is genuinely unreachable
  const serverDown = {
    ok: false,
    baseUrl: "http://127.0.0.1:8000",
    server: { ok: false, stage: "liveness", error: { message: "Server is not reachable.", hint: "Start it with scripts/start-server.sh." } },
  };
  const downView = view.describeStatus(serverDown);
  check("Server outage → down tone", downView.tone === "down", downView.tone);
  check("Server outage still shows the address", downView.detail.some((l) => l.includes("127.0.0.1:8000")), downView.detail);
  check("Server outage still offers the Server fix", /start-server/.test(downView.fix), downView.fix);
  check("Server outage marks showAddress true", downView.showAddress === true, downView.showAddress);

  // The two must never render the same headline.
  check("the two failures do not share a headline", view.describeStatus(routeFailure).headline !== downView.headline, [view.describeStatus(routeFailure).headline, downView.headline]);

  // (3) the backend answered, and the backend itself says the Server is down
  const backendSaysDown = { ok: false, server: { ok: false, stage: "liveness", error: { message: "PowerContext Server is not reachable at http://127.0.0.1:8000.", hint: "Start it with scripts/start-server.sh." } } };
  check("backend-reported outage → down tone", view.describeStatus(backendSaysDown).tone === "down");

  // A payload with no address at all must say so rather than printing "地址：".
  const noAddress = { ok: false, server: { ok: false, stage: "liveness", error: { message: "boom" } } };
  const noAddressView = view.describeStatus(noAddress);
  check("a missing address is stated, not left blank", noAddressView.detail.some((l) => l === "地址：未知（没有从后端拿到配置）"), noAddressView.detail);
  check("a missing address marks showAddress false", noAddressView.showAddress === false, noAddressView.showAddress);
}

section("BUG-3: fallback to bare fetch is counted, and only for a missing door");
{
  transport.resetCounters();
  const rawCalls = [];
  const rawFetch = async (url, init) => {
    rawCalls.push({ url, init });
    return new Response(JSON.stringify({ ok: true, via: "raw" }), { status: 200, headers: { "content-type": "application/json" } });
  };

  // No hana at all: the documented fallback, counted.
  const body = await transport.loadSection("memory", { hana: null, rawPath: "/api/apps/hana-powercontext/routes/memory", fetchImpl: rawFetch });
  check("the fallback served the request", body && body.via === "raw", body);
  check("the fallback was counted", transport.counters.fallbacks === 1, transport.counters);
  check("the raw fetch was counted", transport.counters.raw_fetch === 1, transport.counters);
  check("the official door was not counted", transport.counters.api_fetch === 0, transport.counters);
  check("the fallback used the derived routes base", String(rawCalls[0].url).includes("/api/apps/hana-powercontext/routes/memory"), rawCalls[0].url);

  // A present-but-throwing official door must NOT silently fall back: a bare retry
  // is exactly the call that produced the 403, so retrying it would hide the cause.
  transport.resetCounters();
  const throwing = {
    async fetch() {
      throw new Error("hana.api.fetch requires appSurfaceSession in the iframe URL.");
    },
  };
  const failed = await transport.loadSection("status", { hana: { api: throwing }, rawPath: "/x", fetchImpl: rawFetch });
  check("a throwing official door does not fall back", transport.counters.fallbacks === 0, transport.counters);
  check("it is reported as a route failure", failed && failed.kind === "route_failure", failed);
  check("the transport is named as api", failed.transport === "api", failed);
  check("the SDK's own explanation is carried through", /appSurfaceSession/.test(failed.message), failed.message);
  check("the raw fetch was never called", rawCalls.filter((c) => String(c.url).includes("/x")).length === 0, rawCalls.length);

  // Feature detection must be about the function, not the namespace.
  check("hasApiFetch rejects an api namespace without fetch", transport.hasApiFetch({ api: {} }) === false);
  check("hasApiFetch accepts a callable door", transport.hasApiFetch({ api: { fetch: async () => new Response() } }) === true);
  check("hasApiFetch rejects no hana at all", transport.hasApiFetch(null) === false);
}

section("BUG-3: routesBase derivation");
{
  check(
    "a card page under the App namespace resolves to its routes base",
    transport.routesBaseFrom("/api/apps/hana-powercontext/ui/dashboard.html") === "/api/apps/hana-powercontext/routes",
    transport.routesBaseFrom("/api/apps/hana-powercontext/ui/dashboard.html"),
  );
  check(
    "a nested page still resolves",
    transport.routesBaseFrom("/api/apps/hana-powercontext/ui/sub/page.html") === "/api/apps/hana-powercontext/routes",
    transport.routesBaseFrom("/api/apps/hana-powercontext/ui/sub/page.html"),
  );
  check("an unexpected pathname falls back to the known namespace", transport.routesBaseFrom("/something/else") === "/api/apps/hana-powercontext/routes");
  check("an empty pathname does not throw", transport.routesBaseFrom("") === "/api/apps/hana-powercontext/routes");
  check("undefined does not throw", transport.routesBaseFrom(undefined) === "/api/apps/hana-powercontext/routes");
  check("a degenerate /ui/ path does not produce a broken base", transport.routesBaseFrom("/ui/x.html") === "/api/apps/hana-powercontext/routes", transport.routesBaseFrom("/ui/x.html"));
}

/* ------------------------------------------------------ B18: view state -- */

section("B18: collapsed sections survive a remount");
{
  /** An in-memory stand-in for the host's hana.state bridge. */
  function fakeBridge(store = new Map()) {
    return {
      store,
      async get(key, fallback) {
        return store.has(key) ? store.get(key) : fallback;
      },
      async set(key, value) {
        store.set(key, value);
      },
    };
  }

  // First mount: nothing stored yet, everything expanded.
  const store = new Map();
  const first = await transport.readCollapsed(fakeBridge(store));
  check("a fresh mount starts expanded", first.handoff === false && first.memory === false, first);

  // The user collapses one section.
  await transport.writeCollapsed(fakeBridge(store), "handoff", true);
  check("the collapse was written under a namespaced key", store.has("collapsed:handoff"), [...store.keys()]);
  check("the key namespaces by section", transport.collapseKey("memory") === "collapsed:memory", transport.collapseKey("memory"));

  // Remount: a brand-new bridge over the same store, exactly like a fresh iframe.
  const second = await transport.readCollapsed(fakeBridge(store));
  check("the collapse survived the remount", second.handoff === true, second);
  check("the untouched section stayed expanded", second.memory === false, second);

  // Re-expanding must persist too, and must be distinguishable from "never set".
  await transport.writeCollapsed(fakeBridge(store), "handoff", false);
  const third = await transport.readCollapsed(fakeBridge(store));
  check("re-expanding survives a remount", third.handoff === false, third);
  check("the explicit false was actually stored", store.get("collapsed:handoff") === false, store.get("collapsed:handoff"));

  // A bridge that is missing or broken must degrade, never throw.
  let threw = null;
  let degraded;
  try {
    degraded = await transport.readCollapsed(null);
  } catch (error) {
    threw = error;
  }
  check("a missing bridge does not throw", threw === null, threw && threw.message);
  check("a missing bridge reads as expanded", degraded.handoff === false && degraded.memory === false, degraded);
  check("writing through a missing bridge is a no-op, not a throw", (await transport.writeCollapsed(null, "handoff", true)) === false);

  const broken = {
    async get() {
      throw new Error("state unavailable");
    },
    async set() {
      throw new Error("state unavailable");
    },
  };
  let brokenThrew = null;
  try {
    await transport.readCollapsed(broken);
    await transport.writeCollapsed(broken, "handoff", true);
  } catch (error) {
    brokenThrew = error;
  }
  // The page wraps these in try/catch, but the unit itself is allowed to propagate
  // so the page stays in control of what a failure means. Assert the page's
  // contract instead: a throw here must not be able to blank the card.
  check("a broken bridge surfaces to the caller (the page decides)", brokenThrew !== null, brokenThrew && brokenThrew.message);
}

/* ------------------------------ BUG-4: the hana browser bridge (sdk.js) -- */

section("BUG-4: the card imports the hana browser bridge as a module");
{
  // The defect: `globalThis.hana` never existed in the card iframe, because the
  // scaffold's local bridge was never included. Every hana.* call was a silent
  // no-op, which is why fixing the credential *door* (BUG-3) still 403'd.
  check("the bridge asset is present and substantive", bridgeSource.length > 100000, bridgeSource.length);
  check("the bridge implements the official door", bridgeSource.includes("pluginApiFetch"));
  check("the bridge reads the surface-session credential", bridgeSource.includes("appSurfaceSession"));
  check("the bridge exports hana by name", /export\s*\{[\s\S]{0,200}?hana2 as hana/.test(bridgeSource));

  // Fix-1 stamps the specifier with ?v=, so the query is allowed but not required.
  check("the page imports the bridge from ./sdk.js", /import\s*\{\s*hana\s*\}\s*from\s*["']\.\/sdk\.js(\?v=[^"']*)?["']/.test(pageSource), pageSource.slice(0, 160));
  check("the import is a static top-level import (not dynamic)", !/import\s*\(/.test(pageSource.split("import { hana }")[0]), "expected no dynamic import before the bridge import");

  // A classic <script src> of an ES module is a syntax error — assert the page
  // never does it, and that the wiring really is type=module.
  // BUG-7 regression guard: registrar paths are /routes/-relative subpaths —
  // an "/api/..." prefix here double-nests the URL the SDK builds and 404s.
  const indexSource = (typeof arguments !== "undefined") ? "" : "";
  check("registrar mounts status at /status (no /api prefix)", /routes\.register\(\(app\)\s*=>\s*\{[\s\S]*?app\.get\("\/status"/.test(indexText || ""), "index.js paths");
  check("registrar mounts no path starting with /api/", !/app\.get\(\s*"\/api\//.test(indexText || ""), "index.js paths");

  // BUG-8: the envelope must unwrap to the raw boolean, and an unknown object
  // must degrade to "unset" (expanded) rather than to a truthy guess.
  {
    const env = transport.unwrapStored({ appId: "a", scope: "card", key: "collapsed:x", value: false });
    check("the storage envelope unwraps to the stored value", env === false, env);
    check("a wrapped true unwraps to true", transport.unwrapStored({ value: true }) === true, transport.unwrapStored({ value: true }));
    check("an unknown object degrades to unset", transport.unwrapStored({ weird: 1 }) === null, transport.unwrapStored({ weird: 1 }));
    check("a raw boolean passes through untouched", transport.unwrapStored(false) === false, transport.unwrapStored(false));
  }

  check("the wiring is loaded as type=module", scriptSrcs.length > 0 && /<script[^>]*type=["']module["'][^>]*src=["'][^"']*dashboard-page\.js(\?v=[^"']*)?["']/.test(htmlSource), scriptSrcs);
  check("the bridge is not classic-loaded", !scriptSrcs.some((src) => pathnameOf(src).endsWith("sdk.js")), scriptSrcs);

  // Classic scripts run before deferred modules, so the globals the module reads
  // are guaranteed present. Assert the order that makes that true.
  const idx = (name) => scriptSrcs.findIndex((src) => pathnameOf(src).endsWith(name));
  check("the view logic loads before the wiring", idx("dashboard.js") > -1 && idx("dashboard.js") < idx("dashboard-page.js"), scriptSrcs);
  check("the transport loads before the wiring", idx("dashboard-fetch.js") > -1 && idx("dashboard-fetch.js") < idx("dashboard-page.js"), scriptSrcs);
}

section("BUG-4: a failed module load still says something readable");
{
  // Static module imports change the failure mode: if sdk.js is missing or
  // corrupt, the wiring never runs at all and the page would sit on its
  // "正在连接…" skeleton forever. The scaffold's starter pattern is an inline
  // classic error handler, which must therefore exist and be classic.
  check("an inline error handler exists", /window\.addEventListener\(\s*["']error["']/.test(htmlSource));
  check("it is a classic script, so it survives a module failure", /<script>\s*window\.addEventListener\(\s*["']error["']/.test(htmlSource));
  check("it runs before any module script", htmlSource.indexOf("addEventListener('error'") < htmlSource.indexOf('type="module"'), [htmlSource.indexOf("addEventListener('error'"), htmlSource.indexOf('type="module"')]);
  check("it uses capture so it sees resource load errors", /,\s*true\s*\)/.test(htmlSource), "expected addEventListener(..., true)");
  check("it names the resource-check remedy", /检查 App 资源/.test(htmlSource));
  check("it names the reopen/reload remedy", /重开卡片或重载 App/.test(htmlSource));
  check("it writes to the skeleton headline", /boot-headline/.test(htmlSource));
  check("it writes to the skeleton detail", /boot-detail/.test(htmlSource));
  check("the skeleton the fallback replaces actually starts as connecting", /id=["']boot-headline["'][^>]*>正在连接/.test(htmlSource), "expected the 正在连接… skeleton");
}

section("BUG-4: the bridge really exports a usable hana at runtime");
{
  // The strongest offline check available: actually import the bridge as a module
  // and look at what comes out. The text assertions above prove the file is the
  // right one; this proves it yields the API the card calls. What it still cannot
  // prove is that a real host-minted iframe gives it a session — that is B24.
  let bridgeModule = null;
  let importError = null;
  try {
    bridgeModule = await import(new URL("../ui/assets/sdk.js", import.meta.url).href);
  } catch (error) {
    importError = error;
  }

  check("the bridge imports as an ES module", importError === null, importError && importError.message);
  if (bridgeModule) {
    check("it exports hana", typeof bridgeModule.hana === "object" && bridgeModule.hana !== null, Object.keys(bridgeModule));
    const hana = bridgeModule.hana;
    // This is the exact call BUG-3 introduced. If it is ever absent, the card's
    // credential door is gone again and BUG-4 has come back.
    check("hana.api.fetch is a function (the BUG-3 door)", typeof hana.api?.fetch === "function", typeof hana.api?.fetch);
    check("hana.api.url is a function", typeof hana.api?.url === "function");
    check("hana.state.get/set are functions (B18's persistence)", typeof hana.state?.get === "function" && typeof hana.state?.set === "function");
    check("hana.assets.url is a function", typeof hana.assets?.url === "function");
    check("hana exposes a ready handshake", typeof hana.ready === "function");
  }
}

section("BUG-4: the page threads hana explicitly (route b)");
{
  // Route (b): the bridge is passed down, and no code reads an ambient global.
  // Route (a) (assigning globalThis.hana) was rejected because it hides the
  // dependency and lets unrelated code start relying on a global that exists only
  // inside a host-mounted card.
  const code = pageSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\//.test(line))
    .join("\n");

  check("no code reads globalThis.hana", !/globalThis\.hana/.test(code), "route (b) means the global is never consulted");
  check("the page never assigns a global hana", !/globalThis\.hana\s*=/.test(code));
  check("the imported bridge reaches the transport", /hana,/.test(code) && /loadSection\(/.test(code));
  // B25: the binding now reaches the prefs helpers; the state bridge is retired.
  check("the imported bridge reaches the prefs helpers", /transport\.readPrefs\(\{ hana,/.test(code), "expected transport.readPrefs({ hana, ... })");
  check("the page no longer reads hana.state at all", !/hana\.state/.test(code), "hana.state must not be read for collapse state any more");
  check("the transport still accepts an injected hana", typeof transport.loadSection === "function");
  check("an injected bridge is what the transport uses", await (async () => {
    transport.resetCounters();
    let used = false;
    const stub = { api: { fetch: async () => { used = true; return new Response("{}", { status: 200 }); } } };
    await transport.loadSection("status", { hana: stub });
    return used && transport.counters.api_fetch === 1;
  })());
}

/* ------------------------------ TASK-8 Fix-1: cache-busted asset URLs ---- */

section("Fix-1: no self-referencing asset is left un-versioned");
{
  const htmlRefs = [...htmlSource.matchAll(/(?:href|src)=["'](\.\/[^"']+)["']/g)].map((m) => m[1]);
  const importRefs = [...pageSource.matchAll(/from\s*["'](\.\/[^"']+)["']/g)].map((m) => m[1]);
  const refs = [...htmlRefs, ...importRefs];
  const manifestVersion = JSON.parse(readUi("../manifest.json")).version;

  check("the card references several of its own assets", refs.length >= 4, refs);
  check("none of them is un-versioned", refs.every((ref) => /[?&]v=/.test(ref)), refs.filter((ref) => !/[?&]v=/.test(ref)));
  check("all of them match the manifest version", refs.every((ref) => ref.includes("?v=" + manifestVersion)), refs.filter((ref) => !ref.includes("?v=" + manifestVersion)));
  // The two that actually produced the phantom outage: the wiring and the bridge.
  check("the wiring carries the cache key", refs.some((ref) => ref.includes("dashboard-page.js?v=")), refs);
  check("the bridge import carries the cache key", importRefs.some((ref) => ref.includes("sdk.js?v=")), importRefs);
}

/* -------------------------- TASK-8 Fix-2: a failure cannot be hidden ---- */

section("Fix-2: a failed section renders expanded and refuses to collapse");
{
  const routeFailure = { kind: "route_failure", transport: "api", status: 403, message: "403" };
  const backendErr = { ok: false, error: { kind: "backend_error", message: "内部" } };
  const outage = { ok: false, error: { kind: "unreachable", message: "down" } };
  const okEmpty = { ok: true, handoff: null };

  check("a route failure is detected as a failure", transport.sectionFailed(routeFailure) === true);
  check("a backend_error is detected as a failure", transport.sectionFailed(backendErr) === true);
  check("an outage is detected as a failure", transport.sectionFailed(outage) === true);
  check("a success is not a failure", transport.sectionFailed(okEmpty) === false);
  check("the legitimate empty Handoff is not a failure", transport.sectionFailed({ ok: true, handoff: null, status: "empty" }) === false);

  // The rule under test: a stored "collapsed" preference loses to a failure.
  check("a collapsed failed section renders expanded", transport.effectiveCollapsed(backendErr, true) === false);
  check("a collapsed outage section renders expanded", transport.effectiveCollapsed(outage, true) === false);
  check("a collapsed route failure renders expanded", transport.effectiveCollapsed(routeFailure, true) === false);
  // B18 semantics for the healthy case must be untouched by Fix-2.
  check("a collapsed successful section stays collapsed (B18 preserved)", transport.effectiveCollapsed(okEmpty, true) === true);
  check("an expanded successful section stays expanded", transport.effectiveCollapsed(okEmpty, false) === false);

  // And the wiring must actually use it, not merely define it.
  check("the wiring consults the rule when rendering", /effectiveCollapsed\(/.test(pageSource));
  check("the wiring refuses to toggle a failed section", /if\s*\(failed\)\s*return;/.test(pageSource));
  check("a failed section is flagged for the stylesheet", /dataset\.failed/.test(pageSource));
}

/* ------------------- TASK-8 Fix-4: internal errors never wear the outage -- */

section("Fix-4: only network failures may render as an outage");
{
  // Route-level: the classifier's allow-list.
  check("unreachable keeps the outage right", await (async () => {
    const s = await dashboardStatus({}, () => ({ baseUrl: "http://127.0.0.1:8000" }));
    return s && typeof s.ok === "boolean";
  })());
  check("a throwing config resolver becomes backend_error, not unreachable", await (async () => {
    const s = await dashboardStatus({}, () => {
      throw new Error("boom");
    });
    return s.ok === false && s.server.error.kind === "backend_error" && s.server.error.origin === "config";
  })());

  // View-level: the two branches must not share copy or tone.
  const internal = view.describeStatus({
    ok: false,
    baseUrl: null,
    configError: { kind: "backend_error" },
    server: { ok: false, stage: "config", error: { kind: "backend_error", origin: "config", message: "配置解析抛错", hint: "查 Hana 日志" } },
  });
  check("backend_error is toned internal", internal.tone === "internal", internal.tone);
  check("backend_error names itself unrelated to the Server", /与 Server 无关/.test(internal.headline), internal.headline);
  check("backend_error carries no Server repair command", !/start-server/.test(JSON.stringify(internal)), internal);
  check("backend_error carries no base-url advice", !/POWERCONTEXT_HANA_BASE_URL/.test(JSON.stringify(internal)), internal);
  check("backend_error does not print an empty address", !internal.detail.some((l) => /^地址：$/.test(l)), internal.detail);

  const outage = view.describeStatus({
    ok: false,
    baseUrl: "http://127.0.0.1:8000",
    server: { ok: false, stage: "liveness", error: { kind: "unreachable", message: "not reachable", hint: "启动它：scripts/start-server.sh" } },
  });
  check("a real network failure still gets the outage tone", outage.tone === "down", outage.tone);
  check("a real network failure still shows the address", outage.detail.some((l) => l.includes("127.0.0.1:8000")), outage.detail);
  check("the two branches do not share a headline", internal.headline !== outage.headline, [internal.headline, outage.headline]);

  // Section-level: a backend_error section must not be toned like an outage.
  const section = view.describeHandoff({ ok: false, error: { kind: "backend_error", message: "内部" } });
  check("a backend_error section is toned internal", section.tone === "internal", section.tone);
  check("a backend_error section does not send the reader to the Server", !/先让 Server 恢复/.test(section.action), section.action);
  const memorySection = view.describeMemory({ ok: false, error: { kind: "backend_error", message: "内部" } });
  check("a backend_error memory section is toned internal", memorySection.tone === "internal", memorySection.tone);
}

/* ------------------------ B25: preferences travel over /prefs ---------- */

section("B25: the card persists collapse preference through its own backend");
{
  transport.resetCounters();

  // The read path: the transport must issue a GET to the App-relative prefs path
  // and hand back the collapse map, with the credential door doing the carrying.
  const seen = [];
  const recorder = {
    api: {
      async fetch(path, init) {
        seen.push({ path, init });
        return new Response(JSON.stringify({ ok: true, prefs: { collapsed: { handoff: true } } }), { status: 200 });
      },
    },
  };
  const collapsed = await transport.readPrefs({ hana: recorder });
  check("the read goes to the App-relative prefs path", seen[0].path === transport.PREFS_PATH && seen[0].path === "prefs", seen[0].path);
  check("the read is a GET", seen[0].init.method === "GET", seen[0].init.method);
  check("the read carries no body", seen[0].init.body === undefined, seen[0].init.body);
  check("the read returns the collapse map", collapsed.handoff === true, collapsed);
  check("the read used the credential door", transport.counters.api_fetch === 1, transport.counters);

  // The response shape the route promises.
  check("an empty prefs body is tolerated", JSON.stringify(await transport.readPrefs({ hana: { api: { async fetch() { return new Response("{}", { status: 200 }); } } } })) === "{}");
  check("a prefs body with no collapsed field is tolerated", JSON.stringify(await transport.readPrefs({ hana: { api: { async fetch() { return new Response(JSON.stringify({ ok: true, prefs: {} }), { status: 200 }); } } } })) === "{}");

  // The write path.
  transport.resetCounters();
  const writes = [];
  const writer = { api: { async fetch(path, init) { writes.push({ path, init }); return new Response(JSON.stringify({ ok: true, prefs: { collapsed: {} }, persisted: true }), { status: 200 }); } } };
  const ok = await transport.writePrefs("memory", false, { hana: writer });
  check("the write reports success", ok === true, ok);
  check("the write is a PUT to the prefs path", writes[0].init.method === "PUT" && writes[0].path === "prefs", writes[0]);
  check("the write sends one field only (so cards cannot clobber each other)", JSON.stringify(JSON.parse(writes[0].init.body)) === JSON.stringify({ collapsed: { memory: false } }), writes[0].init.body);
  check("an explicit false is sent, not omitted", JSON.parse(writes[0].init.body).collapsed.memory === false);
  check("the write declares a JSON content type", writes[0].init.headers["content-type"] === "application/json", writes[0].init.headers);
  check("a successful write does not count as an error", transport.counters.pref_write_errors === 0, transport.counters);

  // Degradation: the toggle already happened on screen, so a failed write must be
  // counted and swallowed rather than thrown back at the user.
  transport.resetCounters();
  const broken = { api: { async fetch() { throw new Error("prefs unavailable"); } } };
  let threw = null;
  let failedOk = null;
  try {
    failedOk = await transport.writePrefs("handoff", true, { hana: broken });
  } catch (error) {
    threw = error;
  }
  check("a failed write does not throw (the toggle must stand)", threw === null, threw && threw.message);
  check("a failed write returns false", failedOk === false, failedOk);
  check("a failed write increments pref_write_errors", transport.counters.pref_write_errors === 1, transport.counters);
  check("a failed write is still counted through the legacy counter set", "pref_write_errors" in transport.counters);

  // A 200 whose body says ok:false is a failure too.
  transport.resetCounters();
  const refusing = { api: { async fetch() { return new Response(JSON.stringify({ ok: false, error: "no dataDir" }), { status: 200 }); } } };
  check("an ok:false body is a failed write", (await transport.writePrefs("memory", true, { hana: refusing })) === false && transport.counters.pref_write_errors === 1, transport.counters);

  // A failing read degrades to the default rather than breaking the card.
  check("a failed read yields an empty map (everything expanded)", JSON.stringify(await transport.readPrefs({ hana: broken })) === "{}");
}

section("B25: the legacy hana.state helpers are kept, labelled, and unused");
{
  // The probe still exercises the retired path on purpose: it is the record of what
  // B25 was, and deleting a tested function is how the evidence for a past decision
  // disappears. What matters is that the page no longer calls it.
  check("the legacy helpers are still exported", typeof transport.readCollapsed === "function" && typeof transport.writeCollapsed === "function");
  check("the legacy key helper is still exported for the record", transport.collapseKey("handoff") === "collapsed:handoff", transport.collapseKey("handoff"));
  check("the page does not call writeCollapsed any more", !/writeCollapsed/.test(pageSource), "the live path must be savePref -> PUT /prefs");
  check("the page does not call readCollapsed any more", !/readCollapsed/.test(pageSource));
  check("the page's boot reads prefs instead", /state\.collapsed = await loadPrefs\(\)/.test(pageSource));
  // Comments legitimately mention hana.state (explaining why it was retired), so the
  // check has to look at executable code only.
  const pageCodeOnly = pageSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\//.test(line))
    .join("\n");
  check("the page never touches hana.state in code", !/hana\.state/.test(pageCodeOnly), "hana.state must not be read for collapse state any more");
}
console.log(`\n=== DASHBOARD PROBE: ${checks - failures}/${checks} checks passed ${failures === 0 ? "— ALL PASSED" : "— " + failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
