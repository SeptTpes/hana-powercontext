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
      return jsonResponse(202, {
        status: "captured",
        source: { family: "source", source_id: body.source_id, revision: 1 },
        position: 1,
      });
    }
    if (url.endsWith("/v1/work/handoffs/prepare-current")) {
      return jsonResponse(200, {
        handoff: { objective: "ship stage 1" },
        boundary: { source_id: "pc-handoff-20261007160000" },
      });
    }
    return jsonResponse(404, { error: { code: "unknown", message: "no stub for " + url } });
  });
  const config = resolveConfig(sdk, {});

  const remembered = await callRemember(sdk, config, { text: "a fact", kind: "decision", reason: "because" });
  check("remember succeeds", remembered.isError !== true, textOf(remembered));
  check("remember reports the entry id", /mem_ent_1/.test(textOf(remembered)), textOf(remembered));
  check("scope fell back to the Server default", /scp_default/.test(textOf(remembered)), textOf(remembered));
  check("scope source is disclosed", /server-default/.test(textOf(remembered)), textOf(remembered));

  const rememberCall = seen.find((c) => c.url.endsWith("/v1/memory/remember"));
  check("remember sent the chosen kind", rememberCall.body.kind === "decision", rememberCall.body);
  check("remember sent the reason", rememberCall.body.reason === "because", rememberCall.body);
  check("remember sent the resolved scope", rememberCall.body.scope_id === "scp_default", rememberCall.body);

  const listed = await callMemoryList(sdk, config, {});
  check("list succeeds", listed.isError !== true, textOf(listed));
  check("list renders both entries", /first/.test(textOf(listed)) && /second/.test(textOf(listed)), textOf(listed));
  check("list marks a retired entry", /\[retired\]/.test(textOf(listed)), textOf(listed));
  check("list reports the count", listed.details.count === 2, listed.details);

  const handoff = await callHandoffPrepare(sdk, config, {
    objective: "ship stage 1",
    state: ["骨架已建"],
    next_action: "run the validator",
    disposition: "continuable",
    omissions: ["no real conversation test yet"],
  });
  check("handoff succeeds", handoff.isError !== true, textOf(handoff));
  check("handoff reports its boundary source", /boundary source: pc-handoff-/.test(textOf(handoff)), textOf(handoff));
  check("handoff states that claims are declared, not verified", /declared.*claim/i.test(textOf(handoff)), textOf(handoff));

  const handoffCalls = seen.filter((c) => c.url.includes("/v1/sources/content") || c.url.includes("/v1/work/handoffs/prepare-current"));
  check("handoff made exactly two calls (capture, then prepare)", handoffCalls.length === 2, handoffCalls.map((c) => c.url));
  const prepareCall = handoffCalls.find((c) => c.url.includes("prepare-current"));
  if (prepareCall) {
    check("prepare-current carries the captured source id", prepareCall.body.source_id.startsWith("pc-handoff-"), prepareCall.body.source_id);
    check(
      "prepare-current marks claims as declared with no evidence",
      prepareCall.body.handoff.state.every((s) => s.basis === "declared" && Array.isArray(s.evidence) && s.evidence.length === 0),
      prepareCall.body.handoff.state,
    );
    check("prepare-current declares the handoff schema", prepareCall.body.handoff.schema === "powercontext.current-work-handoff.v1", prepareCall.body.handoff.schema);
    check("prepare-current uses an allowed disposition", ["continuable", "blocked", "complete"].includes(prepareCall.body.handoff.disposition), prepareCall.body.handoff.disposition);
    check("prepare-current declares untrusted trust", prepareCall.body.handoff.trust === "untrusted_input", prepareCall.body.handoff.trust);
  } else {
    check("prepare-current was called", false, handoffCalls.map((c) => c.url));
  }

  const badDisposition = await callHandoffPrepare(sdk, config, { objective: "z", disposition: "nonsense" });
  const badPrepare = seen.filter((c) => c.url.includes("prepare-current")).pop();
  if (badPrepare) {
    check("an unknown disposition falls back to continuable", badPrepare.body.handoff.disposition === "continuable", badPrepare.body.handoff.disposition);
  } else {
    check("the bad-disposition call reached prepare-current", false);
  }
  check("that call still succeeded", badDisposition.isError !== true, textOf(badDisposition));
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
