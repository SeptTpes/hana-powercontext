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
  async function request(section, { hana, rawPath, fetchImpl, baseUrl } = {}) {
    const doRaw = fetchImpl || (typeof fetch === "function" ? fetch : null);
    const init = { headers: { accept: "application/json" } };

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
   * B18 asked whether a collapsed section survives a remount. That question is
   * about *this* persistence, not about the DOM, so it lives here where it can be
   * unit-tested: the probe supplies a fake bridge, collapses something, builds a
   * second reader over the same store, and asserts the state came back. What stays
   * unproven offline is only whether the host's `hana.state` is the thing behind
   * the bridge (that is B18-on-real-hardware).
   *
   * A `null` read means "never written", which must stay distinct from an explicit
   * `false` — otherwise a section the user expanded on purpose would be
   * indistinguishable from one they never touched.
   */
  const DEFAULT_SECTIONS = ["handoff", "memory"];

  function collapseKey(section) {
    return `collapsed:${section}`;
  }

  async function readCollapsed(bridge, sections = DEFAULT_SECTIONS) {
    const out = {};
    for (const section of sections) {
      const stored = bridge && typeof bridge.get === "function" ? await bridge.get(collapseKey(section), null) : null;
      out[section] = stored === null || stored === undefined ? false : Boolean(stored);
    }
    return out;
  }

  async function writeCollapsed(bridge, section, collapsed) {
    if (!bridge || typeof bridge.set !== "function") return false;
    await bridge.set(collapseKey(section), Boolean(collapsed));
    return true;
  }

  const api = {
    counters,
    resetCounters,
    hasApiFetch,
    readCollapsed,
    writeCollapsed,
    collapseKey,
    loadSection,
    request,
    routesBaseFrom,
    routeFailure,
    readCollapsed,
    writeCollapsed,
    collapseKey,
    SURFACE_SESSION_HEADER,
    SURFACE_SESSION_QUERY,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.PowerContextDashboardFetch = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
