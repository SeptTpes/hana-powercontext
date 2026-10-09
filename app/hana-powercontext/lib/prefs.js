/**
 * lib/prefs.js — the card's own preferences, persisted in the App's data directory.
 *
 * Why this file exists (B25, finally diagnosed):
 *
 * The card used to keep "is this section collapsed" in `hana.state`. That was a
 * category error. `hana.state` is a card instance's private scratch pad — its
 * lifetime is the card instance, and closing the card discards it. So the state was
 * written correctly and read correctly and still never survived a remount, which is
 * why three rounds of fixes could not make it persist: nothing was broken except the
 * choice of store.
 *
 * A user's preference about how they like a panel laid out is not instance state. It
 * belongs somewhere that outlives the card, and the App already has such a place:
 * `sdk.dataDir`, the official app-data directory, which survives reloads, host
 * restarts, and even an uninstall/reinstall of the App.
 *
 * What is stored: a handful of booleans, and nothing else. No Server data, no Scope
 * id, no credential, no user text. `prefs.json` is safe to read aloud.
 *
 * Two robustness rules, both from the same instinct — a preferences file must never
 * be able to break the card:
 *
 *   * **Corruption self-heals.** An unreadable or malformed prefs.json reads as
 *     `{}` and is rewritten, so the next read is clean. It never throws at the
 *     caller and never takes a route down with it.
 *   * **Booleans are strict.** `"true"`, `1`, `null` are dropped rather than
 *     coerced. A preferences file that says something ambiguous should fall back to
 *     the default (expanded), not guess.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** The only sections whose collapse state is remembered. */
export const PREF_SECTIONS = ["handoff", "memory"];

const FILE_NAME = "prefs.json";

/** The empty document, freshly built each time so callers cannot mutate a shared one. */
function emptyPrefs() {
  return { collapsed: {} };
}

/** Resolve the prefs file path, or null when this composition has no data directory. */
function prefsPath(sdk) {
  const dir = sdk && typeof sdk.dataDir === "string" && sdk.dataDir ? sdk.dataDir : null;
  if (!dir) return null;
  return { dir, file: join(dir, FILE_NAME) };
}

/**
 * Keep only the fields we own, and only when they are real booleans.
 *
 * This is the gate that makes a hand-edited or half-written file harmless: anything
 * unexpected is dropped, so the rest of the App can trust the shape unconditionally.
 */
function normalize(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  const collapsed = input.collapsed;
  if (!collapsed || typeof collapsed !== "object" || Array.isArray(collapsed)) return out;
  for (const section of PREF_SECTIONS) {
    // Strict: a truthy string is not a preference, it is a bug in whatever wrote it.
    if (typeof collapsed[section] === "boolean") out[section] = collapsed[section];
  }
  return out;
}

/** Short, non-leaking description of a thrown value. */
function describe(error) {
  return error && error.message ? String(error.message) : String(error);
}

/**
 * Read the stored preferences.
 *
 * Returns `{ prefs, healed, error }`:
 *   * `prefs`  — always a usable `{ collapsed: {...} }`, never null;
 *   * `healed` — the stored file was unusable and has been rewritten as empty;
 *   * `error`  — a human-readable note when something went wrong, for the route log.
 *
 * Never throws. A preferences read failing is not allowed to fail a route.
 */
export function readPrefs(sdk) {
  const target = prefsPath(sdk);
  if (!target) {
    // No data directory (a composition without app-data): behave like "nothing
    // stored", not like an error. The card still works, it just forgets.
    return { prefs: emptyPrefs(), healed: false, error: null };
  }

  let raw;
  try {
    raw = readFileSync(target.file, "utf8");
  } catch (error) {
    // ENOENT is the normal first-run case and needs no repair. Anything else
    // (permissions, a directory where the file should be) is worth reporting, but
    // the card must still get a usable answer.
    const missing = error && error.code === "ENOENT";
    return {
      prefs: emptyPrefs(),
      healed: false,
      error: missing ? null : "读取失败：" + describe(error),
    };
  }

  let parsed = null;
  let parsedOk = true;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsedOk = false;
  }

  if (!parsedOk) {
    // A corrupt file self-heals: rewrite it so the next read is clean.
    const rewrite = writePrefs(sdk, emptyPrefs());
    return {
      prefs: emptyPrefs(),
      healed: true,
      error: rewrite.ok ? null : "损坏且重写失败：" + rewrite.error,
    };
  }

  const collapsed = normalize(parsed);
  // An object that parsed but carries nothing we recognise is also repaired, so a
  // file full of junk does not linger forever and get re-read on every boot.
  const hadShape = Boolean(
    parsed && typeof parsed === "object" && !Array.isArray(parsed) &&
      parsed.collapsed && typeof parsed.collapsed === "object" && !Array.isArray(parsed.collapsed),
  );
  const healed = !hadShape;
  if (healed) writePrefs(sdk, { collapsed });

  return { prefs: { collapsed }, healed, error: null };
}

/**
 * Merge a patch into the stored preferences and write the result.
 *
 * Shallow merge on `collapsed`, deliberately: the card sends one section at a time,
 * and a deep merge would be a promise about nested structures this file does not
 * have. Returns `{ ok, prefs, persisted, error }`.
 */
export function writePrefs(sdk, patch) {
  const target = prefsPath(sdk);
  const current = readRaw(sdk);
  const merged = { collapsed: { ...current.collapsed, ...normalize(patch) } };

  if (!target) {
    // Without a data directory there is nowhere to persist. Report success with the
    // merged value so the caller's optimistic UI stays consistent, but say so —
    // silently pretending to persist is how "it worked in my test" happens.
    return { ok: true, prefs: merged, persisted: false, error: "没有 dataDir，偏好仅在本次运行内生效" };
  }

  try {
    if (!existsSync(target.dir)) mkdirSync(target.dir, { recursive: true });
  } catch (error) {
    return { ok: false, prefs: merged, persisted: false, error: "创建目录失败：" + describe(error) };
  }

  // Write-then-rename: a reader that runs mid-write sees either the old file or the
  // new one, never a half-written one. The temp name is fixed rather than random
  // because only this App writes here, and a predictable name is easier to reason
  // about than a directory slowly filling with orphans.
  const temp = target.file + ".tmp";
  const body = JSON.stringify(merged, null, 2) + "\n";
  try {
    writeFileSync(temp, body, "utf8");
    renameSync(temp, target.file);
    return { ok: true, prefs: merged, persisted: true, error: null };
  } catch (error) {
    // Rename can fail across odd filesystems; a direct write beats losing the
    // preference entirely, and the file is tiny enough that a torn write is caught
    // by the corruption path on the next read.
    try {
      writeFileSync(target.file, body, "utf8");
      return { ok: true, prefs: merged, persisted: true, error: null };
    } catch (inner) {
      return { ok: false, prefs: merged, persisted: false, error: "写入失败：" + describe(inner) };
    }
  }
}

/** Best-effort read used only as the merge base; never throws, never repairs. */
function readRaw(sdk) {
  const target = prefsPath(sdk);
  if (!target) return emptyPrefs();
  try {
    const parsed = JSON.parse(readFileSync(target.file, "utf8"));
    return { collapsed: normalize(parsed) };
  } catch {
    // Merging onto nothing is the right answer for a missing or corrupt file; the
    // write that follows produces a clean one.
    return emptyPrefs();
  }
}
