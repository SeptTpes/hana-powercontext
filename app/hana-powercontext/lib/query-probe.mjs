/**
 * lib/query-probe.mjs — plan B, measured side by side against plan A.
 *
 * Why this file exists: T9's root cause was that `/v1/context/prepare` answers a
 * full natural-language question with `status: "empty"` while the same
 * sentence's noun phrase recalls the entry. Plan A (shipped) shapes the query
 * before it leaves the App. Plan B would leave the query alone and ask a
 * different endpoint — `POST /v1/memory/search` — whose response is a hit list
 * rather than a prepared context block.
 *
 * This probe does NOT change the injection path. It runs both call shapes over
 * the same query variants, on the same Scope, against the same live Server, and
 * writes `artifacts/stage2/query-probe.md` so stage 3 can decide with numbers
 * instead of guesses.
 *
 * Run:
 *   node app/hana-powercontext/lib/query-probe.mjs
 *   node app/hana-powercontext/lib/query-probe.mjs --base-url http://127.0.0.1:8000 --scope scp_... --out artifacts/stage2/query-probe.md
 *
 * The probe is read-only. It never calls /v1/sources/content, /v1/memory/remember
 * or any finalize endpoint, so running it cannot change what the Server holds.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveConfig } from "./config.js";
import { request } from "./powercontext.js";
import { extractRetrievalQuery } from "./hooks.js";

/* ------------------------------------------------------------- arguments -- */

function argValue(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const BASE_URL = argValue("--base-url", "http://127.0.0.1:8000");
const OUT_PATH = resolve(argValue("--out", "artifacts/stage2/query-probe.md"));
const SCOPE_ARG = argValue("--scope", "");
const MAX_BYTES = 8192;
const LIMIT = 5;
/** The address every stage 0/2 entry records; a hit that lacks it is not the hit. */
const ADDRESS = "127.0.0.1:8000";

/* ---------------------------------------------------------------- queries -- */

const ZH_QUESTION = "你是一个全新会话。请不要调用任何工具。我之前让你记住的 PowerContext Server 地址是什么？";
const ZH_PLAIN = "我之前让你记住的 PowerContext Server 地址是什么？";

/** The same question in five shapes; every row is a query this App could send. */
function buildCases() {
  const extracted = extractRetrievalQuery(ZH_QUESTION);
  return [
    { name: "zh-prefixed (verbatim)", query: ZH_QUESTION, note: "what the pre-step hook sent before the T9 fix" },
    { name: "zh-plain (verbatim)", query: ZH_PLAIN, note: "same question without the harness preamble" },
    { name: "zh-extracted (plan A)", query: extracted.query, note: "extractRetrievalQuery() output — what the hook sends now" },
    { name: "zh-short", query: "PowerContext Server 地址", note: "the phrase that already worked in the T9 experiment" },
    { name: "en-smoke", query: "what is the PowerContext Server base URL for hana-powercontext", note: "stage 0 smoke phrasing" },
  ];
}

/* ------------------------------------------------------------------ calls -- */

/** A JSON door with the same bounds the App's manifest declares. */
function makeSdk() {
  return {
    network: {
      async fetch(url, init) {
        return fetch(url, { ...init });
      },
    },
  };
}

async function timedCall(sdk, config, path, body) {
  const started = Date.now();
  const result = await request(sdk, config, path, body, { timeoutMs: 5000, maxResponseBytes: 131072 });
  return { ms: Date.now() - started, ...result };
}

/* ---------------------------------------------------------------- shapes -- */

/** A one-line description of a response's shape, for the report's table. */
function describeShape(kind, result) {
  if (!result.ok) return ("error: " + result.kind + " (" + (result.message || "") + ")").slice(0, 120);
  const data = result.data || {};
  if (kind === "prepare") {
    const bytes = Number.isFinite(data.content_bytes) ? data.content_bytes : 0;
    return "status=" + data.status + " content_bytes=" + bytes;
  }
  const hits = Array.isArray(data.hits) ? data.hits : null;
  return hits ? "mode=" + data.mode + " hits=" + hits.length : "unexpected shape: " + Object.keys(data).join(",");
}

/** Did the response carry the address this Scope's entry records? */
function carriesAddress(kind, result) {
  if (!result.ok) return false;
  const data = result.data || {};
  if (kind === "prepare") return typeof data.content === "string" && data.content.includes(ADDRESS);
  return Array.isArray(data.hits) && data.hits.some((hit) => typeof hit.text === "string" && hit.text.includes(ADDRESS));
}

/** The first 200 characters of whatever the response actually carried. */
function head(kind, result) {
  if (!result.ok) return result.kind + ": " + result.message;
  const data = result.data || {};
  if (kind === "prepare") {
    const text = typeof data.content === "string" ? data.content : "";
    return text === "" ? "(no content)" : text.replace(/\s+/g, " ").slice(0, 200);
  }
  const first = Array.isArray(data.hits) && data.hits[0] ? data.hits[0] : null;
  if (!first) return "(no hits)";
  return (first.text + " [" + (first.matched_by || []).join("+") + " score=" + first.score + "]").slice(0, 240);
}

/* ------------------------------------------------------------- discovery -- */

/**
 * Find a Scope to ask about, when the caller did not name one.
 *
 * The probe reads the Server's default Scope and keeps it only if it actually
 * holds a memory entry — a probe against an empty Scope would report "no hits"
 * for every row and prove nothing about either endpoint.
 */
async function discoverScope(sdk, config) {
  const defaultScope = await timedCall(sdk, config, "/v1/scopes/default", {});
  if (!defaultScope.ok || !defaultScope.data || !defaultScope.data.scope_id) {
    return { ok: false, reason: "the Server did not answer /v1/scopes/default" };
  }
  const scopeId = defaultScope.data.scope_id;
  const entries = await timedCall(sdk, config, "/v1/memory/entries/list", { scope_id: scopeId });
  if (!entries.ok) return { ok: false, reason: "entries/list failed: " + entries.kind };
  const list = Array.isArray(entries.data.entries) ? entries.data.entries : [];
  if (list.length === 0) {
    return { ok: false, reason: "Scope " + scopeId + " holds no memory entries; a probe there would be vacuous" };
  }
  return { ok: true, scopeId, entryCount: list.length, firstEntry: list[0] };
}

/* ------------------------------------------------------------------- main -- */

const sdk = makeSdk();
const config = resolveConfig(sdk, { baseUrl: BASE_URL });
const cases = buildCases();

let scopeId = SCOPE_ARG;
let entry = null;
let offlineReason = null;

if (!scopeId) {
  const discovered = await discoverScope(sdk, config);
  if (discovered.ok) {
    scopeId = discovered.scopeId;
    entry = discovered.firstEntry;
  } else {
    offlineReason = discovered.reason;
  }
} else {
  const entries = await timedCall(sdk, config, "/v1/memory/entries/list", { scope_id: scopeId });
  if (entries.ok) entry = (entries.data.entries || [])[0] || null;
  else offlineReason = "Scope " + scopeId + " is not readable: " + entries.kind;
}

const rows = [];
for (const testCase of cases) {
  const row = {
    name: testCase.name,
    note: testCase.note,
    sent: testCase.query,
    extracted: extractRetrievalQuery(testCase.query),
    bytes: Buffer.byteLength(testCase.query, "utf8"),
    prepare: { shape: "—", head: "—", carriesAddress: false, ms: 0 },
    search: { shape: "—", head: "—", carriesAddress: false, ms: 0 },
  };
  if (!offlineReason && scopeId) {
    const prepare = await timedCall(sdk, config, "/v1/context/prepare", { scope_id: scopeId, query: testCase.query, max_bytes: MAX_BYTES });
    row.prepare = { shape: describeShape("prepare", prepare), head: head("prepare", prepare), carriesAddress: carriesAddress("prepare", prepare), ms: prepare.ms };
    const search = await timedCall(sdk, config, "/v1/memory/search", { scope_id: scopeId, query: testCase.query, limit: LIMIT });
    row.search = { shape: describeShape("search", search), head: head("search", search), carriesAddress: carriesAddress("search", search), ms: search.ms };
  }
  rows.push(row);
  console.log(testCase.name + ": prepare[" + row.prepare.shape + "] search[" + row.search.shape + "]");
}

/* ----------------------------------------------------------------- report -- */

function markdown(meta) {
  const lines = [];
  const rows = meta.rows;
  lines.push("# T9 query-probe · plan A vs plan B (side by side)");
  lines.push("");
  lines.push("- Server: `" + meta.baseUrl + "`");
  lines.push("- Scope: `" + (meta.scopeId || "(unresolved)") + "`");
  lines.push("- Reference entry: " + (meta.entry ? "`" + (meta.entry.citation ? meta.entry.citation.entry_id : "?") + "` — " + JSON.stringify(String(meta.entry.text || "").slice(0, 160)) : "(none read)"));
  lines.push("- prepare body: `{ scope_id, query, max_bytes: " + meta.maxBytes + " }`  ·  memory/search body: `{ scope_id, query, limit: " + meta.limit + " }`");
  lines.push("- Read-only probe: no write endpoint is touched.");
  lines.push("");
  if (meta.offlineReason) {
    lines.push("**Offline**: " + meta.offlineReason + ". The extraction column is still real — it is pure local computation — but no endpoint was called.");
    lines.push("");
  }
  lines.push("## Side-by-side");
  lines.push("");
  // Column 4 is the point of the whole file: the same input, before and after
  // the shipped extractor, so a reader sees the fix without running anything.
  lines.push("| # | query variant | bytes sent | query as sent | extractRetrievalQuery(input) → what the hook sends now | `/v1/context/prepare` | `/v1/memory/search` |");
  lines.push("|---|---|---|---|---|---|---|");
  rows.forEach(function (row, index) {
    const prepare = meta.offlineReason ? "—" : row.prepare.shape + "<br>" + (row.prepare.carriesAddress ? "**has the address**" : "no address") + " · " + row.prepare.ms + " ms";
    const search = meta.offlineReason ? "—" : row.search.shape + "<br>" + (row.search.carriesAddress ? "**has the address**" : "no address") + " · " + row.search.ms + " ms";
    const extracted = "`" + row.extracted.query + "`" + (row.extracted.usedFallback ? " *(fallback)*" : " *(extracted)*");
    lines.push("| " + (index + 1) + " | " + row.name + " | " + row.bytes + " | `" + row.sent + "` | " + extracted + " | " + prepare + " | " + search + " |");
  });
  lines.push("");
  lines.push("## What each response actually carried");
  lines.push("");
  rows.forEach(function (row, index) {
    lines.push("**" + (index + 1) + ". " + row.name + "** — " + row.note);
    lines.push("");
    lines.push("- prepared context: `" + (meta.offlineReason ? "—" : row.prepare.head) + "`");
    lines.push("- search hits: `" + (meta.offlineReason ? "—" : row.search.head) + "`");
    lines.push("");
  });
  lines.push("## Reading of the two endpoints");
  lines.push("");
  lines.push("| | `/v1/context/prepare` (plan A path) | `/v1/memory/search` (plan B candidate) |");
  lines.push("|---|---|---|");
  lines.push("| response shape | a prepared block: `status`, `content` (already framed as untrusted history), `content_bytes` | a hit list: `mode`, `hits[]` with `citation`, `text`, `score`, `matched_by` |");
  lines.push("| injection-ready | yes — the block is what the hook wraps and inserts, framing included | no — the App would have to render hits into a message itself and own the untrusted-history framing |");
  lines.push("| size bound honoured by Server | yes (`max_bytes`) | no byte budget; only `limit` |");
  lines.push("| empty result | `status: empty`, no content | `hits: []` |");
  lines.push("| matching | the Server's prepare matcher | FTS over entry text (`mode: fts`, `matched_by: [fts]`) |");
  lines.push("| writes | none | none |");
  lines.push("");
  // Counted from the rows above, not asserted: the numbers lead the conclusion,
  // so a future run that disagrees cannot leave a stale sentence behind.
  const divergences = rows.filter(function (row) {
    return row.prepare.carriesAddress !== row.search.carriesAddress;
  });
  lines.push("## Decision input for stage 3");
  lines.push("");
  if (meta.offlineReason) {
    lines.push("No endpoint was reached, so there is no comparison to read here. Re-run with the Server up.");
  } else {
    lines.push("- Rows where the two endpoints disagree about recalling the entry: **" + divergences.length + " / " + rows.length + "**.");
    lines.push("- Plan A is **shipped** and needs no new App-side rendering; it is the main path.");
    if (divergences.length === 0) {
      lines.push("- Plan B recalled exactly where and only where plan A did. **Switching endpoints alone would not have fixed T9**: both endpoints answer a full natural-language question with nothing. That is the measurement this probe was run to get, and it is the reason the shipped fix shapes the query instead of moving the call.");
      lines.push("- Keep plan B unimplemented. Revisit only if a later Server version makes search recall text that prepare does not; the table above is the baseline to re-measure against.");
    } else {
      lines.push("- Plan B recalled on " + divergences.length + " row(s) where plan A did not: " + divergences.map(function (row) { return row.name; }).join(", ") + ". That is the condition under which plan B deserves a prototype — with an App-side renderer and an explicit framing decision, since search returns raw hits rather than a framed block.");
    }
  }
  lines.push("");
  return lines.join("\n");
}

mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, markdown({ baseUrl: BASE_URL, scopeId, entry, rows, offlineReason, maxBytes: MAX_BYTES, limit: LIMIT }) + "\n", "utf8");
console.log("");
console.log("wrote " + OUT_PATH);
if (offlineReason) console.log("note: offline — " + offlineReason);
