/*
 * JSON log field reordering for the log view (experimental feature).
 *
 * The whole point is a screen reader hearing the fields of a JSON log line
 * in a useful order (message first, timestamps last). The transform must
 * therefore never alter the *content* of the line, only the order of its
 * top-level fields — so it reorders spans of the raw source text instead of
 * parse-then-stringify, which would round 9007199254740993 to
 * 9007199254740992 and lose the original escaping/formatting.
 *
 * Lines are not always pure JSON: Kubernetes timestamps, klog prefixes
 * ("I0714 ... file.go:123]") and ANSI colour codes may surround the object.
 * The rule is: take the outermost slice from the first "{" to the last "}";
 * if that slice parses as a plain JSON object, reorder its fields and keep
 * the surrounding text byte-for-byte. Anything else is left untouched.
 */

// findJsonObject returns the [open, close] span of the outermost JSON object
// in the line, or null when the line carries none. JSON.parse is used ONLY
// for validation — its result is discarded, so number precision cannot leak
// into the output.
function findJsonObject(line) {
  const open = line.indexOf("{");
  if (open < 0) return null;
  const close = line.lastIndexOf("}");
  if (close <= open) return null;
  let parsed;
  try {
    parsed = JSON.parse(line.slice(open, close + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  return { open, close };
}

// scanString finds the end of the JSON string literal starting at start
// (which must point at its opening quote): the index just past the closing
// quote, or -1 if the string never terminates. Backslash escapes are skipped
// so quotes and braces inside strings are never mistaken for structure.
function scanString(line, start) {
  for (let i = start + 1; i < line.length; i++) {
    const c = line[i];
    if (c === "\\") {
      i++; // skip the escaped character
      continue;
    }
    if (c === '"') return i + 1;
  }
  return -1;
}

// topLevelMembers splits the body of an already-validated JSON object (the
// text between the outer braces) into {key, keySpan, valueSpan} entries,
// where the spans point into the raw source. Returns null if the walk finds
// malformed input (defensive; the caller validated first).
function topLevelMembers(body) {
  const members = [];
  const n = body.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n) break; // trailing whitespace after the last member
    if (body[i] !== '"') return null;

    const keyStart = i;
    const keyEnd = scanString(body, i);
    if (keyEnd < 0) return null;
    let key;
    try {
      key = JSON.parse(body.slice(keyStart, keyEnd));
    } catch {
      return null;
    }
    i = keyEnd;
    while (i < n && /\s/.test(body[i])) i++;
    if (body[i] !== ":") return null;
    i++;
    while (i < n && /\s/.test(body[i])) i++;
    if (i >= n) return null;

    const valueStart = i;
    let depth = 0;
    let valueEnd = -1;
    for (; i < n; i++) {
      const c = body[i];
      if (c === '"') {
        const end = scanString(body, i);
        if (end < 0) return null;
        i = end - 1;
        continue;
      }
      if (c === "{" || c === "[") {
        depth++;
      } else if (c === "}" || c === "]") {
        if (depth === 0) {
          valueEnd = i; // the object's own closing brace
          break;
        }
        depth--;
      } else if (c === "," && depth === 0) {
        valueEnd = i;
        break;
      }
    }
    if (valueEnd < 0 && depth === 0) {
      valueEnd = n;
    }
    if (valueEnd < 0) return null;
    let end = valueEnd;
    while (end > valueStart && /\s/.test(body[end - 1])) end--;
    members.push({
      key,
      keySpan: body.slice(keyStart, keyEnd),
      valueSpan: body.slice(valueStart, end),
    });
    i = valueEnd + 1; // past the comma, or past the closing brace
  }
  return members;
}

// applyLogTemplate reorders the top-level fields of a JSON log line so the
// fields listed in fieldOrder come first (in that order) and any remaining
// fields follow in their original order. Returns:
//   { text, reason: "ok" }          — reordered
//   { text, reason: "no-overlap" }  — JSON object, but none of the template's
//                                     fields are present; text is the original
//   { text, reason: "not-json" }    — no JSON object; text is the original
export function applyLogTemplate(line, fieldOrder) {
  const obj = findJsonObject(line);
  if (!obj) return { text: line, reason: "not-json" };

  const members = topLevelMembers(line.slice(obj.open + 1, obj.close));
  if (!members) return { text: line, reason: "not-json" };

  const order = Array.isArray(fieldOrder) ? fieldOrder : [];
  const used = new Set();
  const ordered = [];
  for (const name of order) {
    const m = members.find(
      (member) => member.key === name && !used.has(member),
    );
    if (m) {
      used.add(m);
      ordered.push(m);
    }
  }
  if (ordered.length === 0) return { text: line, reason: "no-overlap" };
  for (const m of members) {
    if (!used.has(m)) ordered.push(m);
  }

  const inner = ordered.map((m) => `${m.keySpan}:${m.valueSpan}`).join(", ");
  const text =
    line.slice(0, obj.open) + "{" + inner + "}" + line.slice(obj.close + 1);
  return { text, reason: "ok" };
}

// extractJsonFields extracts the top-level field names of the JSON object in
// a line (in original order, duplicates removed) plus the object itself as a
// sample for the template editor's preview. Returns null when the line has
// no JSON object. This is the editor's only import path: the user pastes a
// log line they copied themselves.
export function extractJsonFields(line) {
  const obj = findJsonObject(line);
  if (!obj) return null;
  const members = topLevelMembers(line.slice(obj.open + 1, obj.close));
  if (!members) return null;
  const keys = [];
  const seen = new Set();
  for (const m of members) {
    if (!seen.has(m.key)) {
      seen.add(m.key);
      keys.push(m.key);
    }
  }
  return { keys, sample: line.slice(obj.open, obj.close + 1) };
}
