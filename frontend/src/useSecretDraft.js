/*
 * Shared draft-row logic for the secret form editor (create and edit).
 *
 * A "row" is { id, key, value, isBinary, isNew, deleted }:
 *   - isNew marks rows added in this editing session (not yet in the cluster).
 *   - deleted marks existing rows the user asked to remove (it is a soft flag
 *     so a wrong tap is one keystroke away from being undone).
 *
 * The value a row holds depends on the value mode:
 *   - transparent: decoded text (the system does the base64 work).
 *   - base64:      raw base64 as stored (the user does the base64 work; we
 *                  only validate it here and on the backend at patch time).
 */

const KEY_RE = /^[A-Za-z0-9._-]+$/;

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export function isValidBase64(s) {
  return BASE64_RE.test(s) && s.length % 4 === 0;
}

let rowSeq = 0;

export function newRow({
  key = "",
  value = "",
  isBinary = false,
  isNew = true,
  deleted = false,
} = {}) {
  return { id: rowSeq++, key, value, isBinary, isNew, deleted };
}

// Seed a draft from a secret detail, picking the display value for the mode
// so the user always edits what they would see in view mode.
export function seedRows(entries, mode) {
  return (entries || []).map((e) =>
    newRow({
      key: e.key,
      value: mode === "base64" ? e.base64 : e.value,
      isBinary: e.isBinary,
      isNew: false,
      deleted: false,
    }),
  );
}

// Validate the active (non-deleted) rows. Returns "" when valid, otherwise a
// user-facing message. Mirrors the backend checks so typos fail fast in the
// UI instead of surfacing as an API error.
export function validateRows(rows, mode) {
  const seen = new Set();
  const active = rows.filter((r) => !r.deleted);
  for (const r of active) {
    const key = r.key.trim();
    if (!key) return "Every key must have a name.";
    if (!KEY_RE.test(key)) {
      return `Key "${key}" is invalid. Use letters, numbers, '.', '-' or '_'.`;
    }
    if (seen.has(key)) return `Duplicate key "${key}".`;
    seen.add(key);
  }
  if (active.length === 0) return "A secret must contain at least one key.";
  if (mode === "base64") {
    for (const r of active) {
      if (!isValidBase64(r.value)) {
        return `Value for key "${r.key}" is not valid base64.`;
      }
    }
  }
  return "";
}

// Collect the active rows into a key -> value map for creation.
export function rowsToMap(rows) {
  const out = {};
  for (const r of rows) {
    if (r.deleted) continue;
    const key = r.key.trim();
    if (key) out[key] = r.value;
  }
  return out;
}

// Compute the SecretChange list for an edit against the original entries.
// Binary values are preserved untouched unless the user is in base64 mode,
// where they are real, editable strings.
export function buildChanges(rows, originalEntries, mode) {
  const original = new Map((originalEntries || []).map((e) => [e.key, e]));
  const changes = [];

  // Removals first so a renamed-looking row (remove + re-add) reads as one
  // operation in the review summary.
  for (const r of rows) {
    if (r.deleted && !r.isNew) {
      changes.push({ key: r.key, value: "", delete: true });
    }
  }
  for (const r of rows) {
    if (r.deleted) continue;
    const key = r.key.trim();
    if (r.isNew) {
      changes.push({ key, value: r.value, delete: false });
      continue;
    }
    if (r.isBinary && mode !== "base64") continue; // cannot edit as text
    const orig = original.get(key);
    const display = mode === "base64" ? orig?.base64 : orig?.value;
    if (!orig || display !== r.value) {
      changes.push({ key, value: r.value, delete: false });
    }
  }
  return changes;
}

// Summarize changes for the confirmation dialog: counts plus a per-key list.
export function summarizeChanges(changes, originalEntries) {
  const original = new Map((originalEntries || []).map((e) => [e.key, e]));
  const summary = { added: 0, changed: 0, deleted: 0, list: [] };
  for (const c of changes) {
    if (c.delete) {
      summary.deleted++;
      summary.list.push({ key: c.key, kind: "delete" });
    } else if (original.has(c.key)) {
      summary.changed++;
      summary.list.push({ key: c.key, kind: "change" });
    } else {
      summary.added++;
      summary.list.push({ key: c.key, kind: "add" });
    }
  }
  return summary;
}
