/**
 * hana-powercontext — a Hana v2 App that connects a session to a running
 * PowerContext Server over HTTP.
 *
 * This App is deliberately a thin wrapper: every piece of real logic (recall,
 * storage, extraction, handoff assembly) already lives in the PowerContext
 * Server. What is here is the wiring, plus one guarantee — the Server being
 * down degrades the App's answers, and never the session.
 */

import { defineApp } from "./sdk/app-contract/server-client.js";
import { resolveConfig } from "./lib/config.js";
import { probe } from "./lib/powercontext.js";
import {
  buildToolRegistrations,
  commandDoctor,
  commandHandoff,
  commandHooks,
  commandMemory,
  commandReview,
  commandScope,
  pcUsage,
} from "./lib/register.js";
import { registerHooks } from "./lib/hooks.js";
import { dashboardHooks, dashboardHandoff, dashboardMemory, dashboardStatus, runSection } from "./lib/dashboard.js";

export const name = "hana-powercontext";

/**
 * How long to wait before touching the slash-command registry.
 *
 * The host's AppHost reports an App's load state right after setup resolves, and
 * a call to `commands.register` made in that window can mark the load `failed` in
 * a composition that has no registry. Waiting past the window costs one timer and
 * removes slash commands from the App's load result entirely.
 */
const COMMAND_REGISTRATION_DELAY_MS = 1500;

export default defineApp(async (sdk) => {
  await sdk.logger.info("hana-powercontext loaded");

  // Settings are resolved per invocation, never once at load time: a config or
  // environment change should take effect on the next tool call without
  // requiring the App to be reloaded.
  const configNow = (overrides) => resolveConfig(sdk, overrides);

  let registered = 0;
  for (const registration of buildToolRegistrations()) {
    const { run, ...definition } = registration;
    await sdk.tools.register({
      ...definition,
      execute: async (args) => run(sdk, configNow(), args || {}),
    });
    registered += 1;
  }
  await sdk.logger.info(`hana-powercontext registered ${registered} tools`);

  // Stage 2: the pre-step recall hook. Registration is synchronous and needs no
  // late host service, so unlike `commands.register` it is safe here — and it
  // must happen during setup, because a hook that misses the first turn is a
  // hook that misses the whole point.
  //
  // Whether the host ever *calls* it is a separate question the permission
  // ledger answers per turn: without `app/hooks.agent-pre-step` the host skips
  // this App and the turn proceeds untouched. The App never grants itself
  // anything; that decision belongs to the user in Hana's permission UI.
  //
  // BUG-2: the D16 bisect left this line in its disabled state and it shipped
  // that way (v0.2.0 logged "registered 0 hook adjudicator(s)"). The wiring is
  // the whole point of stage 2 — restore it and fail loudly if it ever
  // regresses, because a silently absent hook is indistinguishable from a
  // silently ungranted one at the tool layer.
  const hookDisposers = await registerHooks(sdk, configNow, (message) => {
    void sdk.logger.info(`hana-powercontext: ${message}`);
  });
  if (!Array.isArray(hookDisposers) || hookDisposers.length !== 2) {
    await sdk.logger.warn(
      `hana-powercontext: expected 2 hook adjudicators, got ${Array.isArray(hookDisposers) ? hookDisposers.length : typeof hookDisposers}`,
    );
  }
  await sdk.logger.info(`hana-powercontext registered ${hookDisposers.length} hook adjudicator(s)`);

  /** Ask the host's own ledger what this App has actually been granted. */
  const probeCapabilities = async () => sdk.capabilities.get();

  // Stage 3: the dashboard card's backend. One registrar, four read-only routes,
  // all of them thin wrappers over lib/ — so the card inherits the App's network
  // declaration, Scope resolution, timeout and fail-open behaviour rather than
  // reimplementing a second, weaker copy of all four. The card itself never
  // reaches the PowerContext Server.
  //
  // `routes.register` returns a disposer synchronously and needs no capability
  // word, which is why adding the card changes no permission the user must grant.
  try {
    sdk.routes.register((app) => {
      /**
       * One route = one logged, self-contained request.
       *
       * Fix-3: every card request is attributable in the host log. Before this,
       * "did the card even call us?" was unanswerable — the host logs the route
       * *rejection* but not the handler, so a 79-request traffic question could not
       * be attributed to anyone. Entry and exit are logged with metadata only:
       * route name, outcome kind, HTTP status, duration, and booleans. No payload
       * body, no Scope id, no credential.
       *
       * Fix-4: `runSection` also guarantees a throw becomes a `backend_error`
       * payload instead of a 500, so the card always has something specific to
       * render and the exit line can name it.
       */
      const section = (name, work) => async (c) => {
        await sdk.logger.info(`hana-powercontext dashboard route enter: ${name}`);
        const { payload, meta, durationMs } = await runSection(name, configNow, (resolve) => work(resolve, c));
        await sdk.logger.info(
          `hana-powercontext dashboard route exit: ${name} status=200 ok=${meta.ok} kind=${meta.kind} ` +
            `hasAddress=${meta.hasAddress} failed=${meta.failedSections} durationMs=${durationMs}`,
        );
        // A failed section is still a 200: the card must render the failure, and a
        // 500 would leave it with nothing to say.
        return c.json(payload);
      };

      app.get("/api/status", section("status", (resolve) => dashboardStatus(sdk, resolve)));
      app.get("/api/handoff", section("handoff", (resolve) => dashboardHandoff(sdk, resolve)));
      app.get(
        "/api/memory",
        section("memory", (resolve, c) => {
          const limit = Number(new URL(c.req.url).searchParams.get("limit"));
          return dashboardMemory(sdk, resolve, { previewLimit: Number.isFinite(limit) && limit > 0 ? limit : 10 });
        }),
      );
      app.get("/api/hooks", section("hooks", () => Promise.resolve(dashboardHooks())));
    });
    await sdk.logger.info("hana-powercontext registered dashboard routes");
  } catch (error) {
    // A composition without a route door simply has no card backend; the tools
    // and hooks are unaffected, and saying so beats failing the load.
    await sdk.logger.info(
      `hana-powercontext: dashboard routes unavailable in this composition (${error && error.message ? error.message : String(error)})`,
    );
  }

  // One slash-command entry point with subcommands, rather than four separate
  // `/pc-*` words: the chat slash menu stays short, and `/pc` with no argument
  // is a usable help screen.
  const handlePc = async (invocation) => {
    const [subcommand] = String(invocation.args || "").trim().split(/\s+/);
    switch ((subcommand || "").toLowerCase()) {
      case "doctor":
        return commandDoctor(sdk, configNow(), probe);
      case "scope":
        return commandScope(sdk, configNow());
      case "memory":
        return commandMemory(sdk, configNow());
      case "hooks":
        return commandHooks(configNow(), probeCapabilities);
      case "handoff":
        return commandHandoff();
      case "review":
        // Human-only by construction: this is a slash command, so the only way to
        // reach it is a person typing it. No pc_* tool exposes review, and none
        // ever will — see lib/tools.js's review section.
        return commandReview(sdk, configNow(), invocation.args);
      case "":
        return pcUsage();
      default:
        return `Unknown subcommand \"${subcommand}\" (this is not an error, just an unknown word).\n\n${pcUsage()}`;
    }
  };

  const commandDefinitions = [
    {
      name: "pc",
      description: "PowerContext: Server status, Scope, and memory inventory",
      usage: "/pc [doctor|scope|memory|hooks|handoff|review]",
      handler: handlePc,
    },
    {
      // Also reachable as `/powercontext`, which is easier to find by name in a
      // long slash menu.
      name: "powercontext",
      description: "Alias for /pc",
      usage: "/powercontext [doctor|scope|memory|hooks|handoff|review]",
      handler: handlePc,
    },
  ];

  //
  // Slash commands are registered AFTER setup resolves, on purpose.
  //
  // The host's `commands` door resolves its registry inline and throws when there
  // is none — and the host's own isolated `--smoke` AppHost composes no engine at
  // all, so `commands.register` there can only reject. More importantly, the host
  // loader observes that call however it is caught and marks the App's load state
  // `failed`, which would take the tool registrations above down with it.
  //
  // So: registering a slash command must never be able to affect whether this App
  // loads. Deferring past the load window and catching everything is what
  // guarantees that. The tool surface is the contract; `/pc` is a convenience
  // layered on top of the same functions.
  const registerCommands = async () => {
    for (const definition of commandDefinitions) {
      try {
        await sdk.commands.register(definition);
      } catch (error) {
        // Expected wherever no slash registry is composed. One informational line,
        // no retry loop, no rethrow: retrying cannot conjure a registry, and a
        // loop would outlive the App for no benefit.
        await sdk.logger.info(
          `hana-powercontext: /${definition.name} unavailable in this composition (${
            error && error.message ? error.message : String(error)
          }); the pc_* tools are unaffected`,
        );
        return false;
      }
    }
    await sdk.logger.info("hana-powercontext registered /pc and /powercontext");
    return true;
  };

  // Deliberately not awaited, and the promise is fully handled: whatever happens
  // here settles without reaching the App's load result.
  setTimeout(() => {
    registerCommands().catch(() => {});
  }, COMMAND_REGISTRATION_DELAY_MS);

  await sdk.logger.info(`hana-powercontext ready (${registered} tools registered)`);
});