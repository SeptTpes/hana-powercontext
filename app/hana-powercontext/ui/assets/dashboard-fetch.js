/**
 * ui/assets/dashboard-fetch.js — the card's one door to its own backend.
 *
 * BUG-3 lived here. The card used a bare `fetch()`, which worked while the
 * surface-session credential happened to ride along on a same-origin cookie and
 * stopped working the moment the host stopped honouring that — every card
 * interaction answered `403 {"error":"forbidden","reason":"missing_credential"}`
 * while the App's tools and hooks kept running fine.
 *
 * The official door is `hana.api.fetch` from the App's browser SDK: it reads
 * `appSurfaceSession` out of the card iframe's own URL and sets it as a request
 * header, then resolves the path relative to this App's routes. Its contract, read
 * from the bundled SDK (`sdk/_ui-types.d.ts` and the `ui.js` implementation):
 *
 *   fetch(path: string, init?: RequestInit): Promise<Response>
 *     -> GET <origin>/api/apps/<appId>/routes/<path>
 *     -> header appSurfaceSession: <the value from the iframe URL>
 *     -> path is App-relative ("status", "/status", "memory?limit=3");
 *        a leading slash is stripped, and a path starting with "api/apps" is
 *        rejected outright.
 *
 * So this module passes `"status"`, never a full URL — the SDK owns the prefix.
 *
 * The module has no DOM dependency on purpose: `lib/dashboard-probe.mjs` imports
 * it directly to assert which door was used and what the card says when each door
 * fails. View logic that can only be exercised by a real iframe is view logic that
 * ships broken.
 */

(function attachTransport(root) {
  "use strict";

  /**
   * The header the SDK sets, and the query key it reads it from. Named here — not
   * set here — so a failure can be described precisely and a probe can assert the
   * App never tries to supply the credential itself. Both values are read from the
   * bundled SDK (`ui.js`: `APP_SURFACE_SESSION_HEADER` / `..._QUERY`) and match
   * the host's APPS.md.
   */
  const SURFACE_SESSION_HEADER = "X-Hana-App-Surface-Session";
  const SURFACE_SESSION_QUERY = "appSurfaceSession";

  /**
   * This App's own preference route, relative to the App's route namespace.
   * BUG-7 established that registered paths are route-relative, so the SDK's own
   * prefix resolution yields /routes/prefs — matching the other four routes.
   */
  const PREFS_PATH = "prefs";

  /**
   * Which door was used, and how often. Counts only — no URL, no credential.
   *
   * `fallbacks` is the one worth watching: it counts the times the official door
   * was absent and a bare `fetch` took over, which is exactly the code path BUG-3
   * proved is not credential-safe in a current host.
   */
  const counters = {
    api_fetch: 0,
    raw_fetch: 0,
    fallbacks: 0,
    route_errors: 0,
    transport_errors: 0,
    ok: 0,
    // B25: a preference write that failed. Counted rather than thrown — the toggle
    // still takes effect for this view, and the user is not interrupted to be told
    // that a layout choice will not be remembered.
    pref_write_errors: 0,
  };

  function resetCounters() {
    for (const key of Object.keys(counters)) counters[key] = 0;
  }

  /** Is the official, credential-carrying door present? */
  function hasApiFetch(hana) {
    return Boolean(hana && hana.api && typeof hana.api.fetch === "function");
  }

  /**
   * Turn any thrown value into a short, non-leaking description.
   *
   * `hana.api.fetch` throws messages that mention `appSurfaceSession`; those are
   * useful to a reader and contain no secret (the header *name*, never its value).
   */
  function describe(error) {
    if (!error) return "未知错误";
    const message = typeof error.message === "string" && error.message ? error.message : String(error);
    return message.length > 300 ? message.slice(0, 300) + "…" : message;
  }

  /**
   * The failure the card renders when its OWN backend could not be reached.
   *
   * Deliberately distinct from a Server outage: nothing here suggests the
   * PowerContext Server is down, because it is not — the App backend is, and the
   * fix is to reopen the card, not to start a Server. Conflating the two is what
   * made the original bug hard to read (the outage banner showed with an empty
   * address, which is the tell).
   */
  function routeFailure(section, detail) {
    return {
      kind: "route_failure",
      transport: detail.transport,
      status: detail.status === undefined ? null : detail.status,
      message: detail.message,
      hint: "关闭这张卡片并重新打开。若仍然如此，重载 App；卡片后端与 Server 是两条独立链路，Server 是否在跑与本提示无关。",
    };
  }

  /**
   * One backend call.
   *
   * Never throws: a throwing call would leave the card on "正在连接…" forever,
   * which is the worst possible failure state for a UI.
   *
   * Returns either the backend's JSON body (which carries its own `ok`), or a
   * `routeFailure` descriptor the view renders as a transport problem.
   */
  async function loadSection(section, options = {}) {
    const hana = options.hana !== undefined ? options.hana : root.hana;
    const outcome = await request(section, { ...options, hana });

    if (outcome.thrown) {
      counters.transport_errors += 1;
      return routeFailure(section, {
        transport: outcome.transport,
        message: `调用卡片后端（${section}）失败：${describe(outcome.thrown)}`,
      });
    }

    const { response } = outcome;
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      counters.route_errors += 1;
      const reason = body && body.reason ? `（${body.reason}）` : "";
      return routeFailure(section, {
        transport: outcome.transport,
        status: response.status,
        message: `卡片后端 ${section} 返回 HTTP ${response.status}${reason}。`,
      });
    }

    counters.ok += 1;
    return body;
  }

  /**
   * Perform the request through whichever door is available.
   *
   * Note what is deliberately NOT done: when `hana.api.fetch` exists but throws,
   * this does not silently retry with a bare `fetch`. A bare retry is exactly the
   * call that produced the 403 — retrying it would turn a clear credential failure
   * into a confusing double failure, and would hide the real cause. The fallback is
   * only for the case the task calls out: the official door being absent (older
   * host, or a plain browser).
   */
  async function request(section, { hana, rawPath, fetchImpl, baseUrl, method, body } = {}) {
    const doRaw = fetchImpl || (typeof fetch === "function" ? fetch : null);
    const init = { headers: { accept: "application/json" } };
    // Writes (the prefs route) need a method and a body; reads leave both unset so
    // they stay plain GETs.
    if (method) init.method = method;
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    if (hasApiFetch(hana)) {
      try {
        counters.api_fetch += 1;
        // App-relative on purpose: the SDK resolves it against this App's routes
        // and attaches the surface credential. Passing a full URL here is the
        // mistake that silently reintroduces a credential-less request.
        const response = await hana.api.fetch(section, init);
        return { thrown: null, response, transport: "api" };
      } catch (error) {
        return { thrown: error, transport: "api", response: null };
      }
    }

    counters.fallbacks += 1;
    counters.raw_fetch += 1;
    if (!doRaw) {
      return { thrown: new Error("no fetch implementation available"), transport: "none", response: null };
    }
    // A same-origin relative URL is correct in the card and needs no `location`;
    // `baseUrl` exists so an offline caller can point it at a local server.
    const target = rawPath ? (baseUrl ? String(baseUrl).replace(/\/+$/, "") + rawPath : rawPath) : section;
    try {
      const response = await doRaw(target, init);
      return { thrown: null, response, transport: "raw" };
    } catch (error) {
      return { thrown: error, transport: "raw", response: null };
    }
  }

  /* --------------------------------------------------- preferences (B25) -- */

  /**
   * Read the card's persisted preferences from the App's own backend.
   *
   * Returns the collapse map, or `{}` on any failure. A card that cannot read its
   * preferences must still render — it just starts with everything expanded, which
   * is the default anyway. Failing loudly here would trade a cosmetic loss for a
   * broken card.
   */
  async function readPrefs(options = {}) {
    const outcome = await request(PREFS_PATH, { ...options, method: "GET" });
    if (outcome.thrown || !outcome.response || !outcome.response.ok) return {};
    try {
      const body = await outcome.response.json();
      return body && body.prefs && body.prefs.collapsed ? body.prefs.collapsed : {};
    } catch {
      return {};
    }
  }

  /**
   * Persist one section's collapse preference.
   *
   * The write is a single field, merged server-side, so two cards cannot clobber
   * each other's unrelated choices. On failure the caller keeps the new state on
   * screen and the counter records it: the user asked for the section to collapse
   * and it did — interrupting them to say "that will not be remembered" is noise
   * about a detail they did not ask about.
   *
   * Returns true when the write is known to have landed.
   */
  async function writePrefs(section, collapsed, options = {}) {
    const body = { collapsed: { [section]: Boolean(collapsed) } };
    const outcome = await request(PREFS_PATH, { ...options, method: "PUT", body });
    if (outcome.thrown || !outcome.response || !outcome.response.ok) {
      counters.pref_write_errors += 1;
      return false;
    }
    try {
      const payload = await outcome.response.json();
      if (payload && payload.ok === false) {
        counters.pref_write_errors += 1;
        return false;
      }
    } catch {
      // An unparseable 200 still means the route accepted the write; the response
      // body is not what the toggle depends on.
    }
    return true;
  }

  /**
   * Where this App's backend lives for a bare `fetch`.
   *
   * Derived from the page's own path — `/api/apps/<id>/ui/dashboard.html` means the
   * routes are at `/api/apps/<id>/routes`. Only the fallback path uses this; with
   * `hana.api.fetch` the SDK owns the prefix and this is never consulted. The
   * hard-coded last resort keeps the function total rather than throwing on an
   * unexpected pathname.
   */
  function routesBaseFrom(pathname, appId = "hana-powercontext") {
    const path = typeof pathname === "string" ? pathname : "";
    const at = path.indexOf("/ui/");
    if (at > -1 && at > 0) {
      // Guard against a degenerate slice (e.g. a pathname that starts with /ui/).
      const base = path.slice(0, at);
      if (base) return base + "/routes";
    }
    return `/api/apps/${appId}/routes`;
  }

  /* ------------------------------------------------------- view state (B18) -- */

  /**
   * The collapse state, read and written through whatever bridge is supplied.
   *
   * DEPRECATED for production use — kept as the record of the pre-0.4.0
   * `hana.state` approach (see `artifacts/ACCEPTANCE-2.md`). No live caller; do not
   * wire new code to these. The card persists its collapse preference through
   * `readPrefs`/`writePrefs` against the App's own app-data.
   *
   * Why it is still here, and still tested: B18 asked whether a collapsed section
   * survives a remount, and this is the code that answered "no, and here is why".
   * The probe supplies a fake bridge, collapses something, builds a second reader
   * over the same store, and asserts the state came back — which pins the
   * *mechanism* while the real defect was the store's lifetime
   * (`hana.state` lives as long as the card instance). Deleting a tested function
   * is how the evidence for a past decision disappears.
   *
   * A `null` read means "never written", which must stay distinct from an explicit
   * `false` — otherwise a section the user expanded on purpose would be
   * indistinguishable from one they never touched.
   */
  const DEFAULT_SECTIONS = ["handoff", "memory"];

  function collapseKey(section) {
    return `collapsed:${section}`;
  }

  /**
   * BUG-8: unwrap the storage envelope.
   *
   * The host's state API round-trips the value inside an envelope
   * (`{appId, scope, key, value, ...}` — the same shape the server's
   * storage GET returns, observable as `[object Object]` in the card's
   * state-bridge meter). `Boolean(envelope)` is always true, which is how
   * a single stored collapse made every remount open collapsed forever,
   * no matter what the user did afterwards.
   *
   * Envelope members found in the wild: `value` (the stored value),
   * `key`, `scope`, `appId`, `updatedAt`. Unknown shapes degrade to
   * "unset" (expanded) rather than to a guess — an unknown object is not
   * evidence of a collapse.
   */
  function unwrapStored(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== "object") return raw;
    if ("value" in raw) return raw.value;
    return null;
  }

  async function readCollapsed(bridge, sections = DEFAULT_SECTIONS) {
    const out = {};
    for (const section of sections) {
      const storedRaw = bridge && typeof bridge.get === "function" ? await bridge.get(collapseKey(section), null) : null;
      const stored = unwrapStored(storedRaw);
      out[section] = stored === null || stored === undefined ? false : Boolean(stored);
    }
    return out;
  }

  async function writeCollapsed(bridge, section, collapsed) {
    if (!bridge || typeof bridge.set !== "function") return false;
    await bridge.set(collapseKey(section), Boolean(collapsed));
    return true;
  }

  /* -------------------------------------------------- failure visibility -- */

  /**
   * Did this section fail to load?
   *
   * Fix-2 rests on this predicate, which is why it is a named, tested function
   * rather than an inline `!` somewhere in the render path. Two shapes arrive here:
   *
   *   * the transport's own `route_failure` descriptor, which has no `ok` field
   *     (`loadSection` returns it directly rather than wrapping it), and
   *   * the backend's body, which carries `ok: false` when the section's work
   *     failed.
   *
   * A body with `ok: true` is a success — including an `ok: true, handoff: null`
   * empty Handoff, which is a *normal* answer and must stay collapsible like any
   * other successful section.
   */
  function sectionFailed(section) {
    if (!section || typeof section !== "object") return false;
    if (section.ok === false) return true;
    // The route-failure descriptor: identified by its own kind, since it has no ok.
    return section.kind === "route_failure" || section.kind === "backend_error";
  }

  /**
   * The collapse state a section should actually render with.
   *
   * A failed section is ALWAYS expanded, whatever the user last chose. Its content
   * is the error — the reason the card exists on a bad day — and a collapsed failed
   * section is an invisible failure, which is the single defect this whole
   * campaign kept finding. Collapse preference applies only to sections that
   * loaded.
   */
  function effectiveCollapsed(section, storedValue) {
    if (sectionFailed(section)) return false;
    return Boolean(storedValue);
  }

  const api = {
    counters,
    resetCounters,
    hasApiFetch,
    // B25: the live persistence path.
    readPrefs,
    writePrefs,
    PREFS_PATH,
    sectionFailed,
    effectiveCollapsed,
    unwrapStored,
    loadSection,
    request,
    routesBaseFrom,
    routeFailure,
    // Legacy: these two are the hana.state-era collapse persistence. Retired in
    // 0.4.0 in favour of readPrefs/writePrefs above; kept because the probe still
    // exercises them as the record of what B25 was, and because deleting a tested
    // function is how the evidence for a past decision disappears.
    readCollapsed,
    writeCollapsed,
    collapseKey,
    SURFACE_SESSION_HEADER,
    SURFACE_SESSION_QUERY,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.PowerContextDashboardFetch = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
