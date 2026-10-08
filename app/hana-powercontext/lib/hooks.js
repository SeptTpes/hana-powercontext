/**
 * lib/hooks.js — the stage 2 push-side: pre-step recall injection, optional input
 * capture, and the (default-off) before-start handoff injection.
 *
 * The load-bearing rule, same as everywhere else in this App: **a hook never
 * breaks a turn.** Every path returns either a decision or `undefined`, and
 * `undefined` means "leave the messages exactly as they were". Nothing here
 * throws at the host: a hook that throws is a hook the host has to defend
 * against, and the whole value of this layer disappears the first time recall
 * failure costs someone a turn.
 *
 * The three hooks are registered together and each owns its own kill-switch,
 * because they have genuinely different risk profiles:
 *
 *   agent/pre-step        injection      default ON  — reads the Server
 *   agent/pre-step        capture        default OFF — writes prompts to the Server
 *   agent/before-start    handoff        default OFF — needs a generation provider
 */

import { request } from "./powercontext.js";
import { resolveScope } from "./tools.js";

/* ------------------------------------------------------------- constants -- */

/**
 * Query cap. The last user message can be arbitrarily long; recall quality does
 * not improve past the opening of a request, and the Server's own query field
 * tops out at 8192. 512 keeps the request small and the cache key stable.
 */
export const QUERY_MAX_CHARS = 512;

/** Recall cache lifetime. Within this window a repeated step reuses the text. */
export const CACHE_TTL_MS = 60_000;

/**
 * Cache key cap. Sessions are keyed by `sessionPath`, but a bridge session has
 * no path at all, so it is keyed by `sessionId` instead.
 */
const CACHE_MAX_ENTRIES = 64;

/** How many recent prompts the capture deduplicator remembers. */
export const CAPTURE_LRU_SIZE = 32;

/** Wrapper cost allowance on top of the configured body budget. */
export const WRAPPER_OVERHEAD_BYTES = 1024;

/**
 * The explicit trust wrapper.
 *
 * The host can only receive injection as a message, and a bare recalled passage
 * sitting in the transcript is indistinguishable from the user's own words or
 * from an instruction. The markers make the boundary visible in the model input
 * itself, so recalled history is never read as either of those.
 */
export const RECALL_PREFIX = "[PowerContext recall · untrusted_history]";
export const RECALL_SUFFIX = "[end recall]";

/* -------------------------------------------------------------- counters -- */

/**
 * In-memory debug counters behind `/pc hooks`. They hold counts only — never
 * prompt text, never recalled content, never a credential. They reset when the
 * App process does, which is the right lifetime for a diagnostic.
 */
export const counters = {
  prestep_invocations: 0,
  injections: 0,
  skipped_disabled: 0,
  skipped_empty: 0,
  /**
   * Extraction produced no usable phrase *and* the verbatim fallback was empty
   * too — the union of both, which is the honest reading of the name
   * ("skipped because the extracted query was empty, fallback included").
   * It is not a count of extra skips on top of `skipped_empty`: the
   * extraction-empty case reports here *instead of* there, so no step is ever
   * counted in both. See D18.
   */
  skipped_empty_extracted: 0,
  /** Steps where extraction produced a query that differs from the raw text. */
  extract_hits: 0,
  skipped_error: 0,
  skipped_no_query: 0,
  skipped_oversize: 0,
  cache_hits: 0,
  cache_misses: 0,
  captures: 0,
  captures_duplicate: 0,
  captures_failed: 0,
  beforestart_invocations: 0,
  beforestart_injections: 0,
  beforestart_skipped: 0,
};

export function resetCounters() {
  for (const key of Object.keys(counters)) counters[key] = 0;
}

/* ----------------------------------------------------------- small utils -- */

function utf8Bytes(text) {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(text).length : Buffer.byteLength(text, "utf8");
}

/**
 * Truncate to a UTF-8 byte budget without splitting a character.
 *
 * `String.prototype.slice` counts UTF-16 code units, so slicing by a byte count
 * would cut multi-byte text in half and send a replacement character to the
 * model — and a lone surrogate would be worse: it is not valid UTF-8 at all.
 */
export function truncateToBytes(text, maxBytes) {
  if (typeof text !== "string") return "";
  if (maxBytes <= 0) return "";
  if (utf8Bytes(text) <= maxBytes) return text;

  // Walk back from a code-unit estimate until the encoded form fits. The
  // estimate is only a starting point; the loop is what guarantees the bound.
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && utf8Bytes(text.slice(0, end)) > maxBytes) {
    end -= Math.max(1, Math.ceil((utf8Bytes(text.slice(0, end)) - maxBytes) / 4));
  }
  // A surrogate pair split by the code-unit boundary is not a character.
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

/** Flatten one Pi content part to text, ignoring non-text parts. */
function partToText(part) {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  return "";
}

/**
 * Read the text of a message.
 *
 * Pi carries `content` either as a plain string or as an array of parts, and
 * both shapes reach a hook. A tool-result style array has no text worth using as
 * a query, so it flattens to whatever text parts exist — usually nothing.
 */
export function messageText(message) {
  if (!message || typeof message !== "object") return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(partToText).filter(Boolean).join("\n");
  return "";
}

/** Index of the last user message, or -1. */
export function lastUserIndex(messages) {
  if (!Array.isArray(messages)) return -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i] && typeof messages[i] === "object" && messages[i].role === "user") return i;
  }
  return -1;
}

/** The wrapped recall message, exactly as it will be injected. */
export function wrapRecall(content) {
  return `${RECALL_PREFIX}\n${content}\n${RECALL_SUFFIX}`;
}

/* ---------------------------------------------------------------- caches -- */

/**
 * Recall cache: sessionKey -> { query, text, at, scopeId }.
 *
 * Keyed by session, not by query, because the point is "do not re-ask for the
 * same session within the window". A different query inside the window still
 * reuses the cached text — see `prepareRecall` for why that is deliberate.
 */
const recallCache = new Map();

/** In-flight prepares, so concurrent steps in one session share one request. */
const inFlight = new Map();

function cacheGet(sessionKey) {
  const hit = recallCache.get(sessionKey);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    recallCache.delete(sessionKey);
    return null;
  }
  // Refresh recency for the LRU behaviour.
  recallCache.delete(sessionKey);
  recallCache.set(sessionKey, hit);
  return hit;
}

function cacheSet(sessionKey, entry) {
  recallCache.delete(sessionKey);
  recallCache.set(sessionKey, entry);
  while (recallCache.size > CACHE_MAX_ENTRIES) {
    const oldest = recallCache.keys().next().value;
    recallCache.delete(oldest);
  }
}

/**
 * Drop every cached recall.
 *
 * Called when the Server is actually found to be unreachable. Note what this can
 * and cannot do: a cache hit makes no request, so an outage that begins while a
 * session is inside its TTL window is not detected until either the window
 * expires or a step misses the cache. Discovering an outage every step would
 * cost a health request per step, which is exactly the per-step Server load this
 * cache exists to avoid. The trade is deliberate: within the window the session
 * keeps a usable recall from a Server that was reachable moments ago, and the
 * first real failure after that clears everything.
 */
export function clearRecallCache() {
  recallCache.clear();
  inFlight.clear();
}

export function recallCacheSize() {
  return recallCache.size;
}

/**
 * Capture deduplicator: a bounded LRU of content hashes.
 *
 * Hashes, not the prompts themselves — the point is to recognise a repeat, and
 * keeping the text would turn a dedupe table into a second copy of the user's
 * input sitting in memory.
 */
const captureSeen = new Map();

/**
 * Stable content fingerprint for the capture deduplicator.
 *
 * Two FNV-1a-style lanes rather than a cryptographic digest, chosen for what the
 * job actually is: recognising "this is the same prompt as one of the last 32".
 * A collision costs one skipped capture of text that was already captured, so
 * this needs no collision resistance and no secret — and a local implementation
 * keeps the App's own module graph free of Node built-ins, which a background
 * AppHost child runs under a permission model that this App does not need to
 * spend anything on. 64 combined bits make an accidental collision far rarer
 * than the 32-entry window could ever expose.
 */
export function contentHash(text) {
  const input = String(text);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`;
}

/** `true` when this content was already captured inside the LRU window. */
export function captureWasSeen(hash) {
  if (captureSeen.has(hash)) {
    captureSeen.delete(hash);
    captureSeen.set(hash, true);
    return true;
  }
  captureSeen.set(hash, true);
  while (captureSeen.size > CAPTURE_LRU_SIZE) {
    captureSeen.delete(captureSeen.keys().next().value);
  }
  return false;
}

export function resetCaptureDedupe() {
  captureSeen.clear();
}

/* ------------------------------------------------------------- sessionKey -- */

/**
 * Stable identity for caching, from the host-asserted session.
 *
 * `sessionPath` is the documented locator and the first choice. A bridge session
 * has no path (the contract says so explicitly), and falling back to the id is
 * what keeps per-session caching working there instead of collapsing every
 * bridge session onto one key.
 */
export const ANONYMOUS_SESSION = "anonymous";

export function sessionKeyOf(session) {
  if (session && typeof session.sessionPath === "string" && session.sessionPath !== "") return session.sessionPath;
  if (session && typeof session.sessionId === "string" && session.sessionId !== "") return `id:${session.sessionId}`;
  return ANONYMOUS_SESSION;
}

/* ------------------------------------------------------------------ query -- */

/** Last query seen per session, for tool-loop steps that carry no new user text. */
const lastQuery = new Map();

/**
 * Retrieval stop list, Chinese and English, matched case-insensitively.
 *
 * The Server's prepare path matches entities, not questions: a full natural
 * language sentence returns `status: "empty"` while the same sentence's noun
 * phrase recalls the entry (measured, four-way experiment in
 * `artifacts/stage2/prepare-query-experiment.py`). This list is therefore
 * deliberately narrow — it drops the *asking* words (什么/怎么/what/is/please)
 * and keeps every word that could name a thing. Over-filtering is worse than
 * under-filtering here, because a query that loses its entity recalls nothing
 * while a query that keeps a stray "is" still recalls: hence the fallback to
 * the verbatim text whenever extraction comes back too short.
 *
 * Entries are grouped by what they are for, so the list can be audited:
 *   1. question words and interrogative tails
 *   2. politeness / instruction words
 *   3. articles, auxiliaries, prepositions, pronouns (English)
 *   4. discourse words that name no entity ("address", "我之前", "的")
 *
 * The "address"/"地址" entry looks surprising and earns its place: in
 * "PowerContext Server 地址是什么" the entity is `PowerContext Server`, and
 * keeping "地址" leaves a phrase the Server's matcher scores as two competing
 * tokens instead of one clean entity. `http://127.0.0.1:8000` in a query is a
 * token, not the word "address", so nothing a user actually needs is dropped.
 */
export const EXTRACT_STOPWORDS = [
  // 1. question words and interrogative tails
  "什么", "是什么", "是什么意思", "怎么", "怎么办", "如何", "为什么", "哪个", "哪些", "多少", "吗", "呢", "么", "是否",
  // 2. politeness and instruction words
  "请", "请问", "问", "帮我", "帮忙", "麻烦", "请你", "你可以", "可以的", "谢谢", "你是一个全新会话", "全新会话",
  "请不要调用工具", "不要调用工具", "不要调用任何工具", "请不要", "记住的", "记住", "让你记住的", "让你", "我之前",
  "刚才", "前面", "上面", "一下", "一个", "这个", "那个",
  // 3. English function words
  "what", "which", "who", "whose", "whom", "when", "where", "why", "how", "is", "are", "was", "were", "am", "be",
  "been", "being", "the", "a", "an", "do", "does", "did", "done", "please", "my", "me", "i", "you", "your", "we",
  "our", "it", "its", "this", "that", "these", "those", "before", "in", "to", "for", "of", "on", "at", "by", "with",
  "and", "or", "but", "if", "then", "than", "so", "as", "from", "about", "into", "over", "under", "again", "tell",
  "say", "said", "know", "remember", "ask", "asked", "url", "address", "addr", "base",
  // 4. discourse words that name no entity
  "的", "了", "着", "吗", "呢", "是", "地址", "你上次说的", "上次说的", "我们上次讨论的", "上次讨论的", "上次", "我们",
  "你", "说的", "在哪里", "在哪儿", "哪个", "的那个",
];

/** Instruction prefixes removed before stop-word filtering (see 2 above). */
const INSTRUCTION_PREFIX_SOURCE =
  "(你是一个全新会话|这是一个全新会话|全新会话|请不要调用(任何)?工具|不要调用(任何)?工具|请你?|请问|请|帮我|帮忙|麻烦你?|你可以)+";

/**
 * A fresh pattern per use. `String.replace` with a global regex advances its own
 * `lastIndex`, so a shared instance would silently skip a match on the second
 * call from the same position — a statefulness bug that only shows up on the
 * second message of a session.
 */
const instructionPrefix = () => new RegExp(INSTRUCTION_PREFIX_SOURCE, "g");

/** What splitting a user message into candidate fragments looks like. */
const SENTENCE_SPLIT = /[\n\r。！？!?；;.]+/;

/**
 * A literal dot inside a host name, an IPv4 address or a file name is not a
 * sentence boundary. "127.0.0.1:8000" must survive as one token, so those dots
 * are parked behind a placeholder for the split and restored afterwards.
 */
const URL_LIKE = /[A-Za-z0-9_@:/\\-]+(?:\.[A-Za-z0-9_@:/\\-]+)+/g;
const DOT_PLACEHOLDER = "\u0000";

/** Full-width spaces and punctuation inside a CJK run are boundaries. */
const PUNCTUATION = /[\u3000-\u303f\uff00-\uffef]/g;

/**
 * Strip the conversational shape from one user message and return a phrase
 * shaped for retrieval — or the original text when nothing usable is left.
 *
 * The rules, in order:
 *
 *   1. **Drop instruction sentences.** A user paste often opens with a harness
 *      preamble ("你是一个全新会话。请不要调用任何工具。"). Those fragments name
 *      nothing; the sentence that carries the question is kept.
 *   2. **Strip brackets, quotes and markup.** `**bold**`, `\`code\``, 《》「」,
 *      quotes and list bullets are formatting, not content.
 *   3. **Filter stop words.** Chinese runs have no spaces, so a stop word is
 *      removed *inside* a token ("地址是什么" -> "地址"); English tokens are
 *      matched whole so that "thesaurus" is not "saurus".
 *   4. **Fall back to the raw text** when the result is empty or shorter than
 *      two characters. The Server's own prepare can decide what to do with a
 *      question; guessing a phrase out of nothing cannot improve on that.
 *
 * Pure and total: any input, including a non-string, returns a string, and the
 * output is never longer than `QUERY_MAX_CHARS` UTF-8 bytes.
 */
export function extractRetrievalQuery(userText) {
  const raw = typeof userText === "string" ? userText.trim() : "";
  const capped = truncateToBytes(raw, QUERY_MAX_CHARS).trim();

  // Park the dots that belong to a host name or a file name, split on what is
  // left, then put them back: "127.0.0.1:8000" is one entity, not four.
  const sentences = capped
    .replace(URL_LIKE, (match) => match.split(".").join(DOT_PLACEHOLDER))
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.split(DOT_PLACEHOLDER).join("."))
    .map((sentence) => sentence.replace(/^\s*(?:[-*•·>]+|\d+[.)])\s*/, "").replace(instructionPrefix(), " "))
    .map((sentence) => sentence.replace(PUNCTUATION, " ").replace(/["'\`“”‘’「」『』《》〈〉【】\[\]{}()<>]/g, " "))
    .map((sentence) => sentence.replace(/[*_~|^#>]+/g, " "))
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => hasSubstance(sentence));

  const kept = [];
  for (const sentence of sentences) {
    for (const token of sentence.split(" ")) {
      const cleaned = stripStopwords(token);
      if (cleaned !== "") kept.push(cleaned);
    }
  }
  const extracted = kept.join(" ").replace(/\s+/g, " ").trim();

  // Rules 1-3 either produced something usable or they did not. Too short means
  // "nothing usable": two characters is the floor for a phrase that could match
  // an entity, and it is a byte floor because a lone CJK character is 3 bytes.
  if (extracted === "" || utf8Bytes(extracted) < 2) {
    return { extracted: "", query: capped, usedFallback: true };
  }
  return { extracted, query: truncateToBytes(extracted, QUERY_MAX_CHARS).trim(), usedFallback: false };
}

/** Words that remain after an instruction prefix is stripped but name nothing. */
const FILLER_ONLY = new Set(["任何", "所有", "这些", "那些", "一下", "一个", "这个", "那个", "the", "a", "an", "it"]);

/**
 * Would this fragment still say something after the instruction prefix is gone?
 *
 * A fragment made only of an instruction and its filler ("请不要调用任何工具")
 * is dropped whole. A fragment that keeps an entity ("请记住 Server 地址是
 * http://127.0.0.1:8000") is kept, because dropping it would drop the fact.
 */
function hasSubstance(fragment) {
  if (fragment === "") return false;
  // Non-CJK text (an English sentence, a URL, a path) keeps its own words and is
  // always worth filtering; only CJK filler needs this guard.
  if (!/[\u3400-\u9fff]/.test(fragment)) return true;
  const residue = fragment.replace(instructionPrefix(), " ").replace(/[\s的了吗呢，,、]/g, "");
  if (residue === "") return false;
  return !FILLER_ONLY.has(residue);
}

/**
 * Remove stop words from one token; CJK matches inside, ASCII matches whole.
 *
 * The asymmetry is the point. Chinese has no spaces, so "地址是什么" arrives as
 * a single token and the question word has to be removed from *inside* it.
 * English does have spaces, so matching inside would turn "thesaurus" into
 * "saurus"; a token that is exactly a stop word is dropped, nothing else.
 *
 * Markup characters can survive inside a CJK run ("**地址**"), so every token is
 * trimmed of non-word residue at its edges before it is kept.
 */
function stripStopwords(token) {
  let out = token;
  for (const word of EXTRACT_STOPWORDS) {
    if (out === "") break;
    if (/^[\x00-\x7f]+$/.test(word)) {
      if (out.toLowerCase() === word) return "";
    } else {
      out = out.split(word).join("");
    }
  }
  // Unicode-aware: a CJK character is a word character, and stripping the edges
  // must not strip it. \p{L} covers a-z, A-Z and Han; the rest are dropped.
  const trimmed = out.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : "";
}

export function queryFromMessages(messages) {
  const index = lastUserIndex(messages);
  if (index < 0) return { query: "", index: -1 };
  const text = messageText(messages[index]).trim();
  return { query: truncateToBytes(text, QUERY_MAX_CHARS).trim(), index };
}

function rememberQuery(sessionKey, query) {
  lastQuery.set(sessionKey, query);
  while (lastQuery.size > CACHE_MAX_ENTRIES) lastQuery.delete(lastQuery.keys().next().value);
}

export function resetLastQuery() {
  lastQuery.clear();
}

/** The session's remembered query, or undefined. Read-only, for the probes. */
export function lastQueryFor(sessionKey) {
  return lastQuery.get(sessionKey);
}

/* ------------------------------------------------------------- injection -- */

/**
 * Insert the recalled text as one message immediately before the last user
 * message, and return a NEW array.
 *
 * Three rules, all of them deliberate:
 *
 *   * **No existing message is touched.** Every element is passed through by
 *     reference. Recall is additive; a hook that rewrote history would be
 *     indistinguishable from a hook that corrupted it.
 *   * **The recall sits before the user's question, not after it.** The user's
 *     own words stay last, which is where the model looks for the actual
 *     request — recall is context for that request, not a replacement for it.
 *   * **Only the injection is inserted.** When the recall would push past the
 *     budget, the recall is truncated; the messages around it are never trimmed
 *     to make room. Dropping the user's own text to fit recall would be a
 *     strictly worse trade than shortening the recall.
 */
export function injectBeforeLastUser(messages, recallText, maxBytes) {
  const index = lastUserIndex(messages);
  const budget = Math.max(0, maxBytes);
  const body = truncateToBytes(recallText, budget);
  const wrapped = wrapRecall(body);
  const message = { role: "user", content: wrapped };

  const next = messages.slice();
  if (index < 0) {
    // No user message at all (a pure tool-loop step that still triggered the
    // hook). Appending keeps the recall present without inventing an order.
    next.push(message);
  } else {
    next.splice(index, 0, message);
  }
  return { messages: next, injected: wrapped, truncated: body !== recallText };
}

/* --------------------------------------------------------------- prepare -- */

function scopeFor(sdk, config) {
  return resolveScope(sdk, config, undefined);
}

/**
 * One bounded recall query, with a per-session TTL cache.
 *
 * Returns `{ ok, text, bytes, scopeId, error }`. Never throws.
 *
 * Note the reuse rule: within the TTL a cached entry is returned regardless of
 * whether this step's query differs. That is the contract this stage was asked
 * for ("same session within 60s reuses the last injection"), and it is also the
 * behaviour that keeps a per-step hook from becoming a per-step Server load. A
 * different topic inside 60 seconds will therefore see the previous recall; the
 * cost of that is a less relevant injection for one step, against a request per
 * model step for every session on the machine.
 */
export async function prepareRecall(sdk, config, sessionKey, query, options = {}) {
  const cached = cacheGet(sessionKey);
  if (cached) {
    counters.cache_hits += 1;
    return { ok: true, text: cached.text, bytes: cached.bytes, scopeId: cached.scopeId, cached: true, query: cached.query };
  }
  counters.cache_misses += 1;

  const scope = await scopeFor(sdk, config);
  if (!scope.ok) return { ok: false, error: scope };

  const key = `${sessionKey}\u0000${query}\u0000${scope.scopeId}\u0000${config.prestepMaxBytes}`;
  if (inFlight.has(key)) return inFlight.get(key);

  const pending = (async () => {
    const response = await request(
      sdk,
      config,
      "/v1/context/prepare",
      { scope_id: scope.scopeId, query, max_bytes: config.prestepMaxBytes },
      { timeoutMs: config.prestepTimeoutMs, signal: options.signal },
    );
    if (!response.ok) return { ok: false, error: response };

    const data = response.data || {};
    const text = typeof data.content === "string" ? data.content : "";
    const bytes = Number.isFinite(data.content_bytes) ? data.content_bytes : utf8Bytes(text);
    if (bytes <= 0 || text.trim() === "") {
      return { ok: true, empty: true, text: "", bytes: 0, scopeId: scope.scopeId };
    }

    cacheSet(sessionKey, { query, text, bytes, at: Date.now(), scopeId: scope.scopeId });
    return { ok: true, text, bytes, scopeId: scope.scopeId, cached: false };
  })();

  inFlight.set(key, pending);
  try {
    return await pending;
  } finally {
    inFlight.delete(key);
  }
}

/* --------------------------------------------------------------- capture -- */

/**
 * Capture one user prompt as a Source, with deduplication. Never throws.
 *
 * Off by default and deliberately narrow: only the user's own prompt is
 * captured. Tool results and assistant messages are not, which keeps the
 * privacy surface to text the user typed themselves and avoids needing the
 * separate observe grant this stage does not request.
 */
export async function capturePrompt(sdk, config, scopeId, text) {
  const body = truncateToBytes(text, config.captureMaxBytes).trim();
  if (body === "") return { ok: true, skipped: true };

  const hash = contentHash(body);
  if (captureWasSeen(hash)) {
    counters.captures_duplicate += 1;
    return { ok: true, duplicate: true };
  }

  const response = await request(sdk, config, "/v1/sources/content", {
    scope_id: scopeId,
    source_id: nextCaptureSourceId(),
    content: body,
    metadata: { captured_by: "hana-powercontext", captured_at: new Date().toISOString() },
  });

  if (!response.ok) {
    counters.captures_failed += 1;
    return { ok: false, error: response };
  }
  counters.captures += 1;
  return { ok: true, source: response.data ? response.data.source : null };
}

/** Monotonic counter for capture ids, for the same reason the handoff boundary has one. */
let captureSequence = 0;

/** A unique, sortable capture Source id: millisecond stamp + process counter. */
export function nextCaptureSourceId() {
  captureSequence += 1;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
  return `pc-capture-${stamp}-${String(captureSequence).padStart(4, "0")}`;
}

/* ----------------------------------------------------------- the hooks ---- */

/**
 * `agent/pre-step` — the core of stage 2.
 *
 * Returns `{ messages }` when recall was injected, and `undefined` in every
 * other case: switch off, no usable query, Server unreachable, timeout, empty
 * recall, or any unexpected error. The host treats `undefined` as "no change",
 * so the turn proceeds untouched.
 */
export async function preStepDecision(sdk, config, invocation, deps = {}) {
  const {
    prepareRecallFn = prepareRecall,
    capturePromptFn = capturePrompt,
    now = () => Date.now(),
  } = deps;

  counters.prestep_invocations += 1;

  if (!config.prestep) {
    counters.skipped_disabled += 1;
    return undefined;
  }

  const messages = invocation && Array.isArray(invocation.messages) ? invocation.messages : null;
  if (!messages || messages.length === 0) {
    counters.skipped_empty += 1;
    return undefined;
  }

  const sessionKey = sessionKeyOf(invocation.session);

  // No session identity at all means no safe cache key: every anonymous
  // invocation would share one entry, so one session's recall could be injected
  // into another's. Injection without usable session identity is a correctness
  // problem, not a degraded feature, so this path injects nothing.
  if (sessionKey === ANONYMOUS_SESSION) {
    counters.skipped_no_query += 1;
    return undefined;
  }

  // Layer 1: the verbatim last-user-message query (unchanged since stage 2).
  // Only the text is read here; the message index it reports belongs to the
  // injection helper, which finds the insertion point itself.
  const { query: rawQuery } = queryFromMessages(messages);

  // Layer 2: the retrieval-shaping pass added in stage 2B. The raw text is the
  // fallback *inside* the extractor, so the only way to arrive here with an
  // empty query is an empty or unusable message — not a badly shaped one.
  const { query, extracted, usedFallback } = rawQuery === ""
    ? { query: "", extracted: "", usedFallback: false }
    : extractRetrievalQuery(rawQuery);

  if (query === "") {
    counters.skipped_empty_extracted += 1;
    // A pure tool-loop step: no new user text. Falling back to the session's last
    // query keeps recall alive across the steps of one turn without inventing a
    // query the user never typed.
    const previous = lastQuery.get(sessionKey);
    if (!previous) {
      counters.skipped_no_query += 1;
      return undefined;
    }
    const recall = await safePrepare(prepareRecallFn, sdk, config, sessionKey, previous, invocation.signal);
    if (!recall.ok) {
      counters.skipped_error += 1;
      if (recall.unreachable) clearRecallCache();
      return undefined;
    }
    if (recall.empty) {
      counters.skipped_empty += 1;
      return undefined;
    }
    return finishInjection(messages, recall, config, counters);
  }

  // A step whose extraction actually changed the text is counted once, here and
  // nowhere else, so `extract_hits` is exactly "how much work the layer is
  // doing" rather than an approximation of it.
  if (!usedFallback && extracted !== rawQuery) counters.extract_hits += 1;

  rememberQuery(sessionKey, query);

  const recall = await safePrepare(prepareRecallFn, sdk, config, sessionKey, query, invocation.signal);
  if (!recall.ok) {
    counters.skipped_error += 1;
    if (recall.unreachable) clearRecallCache();
    return undefined;
  }
  if (recall.empty) {
    counters.skipped_empty += 1;
    return undefined;
  }

  // Capture is best-effort and strictly after a successful recall, so a capture
  // problem can never be the reason a step lost its injection.
  //
  // It captures `rawQuery`, not the extracted phrase, and that is a deliberate
  // separation of the two consumers: the extractor exists so the *matcher* can
  // find something, and losing the user's own wording to it would be a
  // regression in what capture means — the prompt as typed, kept for later
  // reading by a human or a model. The extracted phrase is a retrieval key; it
  // is not the record.
  if (config.capturePrompts && recall.scopeId) {
    try {
      await capturePromptFn(sdk, config, recall.scopeId, rawQuery);
    } catch {
      counters.captures_failed += 1;
    }
  }

  return finishInjection(messages, recall, config, counters);
}

function finishInjection(messages, recall, config, counterSink) {
  try {
    const { messages: next, injected } = injectBeforeLastUser(messages, recall.text, config.prestepMaxBytes);
    counterSink.injections += 1;
    void injected;
    return { messages: next };
  } catch {
    counterSink.skipped_error += 1;
    return undefined;
  }
}

/** Wrap a prepare call so a thrown error becomes a structured skip, not a throw. */
async function safePrepare(prepareFn, sdk, config, sessionKey, query, signal) {
  try {
    const result = await prepareFn(sdk, config, sessionKey, query, { signal });
    if (!result || result.ok !== true) {
      const error = result && result.error ? result.error : null;
      return { ok: false, unreachable: Boolean(error && error.kind === "unreachable") };
    }
    return result;
  } catch {
    return { ok: false, unreachable: false };
  }
}

/**
 * `agent/before-start` — handoff injection, default off.
 *
 * Asks the Server for the latest prepared Handoff. On a Server with no
 * generation provider there is never one to find (D11), so this hook is a no-op
 * in basic-memory mode by construction rather than by a special case.
 */
export async function beforeStartDecision(sdk, config, invocation, deps = {}) {
  const { requestFn = request } = deps;
  counters.beforestart_invocations += 1;

  if (!config.beforeStart) {
    counters.beforestart_skipped += 1;
    return undefined;
  }

  try {
    const scope = await scopeFor(sdk, config);
    if (!scope.ok) {
      counters.beforestart_skipped += 1;
      return undefined;
    }

    const response = await requestFn(
      sdk,
      config,
      "/v1/handoff/continue",
      { scope_id: scope.scopeId, selection: "latest" },
      { timeoutMs: config.prestepTimeoutMs, signal: invocation && invocation.signal },
    );
    if (!response.ok) {
      counters.beforestart_skipped += 1;
      return undefined;
    }

    // The Server answers with a HandoffResolution: `content` sits at the top
    // level and is `null` when there is nothing to continue (`status: "empty"`),
    // which is the normal answer on a Server with no committed handoff. Read it
    // from there rather than inventing a wrapper field.
    const resolution = response.data || {};
    const content = resolution.content || null;
    if (!content || resolution.status === "empty") {
      counters.beforestart_skipped += 1;
      return undefined;
    }

    counters.beforestart_injections += 1;
    return {
      message: {
        customType: "powercontext.handoff",
        content: wrapRecall(JSON.stringify(content, null, 2)),
        display: false,
      },
    };
  } catch {
    counters.beforestart_skipped += 1;
    return undefined;
  }
}

/**
 * Register both hooks and return their disposers.
 *
 * Registration itself is not wrapped in a retry: `onDecision` returns a disposer
 * synchronously and does not need the host's command registry, so unlike
 * `commands.register` it is safe to call during setup. Failures are reported
 * through the logger and never reject out of the App.
 */
export async function registerHooks(sdk, configNow, logger) {
  const disposers = [];

  const withConfig = (fn) => async (invocation) => {
    // Config is resolved per invocation so a switch change takes effect on the
    // next step, without an App reload.
    const config = configNow();
    try {
      return await fn(sdk, config, invocation);
    } catch {
      // Belt and braces: the individual handlers already swallow, but a hook must
      // never be the thing that breaks a turn.
      return undefined;
    }
  };

  try {
    disposers.push(sdk.hooks.onDecision("agent/pre-step", withConfig(preStepDecision)));
  } catch (error) {
    void logger(`hana-powercontext: could not register agent/pre-step (${error && error.message ? error.message : error})`);
  }

  try {
    disposers.push(sdk.hooks.onDecision("agent/before-start", withConfig(beforeStartDecision)));
  } catch (error) {
    void logger(`hana-powercontext: could not register agent/before-start (${error && error.message ? error.message : error})`);
  }

  return disposers;
}
