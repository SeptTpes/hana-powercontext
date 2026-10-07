/**
 * lib/register.js — the tool registration table.
 *
 * Kept separate from lib/tools.js so the handlers stay plain functions that can
 * be exercised without an SDK, and separate from index.js so the entry file
 * reads as what it is: a list of things being registered.
 */

import {
  callHandoffPrepare,
  callMemoryList,
  callRemember,
  commandDoctor,
  commandHandoff,
  commandMemory,
  commandScope,
  HANDOFF_DISPOSITIONS,
  MEMORY_KINDS,
  pcUsage,
} from "./tools.js";

export { commandDoctor, commandHandoff, commandMemory, commandScope, pcUsage };

const MAX_MEMORY_BYTES = 8192;

/**
 * Each entry is a tool registration with one extra field, `run`, which index.js
 * strips before handing the rest to `sdk.tools.register`. `run` receives the
 * live sdk and freshly-resolved config, so nothing has to be captured at load
 * time.
 */
export function buildToolRegistrations() {
  return [
    {
      name: "pc_remember",
      description:
        "Write one durable memory entry into a PowerContext Scope. Use for facts worth recalling in a later session: project conventions, decisions and their reasons, gotchas, or stable references. Not for transient task state.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: `The memory itself. Write it self-contained: it will be read in a later session with no access to this conversation. At most ${MAX_MEMORY_BYTES} UTF-8 bytes.`,
          },
          kind: {
            type: "string",
            description: "Category of the entry. Defaults to project-fact.",
            enum: MEMORY_KINDS,
          },
          scope_id: {
            type: "string",
            description: "Target Scope. Defaults to the configured Scope, then to the Server's default Scope.",
          },
          reason: {
            type: "string",
            description: "Why this is worth remembering. Stored with the entry for later review.",
          },
        },
        required: ["text"],
        additionalProperties: false,
      },
      // Not read-only: it changes Server state, so the host should review it.
      sessionPermission: {
        kind: "write",
        description: "Appends one memory entry to the PowerContext Server.",
      },
      run: (sdk, config, args) => callRemember(sdk, config, args),
    },
    {
      name: "pc_memory_list",
      description:
        "List the memory entries currently held in a PowerContext Scope. Read-only. Use before remembering, to avoid writing a duplicate of something already recorded.",
      parameters: {
        type: "object",
        properties: {
          scope_id: {
            type: "string",
            description: "Scope to read. Defaults to the configured Scope, then to the Server's default Scope.",
          },
          include_inactive: {
            type: "boolean",
            description: "Include retired entries, for audit. Defaults to false.",
          },
        },
        additionalProperties: false,
      },
      sessionPermission: { readOnly: true },
      run: (sdk, config, args) => callMemoryList(sdk, config, args),
    },
    {
      name: "pc_handoff_prepare",
      description:
        "Capture a durable handoff boundary for the current work and return the prepared handoff. Use at the end of a work session so that a different session can continue the work. Records what you declare as unverified claims; it does not verify them.",
      parameters: {
        type: "object",
        properties: {
          objective: {
            type: "string",
            description: "What this piece of work is trying to achieve.",
          },
          state: {
            type: "array",
            items: { type: "string" },
            description:
              "What has actually been established so far. Each item is recorded as a declared claim with no evidence attached.",
          },
          next_action: {
            type: "string",
            description: "The single next step a successor should take.",
          },
          disposition: {
            type: "string",
            enum: HANDOFF_DISPOSITIONS,
            description: "Whether the work can continue, is blocked, or is finished. Defaults to continuable.",
          },
          omissions: {
            type: "array",
            items: { type: "string" },
            description: "Known gaps in this handoff, so the successor does not over-trust it.",
          },
          scope_id: {
            type: "string",
            description: "Target Scope. Defaults to the configured Scope, then to the Server's default Scope.",
          },
        },
        required: ["objective"],
        additionalProperties: false,
      },
      sessionPermission: {
        kind: "write",
        description: "Captures a handoff boundary Source on the PowerContext Server.",
      },
      run: (sdk, config, args) => callHandoffPrepare(sdk, config, args),
    },
  ];
}
