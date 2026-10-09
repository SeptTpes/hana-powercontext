/**
 * ui/assets/dashboard-page.js — the dashboard card's wiring. **ES module.**
 *
 * Two jobs: render the view model from `./dashboard.js`, and remember which
 * sections the user collapsed. The fetching itself lives in
 * `./dashboard-fetch.js`, which owns the BUG-3 fix and is importable without a
 * DOM so it can be asserted offline.
 *
 * --- BUG-4: why this file is a module now -------------------------------
 *
 * BUG-3 taught the card to call `hana.api.fetch`, and it still 403'd in a real
 * card, because `globalThis.hana` **did not exist**. That global is not supplied
 * by the host: it comes from the scaffold's local browser bridge,
 * `ui/assets/sdk.js` (APPS.md: "轻量 HTML 可使用脚手架附带的本地
 * ui/assets/sdk.js"). The ui tree here was hand-built in stage 3, so the bridge
 * was simply never included — and every `hana.*` call was a silent no-op from
 * day one. That is also why collapse state never actually persisted (B18/B23):
 * `hana.state` was never there either.
 *
 * `sdk.js` is an ES module, so it is imported — a classic `<script src>` would
 * be a syntax error on its `export` statements.
 *
 * --- how hana reaches the transport ------------------------------------
 *
 * Explicitly (option b), not by assigning a global (option a). The bridge is
 * imported here, at the one place that owns page wiring, and handed to
 * `loadSection`/`readPrefs`/`writePrefs` through their `options` arguments
 * arguments. That keeps the dependency visible in the code that uses it and
 * leaves `globalThis.hana` untouched — so nothing else in the App can
 * accidentally start depending on an ambient global that only exists inside a
 * host-mounted card. `dashboard-fetch.js` needed no change for this: it already
 * took `options.hana` and a bridge object.
 *
 * It never talks to the PowerContext Server. Everything Server-shaped arrives
 * through this App's own routes, which is the App backend reusing the same Scope
 * resolution, network declaration, timeout and fail-open behaviour as the tools.
 */

// Fix-1: the bridge is version-stamped too. It is imported rather than a
// <script src>, but it is still an asset the host may cache, and a stale bridge
// reintroduces BUG-4 — hana.* silently missing. Keep this query equal to
// manifest.json's version; lib/selftest.mjs asserts both against the manifest.
import { hana } from "./sdk.js?v=1.0.0";

(function main() {
  "use strict";

  const view = globalThis.PowerContextDashboard;
  const transport = globalThis.PowerContextDashboardFetch;
  const root = document.getElementById("root");

  if (!view || !transport) {
    // A missing classic script is a packaging error, not a runtime condition: say
    // which one so the failure is diagnosable instead of a blank card. (The html's
    // inline fallback covers the case where THIS module never runs at all.)
    root.textContent = !view
      ? "卡片脚本未加载（dashboard.js）。请重载 App。"
      : "卡片脚本未加载（dashboard-fetch.js）。请重载 App。";
    return;
  }

  /**
   * Where the fallback path would look. Only consulted when `hana.api.fetch` is
   * absent (older host or a plain browser); with the official door the SDK owns
   * the prefix and this is never used.
   */
  const routesBase = transport.routesBaseFrom(typeof location === "object" ? location.pathname : "");

  /**
   * The collapsible sections.
   *
   * These keys used to double as the `hana.state` keys for collapse state; since
   * 0.4.0 the preference is persisted in the App's own app-data instead, keyed by
   * these same names in `prefs.json`.
   */
  const SECTIONS = ["handoff", "memory"];

  const state = {
    data: null,
    collapsed: {},
    busy: false,
  };

  /* ------------------------------------------------- preferences (B25) -- */

  /**
   * Where "is this section collapsed" is remembered, and why not `hana.state`.
   *
   * This used to live in `hana.state`, through a `stateBridge` object. The 0.3.9
   * instrumented build settled it: `hana.state` is a card *instance's* private
   * scratch pad (the SDK's own wording), so it is discarded when the card closes.
   * The value was written correctly, read correctly, and still never survived a
   * remount — three rounds of fixes were chasing a store that was never a store.
   *
   * Layout preference is not instance state; it is a user preference, and it now
   * lives in the App's own app-data (`<dataDir>/prefs.json`) through the backend's
   * GET/PUT /prefs route. That survives reloads, host restarts, and — unlike both
   * of the previous attempts — an uninstall/reinstall.
   *
   * `stateBridge` was deleted rather than left alongside: with the collapse state
   * moved, it had no remaining caller, and keeping two persistence systems for one
   * boolean is how the next person ends up debugging the wrong one.
   */
  const prefsState = { reads: 0, writes: 0, readErrors: 0, writeErrors: 0, last: "无" };

  /** Read the persisted collapse map. Never throws; `{}` means "nothing stored". */
  async function loadPrefs() {
    prefsState.reads += 1;
    try {
      const collapsed = await transport.readPrefs({ hana, rawPath: routesBase + "/prefs", fetchImpl: typeof fetch === "function" ? fetch : null });
      prefsState.last = Object.keys(collapsed).length ? JSON.stringify(collapsed) : "空";
      return collapsed;
    } catch (error) {
      // transport.readPrefs already swallows failures; this is belt-and-braces so
      // that a future change there cannot take the card's boot down with it.
      prefsState.readErrors += 1;
      prefsState.last = "读失败";
      return {};
    }
  }

  /**
   * Persist one section's collapse preference.
   *
   * The visual toggle has already happened by the time this is called, so a write
   * failure must NOT undo it or interrupt: the user asked for the section to
   * collapse, and it did. The failure is counted and surfaced in the footer, which
   * is where "it will not be remembered next time" belongs.
   */
  async function savePref(section, collapsed) {
    prefsState.writes += 1;
    const ok = await transport.writePrefs(section, collapsed, {
      hana,
      rawPath: routesBase + "/prefs",
      fetchImpl: typeof fetch === "function" ? fetch : null,
    });
    if (ok) {
      prefsState.last = JSON.stringify({ [section]: Boolean(collapsed) });
    } else {
      prefsState.writeErrors += 1;
      prefsState.last = "写失败（本次仍生效）";
    }
    return ok;
  }

  /* ---------------------------------------------------------------- fetch -- */

  /**
   * One backend call, through whichever door the SDK offers.
   *
   * `hana.api.fetch` is the documented door and the one that carries the surface
   * credential; the bare-`fetch` fallback exists only for a host (or browser)
   * without it. The transport module counts which one was used, so
   * `/pc hooks`-style diagnosis and the offline probe can both see it.
   */
  function load(section) {
    return transport.loadSection(section, {
      // The imported bridge, passed explicitly. See the header: this is why the
      // transport never has to read a global.
      hana,
      rawPath: routesBase + "/" + section,
      fetchImpl: typeof fetch === "function" ? fetch : null,
    });
  }

  async function loadAll() {
    // Independent sections, fetched together; one failing must not cancel the
    // others, so each promise settles on its own.
    const [status, handoff, memory, hooks] = await Promise.all([
      load("status"),
      load("handoff"),
      load("memory"),
      load("hooks"),
    ]);
    return { status, handoff, memory, hooks };
  }

  /* -------------------------------------------------------------- render -- */

  /** Small DOM helper: text only, never innerHTML, so Server text cannot inject. */
  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined && content !== null) node.textContent = String(content);
    return node;
  }

  function renderStatus(status) {
    const model = view.describeStatus(status);
    const box = el("div", "pc-status");
    box.dataset.tone = model.tone;
    box.appendChild(el("span", "pc-dot"));

    const body = el("div", "pc-status-body");
    body.appendChild(el("div", "pc-headline", model.headline));
    const detail = el("div", "pc-detail");
    for (const line of model.detail) detail.appendChild(el("div", null, line));
    body.appendChild(detail);

    if (model.fix) {
      const fix = el("div", "pc-fix", "怎么修：" + model.fix);
      fix.dataset.tone = model.tone;
      body.appendChild(fix);
    }
    box.appendChild(body);
    return box;
  }

  function renderSection(key, model, bodyBuilder) {
    const section = el("section", "pc-section");

    // Fix-2: a failed section is always expanded, and cannot be collapsed at all.
    // Its body IS the error; hiding it would recreate the "invisible failure" this
    // campaign spent three rounds chasing (a 403 drawn as an outage, a stale asset
    // drawn as a dead Server, a failed section drawn as an empty area).
    const data = state.data ? state.data[key] : undefined;
    const failed = transport.sectionFailed(data);
    const collapsed = transport.effectiveCollapsed(data, state.collapsed[key]);

    section.dataset.collapsed = collapsed ? "true" : "false";
    section.dataset.failed = failed ? "true" : "false";
    // Carry the tone onto the section so a backend failure cannot look like an
    // outage section; the stylesheet keys off this.
    section.dataset.tone = model.tone || "ok";

    const head = el("div", "pc-section-head");
    head.appendChild(el("span", "pc-section-title", model.title));
    // A failed section advertises that it is open for a reason.
    if (failed) head.appendChild(el("span", "pc-section-flag", "失败"));
    head.appendChild(el("span", "pc-chevron", failed ? "\u25be" : "\u25bc"));
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
    if (failed) {
      head.setAttribute("aria-disabled", "true");
      head.title = "这一区加载失败，错误内容不会被折叠隐藏。";
    }

    const toggle = async () => {
      // Refuse to hide an error. `state.collapsed` is deliberately left untouched
      // so a later successful load restores the user's own preference rather than
      // inheriting the forced-expanded state.
      if (failed) return;
      state.collapsed[key] = !state.collapsed[key];
      section.dataset.collapsed = state.collapsed[key] ? "true" : "false";
      head.setAttribute("aria-expanded", state.collapsed[key] ? "false" : "true");
      // B25: one field, PUT to the App's own app-data. Failure is counted, not
      // surfaced — the section did collapse, and that is what the user asked for;
      // whether it will be remembered next time belongs in the footer, not in a
      // dialog over the thing they just clicked.
      await savePref(key, state.collapsed[key]);
    };
    head.addEventListener("click", toggle);
    head.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle();
      }
    });

    section.appendChild(head);
    const body = el("div", "pc-section-body");
    bodyBuilder(body, model);
    section.appendChild(body);
    return section;
  }

  function renderHandoff(section) {
    const model = view.describeHandoff(section);
    return renderSection("handoff", model, (body, m) => {
      for (const line of m.lines) body.appendChild(el("p", "pc-line", line));
      if (m.action) body.appendChild(el("div", "pc-empty-action", m.action));
    });
  }

  function renderMemory(section) {
    const model = view.describeMemory(section);
    return renderSection("memory", model, (body, m) => {
      if (m.counts && m.counts.length) {
        const counts = el("div", "pc-counts");
        for (const item of m.counts) {
          const chip = el("span", "pc-count");
          chip.appendChild(el("span", null, item.kind));
          chip.appendChild(el("strong", null, item.count));
          counts.appendChild(chip);
        }
        body.appendChild(counts);
      }

      for (const entry of m.entries || []) {
        const row = el("div", "pc-entry");
        row.dataset.retired = entry.retired ? "true" : "false";
        row.appendChild(el("span", "pc-badge", entry.kind));
        const text = el("div", "pc-entry-text");
        text.appendChild(el("div", null, entry.text));
        if (entry.id) text.appendChild(el("div", "pc-entry-id", entry.id));
        row.appendChild(text);
        body.appendChild(row);
      }

      if (m.note) body.appendChild(el("p", "pc-line pc-muted", m.note));
      if (m.action) body.appendChild(el("div", "pc-empty-action", m.action));
    });
  }

  function renderFooter(hooks, checkedAt) {
    const model = view.describeHooks(hooks);
    const footer = el("footer", "pc-footer");
    const lines = el("div", "pc-footer-lines");
    for (const line of model.lines) lines.appendChild(el("div", null, line));
    if (checkedAt) lines.appendChild(el("div", "pc-timestamp", "更新于 " + checkedAt));
    // Which door served this refresh. Silent when the official one is in use (the
    // normal case); stated when the bare-fetch fallback took over, because that is
    // the condition BUG-3 proved is not credential-safe in a current host.
    const counters = transport.counters;
    // B25: this meter used to read "视图状态桥" and report hana.state traffic. That
    // store is gone — it could never have worked — so the meter now reports the
    // persistence that does: app-data preferences, read at boot and written on each
    // toggle. The raw envelope line is dropped; the counts are the useful part, and
    // the value here is a preference, not a diagnostic puzzle.
    // D37 fix: one failure, one count. `savePref` already records every failure it
    // sees, and `transport.counters.pref_write_errors` increments on exactly those
    // same calls — so summing the two displayed 2 for a single failed write. The
    // page counter is the one that is always populated on this path (it also covers
    // failures that never reach the transport), so it is the one shown; the
    // transport counter stays in the counter set for offline diagnosis.
    lines.appendChild(el("div", "pc-timestamp",
      "折叠偏好（app-data 持久）：读 " + prefsState.reads + " · 写 " + prefsState.writes +
      " · 写失败 " + prefsState.writeErrors +
      " · 末次 " + prefsState.last
    ));
    if (counters.fallbacks > 0) {
      lines.appendChild(el("div", "pc-timestamp", "注意：本次使用了回退通道（无 hana.api.fetch），可能缺少卡片凭据。"));
    }
    footer.appendChild(lines);

    // When the card's own backend is the thing that failed, the useful action is
    // emphasised and named for what it does. A "刷新" that cannot succeed is a
    // dead end; "重试" next to an explanation is a way out.
    const reopen = state.data && state.data.status && state.data.status.error && state.data.status.error.kind === "route_failure";
    const button = el("button", "pc-refresh", state.busy ? "刷新中…" : reopen ? "重试" : "刷新");
    button.type = "button";
    button.disabled = state.busy;
    if (reopen) button.dataset.emphasis = "reopen";
    button.addEventListener("click", () => refresh());
    footer.appendChild(button);
    return footer;
  }

  function render() {
    const data = state.data || {};
    root.textContent = "";
    root.appendChild(renderStatus(data.status));
    root.appendChild(renderHandoff(data.handoff));
    root.appendChild(renderMemory(data.memory));
    root.appendChild(renderFooter(data.hooks, data.status && data.status.checkedAt));
    root.setAttribute("aria-busy", "false");
  }

  async function refresh() {
    state.busy = true;
    render();
    state.data = await loadAll();
    state.busy = false;
    render();
  }

  /* ---------------------------------------------------------------- boot -- */

  (async function boot() {
    // B25: preferences come from the App's own backend, not from card instance state.
    state.collapsed = await loadPrefs();
    // One fetch on mount. No polling: a card that polls puts a permanent load on
    // the Server for a surface the user may not even be looking at.
    await refresh();

    // Tell the inline startup fallback to stand down. It exists for the case where
    // this module never runs at all (a missing or corrupt sdk.js); now that the card
    // has rendered, an unrelated later error must not relabel a working card as
    // "脚本未能启动".
    window.__pcCardBooted = true;

    // If the host re-mounts or restores this card, re-render from the same data
    // rather than fetching again.
    if (hana && hana.lifecycle && typeof hana.lifecycle.onVisible === "function") {
      hana.lifecycle.onVisible(() => render());
    }
  })();
})();
