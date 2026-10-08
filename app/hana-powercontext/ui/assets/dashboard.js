/**
 * ui/assets/dashboard.js — the dashboard card's view logic.
 *
 * Written as a plain script (no bundler, no imports) because a card page loads it
 * directly, and exposed on `globalThis.PowerContextDashboard` so the same
 * functions can be imported and asserted by `lib/dashboard-probe.mjs`. That is
 * the point of the split: the *rendering decisions* — what to say when a section
 * is empty, what to say when the Server is down — are the part worth testing, and
 * they should not be reachable only through a browser.
 *
 * Every function here is pure. It takes the backend's JSON and returns strings.
 */

(function attachDashboard(root) {
  "use strict";

  /** Escape for text nodes; the card never builds HTML from Server content. */
  function text(value) {
    return value === null || value === undefined ? "" : String(value);
  }

  /** A short, stable handle for an id, so a long uuid does not dominate the row. */
  function shortId(id, keep) {
    const value = text(id);
    if (!value) return "";
    const n = keep || 8;
    if (value.length <= n + 1) return value;
    return value.slice(0, n) + "…";
  }

  function plural(count, one, many) {
    return count === 1 ? one : many;
  }

  /**
   * The status strip. Returns a headline, a tone and the detail lines.
   *
   * The tone is what colours the strip; the point is that a user can tell at a
   * glance whether the card is showing live data or an outage, without reading.
   */
  function describeStatus(status) {
    if (!status) {
      return { tone: "unknown", headline: "状态未知", detail: ["还没有从 App 后端取到状态。"], fix: null };
    }

    // --- BUG-3: the card's own backend failing is NOT a Server outage ---------
    //
    // Three failure sources, three different things to say. Conflating the first
    // with the second is what made BUG-3 hard to read: a 403 from the card's route
    // rendered as "连不上 Server" with an empty 地址, and the address being empty
    // was the only hint that the banner was lying. The Server was up the whole
    // time; the card simply had no credential to call its own backend.
    if (status.error && status.error.kind === "route_failure") {
      const detail = [status.error.message];
      if (status.error.status !== null && status.error.status !== undefined) {
        detail.push("HTTP " + text(status.error.status));
      }
      detail.push("这是卡片与 App 后端之间的问题，不是 PowerContext Server 的问题。");
      return {
        tone: "reopen",
        headline: "卡片后端不可达",
        detail,
        // No Server fix command here, on purpose: telling someone to start a
        // Server that is already running is worse than saying nothing.
        fix: status.error.hint || "关闭这张卡片并重新打开；若仍然如此，重载 App。",
        showAddress: false,
      };
    }

    if (!status.ok) {
      const error = status.server && status.server.error ? status.server.error : {};

      // --- Fix-4: the App's own backend broke — NOT an outage ------------------
      //
      // Everything that is not a network-layer failure lands here: a config or
      // Scope resolution error, a malformed answer, an unexpected throw in the
      // handler. The Server may be perfectly healthy, so this must never wear the
      // outage banner and must never tell the reader to start a Server.
      //
      // This is the branch that was missing when a stale asset plus an internal
      // error rendered as "连不上 Server / 地址：未知" against a Server that was up
      // and serving hook traffic. Amber, not red: insistent, not an outage.
      if (error.kind === "backend_error" || (status.configError && !status.baseUrl)) {
        const detail = [error.message || "看板后端出现内部错误。"];
        if (error.origin) detail.push("环节：" + text(error.origin));
        if (error.cause) detail.push(text(error.cause));
        detail.push("这是看板自己的错误，与 PowerContext Server 无关。");
        return {
          tone: "internal",
          headline: "看板后端内部错误（与 Server 无关）",
          detail,
          fix: error.hint || "这是 App 侧的问题：查看 Hana 日志里 hana-powercontext 的路由记录，或重载 App。",
          // No address is meaningful here, and printing an empty one is how the
          // original confusion started.
          showAddress: false,
        };
      }

      const stage = status.server && status.server.stage === "readiness" ? "服务未就绪" : "连不上 Server";
      // The address is only meaningful when a real payload carried one. Without
      // it the outage line reads as incomplete, which is the honest signal. Per
      // TASK-8 §Fix-4 this wording is reserved for exactly this branch: a
      // network-layer failure that really did not produce an address.
      const address = text(status.baseUrl);
      return {
        tone: "down",
        headline: stage,
        detail: [error.message || "Server 没有响应。", address ? "地址：" + address : "地址：未知（没有从后端拿到配置）"],
        // "How do I fix it" — the thing a failure state owes the reader.
        fix: error.hint || "启动它：scripts/start-server.sh；或把 POWERCONTEXT_HANA_BASE_URL 指向别的 Server。",
        showAddress: Boolean(address),
      };
    }

    const checks = (status.server && status.server.checks) || {};
    const detail = [
      "地址：" + text(status.baseUrl),
      "数据库：" + text(checks.database || "未知"),
    ];
    if (status.scope && status.scope.ok) {
      detail.push(
        "Scope：" + text(status.scope.scopeId) + "（" + scopeSourceLabel(status.scope.source) + "）",
      );
    } else if (status.scope && status.scope.error) {
      // A reachable Server with no usable Scope is its own failure, and saying so
      // beats showing an empty card that looks like a bug.
      return {
        tone: "warn",
        headline: "Server 正常，但没有可用的 Scope",
        detail: detail.concat([status.scope.error.message]),
        fix: status.scope.error.hint || "设 POWERCONTEXT_HANA_SCOPE_ID，或在 Server 上确认默认 Scope。",
      };
    }

    const isReady = status.server && status.server.status === "ready";
    return {
      tone: isReady ? "ok" : "warn",
      headline: isReady ? "已连接" : "Server 可达但未就绪",
      detail,
      fix: null,
      showAddress: true,
    };
  }

  function scopeSourceLabel(source) {
    switch (source) {
      case "argument":
        return "调用参数";
      case "config":
        return "配置指定";
      case "server-default":
        return "Server 默认";
      default:
        return text(source) || "未知来源";
    }
  }

  function dispositionLabel(disposition) {
    switch (disposition) {
      case "continuable":
        return "可继续";
      case "blocked":
        return "受阻";
      case "complete":
        return "已完成";
      default:
        return text(disposition) || "未知";
    }
  }

  /**
   * The Handoff section.
   *
   * The empty case is the one that matters for a new user: it must teach the
   * action, not just say "nothing".
   */
  function describeHandoff(section) {
    if (!section) {
      return { tone: "unknown", title: "最新 Handoff", lines: ["还没有取到交接状态。"], action: null };
    }
    if (!section.ok) {
      const routeFailure = section.error && section.error.kind === "route_failure";
      const internal = section.error && section.error.kind === "backend_error";
      return {
        // A route failure or an App-internal error gets its own tone so the section
        // cannot be mistaken for a Server outage, and neither tells the reader to go
        // fix the Server. Only a genuine network failure earns the "down" look.
        tone: routeFailure ? "reopen" : internal ? "internal" : "down",
        title: "最新 Handoff",
        // The fallback action must match the cause. Telling a reader to wait for
        // the Server when the App itself broke is the same misdirection as the
        // outage banner on an internal error — just in one line instead of a
        // banner. Only the genuine network branch may mention the Server.
        action:
          section.error && section.error.hint
            ? section.error.hint
            : routeFailure
              ? "关闭这张卡片并重新打开。"
              : internal
                ? "看板自身出错：查看 Hana 日志里的路由记录，或重载 App。"
                : "先让 Server 恢复，再点刷新。",
        lines: [section.error && section.error.message ? section.error.message : "取交接状态失败。"],
      };
    }
    if (!section.handoff) {
      return {
        tone: "empty",
        title: "最新 Handoff",
        lines: ["暂无交接。"],
        action: "想让下个会话接得上，就在对话里说「为当前工作准备一份交接」，模型会调用 pc_handoff_prepare。",
      };
    }

    const h = section.handoff;
    const lines = [
      "目标：" + text(h.objective),
      "状态：" + dispositionLabel(h.disposition),
    ];
    if (h.nextAction) lines.push("下一步：" + h.nextAction);
    lines.push("进展 " + text(h.stateCount) + " 条" + (h.omissionCount ? "，已知缺口 " + text(h.omissionCount) + " 条" : ""));
    for (const item of h.statePreview || []) lines.push("· " + item);
    return { tone: "ok", title: "最新 Handoff", lines, action: null };
  }

  /**
   * The memory section: counts by kind plus a bounded preview.
   *
   * `truncated` is surfaced rather than hidden, so the card never implies it is
   * showing everything when it is showing ten.
   */
  function describeMemory(section) {
    if (!section) {
      return { tone: "unknown", title: "记忆", counts: [], entries: [], note: "还没有取到记忆清单。", action: null };
    }
    if (!section.ok) {
      const routeFailure = section.error && section.error.kind === "route_failure";
      const internal = section.error && section.error.kind === "backend_error";
      return {
        tone: routeFailure ? "reopen" : internal ? "internal" : "down",
        title: "记忆",
        // Same rule as the Handoff section: the remedy must name the actual cause.
        action:
          section.error && section.error.hint
            ? section.error.hint
            : routeFailure
              ? "关闭这张卡片并重新打开。"
              : internal
                ? "看板自身出错：查看 Hana 日志里的路由记录，或重载 App。"
                : "先让 Server 恢复，再点刷新。",
        counts: [],
        entries: [],
        note: section.error && section.error.message ? section.error.message : "取记忆清单失败。",
      };
    }
    if (!section.total) {
      return {
        tone: "empty",
        title: "记忆",
        counts: [],
        entries: [],
        note: "这个 Scope 还没有记忆。",
        action: "在对话里说「记住：…」，模型会调用 pc_remember。",
      };
    }

    const counts = Object.keys(section.byKind || {})
      .map((kind) => ({ kind, count: section.byKind[kind] }))
      .sort((a, b) => b.count - a.count);

    return {
      tone: "ok",
      title: "记忆",
      total: section.total,
      counts,
      entries: (section.entries || []).map((entry) => ({
        kind: entry.kind,
        id: shortId(entry.entryId),
        text: entry.text,
        retired: entry.state && entry.state !== "active",
      })),
      note: section.truncated
        ? "共 " + text(section.total) + " 条，这里显示最近 " + text((section.entries || []).length) + " 条。完整清单用 /pc memory。"
        : "共 " + text(section.total) + " 条。",
      action: null,
    };
  }

  /** The footer: hook counters, mirrored read-only from the App's backend. */
  function describeHooks(section) {
    if (!section || !section.ok) return { lines: ["钩子计数不可用。"] };
    const c = section.counters || {};
    const cache = section.cache || {};
    const total = Number(c.prestep_invocations || 0);
    const injected = Number(c.injections || 0);
    return {
      lines: [
        "召回触发 " + text(total) + " 次，注入 " + text(injected) + " 次" +
          (total ? "（命中率 " + Math.round((injected / total) * 100) + "%）" : ""),
        "跳过：空 " + text(c.skipped_empty || 0) + " · 出错 " + text(c.skipped_error || 0) + " · 关闭 " + text(c.skipped_disabled || 0),
        "捕获 " + text(c.captures || 0) + " 条 · 去重 " + text(c.captures_duplicate || 0) + " 条",
        "缓存 " + text(cache.entries || 0) + " 项 / TTL " + text(cache.ttlSeconds || 0) + "s",
      ],
    };
  }

  /** One line summarising the whole card, for a title tooltip or a status row. */
  function summarise(view) {
    const status = describeStatus(view && view.status);
    const memory = describeMemory(view && view.memory);
    const handoff = describeHandoff(view && view.handoff);
    const parts = [status.headline];
    if (memory.tone === "ok") parts.push(text(memory.total) + " " + plural(memory.total, "条记忆", "条记忆"));
    parts.push(handoff.tone === "ok" ? "有交接" : "无交接");
    return parts.join(" · ");
  }

  const api = {
    text,
    shortId,
    describeStatus,
    describeHandoff,
    describeMemory,
    describeHooks,
    summarise,
    scopeSourceLabel,
    dispositionLabel,
  };

  if (typeof module === "object" && module.exports) module.exports = api;
  root.PowerContextDashboard = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
