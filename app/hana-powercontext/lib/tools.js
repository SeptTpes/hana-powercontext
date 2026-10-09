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
import { counters, CACHE_TTL_MS, recallCacheSize, CAPTURE_LRU_SIZE } from "./hooks.js";

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

/**
 * Monotonic counter behind boundary Source ids.
 *
 * A wall-clock stamp alone is not unique: two handoffs prepared inside the same
 * millisecond collapse onto one id, and capture treats one id with two different
 * bodies as a hard 409 — so the second handoff of a pair would be rejected for a
 * reason that has nothing to do with the handoff. The counter removes that within
 * a process; `callHandoffPrepare` still retries with a fresh id if a *different*
 * process already claimed the same stamp.
 */
let boundarySequence = 0;

/** A unique, sortable boundary Source id: millisecond stamp + process counter. */
export function nextBoundarySourceId() {
  boundarySequence += 1;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `pc-handoff-${stamp}-${String(boundarySequence).padStart(4, "0")}`;
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
function failureResult(toolName, error, { changed = false, details = {} } = {}) {
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
      // Tool-specific context. For the handoff tool this carries the boundary
      // Source id even on failure, because knowing which Source now exists is the
      // point of a partial write.
      ...details,
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
 * pc_handoff_prepare — the explicit Handoff flow, in three Server calls.
 *
 *   capture  POST /v1/sources/content   the boundary text becomes a real Source
 *   prepare  POST /v1/handoff/prepare   Server generates an inspectable Draft
 *   finalize POST /v1/handoff/finalize  the Draft becomes a transferable value
 *
 * Why this shape and not the server-driven work-contract endpoint
 * (`/v1/work/handoffs/prepare-current`): that endpoint derives the boundary Source
 * itself and validates the client's `source_id` against its own derivation, so
 * pairing it with a client-captured Source is a contract mismatch — it answers
 * HTTP 409 `source_conflict`. The explicit `prepare`/`finalize` pair takes the
 * exact captured Source as evidence and is the supported route.
 *
 * The whole exchange is one tool call; `finalize` output is returned unchanged so
 * the caller holds the real transferable carrier, not a summary of it. This does
 * NOT commit a durable milestone — `/v1/handoff/commit` is deliberately not
 * exposed, because a temporary transfer is not a durable one.
 *
 * Partial writes are named precisely. Capture, prepare and finalize each persist
 * something, so a later failure reports exactly how far the exchange got and what
 * now exists on the Server, rather than claiming a clean rollback that did not
 * happen.
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
  const nextAction = typeof args.next_action === "string" && args.next_action.trim() !== "" ? args.next_action.trim() : null;

  // Unique, sortable boundary id — see nextBoundarySourceId for why a plain
  // timestamp is not enough.
  const sourceId = nextBoundarySourceId();

  // The boundary text is what the Server's generation step reads. It carries the
  // caller's own words; nothing here is presented as verified evidence.
  const boundary = [
    `objective: ${args.objective}`,
    stateItems.length ? `state:\n${stateItems.map((item) => `  - ${item}`).join("\n")}` : "state: (none declared)",
    `disposition: ${disposition}`,
    nextAction ? `next_action: ${nextAction}` : "next_action: (none declared)",
    omissions.length ? `omissions:\n${omissions.map((item) => `  - ${item}`).join("\n")}` : "omissions: (none declared)",
  ].join("\n\n");

  /**
   * Render a failure that names exactly which steps already persisted.
   *
   * The Server's own message is kept verbatim, and the partial-write sentence is
   * built as its own sentence with its own capital: appending a lowercased clause
   * straight after a full stop produced "…disabled). the handoff boundary Source
   * was captured…", which reads as a typo and buries the important half.
   */
  const partialFailure = (error, { captured, prepared }) => {
    // A completed Server message already ends in a full stop; one that came from
    // this client may not.
    const serverMessage = /\.$/.test(error.message) ? error.message : `${error.message}.`;

    const done = [];
    if (captured) done.push(`the handoff boundary Source ${captured} was captured`);
    if (prepared) done.push("a Handoff Draft was generated");

    const parts = [serverMessage];
    if (done.length) {
      parts.push(
        `However, ${done.join(" and ")} on the Server in scope ${scope.scopeId}, so the work is not lost — ` +
          "no transferable Handoff was produced.",
      );
    }

    return failureResult(
      "pc_handoff_prepare",
      { ...error, message: parts.join(" ") },
      { changed: Boolean(done.length), details: { scopeId: scope.scopeId, boundarySourceId: captured ?? null, draftGenerated: Boolean(prepared) } },
    );
  };

  /* --- step 1/3: capture the boundary as a real Source --------------------- */
  // Bound the retry to exactly one extra attempt. It exists for one narrow case:
  // a *different* process claimed this id with different content (capture then
  // answers 409 source_conflict). Retrying once with a fresh id resolves that,
  // and the bound is what keeps "capture is unhappy" from becoming a loop.
  let captured = await request(sdk, config, "/v1/sources/content", {
    scope_id: scope.scopeId,
    source_id: sourceId,
    content: boundary,
    metadata: { captured_by: "hana-powercontext", captured_at: new Date().toISOString() },
  });
  let usedSourceId = sourceId;
  if (!captured.ok && captured.serverCode === "source_conflict") {
    usedSourceId = nextBoundarySourceId();
    captured = await request(sdk, config, "/v1/sources/content", {
      scope_id: scope.scopeId,
      source_id: usedSourceId,
      content: boundary,
      metadata: { captured_by: "hana-powercontext", captured_at: new Date().toISOString() },
    });
  }
  if (!captured.ok) {
    return failureResult("pc_handoff_prepare", captured, { details: { scopeId: scope.scopeId } });
  }

  // Copy the returned Source object exactly. The Server's evidence schema wants
  // both fields, and inventing either one is what produces a not-found citation.
  const sourceRef = captured.data ? captured.data.source : null;
  if (!sourceRef || !sourceRef.source_id || !sourceRef.name) {
    return partialFailure(
      {
        kind: "malformed_capture",
        message: "Capture succeeded but the Server did not return a usable Source reference.",
        url: `${config.baseUrl}/v1/sources/content`,
      },
      { captured: usedSourceId },
    );
  }
  const boundarySourceId = sourceRef.source_id;

  /* --- step 2/3: ask the Server to generate an inspectable Draft ----------- */
  const prepared = await request(sdk, config, "/v1/handoff/prepare", {
    scope_id: scope.scopeId,
    objective: args.objective,
    evidence: [{ kind: "source", source_ref: sourceRef }],
    max_bytes: config.maxBytes,
  });

  if (!prepared.ok) {
    // The one failure that is a capability gate rather than a fault. Saying so
    // turns an opaque 503 into a fixable setup problem.
    if (prepared.serverCode === "handoff_generation_unavailable") {
      return partialFailure(
        {
          ...prepared,
          message:
            `${prepared.message} Handoff Drafts are generated by the Server's model, and this Server has no generation provider configured (handoff_generation: disabled).`,
          hint:
            "Configure a generation provider on the PowerContext Server (a 'full' config rather than basic memory), then retry. /pc doctor reports the Server's capabilities.",
        },
        { captured: boundarySourceId },
      );
    }
    return partialFailure(prepared, { captured: boundarySourceId });
  }

  const draft = prepared.data;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return partialFailure(
      {
        kind: "malformed_draft",
        message: "The Server returned no usable Handoff Draft.",
        url: `${config.baseUrl}/v1/handoff/prepare`,
      },
      { captured: boundarySourceId },
    );
  }

  /* --- step 3/3: finalize the Draft into the transferable value ------------ */
  // `draft` goes in as the Draft body itself, never wrapped in the {ok, data}
  // envelope this client returns to its own callers.
  const finalized = await request(sdk, config, "/v1/handoff/finalize", {
    scope_id: scope.scopeId,
    draft,
  });
  if (!finalized.ok) {
    return partialFailure(finalized, { captured: boundarySourceId, prepared: true });
  }

  const handoff = finalized.data;
  const statementCount = Array.isArray(draft.state) ? draft.state.length : 0;

  return textResult(
    [
      `Handoff finalized in scope ${scope.scopeId}.`,
      `boundary source: ${boundarySourceId}`,
      `schema: ${handoff && handoff.schema ? handoff.schema : "(not reported)"}`,
      `objective: ${draft.objective}`,
      `disposition: ${draft.disposition}`,
      `state statements: ${statementCount}`,
      Array.isArray(draft.omissions) && draft.omissions.length ? `omissions: ${draft.omissions.length}` : null,
      "",
      "The finalized Handoff below is the transferable value. It is a temporary",
      "transfer, not a durable commit. State statements are Server-generated from",
      "the captured boundary and carry the citations the Server resolved.",
      "",
      "finalized:",
      JSON.stringify(handoff, null, 2),
    ]
      .filter((line) => line !== null)
      .join("\n"),
    {
      ok: true,
      scopeId: scope.scopeId,
      boundarySourceId,
      draft,
      // The complete carrier, returned unchanged, so a caller can hand it on
      // without re-deriving anything.
      finalized: handoff,
    },
  );
}

/* ----------------------------------------------------------------- review -- */

/**
 * /pc review — the human gate for review-class changes.
 *
 * RED LINE, stated here because this is where it would be broken: **no review or
 * administration operation is ever exposed as a model-facing tool.** The pc_* tool
 * set contains none, and this module deliberately adds none. The only way to reach
 * the functions below is a slash command, and a slash command is text a person
 * types — the model cannot manufacture one, cannot call one through tool-calling,
 * and cannot ask this App to run one on its behalf.
 *
 * That matters because approving an Artifact Candidate publishes a generated
 * artifact into the Scope. A model that could approve its own proposals would be
 * reviewing its own work, which is exactly the property the human gate exists to
 * prevent. The design rule is not "the model probably will not"; it is "the model
 * has no path to it".
 *
 * These functions never auto-retry. A version conflict is answered with what the
 * Server said and an instruction to refresh and decide again — an automatic retry
 * would silently apply a decision to a revision the human never looked at.
 */

/** List pending Artifact Candidates for the effective Scope. */
export async function reviewCandidates(sdk, config, { status = "pending", limit = 50 } = {}) {
  const scope = await resolveScope(sdk, config, undefined);
  if (!scope.ok) return { ok: false, error: scope };

  const response = await request(sdk, config, "/v1/artifact-candidates/list", {
    scope_id: scope.scopeId,
    status,
    limit,
  });
  if (!response.ok) return { ok: false, error: response, scope: scope.scopeId };

  const candidates = (response.data && response.data.candidates) || [];
  return {
    ok: true,
    scopeId: scope.scopeId,
    candidates: candidates.map((candidate) => ({
      candidateId: candidate.candidate_id,
      version: candidate.version,
      family: candidate.family,
      status: candidate.status,
      sourceCount: Array.isArray(candidate.source_refs) ? candidate.source_refs.length : 0,
      /** A one-line gist, so a human can tell proposals apart without opening each. */
      summary: candidateSummary(candidate),
    })),
    nextCursor: response.data ? response.data.next_cursor : null,
  };
}

/** Best-effort one-liner for a Candidate's proposal, which varies by family. */
function candidateSummary(candidate) {
  const proposal = candidate && candidate.proposal ? candidate.proposal : null;
  if (!proposal || typeof proposal !== "object") return "";
  const fields = ["name", "title", "lesson", "summary", "objective", "description"];
  for (const field of fields) {
    if (typeof proposal[field] === "string" && proposal[field].trim() !== "") {
      const value = proposal[field].trim();
      return value.length > 120 ? value.slice(0, 120) + "…" : value;
    }
  }
  return "";
}

/**
 * Approve or reject one Candidate.
 *
 * `expectedVersion` is the optimistic-concurrency token the Server requires. When
 * the human did not supply one, it is read from the Server and passed straight
 * through — which is safe precisely because the read and the decision happen in
 * one command the human just typed, and because a mismatch is surfaced rather than
 * retried.
 */
export async function decideCandidate(sdk, config, { candidateId, decision, expectedVersion, reason } = {}) {
  const scope = await resolveScope(sdk, config, undefined);
  if (!scope.ok) return { ok: false, error: scope };

  let version = Number.isFinite(expectedVersion) && expectedVersion >= 1 ? expectedVersion : null;
  if (version === null) {
    const fetched = await request(sdk, config, "/v1/artifact-candidates/get", {
      scope_id: scope.scopeId,
      candidate_id: candidateId,
    });
    if (!fetched.ok) return { ok: false, error: fetched, scope: scope.scopeId };
    version = fetched.data ? fetched.data.version : null;
    if (!Number.isFinite(version)) {
      return {
        ok: false,
        scope: scope.scopeId,
        error: {
          kind: "no_version",
          message: `Candidate ${candidateId} returned no version; refusing to decide blind.`,
          hint: "The Server must report the Candidate's current version before it can be decided.",
        },
      };
    }
  }

  const body = { scope_id: scope.scopeId, candidate_id: candidateId, expected_version: version };
  const path = decision === "reject" ? "/v1/artifact-candidates/reject" : "/v1/artifact-candidates/approve";
  if (decision === "reject") {
    body.reason = reason && reason.trim() !== "" ? reason.trim() : "Rejected from Hana.";
  }

  const response = await request(sdk, config, path, body);
  if (!response.ok) return { ok: false, error: response, scope: scope.scopeId, version };
  return { ok: true, scopeId: scope.scopeId, version, candidate: response.data || null };
}

/** Render `/pc review` and its subcommands for a person reading chat. */
export async function commandReview(sdk, config, argsText) {
  const tokens = String(argsText || "").trim().split(/\s+/).filter(Boolean);
  const action = (tokens[0] || "").toLowerCase();

  if (action === "" || action === "list") {
    const result = await reviewCandidates(sdk, config, {});
    if (!result.ok) {
      const error = result.error || {};
      return [
        "取审阅队列失败。",
        error.message || "未知错误。",
        error.hint ? `怎么修：${error.hint}` : "先确认 /pc doctor 通过。",
      ].join("\n");
    }
    if (result.candidates.length === 0) {
      return [
        `Scope ${result.scopeId} 没有待审阅的候选 —— 这是正常的，不是错误。`,
        "",
        "候选由 Server 的生成能力产出（Experience / Skill 等）。当前 Server 若未配置生成凭据，",
        "队列就会一直是空的；/pc doctor 可以看到 handoff_generation 等能力状态。",
        "",
        "审阅决定只属于人：approve / reject 只能由你在聊天里敲出来，模型没有对应工具。",
      ].join("\n");
    }

    const lines = [`Scope ${result.scopeId} 有 ${result.candidates.length} 个待审阅候选：`, ""];
    for (const candidate of result.candidates) {
      lines.push(`· ${candidate.candidateId}  [${candidate.family}] v${candidate.version}`);
      if (candidate.summary) lines.push(`    ${candidate.summary}`);
      if (candidate.sourceCount) lines.push(`    证据 ${candidate.sourceCount} 条`);
    }
    lines.push("", "决定：/pc review approve <id>　/pc review reject <id> [理由]");
    lines.push("审阅决定只属于人：模型工具面没有对应工具，且永远不会有。");
    return lines.join("\n");
  }

  if (action === "approve" || action === "reject") {
    const candidateId = tokens[1];
    if (!candidateId) {
      return `用法：/pc review ${action} <候选 id>${action === "reject" ? " [理由]" : ""}\n` +
        "先用 /pc review 看有哪些候选。";
    }
    const reason = action === "reject" ? tokens.slice(2).join(" ") : undefined;

    const result = await decideCandidate(sdk, config, { candidateId, decision: action, reason });
    if (!result.ok) {
      const error = result.error || {};
      const lines = [`${action === "reject" ? "驳回" : "批准"} ${candidateId} 失败。`, error.message || "未知错误。"];
      if (error.serverCode === "candidate_not_found") {
        lines.push("这个 id 在当前 Scope 里不存在 —— 重新跑 /pc review 看最新列表。");
      } else if (error.status === 409) {
        // Optimistic-concurrency conflict: the human must look again. Never retry.
        lines.push("候选在你看过之后被改过（版本冲突）。重新跑 /pc review 看最新版本，再决定一次。");
      }
      if (error.hint) lines.push(`怎么修：${error.hint}`);
      lines.push("没有做任何自动重试 —— 决定必须落在你看过的那一版上。");
      return lines.join("\n");
    }

    return [
      `${action === "reject" ? "已驳回" : "已批准"} ${candidateId}（v${result.version}，Scope ${result.scopeId}）。`,
      action === "reject" && reason ? `理由：${reason}` : null,
      action === "approve" ? "该候选已按 Server 的发布语义生效。" : "该候选不会生效。",
    ]
      .filter((line) => line !== null)
      .join("\n");
  }

  return [
    `未知的 review 子命令「${action}」。`,
    "",
    "  /pc review                      列出待审阅候选",
    "  /pc review approve <id>         批准一个候选",
    "  /pc review reject <id> [理由]   驳回一个候选",
    "",
    "审阅决定只属于人：approve / reject 只能由你在聊天里敲出来，模型没有对应工具。",
  ].join("\n");
}

/* --------------------------------------------------------------- commands -- */

/**
 * Name the configuration layers that actually contributed a value.

 * `/pc doctor` used to render `verdict.configSource`, a field `probe()` has never
 * returned — so the line silently never printed, and the one question the line exists
 * to answer ("why is it using that Server?") went unanswered even after the config
 * file layer was fixed. Rendering it from `config.sources`, which is right here, keeps
 * the answer next to the settings it describes.
 *
 * Reported as "defaults" when nothing overrode anything, so the absence of a source is
 * stated rather than left blank — a blank line reads as a bug.
 */
function describeConfigSources(config) {
  const sources = (config && config.sources) || {};
  const named = [];
  if (sources.appData && Object.keys(sources.appData).length > 0) named.push("config.json");
  if (sources.env && Object.keys(sources.env).length > 0) named.push("env");
  if (sources.explicit && Object.keys(sources.explicit).length > 0) named.push("call args");
  return named.length > 0 ? named.join(" + ") : "defaults";
}
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
  lines.push(`config from: ${describeConfigSources(config)}`);
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

/**
 * `/pc hooks` — read-only view of the stage 2 layer: the in-memory counters and
 * the permission ledger's own answer about the two hook grants.
 *
 * The grant status is asked of the host (`app:capabilities`), never inferred from
 * a local flag: only the host knows whether the user approved the hook, and this
 * command must not appear to approve anything on the user's behalf. The probe is
 * injected so the rendering can be tested without a host.
 */
export async function commandHooks(config, probeCapabilities) {
  const lines = [
    "PowerContext hooks (stage 2)",
    "",
    "switches (next invocation picks these up, no reload needed)",
    `  prestep        ${config.prestep ? "on" : "OFF"}   (POWERCONTEXT_HANA_PRESTEP)`,
    `  capturePrompts ${config.capturePrompts ? "ON" : "off"}   (POWERCONTEXT_HANA_CAPTURE_PROMPTS)`,
    `  beforeStart    ${config.beforeStart ? "ON" : "off"}   (POWERCONTEXT_HANA_BEFORE_START)`,
    `  prestepMaxBytes ${config.prestepMaxBytes} | prestepTimeoutMs ${config.prestepTimeoutMs} | captureMaxBytes ${config.captureMaxBytes}`,
    "",
    "counters since this App process started (counts only, no content)",
  ];

  const order = [
    "prestep_invocations",
    "injections",
    "skipped_disabled",
    "skipped_empty",
    // Stage 2B: the extraction layer's own two counters. They answer the
    // question a bare injection count cannot — whether the query that reached
    // the Server was the user's sentence or a phrase the matcher could use.
    "skipped_empty_extracted",
    "extract_hits",
    "skipped_no_query",
    "skipped_error",
    "cache_hits",
    "cache_misses",
    "captures",
    "captures_duplicate",
    "captures_failed",
    "beforestart_invocations",
    "beforestart_injections",
    "beforestart_skipped",
  ];
  for (const key of order) {
    lines.push(`  ${key.padEnd(24)} ${counters[key] ?? 0}`);
  }
  lines.push(`  ${"recall_cache_entries".padEnd(24)} ${recallCacheSize()} (ttl ${CACHE_TTL_MS / 1000}s)`);
  lines.push(`  ${"capture_dedupe_window".padEnd(24)} ${CAPTURE_LRU_SIZE}`);

  lines.push("", "hook grants (answered by the host's own ledger)");
  if (typeof probeCapabilities !== "function") {
    lines.push("  (unavailable in this context — the host capability query is not wired here)");
  } else {
    try {
      const result = await probeCapabilities();
      const rows = (result && result.capabilities) || [];
      const wanted = ["app/hooks.agent-pre-step", "app/hooks.agent-before-start"];
      for (const capability of wanted) {
        const row = rows.find((item) => item && item.capability === capability);
        const status = row ? row.status : "not_asked";
        const enforcement = row ? ` (${row.enforcement})` : "";
        // Only the host can say this; an ungranted hook is simply skipped, and
        // the turn proceeds — which is why "not_asked" is not an error here.
        lines.push(`  ${capability.padEnd(30)} ${status}${enforcement}`);
      }
      // D21 fix: only a real decision is worth warning about. `not_asked` is the
      // ledger having no record — a posture, not a grant — and warning on it made
      // /pc hooks report "unexpected hook grants present" on a clean install whose
      // ledger held zero hook records. The alert must mean what it says, or it
      // trains the reader to ignore it.
      const DECIDED_STATUSES = new Set(["always", "allowed", "session", "denied"]);
      const unexpected = rows
        .filter((item) => item && typeof item.capability === "string" && item.capability.startsWith("app/hooks."))
        .filter((item) => DECIDED_STATUSES.has(item.status))
        .map((item) => item.capability)
        .filter((name) => !wanted.includes(name));
      if (unexpected.length > 0) {
        lines.push(`  WARNING: unexpected hook grants present: ${unexpected.join(", ")}`);
      }
    } catch (error) {
      lines.push(`  (host capability query failed: ${error && error.message ? error.message : String(error)})`);
    }
  }

  lines.push("", "This command only reads. Approving a hook grant happens in Hana's own permission UI.");
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
    "  /pc hooks     recall/capture counters and hook grant status",
    "  /pc handoff   how to drive a work handoff",
    "  /pc review    审阅队列；approve / reject 只有人能执行",
    "",
    "除 /pc review approve|reject 外，这里都只读或只做一次显式写入；",
    "审阅决定只属于人 —— 模型工具面没有对应工具。",
  ].join("\n");
}