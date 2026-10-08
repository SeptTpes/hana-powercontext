/**
 * ui/assets/dashboard-page.js — the dashboard card's wiring.
 *
 * Three jobs: fetch the App's own backend, render the view model from
 * `./dashboard.js`, and remember which sections the user collapsed.
 *
 * It never talks to the PowerContext Server. Everything Server-shaped arrives
 * through `/api/apps/hana-powercontext/routes/{status,handoff,memory,hooks}`,
 * which is the App backend reusing the same Scope resolution, network
 * declaration, timeout and fail-open behaviour as the tools.
 */

(function main() {
  "use strict";

  const view = globalThis.PowerContextDashboard;
  const root = document.getElementById("root");

  /** Where this App's backend lives, derived from the page's own path. */
  const routesBase = (() => {
    const path = location.pathname || "";
    const marker = "/ui/";
    const at = path.indexOf(marker);
    // Served as /api/apps/<id>/ui/dashboard.html -> /api/apps/<id>/routes
    if (at > -1) return path.slice(0, at) + "/routes";
    // Anything unexpected: still same-origin, still the App's own namespace.
    return "/api/apps/hana-powercontext/routes";
  })();

  /** Section keys double as the `hana.state` keys for collapse state. */
  const SECTIONS = ["handoff", "memory"];

  const state = {
    data: null,
    collapsed: {},
    busy: false,
  };

  /* ------------------------------------------------------------ hana.state -- */

  /**
   * Instance state, best effort.
   *
   * `hana.state` is the documented place for a card's own view state, and it
   * needs no capability word. It is still treated as optional: the page must
   * render identically in a plain browser (where there is no `hana` at all),
   * because otherwise the card's logic could only ever be exercised inside a
   * host — and untestable view logic is how cards ship broken.
   */
  const stateBridge = {
    async get(key, fallback) {
      try {
        if (globalThis.hana && hana.state && typeof hana.state.get === "function") {
          const value = await hana.state.get(key);
          return value === undefined || value === null ? fallback : value;
        }
      } catch {
        /* fall through to the fallback */
      }
      return fallback;
    },
    async set(key, value) {
      try {
        if (globalThis.hana && hana.state && typeof hana.state.set === "function") {
          await hana.state.set(key, value);
        }
      } catch {
        /* view state is a convenience; losing it must not break the card */
      }
    },
  };

  /* ---------------------------------------------------------------- fetch -- */

  /**
   * One backend call.
   *
   * A non-2xx answer is still parsed and returned as data: the routes answer 200
   * with an `ok: false` body for a failed section, so a 4xx/5xx here means the
   * route itself is unreachable — which the caller renders as its own failure.
   * Either way this never throws, because a throwing fetch would leave the card
   * on "正在连接…" forever, which is the single worst failure state for a UI.
   */
  async function load(section) {
    const url = routesBase + "/" + section;
    try {
      const response = await fetch(url, { headers: { accept: "application/json" } });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        return {
          ok: false,
          error: {
            kind: "route_error",
            message: "后端路由 " + section + " 返回 HTTP " + response.status + "。",
            hint: "确认 App 后端已加载；重载 App 或查看 Hana 日志。",
          },
        };
      }
      return body;
    } catch (error) {
      return {
        ok: false,
        error: {
          kind: "route_unreachable",
          message: "取不到后端路由 " + section + "（" + (error && error.message ? error.message : "网络错误") + "）。",
          hint: "卡片需要 App 后端在同一 App 命名空间下可访问；重载 App 后重试。",
        },
      };
    }
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
    section.dataset.collapsed = state.collapsed[key] ? "true" : "false";

    const head = el("div", "pc-section-head");
    head.appendChild(el("span", "pc-section-title", model.title));
    head.appendChild(el("span", "pc-chevron", "\u25bc"));
    head.setAttribute("role", "button");
    head.setAttribute("tabindex", "0");
    head.setAttribute("aria-expanded", state.collapsed[key] ? "false" : "true");

    const toggle = async () => {
      state.collapsed[key] = !state.collapsed[key];
      section.dataset.collapsed = state.collapsed[key] ? "true" : "false";
      head.setAttribute("aria-expanded", state.collapsed[key] ? "false" : "true");
      await stateBridge.set("collapsed:" + key, state.collapsed[key]);
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
    footer.appendChild(lines);

    const button = el("button", "pc-refresh", state.busy ? "刷新中…" : "刷新");
    button.type = "button";
    button.disabled = state.busy;
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
    for (const key of SECTIONS) {
      state.collapsed[key] = Boolean(await stateBridge.get("collapsed:" + key, false));
    }
    // One fetch on mount. No polling: a card that polls puts a permanent load on
    // the Server for a surface the user may not even be looking at.
    await refresh();

    // If the host re-mounts or restores this card, re-render from the same data
    // rather than fetching again.
    if (globalThis.hana && hana.lifecycle && typeof hana.lifecycle.onVisible === "function") {
      hana.lifecycle.onVisible(() => render());
    }
  })();
})();
