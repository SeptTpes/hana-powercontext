/**
 * lib/burst-probe.mjs — repeated handoffs must not collide on the boundary id.
 *
 * The original defect class: a timestamp-only boundary id collapses when two
 * handoffs are prepared in quick succession, and capture answers 409
 * `source_conflict` for the second one. This runs the tool repeatedly in a tight
 * loop against the real Server and asserts that every call reaches the generation
 * gate (503) rather than colliding, and that every boundary id is distinct.
 */
import { resolveConfig } from "./config.js";
import { callHandoffPrepare } from "./tools.js";

const scopeId = process.argv[2];
const rounds = Number(process.argv[3] || 8);

const sdk = { dataDir: null, network: { fetch: async (u, i) => fetch(u, { ...i, body: i.body }) } };
const config = resolveConfig(sdk, { baseUrl: "http://127.0.0.1:8000", scopeId, timeoutMs: 8000 });

const ids = [];
let conflicts = 0;
let gated = 0;
let other = 0;

for (let i = 0; i < rounds; i += 1) {
  const res = await callHandoffPrepare(sdk, config, { objective: `burst probe ${i}`, state: [`round ${i}`] });
  const code = res.details && res.details.serverCode;
  const id = res.details && res.details.boundarySourceId;
  if (id) ids.push(id);
  if (code === "source_conflict") conflicts += 1;
  else if (code === "handoff_generation_unavailable") gated += 1;
  else other += 1;
}

const unique = new Set(ids);
console.log(`rounds=${rounds} distinctBoundaryIds=${unique.size} conflicts=${conflicts} generationGated=${gated} other=${other}`);
console.log("ids:", ids.join(", "));

let failed = 0;
const checks = [
  ["every call produced a distinct boundary id", unique.size === ids.length && ids.length === rounds],
  ["no call hit source_conflict", conflicts === 0],
  ["every call reached the generation gate on this Server", gated === rounds],
];
for (const [name, pass] of checks) {
  console.log(`  [${pass ? "PASS" : "FAIL"}] ${name}`);
  if (!pass) failed += 1;
}
process.exit(failed === 0 ? 0 : 1);
