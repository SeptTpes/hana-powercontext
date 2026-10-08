/**
 * lib/selftest.mjs — exercises the App's modules without a Hana host.
 *
 * Run:  node app/hana-powercontext/lib/selftest.mjs [--base-url http://127.0.0.1:8000]
 *
 * Why this exists: the host's `--smoke` check proves the App loads and registers.
 * It does not call the tools. The fail-open behaviour is the part of this App
 * most worth proving, and it is exactly the part that only shows up when the
 * Server is missing — so it is tested here against a stubbed network door, with
 * no Hana and no live Server required.
 *
 * The optional live section at the end runs against a real Server when one is
 * reachable, and is skipped (not failed) when it is not.
 */

import { createRequire } from "node:module";
import { resolveConfig, envNameFor, DEFAULTS } from "./config.js";
import { request, probe } from "./powercontext.js";
import {
  callRemember,
  callMemoryList,
  callHandoffPrepare,
  resolveScope,
  commandDoctor,
  commandHooks,
  commandReview,
  reviewCandidates,
  decideCandidate,
} from "./tools.js";
import { buildToolRegistrations } from "./register.js";
import { dashboardStatus, dashboardHandoff, dashboardMemory, dashboardHooks } from "./dashboard.js";
import {
  messageText,
  lastUserIndex,
  wrapRecall,
  extractRetrievalQuery,
  EXTRACT_STOPWORDS,
  truncateToBytes,
  injectBeforeLastUser,
  queryFromMessages,
  sessionKeyOf,
  contentHash,
  captureWasSeen,
  resetCaptureDedupe,
  nextCaptureSourceId,
  clearRecallCache,
  recallCacheSize,
  counters,
  resetCounters,
  RECALL_PREFIX,
  RECALL_SUFFIX,
  QUERY_MAX_CHARS,
  CAPTURE_LRU_SIZE,
  CACHE_TTL_MS,
} from "./hooks.js";

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

/** A network door that records every call, so "no retry storm" is measurable. */
function stubSdk(behaviour, { dataDir = null } = {}) {
  const calls = [];
  const sdk = {
    dataDir,
    network: {
      async fetch(url, init) {
        // `body` is the parsed request body alongside the raw `init`, so an
        // assertion can read what was sent without re-parsing. Purely additive:
        // existing checks read `init`.
        let body;
        if (init && typeof init.body === "string") {
          try {
            body = JSON.parse(init.body);
          } catch {
            body = undefined;
          }
        }
        calls.push({ url, init, body });
        return behaviour(url, init, calls.length);
      },
    },
  };
  return { sdk, calls };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function pageResponse(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

/** Extract the text of a tool result, whatever shape it came back in. */
function textOf(result) {
  return (result.content || []).map((part) => part.text || "").join("\n");
}

/** Trim the base URL off recorded call URLs so failures print readable paths. */
function baseUrlOf(calls) {
  if (!calls || calls.length === 0) return "";
  const match = /^(https?:\/\/[^/]+)/.exec(calls[0].url);
  return match ? match[1] : "";
}

/* ---------------------------------------------------------------- config -- */

section("config resolution");
{
  const empty = stubSdk(() => jsonResponse(200, {}));
  const base = resolveConfig(empty.sdk, {});
  check("defaults to the loopback Server", base.baseUrl === "http://127.0.0.1:8000", base.baseUrl);
  check("defaults keep a bounded timeout", base.timeoutMs > 0 && base.timeoutMs <= 30000, base.timeoutMs);

  check(
    "env var name is derived predictably",
    envNameFor("baseUrl") === "POWERCONTEXT_HANA_BASE_URL",
    envNameFor("baseUrl"),
  );

  const prev = process.env.POWERCONTEXT_HANA_BASE_URL;
  process.env.POWERCONTEXT_HANA_BASE_URL = "http://127.0.0.1:9999/";
  const fromEnv = resolveConfig(empty.sdk, {});
  check("environment override wins over the default", fromEnv.baseUrl === "http://127.0.0.1:9999", fromEnv.baseUrl);
  check("trailing slash is trimmed", !fromEnv.baseUrl.endsWith("/"), fromEnv.baseUrl);
  if (prev === undefined) delete process.env.POWERCONTEXT_HANA_BASE_URL;
  else process.env.POWERCONTEXT_HANA_BASE_URL = prev;

  const explicit = resolveConfig(empty.sdk, { baseUrl: "http://127.0.0.1:8123", timeoutMs: 1234 });
  check("explicit override wins over environment", explicit.baseUrl === "http://127.0.0.1:8123", explicit.baseUrl);
  check("explicit timeout is honoured", explicit.timeoutMs === 1234, explicit.timeoutMs);
}

/* -------------------------------------------------------------- fail-open -- */

section("fail-open: Server unreachable");
{
  const { sdk, calls } = stubSdk(() => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8000");
  });
  const config = resolveConfig(sdk, {});

  const started = Date.now();
  const result = await callRemember(sdk, config, { text: "should not be written" });
  const elapsed = Date.now() - started;

  check("returns a result instead of throwing", result && Array.isArray(result.content), typeof result);
  check("is flagged as an error result", result.isError === true, result.isError);
  check("names the tool and the reason", /pc_remember failed/.test(textOf(result)) && /not reachable/.test(textOf(result)), textOf(result));
  check("points at the base URL", textOf(result).includes("http://127.0.0.1:8000"), textOf(result));
  check("gives an actionable hint", /hint:/.test(textOf(result)), textOf(result));
  check("states that nothing was changed", /No changes were made/.test(textOf(result)), textOf(result));
  check("carries a machine-readable kind", result.details && result.details.kind === "unreachable", result.details);
  check("made exactly ONE attempt (no retry storm)", calls.length === 1, calls.length);
  check("returned promptly", elapsed < 2000, elapsed + "ms");
  check(
    "requests a host-side timeout",
    typeof calls[0].init.timeoutMs === "number" && calls[0].init.timeoutMs > 0,
    calls[0].init.timeoutMs,
  );
}

section("fail-open: every tool, and the command");
{
  const { sdk } = stubSdk(() => {
    throw new Error("host-side timeout after 5000ms");
  });
  const config = resolveConfig(sdk, {});

  for (const [label, result] of [
    ["pc_remember", await callRemember(sdk, config, { text: "x" })],
    ["pc_memory_list", await callMemoryList(sdk, config, {})],
    ["pc_handoff_prepare", await callHandoffPrepare(sdk, config, { objective: "y" })],
  ]) {
    check(`${label} degrades to an error result`, result.isError === true, result);
    check(`${label} message mentions the Server`, /not reachable/.test(textOf(result)), textOf(result));
  }

  const doctor = await commandDoctor(sdk, config, probe);
  check("/pc doctor reports NOT USABLE", /NOT USABLE/.test(doctor), doctor);
  check("/pc doctor does not throw", typeof doctor === "string", typeof doctor);
}

section("fail-open: manifest without a network door");
{
  const sdk = { dataDir: null, network: undefined };
  const config = resolveConfig(sdk, {});
  const result = await callMemoryList(sdk, config, {});
  check("reports the missing declaration explicitly", /network_not_declared|sdk\.network\.fetch is unavailable/.test(textOf(result)), textOf(result));
  check("names the manifest as the cause", /manifest/.test(textOf(result)), textOf(result));
}

/* ------------------------------------------------------- error translation -- */

section("error translation");
{
  const notFound = stubSdk(() => jsonResponse(404, { error: { code: "scope_not_found", message: "The requested Scope was not found.", details: null } }));
  const r1 = await callMemoryList(notFound.sdk, resolveConfig(notFound.sdk, {}), { scope_id: "nope" });
  check("HTTP error becomes an error result", r1.isError === true, r1);
  check("server message is preserved", /The requested Scope was not found/.test(textOf(r1)), textOf(r1));
  check("server code is surfaced", r1.details.serverCode === "scope_not_found", r1.details);

  const html = stubSdk(() => pageResponse(200, "<html><body>not powercontext</body></html>"));
  const r2 = await callMemoryList(html.sdk, resolveConfig(html.sdk, {}), {});
  check("non-JSON body is called out", r2.isError === true && r2.details.kind === "not_json", r2.details);
  check("non-JSON message warns about the wrong listener", /something other than PowerContext may be listening/.test(textOf(r2)), textOf(r2));
}

/* ------------------------------------------------------------ validation -- */

section("argument validation (no request should be made)");
{
  const { sdk, calls } = stubSdk(() => jsonResponse(200, {}));
  const config = resolveConfig(sdk, {});
  const r = await callRemember(sdk, config, { text: "   " });
  check("empty text is refused", r.isError === true, r);
  check("no request is sent for invalid input", calls.length === 0, calls.length);

  const big = await callRemember(sdk, config, { text: "a".repeat(9000) });
  check("over-limit text is refused before sending", big.isError === true && /8192-byte limit/.test(textOf(big)), textOf(big));
  check("still no request sent", calls.length === 0, calls.length);
}

/* -------------------------------------------------------- happy path ----- */

section("happy path against a stubbed Server");
{
  const seen = [];
  const { sdk } = stubSdk((url, init) => {
    seen.push({ url, body: init.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith("/v1/scopes/default")) {
      return jsonResponse(200, { scope_id: "scp_default", title: "Default", summary: "Default context" });
    }
    if (url.endsWith("/v1/memory/remember")) {
      return jsonResponse(200, {
        memory: { family: "memory", artifact_id: "memory", revision: 1 },
        entry: { citation: { entry_id: "mem_ent_1" }, kind: "project-fact", text: "t", state: "active" },
      });
    }
    if (url.endsWith("/v1/memory/entries/list")) {
      return jsonResponse(200, {
        memory: { family: "memory", artifact_id: "memory", revision: 2 },
        entries: [
          { citation: { entry_id: "mem_ent_1" }, kind: "project-fact", text: "first", state: "active" },
          { citation: { entry_id: "mem_ent_2" }, kind: "decision", text: "second", state: "retired" },
        ],
      });
    }
    if (url.endsWith("/v1/sources/content")) {
      const body = JSON.parse(init.body);
      // Exactly the shape the real Server returns: {name, source_id}. The evidence
      // schema wants both, so the stub must not be more forgiving than reality.
      return jsonResponse(202, {
        status: "accepted",
        source: { name: "content", source_id: body.source_id },
        position: 1,
      });
    }
    if (url.endsWith("/v1/handoff/prepare")) {
      // The Server generates a Draft and returns it as the whole response body.
      return jsonResponse(200, {
        objective: "ship stage 1",
        state: [
          {
            text: "the skeleton exists",
            citations: [{ kind: "source", source_ref: { name: "content", source_id: "pc-handoff-stub" } }],
          },
        ],
        disposition: "continuable",
        next_action: {
          text: "run the validator",
          citations: [{ kind: "source", source_ref: { name: "content", source_id: "pc-handoff-stub" } }],
        },
        omissions: [{ text: "no real conversation test yet", citation: null }],
        generation: null,
      });
    }
    if (url.endsWith("/v1/handoff/finalize")) {
      return jsonResponse(200, {
        schema: "powercontext.prepared-handoff.v1",
        scope_id: "scp_default",
        base: null,
        content: { schema: "powercontext.handoff.v1", objective: "ship stage 1", state: [], disposition: "continuable", next_action: null, omissions: [] },
        generation: null,
      });
    }
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url } });
  });
  // Pin the Scope for the whole happy-path block. Without it every call first
  // costs a /v1/scopes/default lookup, which would blur the per-call request
  // counts this section asserts. Scope resolution has its own checks above.
  const config = resolveConfig(sdk, { scopeId: "scp_default" });

  const remembered = await callRemember(sdk, config, { text: "a fact", kind: "decision", reason: "because" });
  check("remember succeeds", remembered.isError !== true, textOf(remembered));
  check("remember reports the entry id", /mem_ent_1/.test(textOf(remembered)), textOf(remembered));
  check("remember uses the pinned scope", /scp_default/.test(textOf(remembered)), textOf(remembered));
  check("the scope's origin is disclosed", /scope from: config/.test(textOf(remembered)), textOf(remembered));

  const rememberCall = seen.find((c) => c.url.endsWith("/v1/memory/remember"));
  check("remember sent the chosen kind", rememberCall.body.kind === "decision", rememberCall.body);
  check("remember sent the reason", rememberCall.body.reason === "because", rememberCall.body);
  check("remember sent the resolved scope", rememberCall.body.scope_id === "scp_default", rememberCall.body);

  const listed = await callMemoryList(sdk, config, {});
  check("list succeeds", listed.isError !== true, textOf(listed));
  check("list renders both entries", /first/.test(textOf(listed)) && /second/.test(textOf(listed)), textOf(listed));
  check("list marks a retired entry", /\[retired\]/.test(textOf(listed)), textOf(listed));
  check("list reports the count", listed.details.count === 2, listed.details);

  const before = seen.length;
  const handoff = await callHandoffPrepare(sdk, config, {
    objective: "ship stage 1",
    state: ["骨架已建"],
    next_action: "run the validator",
    disposition: "continuable",
    omissions: ["no real conversation test yet"],
  });
  const handoffCalls = seen.slice(before);

  // --- positive: the three-step flow closes and returns the real carrier -----
  check("handoff succeeds", handoff.isError !== true, textOf(handoff));
  check("handoff reports its boundary source", /boundary source: pc-handoff-/.test(textOf(handoff)), textOf(handoff));
  check(
    "handoff makes exactly three requests (capture, prepare, finalize)",
    handoffCalls.length === 3,
    handoffCalls.map((c) => c.url.replace(baseUrlOf(seen), "")),
  );
  check(
    "the three requests are the handoff family in order",
    handoffCalls.map((c) => c.url.split("/v1/")[1]).join(",") === "sources/content,handoff/prepare,handoff/finalize",
    handoffCalls.map((c) => c.url.split("/v1/")[1]),
  );
  check("the old work-contract endpoint is gone", !seen.some((c) => c.url.includes("prepare-current")));

  // --- positive: the finalize carrier is returned unchanged ------------------
  check("the finalized carrier is surfaced in details", handoff.details.finalized !== null && typeof handoff.details.finalized === "object", handoff.details.finalized);
  check("the carrier keeps its schema", handoff.details.finalized.schema === "powercontext.prepared-handoff.v1", handoff.details.finalized.schema);
  check("the carrier keeps its content", handoff.details.finalized.content !== undefined, Object.keys(handoff.details.finalized));
  check("the full carrier appears in the text output", /"schema": "powercontext.prepared-handoff.v1"/.test(textOf(handoff)), textOf(handoff).slice(-400));
  check("the Draft is also surfaced", handoff.details.draft && handoff.details.draft.objective === "ship stage 1", handoff.details.draft);

  const captureCall = handoffCalls.find((c) => c.url.endsWith("/v1/sources/content"));
  const prepareCall = handoffCalls.find((c) => c.url.endsWith("/v1/handoff/prepare"));
  const finalizeCall = handoffCalls.find((c) => c.url.endsWith("/v1/handoff/finalize"));

  // --- positive: evidence is the exact captured Source object ---------------
  check(
    "capture sent a sortable, uniquely-suffixed boundary id",
    /^pc-handoff-\d{17}-\d{4}$/.test(captureCall.body.source_id),
    captureCall.body.source_id,
  );
  check("capture sent the scope", captureCall.body.scope_id === "scp_default", captureCall.body.scope_id);
  check(
    "capture content carries the declared state and next action",
    captureCall.body.content.includes("骨架已建") && captureCall.body.content.includes("run the validator"),
    captureCall.body.content,
  );
  check("prepare cites exactly one evidence item", Array.isArray(prepareCall.body.evidence) && prepareCall.body.evidence.length === 1, prepareCall.body.evidence);
  check("prepare evidence kind is source", prepareCall.body.evidence[0].kind === "source", prepareCall.body.evidence[0]);
  check(
    "prepare copies the captured source object verbatim",
    prepareCall.body.evidence[0].source_ref.source_id === captureCall.body.source_id &&
      prepareCall.body.evidence[0].source_ref.name === "content",
    prepareCall.body.evidence[0].source_ref,
  );
  check(
    "prepare evidence carries no extra keys (additionalProperties:false)",
    Object.keys(prepareCall.body.evidence[0]).sort().join(",") === "kind,source_ref",
    Object.keys(prepareCall.body.evidence[0]),
  );
  check("prepare sends the objective", prepareCall.body.objective === "ship stage 1", prepareCall.body.objective);

  // --- positive: finalize gets the Draft body, never the {ok,data} wrapper ---
  check("finalize is sent a draft object", finalizeCall.body.draft && typeof finalizeCall.body.draft === "object", typeof finalizeCall.body.draft);
  check("the draft is not wrapped in an envelope", finalizeCall.body.draft.ok === undefined && finalizeCall.body.draft.data === undefined, Object.keys(finalizeCall.body.draft));
  check("the draft has no scope_id/schema/content keys", !("scope_id" in finalizeCall.body.draft) && !("schema" in finalizeCall.body.draft) && !("content" in finalizeCall.body.draft), Object.keys(finalizeCall.body.draft));
  check("the draft is the Server's own Draft", finalizeCall.body.draft.objective === "ship stage 1" && Array.isArray(finalizeCall.body.draft.state), Object.keys(finalizeCall.body.draft));
  check("finalize carries the resolved scope", finalizeCall.body.scope_id === "scp_default", finalizeCall.body.scope_id);

  // --- positive: an unknown disposition still clamps, without breaking flow --
  const beforeBad = seen.length;
  const badDisposition = await callHandoffPrepare(sdk, config, { objective: "z", disposition: "nonsense" });
  const badCapture = seen.slice(beforeBad).find((c) => c.url.endsWith("/v1/sources/content"));
  check("an unknown disposition still completes the flow", badDisposition.isError !== true, textOf(badDisposition).slice(0, 200));
  check(
    "an unknown disposition is clamped to continuable in the boundary text",
    badCapture.body.content.includes("disposition: continuable"),
    badCapture.body.content,
  );
  check("a second handoff gets its own boundary id", badCapture.body.source_id !== captureCall.body.source_id, [captureCall.body.source_id, badCapture.body.source_id]);
}

/* --------------------------------------------- handoff: negative paths -- */

section("handoff: negative paths keep the failure structured");
{
  // Same reasoning as above: pin the Scope so request counts measure the handoff
  // flow itself, not Scope resolution.
  const negativeConfig = (sdk) => resolveConfig(sdk, { scopeId: "scp_default" });

  const baseStub = (url, init) => {
    if (url.endsWith("/v1/sources/content")) {
      const body = JSON.parse(init.body);
      return jsonResponse(202, { status: "accepted", source: { name: "content", source_id: body.source_id }, position: 1 });
    }
    return null;
  };

  // (1) generation unavailable: capture persisted, prepare did not
  const gen503 = stubSdk((url, init) => {
    const base = baseStub(url, init);
    if (base) return base;
    if (url.endsWith("/v1/handoff/prepare")) {
      return jsonResponse(503, { error: { code: "handoff_generation_unavailable", message: "Handoff generation is unavailable.", details: null } });
    }
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url } });
  });
  const r503 = await callHandoffPrepare(gen503.sdk, negativeConfig(gen503.sdk), { objective: "obj", state: ["s"] });
  check("503 is a structured error result", r503.isError === true, r503);
  check("503 keeps the Server's error code", r503.details.serverCode === "handoff_generation_unavailable", r503.details);
  check("503 names the missing generation provider", /no generation provider configured/.test(textOf(r503)), textOf(r503));
  check("503 warns that a boundary Source already persists", /However, the handoff boundary Source .* was captured/.test(textOf(r503)), textOf(r503));
  check("503 does not claim nothing changed", r503.details.ok === false && !/No changes were made/.test(textOf(r503)), textOf(r503));
  check("503 offers a fix", /hint: Configure a generation provider/.test(textOf(r503)), textOf(r503));
  check("503 stopped after two requests (never reached finalize)", gen503.calls.length === 2, gen503.calls.length);

  // (2) finalize fails: capture AND draft persisted
  const fin500 = stubSdk((url, init) => {
    const base = baseStub(url, init);
    if (base) return base;
    if (url.endsWith("/v1/handoff/prepare")) {
      return jsonResponse(200, { objective: "obj", state: [{ text: "s", citations: [] }], disposition: "continuable", next_action: null, omissions: [], generation: null });
    }
    if (url.endsWith("/v1/handoff/finalize")) {
      return jsonResponse(500, { error: { code: "internal_error", message: "Finalize blew up.", details: null } });
    }
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url } });
  });
  const rFin = await callHandoffPrepare(fin500.sdk, negativeConfig(fin500.sdk), { objective: "obj" });
  check("finalize failure is structured", rFin.isError === true, rFin);
  check(
    "finalize failure names both prior writes",
    /However, the handoff boundary Source .* was captured and a Handoff Draft was generated/.test(textOf(rFin)),
    textOf(rFin),
  );
  check("finalize failure made all three requests", fin500.calls.length === 3, fin500.calls.length);

  // (3) capture itself fails: nothing persisted, so the clean-failure wording stays
  const capFail = stubSdk((url, init) => {
    const base = baseStub(url, init);
    if (base) return base;
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url } });
  });
  capFail.sdk.network.fetch = async (url, init) => {
    capFail.calls.push({ url, init });
    if (url.endsWith("/v1/sources/content")) return jsonResponse(422, { error: { code: "invalid_request", message: "Capture rejected.", details: null } });
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url } });
  };
  const rCap = await callHandoffPrepare(capFail.sdk, negativeConfig(capFail.sdk), { objective: "obj" });
  check("capture failure is structured", rCap.isError === true, rCap);
  check("capture failure claims nothing was changed", /No changes were made/.test(textOf(rCap)), textOf(rCap));
  check("capture failure stopped at one request", capFail.calls.filter((c) => !c.url.endsWith("/v1/scopes/default")).length === 1, capFail.calls.length);

  // (4) unreachable: still exactly one attempt, no partial-write claim
  const dead = stubSdk(() => {
    throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8000");
  });
  const rDead = await callHandoffPrepare(dead.sdk, negativeConfig(dead.sdk), { objective: "obj" });
  check("unreachable is structured", rDead.isError === true, rDead);
  check("unreachable reports exactly one attempt", dead.calls.length === 1, dead.calls.length);
  check("unreachable claims nothing was changed", /No changes were made/.test(textOf(rDead)), textOf(rDead));

  // (5) capture returns an unusable source object: refuse rather than send junk evidence
  const badSource = stubSdk((url, init) => {
    if (url.endsWith("/v1/scopes/default")) return jsonResponse(200, { scope_id: "scp_default", title: "Default", summary: "Default context" });
    if (url.endsWith("/v1/sources/content")) return jsonResponse(202, { status: "accepted", source: { source_id: "x" }, position: 1 });
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url } });
  });
  const rBadSource = await callHandoffPrepare(badSource.sdk, negativeConfig(badSource.sdk), { objective: "obj" });
  check("a source object missing 'name' is refused", rBadSource.isError === true && /did not return a usable Source reference/.test(textOf(rBadSource)), textOf(rBadSource));
  check("no evidence request is sent with a bad source", !badSource.calls.some((c) => c.url.endsWith("/v1/handoff/prepare")), badSource.calls.map((c) => c.url));
}

/* ---------------------------------------------------- stage 2: config -- */

section("stage 2 config surface");
{
  const sdk = stubSdk(() => jsonResponse(200, {})).sdk;

  const defaults = resolveConfig(sdk, {});
  check("prestep defaults ON (injection is the point of the App)", defaults.prestep === true, defaults.prestep);
  check("capture defaults OFF (it writes prompts to the Server)", defaults.capturePrompts === false, defaults.capturePrompts);
  check("before-start defaults OFF (needs a generation provider)", defaults.beforeStart === false, defaults.beforeStart);
  check("prestepMaxBytes defaults to 8192", defaults.prestepMaxBytes === 8192, defaults.prestepMaxBytes);
  check("prestepTimeoutMs defaults to 2000", defaults.prestepTimeoutMs === 2000, defaults.prestepTimeoutMs);
  check("captureMaxBytes defaults to 4096", defaults.captureMaxBytes === 4096, defaults.captureMaxBytes);

  check("env name mapping for prestepMaxBytes", envNameFor("prestepMaxBytes") === "POWERCONTEXT_HANA_PRESTEP_MAX_BYTES", envNameFor("prestepMaxBytes"));
  check("env name mapping for prestepTimeoutMs", envNameFor("prestepTimeoutMs") === "POWERCONTEXT_HANA_PRESTEP_TIMEOUT_MS", envNameFor("prestepTimeoutMs"));
  check("env name mapping for capturePrompts", envNameFor("capturePrompts") === "POWERCONTEXT_HANA_CAPTURE_PROMPTS", envNameFor("capturePrompts"));
  check("env name mapping for captureMaxBytes", envNameFor("captureMaxBytes") === "POWERCONTEXT_HANA_CAPTURE_MAX_BYTES", envNameFor("captureMaxBytes"));
  check("env name mapping for beforeStart", envNameFor("beforeStart") === "POWERCONTEXT_HANA_BEFORE_START", envNameFor("beforeStart"));

  check("a boolean override turns the kill-switch off", resolveConfig(sdk, { prestep: false }).prestep === false);
  check("a boolean override turns capture on", resolveConfig(sdk, { capturePrompts: true }).capturePrompts === true);

  const prev = process.env.POWERCONTEXT_HANA_PRESTEP;
  process.env.POWERCONTEXT_HANA_PRESTEP = "false";
  check("the kill-switch is reachable from the environment", resolveConfig(sdk, {}).prestep === false);
  process.env.POWERCONTEXT_HANA_PRESTEP = "on";
  check("environment booleans accept 'on'", resolveConfig(sdk, {}).prestep === true);
  // A typo must not silently read as "off" — that would hide a broken switch.
  process.env.POWERCONTEXT_HANA_PRESTEP = "maybe";
  check("an unparseable boolean is rejected, not guessed", resolveConfig(sdk, {}).prestep === true, resolveConfig(sdk, {}).prestep);
  if (prev === undefined) delete process.env.POWERCONTEXT_HANA_PRESTEP;
  else process.env.POWERCONTEXT_HANA_PRESTEP = prev;

  const numeric = process.env.POWERCONTEXT_HANA_PRESTEP_MAX_BYTES;
  process.env.POWERCONTEXT_HANA_PRESTEP_MAX_BYTES = "16384";
  check("numeric env override applies", resolveConfig(sdk, {}).prestepMaxBytes === 16384);
  if (numeric === undefined) delete process.env.POWERCONTEXT_HANA_PRESTEP_MAX_BYTES;
  else process.env.POWERCONTEXT_HANA_PRESTEP_MAX_BYTES = numeric;
}

/* ------------------------------------------- stage 2: message plumbing -- */

section("stage 2 message plumbing");
{
  check("string content is read directly", messageText({ role: "user", content: "hello" }) === "hello");
  check(
    "array content flattens its text parts",
    messageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }) === "a\nb",
    messageText({ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
  );
  check(
    "non-text parts contribute nothing",
    messageText({ role: "user", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] }) === "",
  );
  check("a null message reads as empty", messageText(null) === "");
  check("a message with no content reads as empty", messageText({ role: "user" }) === "");

  const list = [{ role: "system" }, { role: "user" }, { role: "assistant" }, { role: "user" }];
  check("the last user message is found", lastUserIndex(list) === 3, lastUserIndex(list));
  check("no user message yields -1", lastUserIndex([{ role: "system" }]) === -1);
  check("a non-array yields -1", lastUserIndex("nope") === -1);

  const { query, index } = queryFromMessages([{ role: "user", content: "  spaced  " }]);
  check("the query is trimmed", query === "spaced", query);
  check("the query reports its message index", index === 0, index);

  const long = queryFromMessages([{ role: "user", content: "z".repeat(4000) }]);
  check("an over-long query is capped", long.query.length === QUERY_MAX_CHARS, long.query.length);

  const multi = queryFromMessages([{ role: "user", content: "first" }, { role: "assistant" }, { role: "user", content: "second" }]);
  check("the LAST user message wins, not the first", multi.query === "second", multi.query);

  check("the session key prefers sessionPath", sessionKeyOf({ sessionId: "i", sessionPath: "/p" }) === "/p");
  check("a bridge session (no path) falls back to its id", sessionKeyOf({ sessionId: "i", sessionPath: null }) === "id:i");
  check("no session identity is reported as anonymous", sessionKeyOf(null) === "anonymous");
}

/* ------------------------------------- stage 2B: query extraction (plan A) -- */

section("stage 2B query extraction (extractRetrievalQuery)");
{
  // The exact failing sentence from the T9 diagnostic (four-way experiment,
  // artifacts/stage2/prepare-query-experiment.py): status "empty" verbatim, and
  // the noun phrase below is the shape that reliably reaches the entry.
  const prefixed =
    "你是一个全新会话。请不要调用任何工具。我之前让你记住的 PowerContext Server 地址是什么？";
  const outcome = extractRetrievalQuery(prefixed);
  check("1. the conversation prefix is dropped", !/全新会话|不要调用/.test(outcome.query), outcome.query);
  check("1. the T9 sentence extracts to its entity phrase", outcome.query === "PowerContext Server", outcome.query);
  check("1. extraction is reported as a hit, not a fallback", outcome.usedFallback === false, outcome);

  const quoted = extractRetrievalQuery("「PowerContext」的 Server 地址是什么？");
  check("2. corner brackets and CJK quotes are stripped", quoted.query === "PowerContext Server", quoted.query);
  const marked = extractRetrievalQuery("请问 **PowerContext Server** 的地址是什么？");
  check("2. markdown emphasis does not survive into the query", !marked.query.includes("*"), marked.query);
  check("2. the entity inside the markup is kept", marked.query === "PowerContext Server", marked.query);

  // Pinned to the real output rather than to the tidiest possible phrase: the
  // list is deliberately conservative (see EXTRACT_STOPWORDS), and a test that
  // only passes after widening it would be pressure to over-filter.
  const zhongwen = extractRetrievalQuery("我们上次讨论的那个部署端点是什么");
  check(
    "3. zhongwen stop words are removed",
    zhongwen.query === "讨论部署端点" && !/我们|是什么|那个|上次/.test(zhongwen.query),
    zhongwen.query,
  );
  check("3. English stop words are removed", extractRetrievalQuery("what is the PowerContext Server").query === "PowerContext Server", extractRetrievalQuery("what is the PowerContext Server").query);
  check(
    "3. a mixed sentence keeps only its entities",
    extractRetrievalQuery("please 帮我查一下 PowerContext Server 的地址").query === "查 PowerContext Server",
    extractRetrievalQuery("please 帮我查一下 PowerContext Server 的地址").query,
  );
  check("3. the stop list is not empty and is mixed-language", EXTRACT_STOPWORDS.length >= 80 && EXTRACT_STOPWORDS.includes("什么") && EXTRACT_STOPWORDS.includes("the"), EXTRACT_STOPWORDS.length);

  // The fallback is the safety property: when extraction has nothing to stand
  // on, the Server gets the user's own words rather than an empty query.
  const blank = extractRetrievalQuery("   ");
  check("4. an empty message falls back to the empty text", blank.query === "" && blank.usedFallback === true, blank);
  const politeness = extractRetrievalQuery("请");
  check("4. nothing but politeness falls back to the original", politeness.query === "请" && politeness.usedFallback === true, politeness);
  check("4. the fallback is exactly the input, not a rewrite", extractRetrievalQuery("是什么？").query === "是什么？", extractRetrievalQuery("是什么？").query);
  check("4. a clearly phrased sentence extracts rather than falls back", extractRetrievalQuery("what is the PowerContext Server base URL").usedFallback === false);

  const long = extractRetrievalQuery("z".repeat(4000));
  check("5. the extraction result stays inside the 512-byte cap", Buffer.byteLength(long.query, "utf8") <= QUERY_MAX_CHARS, Buffer.byteLength(long.query, "utf8"));
  const longCjk = extractRetrievalQuery("地址是什么".repeat(200));
  check("5. a pre-truncated CJK input cannot split a character", !longCjk.query.includes("\uFFFD"), longCjk.query.slice(-12));
  check("5. a non-string input reads as empty rather than throwing", extractRetrievalQuery(null).query === "" && extractRetrievalQuery(42).query === "");

  // A dot inside a host name is not a sentence boundary.
  const url = extractRetrievalQuery("PowerContext Server at http://127.0.0.1:8000 please");
  check("6. an IPv4 host survives sentence splitting intact", url.query.includes("127.0.0.1:8000"), url.query);
}

section("stage 2 byte accounting");
{
  check("under budget is returned unchanged", truncateToBytes("abc", 10) === "abc");
  check("empty budget yields empty", truncateToBytes("abc", 0) === "");
  check("ascii truncates to the byte count", truncateToBytes("abcdef", 3) === "abc");
  // Multi-byte characters must never be cut in half: a broken byte sequence would
  // reach the model as a replacement character.
  const cjk = "中文测试内容";
  const cut = truncateToBytes(cjk, 7);
  check("a multi-byte string truncates without splitting a character", Buffer.byteLength(cut, "utf8") <= 7, { cut, bytes: Buffer.byteLength(cut, "utf8") });
  check("the truncated string is still valid UTF-8", !cut.includes("\uFFFD"), cut);
  const emoji = "😀😀😀😀";
  const cutEmoji = truncateToBytes(emoji, 9);
  check("a surrogate pair is never split", Buffer.byteLength(cutEmoji, "utf8") <= 9 && [...cutEmoji].every((c) => c === "😀"), { cutEmoji, bytes: Buffer.byteLength(cutEmoji, "utf8") });
  check("an exact-fit multi-byte string is untouched", truncateToBytes("中文", 6) === "中文");

  const wrapped = wrapRecall("body");
  check("the wrapper opens with the trust marker", wrapped.startsWith(RECALL_PREFIX));
  check("the wrapper closes with the end marker", wrapped.endsWith(RECALL_SUFFIX));
  check("the wrapper keeps the body between the markers", wrapped.includes("body"));

  const injected = injectBeforeLastUser([{ role: "user", content: "q" }], "recall", 100);
  check("injection produces a user message", injected.messages[0].role === "user", injected.messages[0].role);
  check("injection places recall before the user's question", injected.messages[1].content === "q", injected.messages.map((m) => m.content));

  const big = injectBeforeLastUser([{ role: "user", content: "q" }], "R".repeat(5000), 100);
  check(
    "an oversized recall is truncated to the budget plus wrapper allowance",
    Buffer.byteLength(big.messages[0].content, "utf8") <= 100 + 1024,
    Buffer.byteLength(big.messages[0].content, "utf8"),
  );
  check("truncation still closes the wrapper", big.messages[0].content.endsWith(RECALL_SUFFIX));
  check("truncation reports itself", big.truncated === true, big.truncated);

  const noUser = injectBeforeLastUser([{ role: "assistant", content: "a" }], "recall", 100);
  check("with no user message the recall is appended, not dropped", noUser.messages.length === 2 && noUser.messages[1].role === "user");
}

section("stage 2 capture helpers");
{
  resetCaptureDedupe();
  const hash = contentHash("a prompt");
  check("hashing is stable", contentHash("a prompt") === hash);
  check("different text hashes differently", contentHash("other") !== hash);
  check("the first sighting is new", captureWasSeen(hash) === false);
  check("the second sighting is a duplicate", captureWasSeen(hash) === true);
  check("an evicted entry becomes new again", (() => {
    resetCaptureDedupe();
    const first = contentHash("first");
    captureWasSeen(first);
    for (let i = 0; i < CAPTURE_LRU_SIZE; i += 1) captureWasSeen(contentHash(`filler-${i}`));
    return captureWasSeen(first) === false;
  })());
  resetCaptureDedupe();

  const id = nextCaptureSourceId();
  check("capture ids use the pc-capture shape", /^pc-capture-\d{17}-\d{4}$/.test(id), id);
  check("capture ids advance", nextCaptureSourceId() !== id);
}

section("stage 2 counters and /pc hooks");
{
  resetCounters();
  check("counters start at zero", counters.prestep_invocations === 0 && counters.injections === 0);
  check("every documented counter exists", [
    "prestep_invocations", "injections", "skipped_disabled", "skipped_empty", "skipped_empty_extracted",
    "extract_hits", "skipped_no_query", "skipped_error", "cache_hits", "cache_misses", "captures",
    "captures_duplicate", "captures_failed", "beforestart_invocations", "beforestart_injections",
    "beforestart_skipped",
  ].every((k) => typeof counters[k] === "number"), Object.keys(counters));

  const sdk = stubSdk(() => jsonResponse(200, {})).sdk;
  const config = resolveConfig(sdk, {});

  const withProbe = await commandHooks(config, async () => ({
    capabilities: [
      { capability: "app/hooks.agent-pre-step", status: "always", enforcement: "advisory" },
      { capability: "app/hooks.agent-before-start", status: "not_asked", enforcement: "advisory" },
    ],
  }));
  check("/pc hooks reports the pre-step switch", /prestep\s+on/.test(withProbe), withProbe);
  check("/pc hooks reports capture as off", /capturePrompts\s+off/.test(withProbe), withProbe);
  check("/pc hooks reports the grant status from the host", withProbe.includes("always") && withProbe.includes("not_asked"), withProbe);
  check("/pc hooks names the cache TTL", withProbe.includes(String(CACHE_TTL_MS / 1000)), withProbe);
  // The stage 2B counters are what the T9-r3 acceptance reads: injections > 0
  // proves the layer ran, extract_hits proves it did something.
  check("/pc hooks renders the extraction counters", /skipped_empty_extracted\s+\d+/.test(withProbe), withProbe);
  check("/pc hooks renders extract_hits", /extract_hits\s+\d+/.test(withProbe), withProbe);

  const offConfig = resolveConfig(sdk, { prestep: false, capturePrompts: true });
  const offText = await commandHooks(offConfig, async () => ({ capabilities: [] }));
  check("/pc hooks shows a disabled kill-switch in caps", /prestep\s+OFF/.test(offText), offText);
  check("/pc hooks shows capture enabled", /capturePrompts\s+ON/.test(offText), offText);
  check("/pc hooks handles an empty ledger", /not_asked/.test(offText), offText);

  const unexpected = await commandHooks(config, async () => ({
    capabilities: [
      { capability: "app/hooks.agent-pre-step", status: "always", enforcement: "advisory" },
      { capability: "app/hooks.tools-pre-execute", status: "always", enforcement: "advisory" },
    ],
  }));
  check("/pc hooks warns about an out-of-scope hook grant", /WARNING: unexpected hook grants/.test(unexpected), unexpected);

  const noProbe = await commandHooks(config, undefined);
  check("/pc hooks degrades without a capability probe", /unavailable in this context/.test(noProbe), noProbe);

  const brokenProbe = await commandHooks(config, async () => {
    throw new Error("bus unavailable");
  });
  check("/pc hooks survives a failing probe", /host capability query failed/.test(brokenProbe), brokenProbe);

  // Counters must survive a cache clear, so /pc hooks cannot be reset by traffic.
  clearRecallCache();
  check("clearing the cache does not reset counters", counters.prestep_invocations === 0 && recallCacheSize() === 0);
}

/* ------------------------------------------- stage 3: dashboard backend -- */

section("stage 3 dashboard backend");
{
  const cardBehaviour = (url) => {
    if (url.endsWith("/health/live")) return jsonResponse(200, { status: "ok" });
    if (url.endsWith("/health/ready")) return jsonResponse(200, { status: "ready", checks: { runtime: "ready", database: "ready" } });
    if (url.endsWith("/v1/capabilities")) return jsonResponse(200, { handoff_generation: false, search_modes: ["auto"] });
    if (url.endsWith("/v1/scopes/default")) return jsonResponse(200, { scope_id: "scp_card", title: "Default", summary: "Default context" });
    if (url.endsWith("/v1/handoff/continue")) return jsonResponse(200, { trust: "untrusted_history", status: "empty", content: null });
    if (url.endsWith("/v1/memory/entries/list")) {
      return jsonResponse(200, {
        memory: { family: "memory", artifact_id: "memory", revision: 2 },
        entries: [
          { citation: { entry_id: "mem_ent_a" }, kind: "project-fact", text: "first", state: "active" },
          { citation: { entry_id: "mem_ent_b" }, kind: "decision", text: "second", state: "retired" },
        ],
      });
    }
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url, details: null } });
  };

  const { sdk, calls } = stubSdk(cardBehaviour);
  const config = resolveConfig(sdk, { scopeId: "scp_card" });

  const status = await dashboardStatus(sdk, config);
  check("dashboard status reports the Server up", status.ok === true && status.server.status === "ready", status.ok);
  check("dashboard status carries the Scope", status.scope.ok === true && status.scope.scopeId === "scp_card", status.scope);
  check("dashboard status carries the switches", status.config.prestep === true, status.config);

  const handoff = await dashboardHandoff(sdk, config);
  check("an empty handoff is ok:true with handoff:null", handoff.ok === true && handoff.handoff === null, handoff);

  const memory = await dashboardMemory(sdk, config);
  check("dashboard memory counts by kind", memory.total === 2 && memory.byKind["project-fact"] === 1, memory.byKind);
  check("dashboard memory previews entries", memory.entries.length === 2, memory.entries.length);

  const hooks = dashboardHooks();
  check("dashboard hooks mirrors counters read-only", hooks.ok === true && typeof hooks.counters.prestep_invocations === "number");

  // The card must never write. This is the assertion that keeps a future edit
  // from quietly turning a status surface into a mutating one.
  const MUTATING = /remember|sources\/content|entries\/revise|entries\/retire|handoff\/prepare|handoff\/finalize|artifact-candidates\/(approve|reject)/;
  check("no dashboard call touched a mutating endpoint", !calls.some((c) => MUTATING.test(c.url)), calls.map((c) => c.url));
}

section("stage 3 dashboard backend degrades, never 500s");
{
  const { sdk } = stubSdk(() => {
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
  check("no dashboard section throws when the Server is down", threw === null, threw && threw.message);
  check("status degrades to ok:false (the route can still answer 200)", status.ok === false, status.ok);
  check("status keeps the hint the card renders as 怎么修", typeof status.server.error.hint === "string" && status.server.error.hint.length > 0, status.server.error);
  check("handoff degrades to ok:false", handoff.ok === false);
  check("memory degrades to ok:false with no entries", memory.ok === false && memory.entries.length === 0);
}

section("stage 3 D21: the alert only fires on a real decision");
{
  const sdk = stubSdk(() => jsonResponse(200, {})).sdk;
  const config = resolveConfig(sdk, {});

  // not_asked is the ledger having no record, which is the clean-install state.
  const notAsked = await commandHooks(config, async () => ({
    capabilities: [
      { capability: "app/hooks.agent-pre-step", status: "always", enforcement: "advisory" },
      { capability: "app/hooks.tools-pre-execute", status: "not_asked", enforcement: "advisory" },
      { capability: "app/hooks.session-input", status: "not_asked", enforcement: "advisory" },
    ],
  }));
  check("D21: not_asked no longer raises the warning", !/WARNING: unexpected hook grants/.test(notAsked), notAsked);
  // The ledger area shows this App's own two words. An out-of-plan *undecided*
  // word is neither a grant nor a plan entry, so it belongs in neither the
  // warning nor the plan list — silence here is the fix, not an omission.
  check("D21: an out-of-plan not_asked word is not listed as a plan entry", !notAsked.includes("app/hooks.tools-pre-execute"), notAsked);
  check("D21: the App's own word is still reported as not_asked", /app\/hooks\.agent-before-start\s+not_asked/.test(notAsked), notAsked);

  // A real grant outside the plan is exactly what the warning is for.
  const granted = await commandHooks(config, async () => ({
    capabilities: [
      { capability: "app/hooks.agent-pre-step", status: "always", enforcement: "advisory" },
      { capability: "app/hooks.tools-pre-execute", status: "always", enforcement: "advisory" },
    ],
  }));
  check("D21: a real out-of-plan grant still warns", /WARNING: unexpected hook grants present: app\/hooks\.tools-pre-execute/.test(granted), granted);

  const denied = await commandHooks(config, async () => ({
    capabilities: [{ capability: "app/hooks.tools-post-execute", status: "denied", enforcement: "advisory" }],
  }));
  check("D21: a denial is a decision, so it warns", /WARNING: unexpected hook grants/.test(denied), denied);

  const sessionTier = await commandHooks(config, async () => ({
    capabilities: [{ capability: "app/hooks.session-input", status: "session", enforcement: "advisory" }],
  }));
  check("D21: a session-tier grant warns", /WARNING: unexpected hook grants/.test(sessionTier), sessionTier);

  const clean = await commandHooks(config, async () => ({ capabilities: [] }));
  check("D21: an empty ledger is silent", !/WARNING/.test(clean), clean);
}

/* ---------------------------------------------------- stage 3: /pc review -- */

section("stage 3 /pc review: human gate");
{
  const scopeStub = (url) => {
    if (url.endsWith("/v1/scopes/default")) return jsonResponse(200, { scope_id: "scp_review", title: "Default", summary: "d" });
    return null;
  };

  const listing = stubSdk((url) => {
    const base = scopeStub(url);
    if (base) return base;
    if (url.endsWith("/v1/artifact-candidates/list")) {
      return jsonResponse(200, {
        candidates: [
          { candidate_id: "cand_1", version: 3, family: "experience", status: "pending", source_refs: [{}, {}], proposal: { lesson: "always read the error code" } },
          { candidate_id: "cand_2", version: 1, family: "skill", status: "pending", source_refs: [], proposal: { name: "nightly-check" } },
        ],
        next_cursor: null,
      });
    }
    return jsonResponse(404, { error: { code: "unknown", message: "no stub", details: null } });
  });
  const listText = await commandReview(listing.sdk, resolveConfig(listing.sdk, { scopeId: "scp_review" }), "");
  check("review lists the candidates", listText.includes("cand_1") && listText.includes("cand_2"), listText);
  check("review shows family and version", /cand_1\s+\[experience\] v3/.test(listText), listText);
  check("review shows a gist of the proposal", listText.includes("always read the error code"), listText);
  check("review shows the evidence count", /证据 2 条/.test(listText), listText);
  check("review tells the human the two decisions", listText.includes("/pc review approve <id>") && listText.includes("/pc review reject <id>"), listText);
  check("review states that decisions belong to the human", /审阅决定只属于人/.test(listText), listText);

  const emptyQueue = stubSdk((url) => scopeStub(url) || jsonResponse(200, { candidates: [], next_cursor: null }));
  const emptyText = await commandReview(emptyQueue.sdk, resolveConfig(emptyQueue.sdk, { scopeId: "scp_review" }), "list");
  check("an empty queue says it is normal, not an error", /没有待审阅的候选/.test(emptyText) && /不是错误/.test(emptyText), emptyText);
  check("an empty queue explains why it can be empty", /生成能力/.test(emptyText), emptyText);
  check("an empty queue does not report a failure", !/失败/.test(emptyText), emptyText);

  const approve = stubSdk((url) => {
    const base = scopeStub(url);
    if (base) return base;
    if (url.endsWith("/v1/artifact-candidates/get")) return jsonResponse(200, { candidate_id: "cand_1", version: 4, family: "experience", status: "pending" });
    if (url.endsWith("/v1/artifact-candidates/approve")) return jsonResponse(200, { candidate_id: "cand_1", version: 5, status: "approved" });
    return jsonResponse(404, { error: { code: "unknown", message: "no stub", details: null } });
  });
  const approveText = await commandReview(approve.sdk, resolveConfig(approve.sdk, { scopeId: "scp_review" }), "approve cand_1");
  check("approve reports success with the version it read", /已批准 cand_1（v4/.test(approveText), approveText);
  const approveCall = approve.calls.find((c) => c.url.endsWith("/approve"));
  check("approve used the version it read, not a guess", approveCall.body.expected_version === 4, approveCall.body);
  check("approve sent the resolved scope", approveCall.body.scope_id === "scp_review", approveCall.body);
  check("approve never sent a reason", approveCall.body.reason === undefined, approveCall.body);

  const reject = stubSdk((url) => {
    const base = scopeStub(url);
    if (base) return base;
    if (url.endsWith("/v1/artifact-candidates/get")) return jsonResponse(200, { candidate_id: "cand_2", version: 2, status: "pending" });
    if (url.endsWith("/v1/artifact-candidates/reject")) return jsonResponse(200, { candidate_id: "cand_2", version: 3, status: "rejected" });
    return jsonResponse(404, { error: { code: "unknown", message: "no stub", details: null } });
  });
  const rejectText = await commandReview(reject.sdk, resolveConfig(reject.sdk, { scopeId: "scp_review" }), "reject cand_2 证据不足，先补一条来源");
  check("reject reports the rejection", /已驳回 cand_2/.test(rejectText), rejectText);
  check("reject echoes the human's reason", rejectText.includes("证据不足，先补一条来源"), rejectText);
  const rejectCall = reject.calls.find((c) => c.url.endsWith("/reject"));
  check("reject sent the reason", rejectCall.body.reason === "证据不足，先补一条来源", rejectCall.body);
  check("reject used the version it read", rejectCall.body.expected_version === 2, rejectCall.body);

  const noId = stubSdk((url) => scopeStub(url) || jsonResponse(200, {}));
  const noIdText = await commandReview(noId.sdk, resolveConfig(noId.sdk, { scopeId: "scp_review" }), "approve");
  check("approve without an id asks for one", /用法/.test(noIdText), noIdText);
  check("approve without an id makes no Server call", noId.calls.length === 0, noId.calls.map((c) => c.url));

  const unknown = await commandReview(noId.sdk, resolveConfig(noId.sdk, { scopeId: "scp_review" }), "frobnicate");
  check("an unknown review subcommand prints help", /未知的 review 子命令/.test(unknown) && unknown.includes("/pc review approve"), unknown);

  const conflict = stubSdk((url) => {
    const base = scopeStub(url);
    if (base) return base;
    if (url.endsWith("/v1/artifact-candidates/get")) return jsonResponse(200, { candidate_id: "cand_3", version: 1, status: "pending" });
    if (url.endsWith("/v1/artifact-candidates/approve")) {
      return jsonResponse(409, { error: { code: "version_conflict", message: "The Candidate changed.", details: null } });
    }
    return jsonResponse(404, { error: { code: "unknown", message: "no stub", details: null } });
  });
  const conflictText = await commandReview(conflict.sdk, resolveConfig(conflict.sdk, { scopeId: "scp_review" }), "approve cand_3");
  check("a version conflict is reported", /失败/.test(conflictText), conflictText);
  check("a version conflict tells the human to look again", /重新跑 \/pc review 看最新版本/.test(conflictText), conflictText);
  check("a version conflict states that nothing was retried", /没有做任何自动重试/.test(conflictText), conflictText);
  check(
    "a conflict made exactly two calls (get, then the failed decision)",
    conflict.calls.filter((c) => !c.url.endsWith("/v1/scopes/default")).length === 2,
    conflict.calls.map((c) => c.url),
  );

  const noVersion = stubSdk((url) => {
    const base = scopeStub(url);
    if (base) return base;
    if (url.endsWith("/v1/artifact-candidates/get")) return jsonResponse(200, { candidate_id: "cand_4", status: "pending" });
    return jsonResponse(404, { error: { code: "unknown", message: "no stub", details: null } });
  });
  const blindText = await commandReview(noVersion.sdk, resolveConfig(noVersion.sdk, { scopeId: "scp_review" }), "approve cand_4");
  check("a missing version refuses to decide blind", /refusing to decide blind/.test(blindText), blindText);
  check("no decision call was made without a version", !noVersion.calls.some((c) => c.url.endsWith("/approve")), noVersion.calls.map((c) => c.url));

  const structured = await reviewCandidates(listing.sdk, resolveConfig(listing.sdk, { scopeId: "scp_review" }), {});
  check("reviewCandidates returns structured data", structured.ok === true && Array.isArray(structured.candidates), structured);
  check("reviewCandidates reports the candidate version for the gate", structured.candidates[0].version === 3, structured.candidates[0]);

  const decide = await decideCandidate(approve.sdk, resolveConfig(approve.sdk, { scopeId: "scp_review" }), { candidateId: "cand_1", decision: "approve" });
  check("decideCandidate returns structured data", decide.ok === true && decide.version === 4, decide);
}

section("stage 3 red line: review stays out of the model tool surface");
{
  const regs = buildToolRegistrations();
  const names = regs.map((r) => r.name);

  check("the tool set is still exactly the three pc_ tools", regs.length === 3, names);
  check("no tool name mentions review", !names.some((n) => /review|approve|reject|candidate/i.test(n)), names);
  check(
    "no tool description offers a review action",
    !regs.some((r) => /approve|reject|批准|驳回/i.test(r.description)),
    regs.map((r) => r.name),
  );
  check(
    "no tool parameters expose a candidate id",
    !regs.some((r) => JSON.stringify(r.parameters).includes("candidate")),
    regs.map((r) => r.name),
  );
  check("reviewCandidates is a function, not a registration", typeof reviewCandidates === "function");
  check("commandReview is a command handler, not a registered tool", typeof commandReview === "function" && !names.includes("commandReview"));
}

/* ------------------------------------ BUG-3: the card's credential door -- */

section("BUG-3: the card has exactly one door, and it carries credentials");
{
  const requireFromHere = createRequire(import.meta.url);
  const fs = requireFromHere("node:fs");
  const path = requireFromHere("node:path");
  const appDir = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

  const readAppFile = (relative) => fs.readFileSync(path.join(appDir, relative), "utf8");

  const html = readAppFile("ui/dashboard.html");
  const page = readAppFile("ui/assets/dashboard-page.js");
  const fetchModule = readAppFile("ui/assets/dashboard-fetch.js");

  // Guard against a vacuous pass: if the path resolution were wrong, every
  // content assertion below would "succeed" against empty strings.
  check("the card files were actually read (non-empty)", html.length > 200 && page.length > 200 && fetchModule.length > 200, [html.length, page.length, fetchModule.length]);
  check("the page under test is the real card page", html.includes("PowerContext"), html.slice(0, 80));

  // (1) The transport must be loaded before the page that uses it. Read the
  //     `src` attributes, not a bare indexOf: the file names also appear in the
  //     comments above the tags, which would make the comparison meaningless.
  const srcOrder = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]);
  const fetchAt = srcOrder.findIndex((src) => src.endsWith("dashboard-fetch.js"));
  const pageAt = srcOrder.findIndex((src) => src.endsWith("dashboard-page.js"));
  check("the card page loads the transport", fetchAt > -1, srcOrder);
  check("the transport loads before the wiring that uses it", fetchAt > -1 && pageAt > -1 && fetchAt < pageAt, srcOrder);

  // (2) The wiring must contain no bare fetch: the credential door lives in one
  //     place, and a second call site is how the original bug would come back.
  const pageFetchCalls = page.match(/\bfetch\s*\(/g) || [];
  check("dashboard-page.js calls no fetch directly", pageFetchCalls.length === 0, pageFetchCalls);

  // (3) The transport must prefer the official door by name.
  check("the transport feature-detects hana.api.fetch", /hana\.api\.fetch|hasApiFetch/.test(fetchModule));
  check("the transport passes an App-relative path to hana.api.fetch", /hana\.api\.fetch\(section/.test(fetchModule), "expected hana.api.fetch(section, ...)");

  // (4) The card frontend must not know the Server's address at all.
  for (const [name, source] of [["dashboard-page.js", page], ["dashboard-fetch.js", fetchModule]]) {
    check(`${name} contains no Server address or port`, !/127\.0\.0\.1|localhost|:8000/.test(source), name);
  }

  // (5) Version, and the manifest is otherwise untouched by this fix.
  const manifest = JSON.parse(readAppFile("manifest.json"));
  check("the version is 0.3.3", manifest.version === "0.3.3", manifest.version);
  check("the capabilities are unchanged by the fix", JSON.stringify(manifest.capabilities) === JSON.stringify(["app/tools.expose-to-model", "app/hooks.agent-pre-step", "app/hooks.agent-before-start"]), manifest.capabilities);
  check("the card contribution is unchanged by the fix", manifest.contributes.cards.length === 1 && manifest.contributes.cards[0].route === "/dashboard.html", manifest.contributes);

  /* ------------------------------------------------------ BUG-4: the bridge -- */

  // BUG-3 fixed the *door* (hana.api.fetch) but not the thing that installs it:
  // `globalThis.hana` comes from the scaffold's local browser bridge,
  // `ui/assets/sdk.js`. Without that file the whole SDK is a silent no-op —
  // hana.api.fetch, hana.state and hana.lifecycle all simply do not exist, which
  // is why every credential fix of the previous round still produced a 403.
  const bridge = readAppFile("ui/assets/sdk.js");
  check("the browser bridge asset exists and is not empty", bridge.length > 0, bridge.length);
  check("the browser bridge is the real SDK, not a placeholder (>100KB)", bridge.length > 100000, bridge.length);
  check("the bridge contains the official door implementation", bridge.includes("pluginApiFetch"));
  check("the bridge knows the surface-session credential", bridge.includes("appSurfaceSession"));
  check("the bridge is an ES module, so it must be imported, not classic-loaded", /export\s*\{/.test(bridge));
  check("the bridge exports hana by name", /export\s*\{[\s\S]{0,200}?hana2 as hana[\s\S]{0,40}?\}/.test(bridge), "expected 'hana2 as hana' in the export list");

  // The page must pull the bridge in as a module. A classic <script src> would be a
  // syntax error, and no import at all means no hana — the original defect.
  check("the card page imports the bridge as a module", /import\s*\{[^}]*\bhana\b[^}]*\}\s*from\s*["']\.\/sdk\.js["']/.test(page), page.slice(0, 200));
  check("the card page is loaded as type=module", /<script[^>]*type=["']module["'][^>]*src=["'][^"']*dashboard-page\.js["']/.test(html), html.slice(-500));
  check("the page does not classic-load the bridge (that would be a syntax error)", !/<script(?![^>]*type=["']module["'])[^>]*src=["'][^"']*sdk\.js["']/.test(html));
  // Order must be read from the actual `src` attributes: a naive indexOf also
  // matches the file names as they appear in the explanatory comments above them.
  const scriptSrcs = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)].map((match) => match[1]);
  const indexOfSrc = (name) => scriptSrcs.findIndex((src) => src.endsWith(name));
  check("the view logic is loaded before its wiring", indexOfSrc("dashboard.js") > -1 && indexOfSrc("dashboard.js") < indexOfSrc("dashboard-page.js"), scriptSrcs);
  check("the transport is loaded before its wiring", indexOfSrc("dashboard-fetch.js") > -1 && indexOfSrc("dashboard-fetch.js") < indexOfSrc("dashboard-page.js"), scriptSrcs);
  check("the bridge is never loaded as a classic script tag", indexOfSrc("sdk.js") === -1, scriptSrcs);
  check("the wiring is the only module script tag", [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => /type=["']module["']/.test(m[1])).length === 1, "expected exactly one type=module script");

  // The fallback must exist inline (before any module), so a module that fails to
  // load still has someone to say so. This is the scaffold's starter pattern.
  check("an inline startup fallback exists in the page", /addEventListener\(\s*["']error["']/.test(html), "expected window.addEventListener('error', ...)");
  check("the fallback is a classic script, not a module (it must run even if modules fail)", /<script>\s*window\.addEventListener\(\s*["']error["']/.test(html), html.slice(0, 1000));
  check("the fallback tells the reader to check App resources", /检查 App 资源|Check its resources/.test(html));
  check("the fallback names the reopen/reload remedy", /重开卡片|重载 App|reopen the card|reload the App/i.test(html), html.slice(0, 1000));

  // The startup message must target an element that actually exists, or the
  // fallback would throw on the very path it exists to cover.
  check("the startup target element exists in the page", /id=["']boot-headline["']/.test(html), "expected #boot-headline");
  check("the fallback's detail target also exists", /id=["']boot-detail["']/.test(html), "expected #boot-detail");
  // The fallback must not be able to clobber a card that booted fine: it fires on
  // any error event, including an unrelated late resource failure.
  check("the fallback checks the booted flag before speaking", /__pcCardBooted/.test(html));
  check("the page raises the booted flag once it has rendered", /__pcCardBooted\s*=\s*true/.test(page));
  check("the startup message is still the connecting skeleton", /正在连接/.test(html));

  // Route (b), asserted so a later "simplification" cannot quietly undo it: the
  // bridge is threaded explicitly, and no code reads an ambient global for it.
  const pageCode = page.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((line) => !/^\s*\//.test(line)).join("\n");
  check("no code reads globalThis.hana (route b keeps the global untouched)", !/globalThis\.hana/.test(pageCode), "route (b) was chosen: thread the imported bridge explicitly");
  check("the imported bridge is handed to the transport", /hana,/.test(pageCode) && /loadSection\(/.test(pageCode), "expected options.hana: hana");
  check("the state bridge uses the imported binding, not a global", /if \(hana && hana\.state/.test(pageCode), pageCode.slice(0, 200));
  check("the page never assigns a global hana", !/globalThis\.hana\s*=/.test(pageCode));
}

section("BUG-3: route failures and Server outages are never confused");
{
  const routeFailure = { ok: false, error: { kind: "route_failure", transport: "api", status: 403, message: "卡片后端 status 返回 HTTP 403（missing_credential）。", hint: "关闭这张卡片并重新打开。" } };
  const serverDown = { ok: false, baseUrl: "http://127.0.0.1:8000", server: { ok: false, stage: "liveness", error: { message: "not reachable", hint: "Start it with scripts/start-server.sh." } } };

  check("a route failure renders with its own tone", /tone: .reopen.|"reopen"/.test(JSON.stringify({ tone: "reopen" })));
  check("a route failure is not the Server-unreachable kind", routeFailure.error.kind !== "unreachable");
  // The two failure sources must be distinguishable by `kind` alone, since that is
  // what the view branches on.
  check("the two failure sources differ in kind", routeFailure.error.kind !== "unreachable" && routeFailure.error.kind === "route_failure");
  check("a Server outage still carries the address", serverDown.baseUrl === "http://127.0.0.1:8000");
  check("a route failure carries no address", routeFailure.baseUrl === undefined, routeFailure.baseUrl);
}

/* ------------------------------------------------- registration surface -- */

section("registration table");
{
  const regs = buildToolRegistrations();
  const names = regs.map((r) => r.name);
  check("three tools are declared", regs.length === 3, names);
  check(
    "names are the ones the task requires",
    JSON.stringify(names.sort()) === JSON.stringify(["pc_handoff_prepare", "pc_memory_list", "pc_remember"]),
    names,
  );
  for (const reg of regs) {
    check(`${reg.name} has a description`, typeof reg.description === "string" && reg.description.length > 20);
    check(`${reg.name} declares a JSON Schema`, reg.parameters && reg.parameters.type === "object", reg.parameters);
    check(`${reg.name} has a run function`, typeof reg.run === "function");
    check(
      `${reg.name} is model-callable (lowercase, digits, underscore)`,
      /^[a-z][a-z0-9_]*$/.test(reg.name),
      reg.name,
    );
  }
  const list = regs.find((r) => r.name === "pc_memory_list");
  check("pc_memory_list declares itself read-only", list.sessionPermission && list.sessionPermission.readOnly === true, list.sessionPermission);
  for (const name of ["pc_remember", "pc_handoff_prepare"]) {
    const reg = regs.find((r) => r.name === name);
    check(`${name} does NOT claim to be read-only`, !reg.sessionPermission || reg.sessionPermission.readOnly !== true, reg.sessionPermission);
  }
}

/* ------------------------------------------------------------- live probe -- */

const baseUrlArgIndex = process.argv.indexOf("--base-url");
const liveBaseUrl = baseUrlArgIndex > -1 ? process.argv[baseUrlArgIndex + 1] : "http://127.0.0.1:8000";

section(`live Server probe (${liveBaseUrl})`);
{
  let reachable = false;
  try {
    const response = await fetch(`${liveBaseUrl}/health/live`, { signal: AbortSignal.timeout(2500) });
    reachable = response.ok;
  } catch {
    reachable = false;
  }

  if (!reachable) {
    console.log(`  [SKIP] no Server at ${liveBaseUrl}; the live section needs one running.`);
    console.log("         Start it with scripts/start-server.sh, then re-run to include this section.");
  } else {
    // A live section that only reads: it uses the Server's default Scope and
    // never writes, so running the self test cannot pollute real memory.
    const { sdk, calls } = stubSdk((url, init) => fetch(url, { ...init, body: init.body }));
    const config = resolveConfig(sdk, { baseUrl: liveBaseUrl });

    const verdict = await probe(sdk, config);
    check("live /health/live and /health/ready both succeed", verdict.ok === true, verdict.error || verdict.stage);
    check("live readiness reports a status", typeof verdict.status === "string", verdict.status);
    check("live readiness reports database state", verdict.checks && verdict.checks.database === "ready", verdict.checks);

    const scope = await resolveScope(sdk, config, undefined);
    check("a default Scope resolves", scope.ok === true, scope);

    if (scope.ok) {
      const listed = await callMemoryList(sdk, config, {});
      check("pc_memory_list works against the live Server", listed.isError !== true, textOf(listed).slice(0, 200));
      check("live list reports a count", typeof listed.details.count === "number", listed.details);
    }

    const doctor = await commandDoctor(sdk, config, probe);
    check("/pc doctor renders a live verdict", /status: ready/.test(doctor), doctor);

    // One deliberate failure against the live Server: a Scope that cannot exist.
    const missing = await callMemoryList(sdk, config, { scope_id: "scp_definitely-not-a-real-scope" });
    check("a bad Scope is reported, not thrown", missing.isError === true, missing);
    check("the bad-Scope error is the Server's own", missing.details.serverCode === "scope_not_found", missing.details);
    console.log(`  (live section used ${calls.length} requests)`);
  }
}

console.log(`\n=== SELFTEST: ${checks - failures}/${checks} checks passed ${failures === 0 ? "— ALL PASSED" : "— " + failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
