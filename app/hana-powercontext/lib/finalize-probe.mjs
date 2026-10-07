/**
 * lib/finalize-probe.mjs — closes the third step of the handoff flow.
 *
 * The real Server on this machine reports `handoff_generation: disabled`, because
 * its middle step is model-driven and no generation provider is configured. That
 * makes the positive path impossible to reach against it — and an untested third
 * step is exactly where a wrong payload shape hides.
 *
 * So this stands up a small local HTTP server that speaks the four endpoints the
 * handoff flow uses, in the shapes the real Server documents, and then runs the
 * App's own `callHandoffPrepare` against it over real sockets. Everything except
 * the Server's model is genuine: real HTTP, the real client, the real request
 * bodies, the real response parsing. It proves the finalize request is built
 * correctly and that the finalized carrier survives the round trip intact.
 *
 * Run: node app/hana-powercontext/lib/finalize-probe.mjs
 */

import { createServer } from "node:http";
import { resolveConfig } from "./config.js";
import { callHandoffPrepare } from "./tools.js";

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  [PASS] ${label}`);
  } else {
    failures += 1;
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : "  -> " + JSON.stringify(detail)}`);
  }
}

/** Recorded requests, so the probe can assert on what the client actually sent. */
const received = [];

/** The draft the simulated generation step produces. */
const DRAFT = {
  objective: "close the handoff flow",
  state: [
    {
      text: "the boundary Source was captured",
      citations: [{ kind: "source", source_ref: { name: "content", source_id: "" } }],
    },
  ],
  disposition: "continuable",
  next_action: { text: "hand the carrier to the next session", citations: [] },
  omissions: [{ text: "the simulation is not real work", citation: null }],
  generation: null,
};

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : undefined;
    received.push({ path: req.url, method: req.method, body });

    if (req.url === "/v1/scopes/default") {
      return send(res, 200, { scope_id: "scp_simulated", title: "Simulated", summary: "Simulated default context" });
    }
    if (req.url === "/v1/sources/content") {
      // Exactly the real Server's shape: {name, source_id}.
      return send(res, 202, { status: "accepted", source: { name: "content", source_id: body.source_id }, position: 1 });
    }
    if (req.url === "/v1/handoff/prepare") {
      // The real Server answers 503 here when there is no provider. With one, it
      // answers with the Draft itself as the whole body.
      const draft = JSON.parse(JSON.stringify(DRAFT));
      draft.objective = body.objective;
      draft.state[0].citations[0].source_ref = body.evidence[0].source_ref;
      return send(res, 200, draft);
    }
    if (req.url === "/v1/handoff/finalize") {
      const draft = body.draft;
      // The real Server wraps the Draft's content into the prepared carrier.
      return send(res, 200, {
        schema: "powercontext.prepared-handoff.v1",
        scope_id: body.scope_id,
        base: null,
        content: {
          schema: "powercontext.handoff.v1",
          objective: draft.objective,
          state: draft.state,
          disposition: draft.disposition,
          next_action: draft.next_action,
          omissions: draft.omissions,
        },
        generation: draft.generation,
      });
    }
    return send(res, 404, { error: { code: "not_found", message: "no simulated route for " + req.url, details: null } });
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
console.log(`=== finalize probe against simulated Server at ${baseUrl} ===\n`);

const sdk = { dataDir: null, network: { fetch: async (u, i) => fetch(u, { ...i, body: i.body }) } };
// Pin the Scope so the recorded request list is the handoff flow alone. Leaving
// it unset adds a `/v1/scopes/default` lookup, which is correct behaviour but
// blurs the count this probe is here to assert.
const config = resolveConfig(sdk, { baseUrl, timeoutMs: 5000, scopeId: "scp_simulated" });

const result = await callHandoffPrepare(sdk, config, {
  objective: "close the handoff flow",
  state: ["the boundary Source was captured"],
  next_action: "hand the carrier to the next session",
  disposition: "continuable",
  omissions: ["the simulation is not real work"],
});

const text = (result.content || []).map((p) => p.text || "").join("\n");
const paths = received.map((r) => r.path);
const prepareReq = received.find((r) => r.path === "/v1/handoff/prepare");
const finalizeReq = received.find((r) => r.path === "/v1/handoff/finalize");
const captureReq = received.find((r) => r.path === "/v1/sources/content");

console.log("--- result text ---");
console.log(text);
console.log();

check("the flow succeeded end to end", result.isError !== true, text.slice(0, 300));
check(
  "it used the three handoff endpoints in order",
  JSON.stringify(paths) === JSON.stringify(["/v1/sources/content", "/v1/handoff/prepare", "/v1/handoff/finalize"]),
  paths,
);
check("capture carried a uniquely suffixed boundary id", /^pc-handoff-\d{17}-\d{4}$/.test(captureReq.body.source_id), captureReq.body.source_id);
check("prepare cited the exact captured Source object", JSON.stringify(prepareReq.body.evidence) === JSON.stringify([{ kind: "source", source_ref: { name: "content", source_id: captureReq.body.source_id } }]), prepareReq.body.evidence);
check("prepare carried the objective", prepareReq.body.objective === "close the handoff flow", prepareReq.body.objective);
check("prepare carried a byte budget", Number.isInteger(prepareReq.body.max_bytes), prepareReq.body.max_bytes);
check("finalize received the Draft unwrapped", finalizeReq.body.draft && finalizeReq.body.draft.ok === undefined && finalizeReq.body.draft.data === undefined, Object.keys(finalizeReq.body.draft || {}));
check("finalize received the full Draft, not a summary", Array.isArray(finalizeReq.body.draft.state) && finalizeReq.body.draft.next_action !== undefined && Array.isArray(finalizeReq.body.draft.omissions), Object.keys(finalizeReq.body.draft || {}));
check("finalize was not handed scope_id/schema/content as draft fields", !("scope_id" in finalizeReq.body.draft) && !("schema" in finalizeReq.body.draft) && !("content" in finalizeReq.body.draft), Object.keys(finalizeReq.body.draft));
check("the finalized carrier is returned whole", result.details.finalized && result.details.finalized.schema === "powercontext.prepared-handoff.v1", result.details.finalized && Object.keys(result.details.finalized));
check("the carrier keeps its content block", result.details.finalized.content && result.details.finalized.content.objective === "close the handoff flow", result.details.finalized.content);
check("the carrier is attributed to the scope", result.details.finalized.scope_id === "scp_simulated", result.details.finalized.scope_id);
check("the Draft is surfaced alongside it", result.details.draft && result.details.draft.objective === "close the handoff flow", result.details.draft && Object.keys(result.details.draft));
check("the carrier is readable in the text output", /"schema": "powercontext.prepared-handoff.v1"/.test(text), text.slice(-300));
check("exactly three requests were made", received.length === 3, paths);
check("no commit was attempted", !paths.some((p) => p.includes("commit")), paths);

server.close();
console.log();
console.log(`=== FINALIZE PROBE: ${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"} ===`);
process.exit(failures === 0 ? 0 : 1);
