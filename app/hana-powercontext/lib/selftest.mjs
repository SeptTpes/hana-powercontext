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

import { resolveConfig, envNameFor, DEFAULTS } from "./config.js";
import { request, probe } from "./powercontext.js";
import { callRemember, callMemoryList, callHandoffPrepare, resolveScope, commandDoctor } from "./tools.js";
import { buildToolRegistrations } from "./register.js";

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
        calls.push({ url, init });
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
