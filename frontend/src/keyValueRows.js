/*
 * Shared key-value row helpers for create/edit forms.
 */

/**
 * Append an empty key-value row to a reactive array.
 * Mutates `rows` in place (Vue reactivity picks it up).
 */
export function addRow(rows) {
  rows.push({ key: "", value: "" });
}

/**
 * Remove the row at index `i` from a reactive array.
 * Mutates `rows` in place.
 */
export function removeRow(rows, i) {
  rows.splice(i, 1);
}

/**
 * Convert an array of { key, value } rows into a plain object.
 * Rows with an empty/whitespace-only key are silently skipped.
 */
export function rowsToMap(rows) {
  const out = {};
  for (const r of rows) {
    if (r.key.trim()) out[r.key.trim()] = r.value;
  }
  return out;
}
