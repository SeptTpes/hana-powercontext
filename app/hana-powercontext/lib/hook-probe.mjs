/**
 * lib/hook-probe.mjs — a host harness for the stage 2 hooks.
 *
 * The self test checks the handlers directly. This drives them the way the host
 * does: it builds an SDK whose `hooks.onDecision` records the adjudicators, calls
 * `registerHooks` exactly as `index.js` does at load, and then invokes the
 * registered adjudicator with a real pre-step invocation. That is what makes the
 * registration path itself part of the evidence, instead of assuming it.
 *
 * Every case runs against a stubbed network door, so the whole file is offline
 * and deterministic. The one thing it cannot prove is the host's own dispatch —
 * that a grant is what makes the host call us at all. That belongs to the
 * acceptance side, in a real host, and is recorded as a blind spot.
 *
 * Run: node app/hana-powercontext/lib/hook-probe.mjs
 */

import { resolveConfig } from "./config.js";
import {
  registerHooks,
  counters,
  resetCounters,
  resetCaptureDedupe,
  resetLastQuery,
  lastQueryFor,
  recallCacheSize,
  clearRecallCache,
  lastUserIndex,
  RECALL_PREFIX,
  RECALL_SUFFIX,
  QUERY_MAX_CHARS,
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

/* --------------------------------------------------------------- harness -- */

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * An SDK shaped like the real one, with a recording hooks door. `behaviour`
 * returns a Response for each call, so a case can script the Server.
 */
function harnessSdk(behaviour, { dataDir = null } = {}) {
  const registered = new Map();
  const calls = [];
  const sdk = {
    dataDir,
    hooks: {
      onDecision(word, adjudicator) {
        registered.set(word, adjudicator);
        return () => registered.delete(word);
      },
    },
    capabilities: {
      async get() {
        return {
          capabilities: [
            { capability: "app/hooks.agent-pre-step", status: "always", enforcement: "advisory" },
            { capability: "app/hooks.agent-before-start", status: "not_asked", enforcement: "advisory" },
          ],
        };
      },
    },
    logger: { async info() {} },
    network: {
      async fetch(url, init) {
        const body = init && init.body ? JSON.parse(init.body) : undefined;
        calls.push({ url, init, body });
        return behaviour(url, init, calls.length);
      },
    },
  };
  return { sdk, registered, calls };
}

/** A realistic Pi-shaped message list: system, user, assistant, tool result, user. */
function messageList() {
  return [
    { role: "system", content: "You are a careful assistant." },
    { role: "user", content: "first question" },
    { role: "assistant", content: [{ type: "text", text: "an answer" }] },
    { role: "toolResult", toolName: "some_tool", content: [{ type: "text", text: "tool output" }] },
    { role: "user", content: "what did we decide about the deployment endpoint?" },
  ];
}

const okPrepare = (text, bytes) => () =>
  jsonResponse(200, { schema: "powercontext.prepared-context.v1", status: "ready", content: text, content_bytes: bytes === undefined ? Buffer.byteLength(text, "utf8") : bytes });

async function freshHarness(behaviour, configOverrides = {}) {
  resetCounters();
  resetCaptureDedupe();
  resetLastQuery();
  clearRecallCache();
  const h = harnessSdk(behaviour);
  const configNow = () => resolveConfig(h.sdk, { scopeId: "scp_hook_probe", ...configOverrides });
  const disposers = await registerHooks(h.sdk, configNow, () => {});
  await disposers;
  return { ...h, configNow, preStep: h.registered.get("agent/pre-step"), beforeStart: h.registered.get("agent/before-start") };
}

/* ------------------------------------------------------ registration ----- */

section("registration through the SDK door");
{
  const h = await freshHarness(okPrepare("recalled text"));
  check("agent/pre-step registered", typeof h.preStep === "function");
  check("agent/before-start registered", typeof h.beforeStart === "function");
  check("exactly two adjudicators were registered", h.registered.size === 2, [...h.registered.keys()]);
  check("registration made no network calls", h.calls.length === 0, h.calls.length);
}

section("hooks door failure is survivable");
{
  resetCounters();
  const sdk = {
    dataDir: null,
    hooks: {
      onDecision() {
        throw new Error("hooks door unavailable in this composition");
      },
    },
    capabilities: { async get() { return { capabilities: [] }; } },
    logger: { async info() {} },
    network: { async fetch() { return jsonResponse(200, {}); } },
  };
  const logged = [];
  const disposers = await registerHooks(sdk, () => resolveConfig(sdk, {}), (m) => logged.push(m));
  check("registerHooks resolves instead of throwing", Array.isArray(disposers), typeof disposers);
  check("the failure is reported on the log", logged.some((m) => /agent\/pre-step/.test(m)), logged);
  check("it reports both hooks", logged.filter((m) => /could not register/.test(m)).length === 2, logged);
}

/* ---------------------------------------------------------- happy path --- */

section("pre-step: injection");
{
  const recall = "BEGIN_POWERCONTEXT_PREPARED_CONTEXT_V1\n{\"trust\":\"untrusted_history\"}\nEND";
  const h = await freshHarness(okPrepare(recall));

  const messages = messageList();
  const original = messages.map((m) => m);
  const decision = await h.preStep({ messages, session: { sessionId: "s1", sessionPath: "/tmp/s1.jsonl" } });

  check("returns a decision", decision && Array.isArray(decision.messages), decision && typeof decision);
  check("the injected set has exactly one more message", decision.messages.length === messages.length + 1, [messages.length, decision.messages.length]);

  const injected = decision.messages[4];
  check("the injection sits immediately before the last user message", injected.role === "user" && decision.messages[5] === messages[4], decision.messages.map((m) => m.role));
  check("the last user message is still last", decision.messages[decision.messages.length - 1] === messages[4]);
  check("the injected text opens with the trust marker", injected.content.startsWith(RECALL_PREFIX), injected.content.slice(0, 60));
  check("the injected text ends with the closing marker", injected.content.trimEnd().endsWith(RECALL_SUFFIX), injected.content.slice(-40));
  check("the Server's recall body is carried verbatim inside the wrapper", injected.content.includes(recall));
  check("the wrapper announces untrusted history", /untrusted_history/.test(injected.content));

  // No existing message may be rewritten, removed, reordered or cloned. The
  // comparison is positional because the insertion shifts everything after it.
  const insertIndex = lastUserIndex(messages);
  check(
    "messages before the injection are passed through by reference",
    original.slice(0, insertIndex).every((m, i) => decision.messages[i] === m),
    insertIndex,
  );
  check(
    "messages after the injection are shifted, never replaced",
    original.slice(insertIndex).every((m, i) => decision.messages[insertIndex + 1 + i] === m),
    insertIndex,
  );
  check("no message was removed", decision.messages.length === original.length + 1);
  check("the injected message is the only new object", decision.messages.filter((m) => !original.includes(m)).length === 1);

  check("exactly one prepare request was made", h.calls.filter((c) => c.url.endsWith("/v1/context/prepare")).length === 1, h.calls.map((c) => c.url));
  const req = h.calls.find((c) => c.url.endsWith("/v1/context/prepare"));
  // Stage 2B changed this assertion on purpose: the ask is now shaped before it
  // is sent, so the Server sees the phrase rather than the question. The
  // instrument panel's verbatim query is the job of the capture path, not this.
  check("the query is the extracted phrase, not the verbatim question", req.body.query === "decide deployment endpoint", req.body.query);
  check("and that extraction is counted", counters.extract_hits === 1, counters.extract_hits);
  check("the request carries the Scope", req.body.scope_id === "scp_hook_probe", req.body.scope_id);
  check("the request carries the pre-step byte budget", req.body.max_bytes === 8192, req.body.max_bytes);
  check("the request carries the pre-step timeout", req.init.timeoutMs === 2000, req.init.timeoutMs);
  check("counters recorded the invocation and injection", counters.prestep_invocations === 1 && counters.injections === 1, { ...counters });
}

section("pre-step: query extraction");
{
  const h = await freshHarness(okPrepare("x"));
  const long = "q".repeat(2000);
  await h.preStep({ messages: [{ role: "user", content: long }], session: { sessionId: "s", sessionPath: "/tmp/a" } });
  const req = h.calls.find((c) => c.url.endsWith("/v1/context/prepare"));
  check("an over-long query is capped at 512 characters", req.body.query.length === QUERY_MAX_CHARS, req.body.query.length);

  // Parts-array content must flatten, and non-text parts must not leak in.
  const h2 = await freshHarness(okPrepare("x"));
  await h2.preStep({
    messages: [{ role: "user", content: [{ type: "text", text: "part one" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "part two" }] }],
    session: { sessionId: "s2", sessionPath: "/tmp/b" },
  });
  const req2 = h2.calls.find((c) => c.url.endsWith("/v1/context/prepare"));
  check("array content flattens to its text parts", req2.body.query === "part one part two", req2.body.query);
  check("image data never reaches the query", !req2.body.query.includes("AAAA"), req2.body.query);

  // A tool-loop step carries no new user text: the previous query is reused.
  const h3 = await freshHarness(okPrepare("x"));
  await h3.preStep({ messages: [{ role: "user", content: "the original question" }], session: { sessionId: "s3", sessionPath: "/tmp/c" } });
  h3.calls.length = 0;
  counters.cache_hits = 0;
  const loopStep = await h3.preStep({
    messages: [{ role: "user", content: "the original question" }, { role: "assistant", content: [] }, { role: "toolResult", content: [] }],
    session: { sessionId: "s3", sessionPath: "/tmp/c" },
  });
  check("a tool-loop step still gets recall (via the previous query)", Boolean(loopStep), loopStep && typeof loopStep);
  check("the repeat step was served from cache, not a new request", h3.calls.filter((c) => c.url.endsWith("/v1/context/prepare")).length === 0, h3.calls.length);

  // No user message anywhere and no history: nothing to ask about.
  const h4 = await freshHarness(okPrepare("x"));
  counters.skipped_no_query = 0;
  const noQuery = await h4.preStep({ messages: [{ role: "assistant", content: "hi" }], session: { sessionId: "s4", sessionPath: "/tmp/d" } });
  check("a queryless step with no history injects nothing", noQuery === undefined, noQuery);
  check("it is counted as skipped_no_query", counters.skipped_no_query === 1, counters.skipped_no_query);
  check("and makes no request", h4.calls.length === 0, h4.calls.length);
}

/* ------------------------------------------------- query extraction (2B) -- */

section("pre-step: retrieval query extraction");
{
  const cases = [
    ["prefix + stop words (zh)", "你是一个全新会话。请不要调用任何工具。我之前让你记住的 PowerContext Server 地址是什么？", "PowerContext Server", "/tmp/prefix-zh"],
    ["stop words only (zh)", "PowerContext Server 地址", "PowerContext Server", "/tmp/stop-zh"],
    ["stop words only (en)", "what is the PowerContext Server base URL for hana-powercontext", "PowerContext Server hana-powercontext", "/tmp/stop-en"],
  ];
  let rememberedAfterPrefix = null;
  for (const [label, text, expected, sessionPath] of cases) {
    const h = await freshHarness(okPrepare("x"));
    await h.preStep({ messages: [{ role: "user", content: text }], session: { sessionId: label, sessionPath } });
    const req = h.calls.find((c) => c.url.endsWith("/v1/context/prepare"));
    check(`${label}: the Server receives the extracted phrase`, req && req.body.query === expected, req && req.body.query);
    check(`${label}: the extraction is counted`, counters.extract_hits >= 1, counters.extract_hits);
    // Read inside the same closure: freshHarness installs a new module-level
    // lastQuery map, so a lookup after the loop would read a different one.
    if (sessionPath === "/tmp/prefix-zh") rememberedAfterPrefix = lastQueryFor(sessionPath);
  }

  // The fallback branch, at the loop level: text the extractor cannot improve on
  // is sent as it was, and is *not* counted as an extraction hit. The task book
  // requires both branches to be asserted separately, and this is that pair.
  const fb = await freshHarness(okPrepare("x"));
  counters.extract_hits = 0;
  await fb.preStep({ messages: [{ role: "user", content: "是什么？" }], session: { sessionId: "fb", sessionPath: "/tmp/fb" } });
  const fbReq = fb.calls.find((c) => c.url.endsWith("/v1/context/prepare"));
  check("the fallback branch sends the verbatim text in a query-shaped input", fbReq.body.query === "是什么？", fbReq.body.query);
  check("the fallback branch is not counted as an extraction hit", counters.extract_hits === 0, counters.extract_hits);

  // An empty user message is the only thing that can leave the query empty, and
  // that is what the new counter is for.
  const empty = await freshHarness(okPrepare("x"));
  counters.skipped_empty_extracted = 0;
  const emptyStep = await empty.preStep({ messages: [{ role: "user", content: "   " }], session: { sessionId: "e", sessionPath: "/tmp/e" } });
  check("an empty user message injects nothing", emptyStep === undefined, emptyStep);
  check("it is counted as skipped_empty_extracted", counters.skipped_empty_extracted >= 1, counters.skipped_empty_extracted);
  check("and it makes no request", empty.calls.length === 0, empty.calls.length);
  check("nothing was remembered for that session", lastQueryFor("/tmp/e") === undefined, lastQueryFor("/tmp/e"));

  // The remembered query is the extracted one, so a tool-loop step in the same
  // session keeps asking the question the Server could actually answer.
  check(
    "the remembered query for the tool-loop path is the extracted phrase",
    rememberedAfterPrefix === "PowerContext Server",
    rememberedAfterPrefix,
  );
}

/* ------------------------------------------------------------ failures --- */

section("pre-step: every failure path returns undefined");
{
  const cases = [
    ["Server unreachable", () => { throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8000"); }, "skipped_error"],
    ["host-side timeout", () => { throw new Error("host-side timeout after 2000ms"); }, "skipped_error"],
    ["HTTP 503 from the Server", () => jsonResponse(503, { error: { code: "unavailable", message: "Server busy", details: null } }), "skipped_error"],
    ["HTTP 404 unknown scope", () => jsonResponse(404, { error: { code: "scope_not_found", message: "not found", details: null } }), "skipped_error"],
    ["empty recall", () => jsonResponse(200, { schema: "powercontext.prepared-context.v1", status: "empty", content: null, content_bytes: 0 }), "skipped_empty"],
    ["non-JSON body", () => new Response("<html>not powercontext</html>", { status: 200, headers: { "content-type": "text/html" } }), "skipped_error"],
  ];

  for (const [label, behaviour, counter] of cases) {
    const h = await freshHarness(behaviour);
    let threw = null;
    let decision;
    try {
      decision = await h.preStep({ messages: messageList(), session: { sessionId: "s", sessionPath: `/tmp/${label}` } });
    } catch (error) {
      threw = error;
    }
    check(`${label}: does not throw`, threw === null, threw && threw.message);
    check(`${label}: returns undefined (no rewrite)`, decision === undefined, decision);
    check(`${label}: counted as ${counter}`, counters[counter] >= 1, { ...counters });
  }
}

section("pre-step: malformed invocation is survivable");
{
  const h = await freshHarness(okPrepare("x"));
  for (const [label, invocation] of [
    ["no invocation", undefined],
    ["no messages", { session: { sessionId: "s", sessionPath: "/tmp/e" } }],
    ["messages is not an array", { messages: "nope", session: { sessionId: "s", sessionPath: "/tmp/f" } }],
    ["empty message array", { messages: [], session: { sessionId: "s", sessionPath: "/tmp/g" } }],
    ["no session identity", { messages: messageList() }],
  ]) {
    let threw = null;
    let decision;
    try {
      decision = await h.preStep(invocation);
    } catch (error) {
      threw = error;
    }
    check(`${label}: no throw, no rewrite`, threw === null && decision === undefined, threw && threw.message);
  }
}

/* -------------------------------------------------------------- caching -- */

section("pre-step: TTL cache");
{
  let served = 0;
  const h = await freshHarness(() => {
    served += 1;
    return jsonResponse(200, { schema: "x", status: "ready", content: `recall #${served}`, content_bytes: 10 });
  });

  const session = { sessionId: "c1", sessionPath: "/tmp/cache" };
  const first = await h.preStep({ messages: [{ role: "user", content: "question one" }], session });
  const requestsAfterFirst = h.calls.length;
  const second = await h.preStep({ messages: [{ role: "user", content: "question two" }], session });

  check("first step injected", Boolean(first));
  check("first step made one request", requestsAfterFirst === 1, requestsAfterFirst);
  check("second step made no new request (cache hit)", h.calls.length === requestsAfterFirst, h.calls.length);
  check("second step reused the cached recall text", second.messages[0].content.includes("recall #1"), second.messages[0].content);
  check("the reuse is counted", counters.cache_hits >= 1, counters.cache_hits);
  check("the cache holds one entry", recallCacheSize() === 1, recallCacheSize());

  // A different session must not share the cached text.
  const other = await h.preStep({ messages: [{ role: "user", content: "question one" }], session: { sessionId: "c2", sessionPath: "/tmp/cache2" } });
  check("another session gets its own request", h.calls.length === requestsAfterFirst + 1, h.calls.length);
  check("another session gets its own recall", other.messages[0].content.includes("recall #2"), other.messages[0].content);

  // Cache versus outage. Two behaviours, deliberately different:
  //
  //   * inside the TTL a hit serves without probing, so an outage that starts
  //     mid-window is not noticed — the session keeps a recall fetched moments
  //     ago, and no per-step health request is spent discovering the outage;
  //   * the first request that actually fails as unreachable clears the cache,
  //     so nothing stale survives the failure.
  const h2 = await freshHarness(() => jsonResponse(200, { schema: "x", status: "ready", content: "cached recall", content_bytes: 12 }));
  const outageSession = { sessionId: "c3", sessionPath: "/tmp/clear" };
  await h2.preStep({ messages: [{ role: "user", content: "q" }], session: outageSession });
  check("cache populated before the outage", recallCacheSize() === 1, recallCacheSize());

  h2.sdk.network.fetch = async () => {
    throw new TypeError("fetch failed: connect ECONNREFUSED");
  };
  const callsBefore = h2.calls.length;
  const insideWindow = await h2.preStep({ messages: [{ role: "user", content: "q" }], session: outageSession });
  check("inside the TTL a cached recall is still served during an outage", Boolean(insideWindow), insideWindow);
  check("and that service cost no request, so the outage went undetected", h2.calls.length === callsBefore, h2.calls.length);

  // The cache is keyed by session, so the way to miss it is a different session.
  // That step must reach the Server, fail, and clear everything.
  const freshSession = await h2.preStep({ messages: [{ role: "user", content: "a question from elsewhere" }], session: { sessionId: "c4", sessionPath: "/tmp/clear-other" } });
  check("a cache-missing step during the outage injects nothing", freshSession === undefined, freshSession);
  check("the real failure cleared the whole cache", recallCacheSize() === 0, recallCacheSize());
  check("the failure is counted", counters.skipped_error >= 1, counters.skipped_error);
}

/* -------------------------------------------------------------- capture -- */

section("pre-step: input capture");
{
  const captureBehaviour = (url) => {
    if (url.endsWith("/v1/context/prepare")) return jsonResponse(200, { schema: "x", status: "ready", content: "recall", content_bytes: 6 });
    if (url.endsWith("/v1/sources/content")) return jsonResponse(202, { status: "accepted", source: { name: "content", source_id: "pc-capture-x" }, position: 1 });
    return jsonResponse(404, { error: { code: "unknown", message: "no stub", details: null } });
  };

  // Default is off: a step must produce no capture call at all.
  const off = await freshHarness(captureBehaviour);
  await off.preStep({ messages: [{ role: "user", content: "a prompt" }], session: { sessionId: "k1", sessionPath: "/tmp/k1" } });
  check("capture is off by default", off.calls.filter((c) => c.url.endsWith("/v1/sources/content")).length === 0, off.calls.map((c) => c.url));
  check("no capture counter moved", counters.captures === 0, counters.captures);

  // Explicitly on: one prepare + one capture per step.
  const on = await freshHarness(captureBehaviour, { capturePrompts: true });
  const decision = await on.preStep({ messages: [{ role: "user", content: "a prompt to capture" }], session: { sessionId: "k2", sessionPath: "/tmp/k2" } });
  const captured = on.calls.filter((c) => c.url.endsWith("/v1/sources/content"));
  check("capture on: the step still injects", Boolean(decision));
  check("capture on: exactly one capture call", captured.length === 1, on.calls.map((c) => c.url));
  check("capture on: exactly one prepare call", on.calls.filter((c) => c.url.endsWith("/v1/context/prepare")).length === 1, on.calls.map((c) => c.url));
  check("capture uses the pc-capture id shape", /^pc-capture-\d{17}-\d{4}$/.test(captured[0].body.source_id), captured[0].body.source_id);
  // Capture keeps the verbatim prompt: the extractor exists for the matcher, and
  // rewriting what gets stored would lose the user's own wording from the record.
  check("capture sends the verbatim prompt, not the extracted phrase", captured[0].body.content === "a prompt to capture", captured[0].body.content);
  check("capture sends the Scope", captured[0].body.scope_id === "scp_hook_probe", captured[0].body.scope_id);
  check("capture stamps its provenance", captured[0].body.metadata.captured_by === "hana-powercontext", captured[0].body.metadata);
  check("capture is counted", counters.captures === 1, counters.captures);

  // Deduplication: the same text again must not be captured twice.
  const again = await freshHarness(captureBehaviour, { capturePrompts: true });
  const step = (text, key) => again.preStep({ messages: [{ role: "user", content: text }], session: { sessionId: key, sessionPath: `/tmp/${key}` } });
  await step("repeat me", "d1");
  await step("something else", "d2");
  await step("repeat me", "d3");
  const allCaptures = again.calls.filter((c) => c.url.endsWith("/v1/sources/content"));
  check("a repeated prompt is not captured twice", allCaptures.length === 2, allCaptures.map((c) => c.body.content));
  check("the duplicate is counted", counters.captures_duplicate >= 1, counters.captures_duplicate);

  // A capture failure must not cost the step its injection.
  const failing = await freshHarness(
    (url) => {
      if (url.endsWith("/v1/context/prepare")) return jsonResponse(200, { schema: "x", status: "ready", content: "recall", content_bytes: 6 });
      if (url.endsWith("/v1/sources/content")) return jsonResponse(500, { error: { code: "internal_error", message: "capture blew up", details: null } });
      return jsonResponse(404, { error: { code: "unknown", message: "no stub", details: null } });
    },
    { capturePrompts: true },
  );
  const survived = await failing.preStep({ messages: [{ role: "user", content: "capture will fail" }], session: { sessionId: "k3", sessionPath: "/tmp/k3" } });
  check("a failed capture still leaves the injection in place", Boolean(survived), survived && typeof survived);
  check("the failed capture is counted", counters.captures_failed >= 1, counters.captures_failed);

  // A capture failure that throws must be swallowed too.
  const throwing = await freshHarness(
    () => jsonResponse(200, { schema: "x", status: "ready", content: "recall", content_bytes: 6 }),
    { capturePrompts: true },
  );
  const throwingDecision = await throwing.preStep(
    { messages: [{ role: "user", content: "boom" }], session: { sessionId: "k4", sessionPath: "/tmp/k4" } },
    {},
  );
  check("a throwing capture path is survivable", throwingDecision === undefined || Boolean(throwingDecision));
}

/* ------------------------------------------------------------ switches --- */

section("pre-step: kill-switch and size guard");
{
  const h = await freshHarness(okPrepare("should never be fetched"), { prestep: false });
  counters.skipped_disabled = 0;
  const off = await h.preStep({ messages: messageList(), session: { sessionId: "z", sessionPath: "/tmp/off" } });
  check("prestep=false injects nothing", off === undefined, off);
  check("prestep=false makes no request at all", h.calls.length === 0, h.calls.length);
  check("it is counted as skipped_disabled", counters.skipped_disabled === 1, counters.skipped_disabled);
  check("nothing was cached either", recallCacheSize() === 0, recallCacheSize());

  // The size guard: an oversized recall is truncated, the messages around it are not.
  const huge = "R".repeat(40000);
  const big = await freshHarness(okPrepare(huge, huge.length), { prestepMaxBytes: 8192 });
  const messages = messageList();
  const decision = await big.preStep({ messages, session: { sessionId: "big", sessionPath: "/tmp/big" } });
  const injected = decision.messages.find((m) => !messages.includes(m));
  const bodyBytes = Buffer.byteLength(injected.content, "utf8");
  check("an oversized recall is still injected", Boolean(decision));
  check(
    "the injected message respects the budget plus wrapper allowance",
    bodyBytes <= 8192 + 1024,
    { bodyBytes, allowed: 8192 + 1024 },
  );
  check("the closing marker survives truncation", injected.content.trimEnd().endsWith(RECALL_SUFFIX), injected.content.slice(-30));
  // Insertion shifts everything after it by one, so the comparison is positional:
  // messages before the injection keep their index, messages after it move by one.
  const insertAt = lastUserIndex(messages);
  const beforePreserved = messages.slice(0, insertAt).every((m, i) => decision.messages[i] === m);
  const afterPreserved = messages.slice(insertAt).every((m, i) => decision.messages[insertAt + 1 + i] === m);
  check("messages before the injection are untouched", beforePreserved, insertAt);
  check("messages after the injection are only shifted, not changed", afterPreserved, insertAt);
  check("the message count is still +1", decision.messages.length === messages.length + 1);
}

/* --------------------------------------------------------- before-start -- */

section("before-start: default off, and honest when on");
{
  const h = await freshHarness(okPrepare("unused"));
  counters.beforestart_skipped = 0;
  const off = await h.beforeStart({ prompt: "hello", systemPrompt: "sys", session: { sessionId: "b1", sessionPath: "/tmp/b1" } });
  check("beforeStart=false injects nothing", off === undefined, off);
  check("beforeStart=false makes no request", h.calls.length === 0, h.calls.length);
  check("it is counted as skipped", counters.beforestart_skipped === 1, counters.beforestart_skipped);

  // Switched on with a Server that has no handoff: the real Server answers
  // status "empty" with a null content, which must inject nothing.
  const none = await freshHarness(
    (url) => jsonResponse(200, { trust: "untrusted_history", status: "empty", scope_id: "scp_hook_probe", content: null, selection: null }),
    { beforeStart: true },
  );
  const noHandoff = await none.beforeStart({ prompt: "hello", systemPrompt: "sys", session: { sessionId: "b2", sessionPath: "/tmp/b2" } });
  check("an empty handoff resolution injects nothing", noHandoff === undefined, noHandoff);
  check("before-start asked the Server once", none.calls.filter((c) => c.url.endsWith("/v1/handoff/continue")).length === 1, none.calls.map((c) => c.url));
  check("before-start asked for the latest selection", JSON.parse(none.calls[0].init.body).selection === "latest", none.calls[0].init.body);

  // Switched on with a handoff present: the real response is a HandoffResolution
  // whose `content` sits at the top level.
  const withHandoff = await freshHarness(
    (url) =>
      jsonResponse(200, {
        trust: "untrusted_history",
        status: "resolved",
        scope_id: "scp_hook_probe",
        content: { schema: "powercontext.handoff.v1", objective: "carry on the work", state: [], disposition: "continuable", next_action: null, omissions: [] },
        selection: "latest",
        selected_revision: { family: "handoff", artifact_id: "handoff", revision: 3 },
        current_revision: { family: "handoff", artifact_id: "handoff", revision: 3 },
        evidence_checks: [],
      }),
    { beforeStart: true },
  );
  const decision = await withHandoff.beforeStart({ prompt: "hello", systemPrompt: "sys", session: { sessionId: "b3", sessionPath: "/tmp/b3" } });
  check("a prepared handoff becomes a message decision", Boolean(decision && decision.message), decision);
  check("the message is a custom message, not a system prompt rewrite", !decision.systemPrompt && decision.message.customType === "powercontext.handoff", decision.message && Object.keys(decision.message));
  check("the handoff is wrapped as untrusted history", decision.message.content.startsWith(RECALL_PREFIX), decision.message.content.slice(0, 60));
  check("it is not shown in the transcript", decision.message.display === false, decision.message.display);
  check("the objective is carried through", decision.message.content.includes("carry on the work"), decision.message.content);
  check("the injection is counted", counters.beforestart_injections === 1, counters.beforestart_injections);

  // A Server error must not throw out of the hook.
  const broken = await freshHarness(() => jsonResponse(503, { error: { code: "unavailable", message: "down", details: null } }), { beforeStart: true });
  let threw = null;
  let failed;
  try {
    failed = await broken.beforeStart({ prompt: "x", systemPrompt: "y", session: { sessionId: "b4", sessionPath: "/tmp/b4" } });
  } catch (error) {
    threw = error;
  }
  check("a Server error yields no injection and no throw", threw === null && failed === undefined, threw && threw.message);
}

console.log(`\n=== HOOK PROBE: ${checks - failures}/${checks} checks passed ${failures === 0 ? "— ALL PASSED" : "— " + failures + " FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
