/**
 * lib/powercontext.js — the thin HTTP client the App's tools and commands sit on.
 *
 * Fail-open contract (the load-bearing rule of this file):
 *   * every call makes AT MOST ONE request; there is no retry, no backoff and no
 *     queue, so an unreachable Server can never turn into a retry storm;
 *   * every request carries an explicit `timeoutMs`, so a hung Server surfaces
 *     as an error in bounded time instead of stalling the caller;
 *   * nothing here throws at a caller that asked for a result — `request()`
 *     returns `{ ok: false, error }` with a human-readable reason, and the tool
 *     layer renders that as a normal tool result. The worst case for a turn is a
 *     tool result that says the Server is down, never a blocked session.
 *
 * It intentionally does not import `./config.js`: callers resolve settings once
 * per invocation and hand the result in, which keeps this module testable
 * without an SDK present.
 */

/** Convert a value into a short, single-line, bounded diagnostic string. */
function describe(value, limit = 400) {
  let text;
  if (value instanceof Error) {
    text = value.message || value.name || "Error";
  } else if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = String(text).replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit) + "…" : text;
}

/**
 * Build a structured, model-readable failure. The `kind` is what callers switch
 * on; `hint` is what a human reads to fix it.
 */
export function failure(kind, message, extra = {}) {
  return { ok: false, kind, message: describe(message, 600), ...extra };
}

/**
 * One POST to the PowerContext Server.
 *
 * @param {object} sdk            the App SDK (only `sdk.network.fetch` is used)
 * @param {object} config         resolved configuration (see lib/config.js)
 * @param {string} path           Server path, e.g. "/v1/context/prepare"
 * @param {object} body           JSON request body
 * @param {object} [options]      { timeoutMs, maxResponseBytes, method }
 * @returns {Promise<{ok: true, status: number, data: any} | {ok: false, kind: string, message: string}>}
 */
export async function request(sdk, config, path, body, options = {}) {
  const url = config.baseUrl + path;
  const method = options.method || "POST";
  const timeoutMs = options.timeoutMs || config.timeoutMs;
  const maxResponseBytes = options.maxResponseBytes || config.maxResponseBytes;

  // A missing network door is a real, actionable misconfiguration: the manifest
  // has no top-level `network` block. Say so instead of reporting a timeout.
  if (!sdk || !sdk.network || typeof sdk.network.fetch !== "function") {
    return failure(
      "network_not_declared",
      "sdk.network.fetch is unavailable; the App manifest must declare a top-level network block.",
      { url },
    );
  }

  let response;
  try {
    response = await sdk.network.fetch(url, {
      method,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Host-side bounds. `timeoutMs` is the single bound that stops a hung
      // Server from stalling the caller; without it this promise could outlive
      // the turn that is waiting on it.
      timeoutMs,
      maxResponseBytes,
    });
  } catch (error) {
    // Reached when the host network door itself refuses or the connection
    // fails: allow-list miss, localhost not allowed, DNS, refused socket, or
    // the host-side timeout firing. No retry is attempted here.
    return failure("unreachable", `PowerContext Server is not reachable at ${config.baseUrl} (${describe(error)}).`, {
      url,
      timeoutMs,
      hint: "Start it with scripts/start-server.sh, or set POWERCONTEXT_HANA_BASE_URL to a running Server.",
    });
  }

  const status = response && typeof response.status === "number" ? response.status : 0;

  let text = "";
  try {
    text = await response.text();
  } catch (error) {
    return failure("read_failed", `Response body from ${url} could not be read (${describe(error)}).`, { url, status });
  }

  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // A non-JSON body is almost always an HTML error page from something that
      // is listening on the port but is not PowerContext.
      return failure(
        "not_json",
        `${url} returned HTTP ${status} with a non-JSON body; something other than PowerContext may be listening on ${config.baseUrl}.`,
        { url, status, bodyPreview: describe(text, 200) },
      );
    }
  }

  if (!response.ok) {
    const serverMessage = data && data.error ? data.error.message || data.error.code : describe(text, 200);
    const serverCode = data && data.error ? data.error.code : undefined;
    return failure("http_error", `${path} returned HTTP ${status}: ${describe(serverMessage)}`, {
      url,
      status,
      serverCode,
      details: data && data.error ? data.error.details : undefined,
    });
  }

  return { ok: true, status, data };
}

/** GET convenience wrapper, used by the health probes. */
export function get(sdk, config, path, options = {}) {
  return request(sdk, config, path, undefined, { ...options, method: "GET" });
}

/**
 * Liveness + readiness in one call — the primitive behind `/pc doctor`.
 * Returns a structured verdict and never throws.
 */
export async function probe(sdk, config) {
  const checkedAt = new Date().toISOString();

  const live = await get(sdk, config, "/health/live");
  if (!live.ok) {
    return {
      ok: false,
      stage: "liveness",
      baseUrl: config.baseUrl,
      checkedAt,
      error: live,
    };
  }

  const ready = await get(sdk, config, "/health/ready");
  if (!ready.ok) {
    return {
      ok: false,
      stage: "readiness",
      baseUrl: config.baseUrl,
      checkedAt,
      liveness: live.data,
      error: ready,
    };
  }

  // capabilities is informational: a Server that is live and ready but whose
  // capability probe fails is still usable, so a failure here is recorded and
  // does not flip `ok`.
  const capabilities = await get(sdk, config, "/v1/capabilities");
  const checks = ready.data && ready.data.checks ? ready.data.checks : {};

  return {
    ok: true,
    baseUrl: config.baseUrl,
    checkedAt,
    status: ready.data ? ready.data.status : "unknown",
    checks,
    liveness: live.data,
    readiness: ready.data,
    capabilities: capabilities.ok ? capabilities.data : null,
    capabilitiesError: capabilities.ok ? null : capabilities,
    /** Context assembly is the one binding a recall tool needs; surface it plainly. */
    contextVersion:
      capabilities.ok && capabilities.data && capabilities.data.context
        ? capabilities.data.context.versions
        : undefined,
  };
}
