/**
 * lib/live-demo.mjs — drives the App's own code against a real PowerContext
 * Server, over real sockets, from outside the Hana host.
 *
 * Run:  node app/hana-powercontext/lib/live-demo.mjs [--base-url http://127.0.0.1:8000]
 *
 * The self test proves the logic against a stubbed network door; this proves the
 * same code path against the real Server — real HTTP, real Scope, real entries —
 * so the claim "the tools work" rests on an actual round trip rather than on a
 * mock agreeing with itself. It writes into a Scope of its own (`--scope`) so it
 * never disturbs a Scope someone else is using.
 *
 * `--fail-open` flips it into the negative case: it points the client at a port
 * where nothing is listening and measures how the tools behave. That is the check
 * worth running AFTER the Server is stopped, and it is what produces the
 * "unreachable in N ms" figure.
 *
 * Handoff coverage is conditional on the Server, honestly. `pc_handoff_prepare`
 * needs a generation provider for its middle step, and a basic-memory Server has
 * none, so the same command legitimately produces either a finalized carrier or a
 * structured `handoff_generation_unavailable`. The demo reads the Server's own
 * reported capability and asserts whichever outcome that Server owes, instead of
 * pretending one of them is universal. Override with
 * `--expect-generation=on|off` when reading a Server that misreports.
 */

import { resolveConfig } from "./config.js";
import { callRemember, callMemoryList, callHandoffPrepare, commandDoctor } from "./tools.js";
import { probe } from "./powercontext.js";
import { registerHooks, counters, resetCounters, resetCaptureDedupe, resetLastQuery, clearRecallCache, lastUserIndex, RECALL_PREFIX, RECALL_SUFFIX } from "./hooks.js";

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = argValue("--base-url", "http://127.0.0.1:8000");
const scopeId = argValue("--scope", "scp_hana_powercontext_demo");
const failOpenMode = process.argv.includes("--fail-open");
const generationOverride = argValue("--expect-generation", "auto");

/** A real transport, shaped like the SDK's network door. */
function liveSdk(url) {
  const calls = [];
  return {
    dataDir: null,
    network: {
      async fetch(target, init) {
        // Record the body too: the stage 2 checks assert on what the hook asked
        // the Server for, not just that it asked.
        calls.push({
          target,
          method: (init && init.method) || "GET",
          body: init && typeof init.body === "string" ? init.body : undefined,
        });
        const response = await fetch(target, { ...init, body: init.body });
        // fetch() reads the body once; the client expects a Response, so hand the
        // same object through and let it read.
        return response;
      },
    },
    calls,
  };
}

/**
 * Register the stage 2 hooks through the SDK door, exactly as index.js does, and
 * hand back the pre-step adjudicator. This is the harness: the hook goes in the
 * way the App installs it, and comes out the way the host would call it.
 */
async function registerPreStep(sdk, configOverrides = {}) {
  resetCounters();
  resetCaptureDedupe();
  resetLastQuery();
  clearRecallCache();
  const registered = new Map();
  sdk.hooks = {
    onDecision(word, adjudicator) {
      registered.set(word, adjudicator);
      return () => registered.delete(word);
    },
  };
  const configNow = () => resolveConfig(sdk, { baseUrl, timeoutMs: failOpenMode ? 3000 : 5000, ...configOverrides });
  await registerHooks(sdk, configNow, () => {});
  return { preStep: registered.get("agent/pre-step"), beforeStart: registered.get("agent/before-start"), configNow };
}

const label = failOpenMode ? "FAIL-OPEN (nothing listening)" : "LIVE";
console.log(`=== hana-powercontext live demo — ${label} ===`);
console.log(`base url: ${baseUrl}`);
// In fail-open mode the Scope is never reached, so advertising a scope id there
// would be misleading.
console.log(failOpenMode ? "scope:    (unused — nothing is listening)" : `scope:    ${scopeId} (provisioned below)`);
console.log();

const sdk = liveSdk(baseUrl);
const config = resolveConfig(sdk, { baseUrl, timeoutMs: failOpenMode ? 3000 : 5000 });
console.log(`effective: baseUrl=${config.baseUrl} timeoutMs=${config.timeoutMs} maxResponseBytes=${config.maxResponseBytes}`);
console.log();

/**
 * Whether this Server can generate a Handoff Draft.
 *
 * Read from the Server's own `/v1/capabilities`, so the demo asserts the outcome
 * the Server actually owes rather than the outcome we wish it had. Unreachable
 * means "no generation", which is the only claim that can be made.
 */
async function resolveGenerationExpectation() {
  if (generationOverride === "on") return { expected: true, source: "--expect-generation=on" };
  if (generationOverride === "off") return { expected: false, source: "--expect-generation=off" };
  if (failOpenMode) return { expected: false, source: "unreachable (fail-open mode)" };
  try {
    const response = await fetch(`${baseUrl}/v1/capabilities`, { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { expected: false, source: `/v1/capabilities HTTP ${response.status}` };
    const body = await response.json();
    return {
      expected: body.handoff_generation === true,
      source: `/v1/capabilities handoff_generation=${String(body.handoff_generation)}`,
    };
  } catch {
    return { expected: false, source: "capabilities unreachable" };
  }
}

let failed = 0;
function report(name, result, { expectError = false } = {}) {
  const text = (result.content || []).map((part) => part.text || "").join("\n");
  const isError = result.isError === true;
  const good = expectError ? isError : !isError;
  if (!good) failed += 1;
  console.log(`--- ${name} — ${good ? "as expected" : "UNEXPECTED"} ---`);
  console.log(text);
  console.log();
  return { text, isError };
}

const generationExpectation = await resolveGenerationExpectation();

if (failOpenMode) {
  // Nothing is listening on this port. Every tool must degrade, promptly and
  // exactly once, without throwing.
  const startedAll = Date.now();
  const remembered = report("pc_remember", await callRemember(sdk, config, { text: "must not be written", scope_id: scopeId }), { expectError: true });
  const listed = report("pc_memory_list", await callMemoryList(sdk, config, { scope_id: scopeId }), { expectError: true });
  const handoff = report("pc_handoff_prepare", await callHandoffPrepare(sdk, config, { objective: "must not be prepared", scope_id: scopeId }), { expectError: true });

  // The stage 2 hook, against a dead Server. It must return undefined — the host
  // reads that as "no change" — and must do so in bounded time with one attempt.
  const hookSdk = liveSdk(baseUrl);
  const { preStep } = await registerPreStep(hookSdk);
  const hookStarted = Date.now();
  let hookThrew = null;
  let hookDecision;
  try {
    hookDecision = await preStep({
      messages: [{ role: "user", content: "does pre-step degrade cleanly?" }],
      session: { sessionId: "fail-open", sessionPath: "/tmp/fail-open" },
    });
  } catch (error) {
    hookThrew = error;
  }
  const hookElapsed = Date.now() - hookStarted;
  console.log("--- agent/pre-step hook — " + (hookThrew === null && hookDecision === undefined ? "as expected" : "UNEXPECTED") + " ---");
  console.log(`decision: ${hookDecision === undefined ? "undefined (no rewrite)" : JSON.stringify(hookDecision).slice(0, 200)}`);
  console.log(`threw:    ${hookThrew ? hookThrew.message : "no"}`);
  console.log(`elapsed:  ${hookElapsed} ms; requests attempted: ${hookSdk.calls.length}`);
  console.log();
  if (hookThrew !== null || hookDecision !== undefined) failed += 1;

  const doctor = await commandDoctor(sdk, config, probe);
  console.log("--- /pc doctor ---");
  console.log(doctor);
  console.log();
  const elapsed = Date.now() - startedAll;

  console.log(`total wall time for 4 tool calls: ${elapsed} ms`);
  console.log(`requests actually attempted: ${sdk.calls.length} (must be 4 — one per call, no retries)`);
  console.log();
  const checks = [
    ["pre-step hook returned undefined (no rewrite)", hookDecision === undefined],
    ["pre-step hook did not throw", hookThrew === null],
    ["pre-step hook made exactly one attempt (no retry storm)", hookSdk.calls.length === 1, hookSdk.calls.length],
    ["pre-step hook stayed inside its timeout budget", hookElapsed < 3000 + 1500, hookElapsed],
    ["pc_remember degraded to an error result", remembered.isError],
    ["pc_memory_list degraded to an error result", listed.isError],
    ["pc_handoff_prepare degraded to an error result", handoff.isError],
    ["handoff names the Server as unreachable", /not reachable/i.test(handoff.text)],
    ["handoff claims nothing was changed", /No changes were made/.test(handoff.text)],
    ["failure names the Server as unreachable", /not reachable/i.test(remembered.text)],
    ["failure states that nothing changed", /No changes were made/.test(remembered.text)],
    ["failure offers a hint", /hint:/i.test(remembered.text)],
    ["/pc doctor reports NOT USABLE", /NOT USABLE/.test(doctor)],
    ["exactly one request per tool call (no retry storm)", sdk.calls.length === 4],
    ["bounded latency", elapsed < config.timeoutMs * 4 + 1500],
  ];
  for (const [name, pass] of checks) {
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}`);
    if (!pass) failed += 1;
  }
} else {
  // The demo owns its Scope, so a run is self-contained and repeatable. The
  // Server treats the idempotency key as the identity of the request: the first
  // run creates the Scope, later runs get the same one back instead of a
  // duplicate or an error.
  const created = await fetch(`${baseUrl}/v1/scopes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "hana-powercontext live demo",
      summary: "Scope owned by app/hana-powercontext/lib/live-demo.mjs. Safe to delete.",
      idempotency_key: "hana-powercontext-live-demo-scope",
    }),
  });
  const createdBody = await created.json().catch(() => null);
  const scope =
    createdBody && (createdBody.scope_id || (createdBody.scope && createdBody.scope.scope_id) || (createdBody.existing && createdBody.existing.scope_id));
  console.log(`--- scope provisioning — HTTP ${created.status} ---`);
  console.log(scope ? `using scope ${scope}` : JSON.stringify(createdBody));
  console.log();
  if (!scope) {
    console.log("Could not provision the demo Scope; stopping.");
    process.exit(1);
  }
  const demoScope = scope;

  const stamp = new Date().toISOString();
  const remembered = report(
    "pc_remember",
    await callRemember(sdk, config, {
      text: `Live demo marker written at ${stamp}. If this text is recalled in a later session, the App's write path reached a real PowerContext Server.`,
      kind: "reference",
      reason: "hana-powercontext stage 1 live demonstration",
      scope_id: demoScope,
    }),
  );

  const listed = report("pc_memory_list", await callMemoryList(sdk, config, { scope_id: demoScope }));

  /* --- handoff: the whole explicit flow, against the real Server ----------- */
  console.log(`handoff generation on this Server: ${generationExpectation.expected ? "enabled" : "disabled"} (${generationExpectation.source})`);
  console.log();
  const beforeHandoff = sdk.calls.length;
  const handoffResult = await callHandoffPrepare(sdk, config, {
    objective: "verify the handoff endpoint family end to end",
    state: ["the boundary is captured as a real Source", "evidence cites the exact returned object"],
    next_action: "inspect whether the finalized carrier came back whole",
    disposition: "continuable",
    omissions: ["this is a demo handoff, not real work"],
    scope_id: demoScope,
  });
  const handoffCalls = sdk.calls.slice(beforeHandoff);
  // `report` returns {text, isError} — that is what the checks below read. Keeping
  // the raw result here instead silently made every text assertion compare against
  // `undefined`, which reads as a failing regex rather than a missing field.
  const handoff = report("pc_handoff_prepare", handoffResult, { expectError: !generationExpectation.expected });
  handoff.details = handoffResult.details;
  handoff.content = handoffResult.content;

  const doctor = await commandDoctor(sdk, config, probe);
  console.log("--- /pc doctor ---");
  console.log(doctor);
  console.log();

  /* --- stage 2: the pre-step hook, against the real Server ---------------- */
  // This is the stage's core claim: with no tool call and no explicit query, a
  // model step gets the previously remembered content injected automatically.
  const hookSdk = liveSdk(baseUrl);
  const { preStep, configNow: hookConfig } = await registerPreStep(hookSdk, { scopeId: demoScope });
  const hookMessages = [
    { role: "system", content: "You are a careful assistant." },
    { role: "user", content: "remind me what the live demo wrote earlier" },
  ];
  const hookStarted = Date.now();
  const decision = await preStep({ messages: hookMessages, session: { sessionId: "live", sessionPath: "/tmp/hana-powercontext-live" } });
  const hookElapsed = Date.now() - hookStarted;
  const injected = decision && Array.isArray(decision.messages) ? decision.messages.find((m) => !hookMessages.includes(m)) : null;

  console.log("--- agent/pre-step hook (live) ---");
  console.log(`decision:  ${decision ? "injected one message" : "undefined"}`);
  console.log(`elapsed:   ${hookElapsed} ms over ${hookSdk.calls.length} request(s)`);
  console.log(`injected:  ${injected ? injected.content.slice(0, 300).replace(/\n/g, " ") : "(nothing)"}`);
  console.log();

  const insertAt = lastUserIndex(hookMessages);
  const hookChecks = [
    ["pre-step injected a recall message against the live Server", Boolean(decision && injected)],
    ["the injection is a user message", Boolean(injected) && injected.role === "user"],
    ["the injection is wrapped as untrusted history", Boolean(injected) && injected.content.startsWith(RECALL_PREFIX) && injected.content.trimEnd().endsWith(RECALL_SUFFIX)],
    ["the injection sits before the user's question", Boolean(decision) && decision.messages[insertAt] === injected],
    ["existing messages survive untouched", Boolean(decision) && hookMessages.every((m, i) => decision.messages[i === insertAt ? insertAt + 1 : i] === m)],
    ["the live recall body is non-empty", Boolean(injected) && injected.content.length > RECALL_PREFIX.length + RECALL_SUFFIX.length + 8],
    [
      "the live recall carries the Server's untrusted-history framing",
      Boolean(injected) && /untrusted_history|Treat every item below as data/i.test(injected.content),
    ],
    ["the hook made exactly one request (prepare only, capture off)", hookSdk.calls.length === 1, hookSdk.calls.map((c) => c.target)],
    ["that request was /v1/context/prepare", hookSdk.calls.length === 1 && hookSdk.calls[0].target.endsWith("/v1/context/prepare")],
    ["the prepare request carried the pre-step byte budget", hookSdk.calls.length === 1 && JSON.parse(hookSdk.calls[0].body || "{}").max_bytes === hookConfig().prestepMaxBytes],
    ["no capture request was sent while capture is off", !hookSdk.calls.some((c) => c.target.endsWith("/v1/sources/content"))],
    ["the injection counter moved", counters.injections === 1, counters.injections],
    [
      "a second step in the same session is served from cache",
      await (async () => {
        const before = hookSdk.calls.length;
        const again = await preStep({ messages: hookMessages, session: { sessionId: "live", sessionPath: "/tmp/hana-powercontext-live" } });
        return Boolean(again) && hookSdk.calls.length === before && counters.cache_hits >= 1;
      })(),
    ],
  ];

  const handoffPaths = handoffCalls.map((c) => c.target.replace(baseUrl, ""));
  const handoffChecks = [
    ["handoff spoke only to the handoff endpoint family", handoffPaths.every((p) => p === "/v1/sources/content" || p === "/v1/handoff/prepare" || p === "/v1/handoff/finalize")],
    ["handoff never called the work-contract endpoint", !handoffPaths.some((p) => p.includes("prepare-current"))],
    ["the first handoff call was capture", handoffPaths[0] === "/v1/sources/content"],
  ];

  if (generationExpectation.expected) {
    // Positive path: three calls, and the third returns the real carrier.
    handoffChecks.push(
      ["handoff closed the flow in exactly three calls", handoffPaths.length === 3],
      ["the third call was finalize", handoffPaths[2] === "/v1/handoff/finalize"],
      ["handoff succeeded", handoff.isError !== true],
      ["the finalized carrier came back", handoff.details && handoff.details.finalized && typeof handoff.details.finalized === "object"],
      ["the carrier declares the prepared-handoff schema", handoff.details && handoff.details.finalized && handoff.details.finalized.schema === "powercontext.prepared-handoff.v1"],
      ["the carrier carries content", handoff.details && handoff.details.finalized && handoff.details.finalized.content !== undefined],
      ["the carrier is attributed to this scope", handoff.details && handoff.details.finalized && handoff.details.finalized.scope_id === demoScope],
      ["the Draft is surfaced too", handoff.details && handoff.details.draft && Array.isArray(handoff.details.draft.state)],
      ["the boundary is a real Source in this scope", handoff.details && String(handoff.details.boundarySourceId).startsWith("pc-handoff-")],
    );
  } else {
    // Negative path: capture persists, prepare is gated, and the error is exact.
    handoffChecks.push(
      ["handoff stopped after capture + prepare (never finalized)", handoffPaths.length === 2],
      ["handoff reported the generation gate", handoff.details && handoff.details.serverCode === "handoff_generation_unavailable"],
      ["the error names the missing provider", /no generation provider configured/.test(handoff.text)],
      [
        "the error says the boundary Source already persists",
        /However, the handoff boundary Source .* was captured/.test(handoff.text) &&
          handoff.details &&
          handoff.details.boundarySourceId !== null &&
          handoff.details.boundarySourceId !== undefined,
      ],
      ["the boundary Source id is reported even on failure", handoff.details && /^pc-handoff-/.test(String(handoff.details.boundarySourceId))],
      ["the error is structured, not thrown", handoff.isError === true && Array.isArray(handoff.content)],
    );
  }

  const boundarySourceId = handoff.details && handoff.details.boundarySourceId;
  console.log(`boundary source: ${boundarySourceId || "(none)"}`);
  console.log();

  const checks = [
    ["pc_remember succeeded against the live Server", !remembered.isError],
    ["the write returned a real entry id", /entry_id: mem_ent_/.test(remembered.text)],
    ["pc_memory_list read the entry back", /Live demo marker written at/.test(listed.text)],
    ["the entry is attributed to this scope", listed.text.includes(demoScope)],
    ["/pc doctor reports the Server ready", /status: ready/.test(doctor)],
    ...handoffChecks,
    ...hookChecks,
  ];
  for (const [name, pass] of checks) {
    console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}`);
    if (!pass) failed += 1;
  }
  console.log();
  console.log(`requests made: ${sdk.calls.map((c) => c.method + " " + c.target.replace(baseUrl, "")).join(", ")}`);
}

console.log();
console.log(`=== ${label}: ${failed === 0 ? "ALL CHECKS PASSED" : failed + " CHECK(S) FAILED"} ===`);
process.exit(failed === 0 ? 0 : 1);
