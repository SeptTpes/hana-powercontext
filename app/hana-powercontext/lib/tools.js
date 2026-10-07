/**
 * lib/tools.js — scope resolution, the three model-callable tools, and the
 * `/pc` command handlers.
 *
 * Every entry point returns a normal result in both directions. A Server
 * failure becomes a result whose text states what failed and what to do about
 * it; it is never an exception thrown through the model loop, because a thrown
 * tool failure makes a turn look broken when the real problem is simply that a
 * local Server is not running.
 */

import { request } from "./powercontext.js";

export const MEMORY_KINDS = Object.freeze([
  "project-fact",
  "decision",
  "convention",
  "gotcha",
  "reference",
  "preference",
]);

export const HANDOFF_DISPOSITIONS = Object.freeze(["continuable", "blocked", "complete"]);

/** Mirrors the Server's own schema bound for a single memory entry. */
const MAX_MEMORY_BYTES = 8192;

/** UTF-8 byte length, so the Server's limit is enforced the same way it is. */
export function utf8Bytes(text) {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : Buffer.byteLength(text, "utf8");
}

function missing(value, name) {
  return typeof value !== "string" || value.trim() === ""
    ? `\`${name}\` is required and must be a non-empty string.`
    : null;
}

function textResult(text, details) {
  return details === undefined ? { content: [{ type: "text", text }] } : { content: [{ type: "text", text }], details };
}

/**
 * Render a client failure as a short block a model can act on. `changed` lets the
 * write paths state plainly that nothing was persisted, which is the first thing
 * a caller needs to know after a failed write.
 */
function failureResult(toolName, error, { changed = false } = {}) {
  const lines = [`${toolName} failed: ${error.message}`];
  if (error.serverCode) lines.push(`server code: ${error.serverCode}`);
  if (error.hint) lines.push(`hint: ${error.hint}`);
  if (!changed) lines.push("No changes were made on the PowerContext Server.");
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    isError: true,
    details: {
      ok: false,
      kind: error.kind,
      status: error.status ?? null,
      baseUrl: error.url ?? null,
      // The Server's own error code and field-level details are what let a caller
      // (or a test) tell "that Scope does not exist" apart from "the Server is
      // down" without re-parsing the message text.
      serverCode: error.serverCode ?? null,
      serverDetails: error.details ?? null,
    },
  };
}

/**
 * Resolve the Scope a call should act on, in priority order:
 *   1. the call's own `scope_id` argument
 *   2. POWERCONTEXT_HANA_SCOPE_ID / the app-data config
 *   3. the Server's default Scope
 *
 * The fallback costs one extra round trip on purpose: an implicit default that
 * silently pointed at an unintended Scope would mix unrelated projects' memories
 * together, which is worse than one request.
 */
export async function resolveScope(sdk, config, explicit) {
  if (typeof explicit === "string" && explicit.trim() !== "") {
    return { ok: true, scopeId: explicit.trim(), source: "argument" };
  }
  if (config.scopeId) {
    return { ok: true, scopeId: config.scopeId, source: "config" };
  }

  const response = await request(sdk, config, "/v1/scopes/default", undefined, { method: "GET" });
  if (!response.ok) return response;

  const scopeId = response.data && response.data.scope_id;
  if (!scopeId) {
    return {
      ok: false,
      kind: "no_default_scope",
      message: "The Server reported no default Scope.",
      hint: "Pass scope_id explicitly, or set POWERCONTEXT_HANA_SCOPE_ID.",
    };
  }
  return { ok: true, scopeId, source: "server-default", scope: response.data };
}

/* ------------------------------------------------------------------ tools -- */

/** POST /v1/memory/remember */
export async function callRemember(sdk, config, args = {}) {
  const problem = missing(args.text, "text");
  if (problem) return { content: [{ type: "text", text: `pc_remember: ${problem}` }], isError: true };

  const bytes = utf8Bytes(args.text);
  if (bytes > MAX_MEMORY_BYTES) {
    return {
      content: [
        {
          type: "text",
          text:
            `pc_remember: text is ${bytes} UTF-8 bytes, over the Server's ${MAX_MEMORY_BYTES}-byte limit. ` +
            "Split it into several focused entries.",
        },
      ],
      isError: true,
    };
  }

  const scope = await resolveScope(sdk, config, args.scope_id);
  if (!scope.ok) return failureResult("pc_remember", scope);

  const kind = typeof args.kind === "string" && args.kind.trim() !== "" ? args.kind.trim() : "project-fact";
  const body = { scope_id: scope.scopeId, kind, text: args.text };
  if (typeof args.reason === "string" && args.reason.trim() !== "") body.reason = args.reason;

  const response = await request(sdk, config, "/v1/memory/remember", body);
  if (!response.ok) return failureResult("pc_remember", response);

  const entry = (response.data && response.data.entry) || null;
  const memory = (response.data && response.data.memory) || null;

  return textResult(
    [
      `Remembered in scope ${scope.scopeId} (scope from: ${scope.source}).`,
      entry ? `entry_id: ${entry.citation.entry_id}` : null,
      `kind: ${kind}`,
      memory ? `memory revision: ${memory.revision}` : null,
      "Recall is available immediately to any other session bound to this scope.",
    ]
      .filter(Boolean)
      .join("\n"),
    { ok: true, scopeId: scope.scopeId, scopeSource: scope.source, entry, memory },
  );
}

/** POST /v1/memory/entries/list */
export async function callMemoryList(sdk, config, args = {}) {
  const scope = await resolveScope(sdk, config, args.scope_id);
  if (!scope.ok) return failureResult("pc_memory_list", scope);

  const response = await request(sdk, config, "/v1/memory/entries/list", {
    scope_id: scope.scopeId,
    include_inactive: args.include_inactive === true,
  });
  if (!response.ok) return failureResult("pc_memory_list", response);

  const entries = (response.data && response.data.entries) || [];
  const memory = (response.data && response.data.memory) || null;

  if (entries.length === 0) {
    return textResult(`No memory entries in scope ${scope.scopeId}.`, {
      ok: true,
      scopeId: scope.scopeId,
      count: 0,
      entries: [],
    });
  }

  const header =
    `${entries.length} memory entr${entries.length === 1 ? "y" : "ies"} in scope ${scope.scopeId}` +
    (memory ? ` (memory revision ${memory.revision})` : "") +
    ":";

  const lines = [header, ""];
  for (const entry of entries) {
    const state = entry.state && entry.state !== "active" ? ` [${entry.state}]` : "";
    lines.push(`- (${entry.kind})${state} ${entry.text}`);
    lines.push(`  entry_id: ${entry.citation.entry_id}`);
  }

  return textResult(lines.join("\n"), { ok: true, scopeId: scope.scopeId, count: entries.length, entries, memory });
}

/**
 * POST /v1/sources/content then POST /v1/work/handoffs/prepare-current.
 *
 * Two Server calls, one coherent outcome. The boundary must be captured as a
 * real Source before the handoff is prepared, because `prepare-current` takes the
 * Source it is handing off as a required field — a handoff built without it would
 * be a claim with nothing behind it. If the first call succeeds and the second
 * fails, that is reported as a partial write rather than as a clean failure, so
 * the caller knows a boundary Source now exists on the Server.
 */
export async function callHandoffPrepare(sdk, config, args = {}) {
  const problem = missing(args.objective, "objective");
  if (problem) return { content: [{ type: "text", text: `pc_handoff_prepare: ${problem}` }], isError: true };

  const scope = await resolveScope(sdk, config, args.scope_id);
  if (!scope.ok) return failureResult("pc_handoff_prepare", scope);

  const stateItems = Array.isArray(args.state)
    ? args.state.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
  const omissions = Array.isArray(args.omissions)
    ? args.omissions.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim())
    : [];
  const disposition =
    typeof args.disposition === "string" && HANDOFF_DISPOSITIONS.includes(args.disposition)
      ? args.disposition
      : "continuable";

  // A unique, sortable boundary id. Date prefix keeps successive handoffs in
  // order when read back from the Server.
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const sourceId = `pc-handoff-${stamp}`;

  const boundary = [
    `objective: ${args.objective}`,
    stateItems.length ? `state:\n${stateItems.map((item) => `  - ${item}`).join("\n")}` : "state: (none declared)",
    `disposition: ${disposition}`,
    typeof args.next_action === "string" && args.next_action.trim() !== ""
      ? `next_action: ${args.next_action}`
      : "next_action: (none declared)",
    omissions.length ? `omissions:\n${omissions.map((item) => `  - ${item}`).join("\n")}` : "omissions: (none declared)",
  ].join("\n\n");

  const captured = await request(sdk, config, "/v1/sources/content", {
    scope_id: scope.scopeId,
    source_id: sourceId,
    content: boundary,
    metadata: { captured_by: "hana-powercontext", captured_at: new Date().toISOString() },
  });
  if (!captured.ok) return failureResult("pc_handoff_prepare", captured);

  const source = captured.data ? captured.data.source : null;
  const realSourceId = source && source.source_id ? source.source_id : sourceId;

  const response = await request(sdk, config, "/v1/work/handoffs/prepare-current", {
    scope_id: scope.scopeId,
    source_id: realSourceId,
    handoff: {
      schema: "powercontext.current-work-handoff.v1",
      trust: "untrusted_input",
      objective: args.objective,
      // Every item is recorded as a *declared* claim with no evidence: this tool
      // cannot verify the caller's own statements, and claiming otherwise would
      // launder unverified text into verified evidence.
      state: (stateItems.length ? stateItems : [args.objective]).map((text) => ({
        text,
        basis: "declared",
        evidence: [],
      })),
      disposition,
      next_action:
        typeof args.next_action === "string" && args.next_action.trim() !== ""
          ? { text: args.next_action.trim(), basis: "declared", evidence: [] }
          : null,
      omissions,
    },
  });

  if (!response.ok) {
    return failureResult(
      "pc_handoff_prepare",
      {
        ...response,
        message:
          `${response.message} The handoff boundary Source ${realSourceId} was already captured in scope ${scope.scopeId}, ` +
          "so the work is not lost, but the handoff itself was not prepared.",
      },
      { changed: true },
    );
  }

  const handoff = response.data || {};
  return textResult(
    [
      `Handoff prepared in scope ${scope.scopeId}.`,
      `boundary source: ${realSourceId}`,
      `objective: ${args.objective}`,
      `disposition: ${disposition}`,
      stateItems.length ? `declared state items: ${stateItems.length}` : "declared state items: 0",
      omissions.length ? `declared omissions: ${omissions.length}` : null,
      "",
      "Every state item is recorded as a *declared* claim with no evidence attached.",
    ]
      .filter((line) => line !== null)
      .join("\n"),
    { ok: true, scopeId: scope.scopeId, boundarySourceId: realSourceId, handoff },
  );
}

/* --------------------------------------------------------------- commands -- */

function plural(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** `/pc doctor` — connectivity and readiness, rendered as plain text. */
export async function commandDoctor(sdk, config, probeFn) {
  const verdict = await probeFn(sdk, config);
  const lines = [`PowerContext Server: ${config.baseUrl}`, `checked: ${verdict.checkedAt}`, ""];

  if (!verdict.ok) {
    lines.push(`NOT USABLE — failed at ${verdict.stage}.`);
    lines.push(verdict.error.message);
    if (verdict.error.hint) lines.push(`hint: ${verdict.error.hint}`);
    lines.push("");
    lines.push(`timeout budget: ${config.timeoutMs} ms (single attempt, no retry)`);
    return lines.join("\n");
  }

  lines.push(`status: ${verdict.status}`);
  for (const [name, value] of Object.entries(verdict.checks || {})) {
    lines.push(`  ${name}: ${value}`);
  }
  lines.push("");
  lines.push(`response cap: ${config.maxResponseBytes} bytes | request timeout: ${config.timeoutMs} ms`);
  if (verdict.configSource) lines.push(`config from: ${verdict.configSource}`);
  if (!verdict.capabilities) {
    lines.push("");
    lines.push("capabilities probe failed (Server is still usable):");
    lines.push(`  ${verdict.capabilitiesError.message}`);
  }
  return lines.join("\n");
}

/** `/pc scope` — show which Scope calls will use, and where that came from. */
export async function commandScope(sdk, config) {
  const scope = await resolveScope(sdk, config, undefined);
  if (!scope.ok) {
    const lines = [`Could not resolve a Scope from ${config.baseUrl}.`, scope.message];
    if (scope.hint) lines.push(`hint: ${scope.hint}`);
    return lines.join("\n");
  }
  const lines = [
    `effective scope: ${scope.scopeId}`,
    `resolved from: ${scope.source}`,
  ];
  if (scope.scope) {
    lines.push(`title: ${scope.scope.title}`);
    if (scope.scope.summary) lines.push(`summary: ${scope.scope.summary}`);
  }
  lines.push("");
  lines.push("Override per call with the tool's scope_id argument, or globally with POWERCONTEXT_HANA_SCOPE_ID.");
  return lines.join("\n");
}

/** `/pc memory` — a short inventory, without dumping full entry text. */
export async function commandMemory(sdk, config) {
  const scope = await resolveScope(sdk, config, undefined);
  if (!scope.ok) {
    const lines = [`Could not resolve a Scope from ${config.baseUrl}.`, scope.message];
    if (scope.hint) lines.push(`hint: ${scope.hint}`);
    return lines.join("\n");
  }

  const response = await request(sdk, config, "/v1/memory/entries/list", { scope_id: scope.scopeId });
  if (!response.ok) return `pc_memory failed: ${response.message}`;

  const entries = (response.data && response.data.entries) || [];
  const byKind = new Map();
  for (const entry of entries) byKind.set(entry.kind, (byKind.get(entry.kind) || 0) + 1);

  const lines = [
    `scope: ${scope.scopeId} (from ${scope.source})`,
    `entries: ${entries.length}`,
  ];
  if (entries.length) {
    lines.push("");
    for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${kind}: ${count}`);
    }
    lines.push("");
    lines.push(`Use pc_memory_list to read them (${plural(entries.length, "entry")}).`);
  }
  return lines.join("\n");
}

/** `/pc handoff` — show how to drive a handoff; it needs real work state. */
export function commandHandoff() {
  return [
    "pc_handoff_prepare takes the work state as arguments, so the model drives it:",
    "",
    "  objective    what this work is trying to achieve      (required)",
    "  state[]       what has actually been established",
    "  next_action   the single next step for a successor",
    "  disposition   continuable | blocked | complete        (default continuable)",
    "  omissions[]   known gaps, so the successor does not over-trust it",
    "",
    "Ask in chat, e.g. \"prepare a handoff for this work\", and the model will call",
    "pc_handoff_prepare. Every state item is stored as a declared, unverified claim.",
  ].join("\n");
}

/** `/pc` with no subcommand, or an unrecognised one. */
export function pcUsage() {
  return [
    "pc — PowerContext from Hana",
    "",
    "  /pc doctor    Server connectivity and readiness",
    "  /pc scope     which Scope calls will use, and why",
    "  /pc memory    memory inventory for the effective Scope",
    "  /pc handoff   how to drive a work handoff",
    "",
    "Nothing here writes to the Server.",
  ].join("\n");
}
