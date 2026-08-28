<script setup>
import {
  ref,
  shallowRef,
  computed,
  watch,
  onBeforeUnmount,
  nextTick,
} from "vue";
import { api, onEvent } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { copyToClipboard } from "../clipboard.js";
import Combobox from "./Combobox.vue";

const props = defineProps({
  namespace: { type: String, required: true },
  pod: { type: String, required: true },
  container: { type: String, required: true },
  opener: { type: Object, default: null },
});

const emit = defineEmits(["close"]);
const { announce } = useStore();

const streaming = ref(false);
const error = ref("");

const tail = ref(500); // history lines to fetch: number, or -1 for "all"
const timestamps = ref(false);
const previous = ref(false); // logs from the previous (crashed) container

const TAIL_OPTIONS = [
  { value: 100, label: "100 lines" },
  { value: 500, label: "500 lines" },
  { value: 1000, label: "1000 lines" },
  { value: -1, label: "All" },
];

const autoScroll = ref(true);
const wrap = ref(true);

const query = ref("");
const useRegex = ref(false);
const caseSensitive = ref(false);
const onlyMatches = ref(false);

const logEl = ref(null);
const headingEl = ref(null);
const searchEl = ref(null);

let streamKey = "";
let offBatch = () => {};
let offEnd = () => {};
let offErr = () => {};
let offPart = () => {};
let partial = ""; // unfinished tail of a long line arriving in pieces

const MAX_LINES = 20000;

const MAX_PARTIAL = 1024 * 1024;
const MAX_REGEX_LEN = 500;
const RE_NESTED_Q = /\)[\*\+]/; // closing paren + quantifier = likely nested quantifier

const filtering = ref(false); // a search rebuild is in flight
const matchCount = ref(0); // matching lines (kept live on append too)

let rawLines = []; // {seq, text} — capped at MAX_LINES
const view = shallowRef([]); // {seq, text, hit, segments|null} — filtered
let matchRows = []; // seqs of matching rows, in view order (gotoMatch)
let nextSeq = 0; // stable, never reused: v-for keys survive eviction
let pendingLines = []; // lines waiting for a mid-rebuild flush
let rebuilding = false; // a search rebuild is scanning/committing
let rebuildToken = 0; // supersedes stale rebuilds

const activeSeq = ref(-1); // roving-focus line
const currentMatchSeq = ref(-1); // highlighted match

function validateRegexSource(source) {
  if (source.length > MAX_REGEX_LEN) {
    return "Pattern is too long (max 500 characters).";
  }
  if (RE_NESTED_Q.test(source)) {
    return "Pattern may hang the app — avoid nested quantifiers like (a+)+.";
  }
  return "";
}

const compiled = computed(() => {
  const q = query.value;
  if (!q) return { mode: "none", error: "" };
  if (useRegex.value) {
    const safetyError = validateRegexSource(q);
    if (safetyError) return { mode: "error", error: safetyError };
    try {
      return {
        mode: "regex",
        re: new RegExp(q, caseSensitive.value ? "g" : "gi"),
        error: "",
      };
    } catch (e) {
      return { mode: "error", error: String(e.message || e) };
    }
  }
  return {
    mode: "plain",
    needle: caseSensitive.value ? q : q.toLowerCase(),
    sensitive: caseSensitive.value,
    error: "",
  };
});

const regexError = computed(() => compiled.value.error);

function lineMatches(text, matcher = compiled.value) {
  if (matcher.mode === "plain") {
    return matcher.sensitive
      ? text.includes(matcher.needle)
      : text.toLowerCase().includes(matcher.needle);
  }
  if (matcher.mode !== "regex") return false; // "none" or "error"
  const re = matcher.re;
  re.lastIndex = 0;
  return re.test(text);
}

function segmentizeRegex(text, regex) {
  const segs = [];
  let last = 0;
  regex.lastIndex = 0;
  let m;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last)
      segs.push({ text: text.slice(last, m.index), hit: false });
    segs.push({ text: m[0], hit: true });
    last = m.index + m[0].length;
    if (m[0].length === 0) regex.lastIndex++; // guard against zero-width loops
  }
  if (last < text.length) segs.push({ text: text.slice(last), hit: false });
  return segs;
}

function segmentizePlain(text, needle, sensitive) {
  const hay = sensitive ? text : text.toLowerCase();
  const segs = [];
  if (sensitive || hay.length === text.length) {
    let last = 0;
    let i;
    while ((i = hay.indexOf(needle, last)) !== -1) {
      if (i > last) segs.push({ text: text.slice(last, i), hit: false });
      segs.push({ text: text.slice(i, i + needle.length), hit: true });
      last = i + needle.length;
    }
    if (last < text.length) segs.push({ text: text.slice(last), hit: false });
    return segs;
  }
  const chars = [];
  const offsets = [];
  for (let u = 0; u < text.length;) {
    const cp = text.codePointAt(u);
    offsets.push(u);
    chars.push(String.fromCodePoint(cp));
    u += cp > 0xffff ? 2 : 1;
  }
  const needleChars = Array.from(needle);
  let last = 0; // code-point cursor
  let i = 0;
  while (i <= chars.length - needleChars.length) {
    let j = 0;
    while (
      j < needleChars.length &&
      chars[i + j].toLowerCase().startsWith(needleChars[j])
    )
      j++;
    if (j === needleChars.length) {
      const startUnit = offsets[i];
      const endUnit =
        i + needleChars.length < chars.length
          ? offsets[i + needleChars.length]
          : text.length;
      if (i > last) {
        segs.push({ text: text.slice(offsets[last], startUnit), hit: false });
      }
      segs.push({ text: text.slice(startUnit, endUnit), hit: true });
      last = i + needleChars.length;
      i = last;
    } else {
      i++;
    }
  }
  if (last < chars.length) {
    segs.push({ text: text.slice(offsets[last]), hit: false });
  }
  return segs;
}

function segmentsFor(text, matcher) {
  if (matcher.mode === "regex") return segmentizeRegex(text, matcher.re);
  return segmentizePlain(text, matcher.needle, matcher.sensitive);
}

function sameSegments(a, b) {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].hit !== b[i].hit || a[i].text !== b[i].text) return false;
  }
  return true;
}

function matchRowPos(seq) {
  return matchRows.indexOf(seq);
}

function nextFrame(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 0);
}

// Append finished lines to the buffer. The backend already batches lines into
// "log:batch" events (200 lines or 50ms), so one apply per event is all the
// render batching needed; lines arriving mid-rebuild are queued until the
// rebuilt view commits.
function pushLines(lines) {
  if (rebuilding) {
    pendingLines.push(...lines);
    return;
  }
  applyLines(lines);
}

function applyLines(batch) {
  const matcher = compiled.value;
  const filterActive = !!query.value && !matcher.error && onlyMatches.value;
  const next = view.value.concat(); // copy entry references, append new ones
  let addedHits = 0;
  for (const text of batch) {
    const seq = nextSeq++;
    rawLines.push({ seq, text });
    const hit = lineMatches(text, matcher);
    if (filterActive && !hit) continue; // kept in the buffer, hidden by the filter
    next.push({
      seq,
      text,
      hit,
      segments: hit ? segmentsFor(text, matcher) : null,
    });
    if (hit) {
      matchRows.push(seq);
      addedHits++;
    }
  }
  matchCount.value += addedHits;

  const drop = rawLines.length - MAX_LINES;
  let refocusEvicted = false;
  if (drop > 0) {
    rawLines.splice(0, drop);
    const firstSeq = rawLines[0].seq;
    const viewCut = next.findIndex((e) => e.seq >= firstSeq);
    if (viewCut > 0) next.splice(0, viewCut);
    const rowCut = matchRows.findIndex((s) => s >= firstSeq);
    if (rowCut > 0) {
      matchCount.value = Math.max(0, matchCount.value - rowCut);
      matchRows.splice(0, rowCut);
    }
    if (activeSeq.value >= 0 && activeSeq.value < firstSeq) {
      refocusEvicted = logEl.value?.contains(document.activeElement) ?? false;
      activeSeq.value = next.length ? next[0].seq : -1;
    }
    if (currentMatchSeq.value >= 0 && currentMatchSeq.value < firstSeq)
      currentMatchSeq.value = -1;
  }
  view.value = next; // one render pass per flush
  if (refocusEvicted && activeSeq.value >= 0) {
    nextTick(() => focusRow(activeSeq.value));
  }
  scrollToBottom();
}

// Rebuild the filtered view from the raw buffer. Scanning and committing are
// chunked across frames (about 8ms of work / 1000 rows each), so no query —
// not even a pathological regex one — can block the main thread for more
// than one frame. Typing a new query supersedes the in-flight rebuild.
function scheduleRebuild(announceResult) {
  const token = ++rebuildToken;
  rebuilding = true;
  filtering.value = true;
  const matcher = compiled.value;
  const only = onlyMatches.value && !!query.value && !matcher.error;
  const oldSegments = new Map();
  for (const entry of view.value) {
    if (entry.segments) oldSegments.set(entry.seq, entry.segments);
  }
  const nextView = [];
  const nextRows = [];
  let hits = 0;
  let pos = 0;
  let committed = 0;

  function scanStep() {
    if (token !== rebuildToken) return; // superseded by a newer rebuild
    const start = performance.now();
    while (pos < rawLines.length) {
      const entry = rawLines[pos++];
      const hit = lineMatches(entry.text, matcher);
      if (only && !hit) continue;
      let segments = null;
      if (hit) {
        segments = segmentsFor(entry.text, matcher);
        const prev = oldSegments.get(entry.seq);
        if (prev && sameSegments(prev, segments)) segments = prev;
        hits++;
        nextRows.push(entry.seq);
      }
      nextView.push({ seq: entry.seq, text: entry.text, hit, segments });
      if ((pos & 1023) === 0 && performance.now() - start > 8) {
        nextFrame(scanStep);
        return;
      }
    }
    commitStep();
  }

  function commitStep() {
    if (token !== rebuildToken) return;
    const target = Math.min(committed + 1000, nextView.length);
    if (view.value.length - target > 1000) {
      view.value = view.value.slice(0, view.value.length - 1000);
      nextFrame(commitStep);
      return;
    }

    view.value = nextView.slice(0, target);
    committed = target;
    if (committed < nextView.length) {
      nextFrame(commitStep);
      return;
    }
    matchRows = nextRows;
    matchCount.value = hits;
    rebuilding = false;
    filtering.value = false;
    if (
      activeSeq.value >= 0 &&
      view.value.findIndex((r) => r.seq === activeSeq.value) === -1
    ) {
      activeSeq.value = view.value.length
        ? view.value[view.value.length - 1].seq
        : -1;
    }
    if (
      currentMatchSeq.value >= 0 &&
      view.value.findIndex((r) => r.seq === currentMatchSeq.value) === -1
    ) {
      currentMatchSeq.value = -1;
    }
    if (announceResult) {
      if (matcher.error) {
        announce(`Invalid pattern: ${matcher.error}`, "assertive");
      } else if (query.value) {
        announce(`${hits} matching lines.`);
      }
    }
    applyLines(pendingLines.splice(0));
  }

  nextFrame(scanStep);
}

watch(view, () => {
  if (rebuilding) return;
  if (
    activeSeq.value >= 0 &&
    view.value.findIndex((r) => r.seq === activeSeq.value) === -1
  ) {
    activeSeq.value = view.value.length
      ? view.value[view.value.length - 1].seq
      : -1;
  }
});

function focusRow(seq) {
  const el = logEl.value?.querySelector(`[data-row="${seq}"]`);
  el?.focus();
}

function moveRow(to) {
  const len = view.value.length;
  if (len === 0) return;
  const i = Math.min(Math.max(to, 0), len - 1);
  activeSeq.value = view.value[i].seq;
  focusRow(activeSeq.value);
}

function pageSize() {
  const height = logEl.value?.clientHeight || 0;
  const first = logEl.value?.querySelector(".log-line");
  const lineHeight = first?.offsetHeight || 18;
  return Math.max(1, Math.round(height / lineHeight) - 1);
}

async function copyFocused() {
  const len = view.value.length;
  const row =
    activeSeq.value >= 0
      ? view.value.findIndex((r) => r.seq === activeSeq.value)
      : -1;
  if (row === -1) {
    await copyAll();
    return;
  }
  await copyToClipboard(view.value[row].text, `Line ${row + 1} of ${len}`);
}

function onLogKeydown(e) {
  const len = view.value.length;
  if (len === 0) return;

  if (e.ctrlKey || e.metaKey) {
    if (e.key === "c" || e.key === "C") {
      e.preventDefault();
      copyFocused();
    } else if (e.key === "a" || e.key === "A") {
      // Ctrl+A = "select all"; the closest equivalent here is copying all.
      e.preventDefault();
      copyAll();
    }
    return;
  }

  const at =
    activeSeq.value >= 0
      ? view.value.findIndex((r) => r.seq === activeSeq.value)
      : -1;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      autoScroll.value = false;
      moveRow(at === -1 ? 0 : at + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      autoScroll.value = false;
      moveRow(at === -1 ? len - 1 : at - 1);
      break;
    case "Home":
      e.preventDefault();
      autoScroll.value = false;
      moveRow(0);
      break;
    case "End":
      e.preventDefault();
      moveRow(len - 1);
      autoScroll.value = true;
      break;
    case "PageDown":
      e.preventDefault();
      autoScroll.value = false;
      moveRow(at === -1 ? 0 : at + pageSize());
      break;
    case "PageUp":
      e.preventDefault();
      autoScroll.value = false;
      moveRow(at === -1 ? 0 : at - pageSize());
      break;
  }
}

// Landing on the log region (Tab) focuses the newest line when following the
// tail, otherwise the top of the stream or the line you were on.
function onLogFocus() {
  const len = view.value.length;
  if (len === 0) return;
  if (autoScroll.value) {
    activeSeq.value = view.value[len - 1].seq;
  } else if (
    activeSeq.value < 0 ||
    view.value.findIndex((r) => r.seq === activeSeq.value) === -1
  ) {
    activeSeq.value = view.value[0].seq;
  }
  focusRow(activeSeq.value);
}

function onLineClick(seq) {
  activeSeq.value = seq;
}

async function scrollToBottom() {
  if (!autoScroll.value) return;
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
}

// Drop all buffered lines and any in-flight search rebuild.
function resetBuffer() {
  rebuildToken++; // invalidate any in-flight rebuild
  rebuilding = false;
  filtering.value = false;
  rawLines = [];
  view.value = [];
  matchRows = [];
  nextSeq = 0;
  pendingLines = [];
  partial = ""; // don't prepend pre-reset pieces to the next line
  matchCount.value = 0;
  currentMatchSeq.value = -1;
  activeSeq.value = -1;
}

async function start() {
  await stop();
  resetBuffer();
  error.value = "";
  streaming.value = true;
  try {
    streamKey = await api.startLogStream(
      props.namespace,
      props.pod,
      props.container,
      {
        tailLines: tail.value,
        timestamps: timestamps.value,
        previous: previous.value,
      },
    );

    offBatch = onEvent(`log:batch:${streamKey}`, (batch) => {
      const chunk = String(batch);
      if (!chunk) return;
      const parts = chunk.split("\n");
      if (partial) {
        parts[0] = partial + parts[0];
        partial = "";
      }
      pushLines(parts);
    });
    offPart = onEvent(`log:part:${streamKey}`, (chunk) => {
      partial += chunk;
      if (partial.length > MAX_PARTIAL) {
        pushLines([partial]); // runaway line: bound memory, show what we have
        partial = "";
      }
    });
    offEnd = onEvent(`log:end:${streamKey}`, () => {
      if (partial) {
        pushLines([partial]);
        partial = "";
      }
      streaming.value = false;
      announce(`Log stream for ${props.container} ended.`);
    });
    offErr = onEvent(`log:error:${streamKey}`, (msg) => {
      error.value = String(msg);
      streaming.value = false;
      announce(`Log stream error: ${error.value}`, "assertive");
    });

    await api.followLogStream(streamKey);

    const mode = previous.value ? "previous instance of " : "";
    announce(`Streaming logs for ${mode}${props.pod} / ${props.container}.`);
  } catch (e) {
    error.value = String(e);
    streaming.value = false;
    announce(`Failed to start logs: ${error.value}`, "assertive");
  }
}

async function stop() {
  offBatch();
  offEnd();
  offErr();
  offPart();
  offBatch = offEnd = offErr = offPart = () => {};
  partial = "";
  if (streamKey) {
    try {
      await api.stopLogStream(streamKey);
    } catch {
      /* best effort */
    }
    streamKey = "";
  }
  streaming.value = false;
}

function clear() {
  resetBuffer();
  announce("Log view cleared.");
}

function exportContent() {
  if (onlyMatches.value && query.value && !regexError.value) {
    return view.value.map((l) => l.text).join("\n");
  }
  return rawLines.map((l) => l.text).join("\n");
}

function suggestedName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${props.pod}_${props.container}_${stamp}.log`;
}

async function download() {
  try {
    const path = await api.saveLogs(suggestedName(), exportContent());
    if (path) announce(`Logs saved to ${path}.`);
  } catch (e) {
    announce(`Failed to save logs: ${String(e)}`, "assertive");
  }
}

async function copyAll() {
  await copyToClipboard(exportContent(), "Logs");
}

function gotoMatch(step) {
  const rows = matchRows;
  if (rows.length === 0) return;
  let pos = matchRowPos(currentMatchSeq.value);
  pos =
    pos === -1
      ? step > 0
        ? 0
        : rows.length - 1
      : (pos + step + rows.length) % rows.length;
  currentMatchSeq.value = rows[pos];
  autoScroll.value = false; // stop fighting the user while they navigate
  nextTick(() => {
    const el = logEl.value?.querySelector(
      `[data-row="${currentMatchSeq.value}"]`,
    );
    el?.scrollIntoView({ block: "center" });
  });
  announce(`Match ${pos + 1} of ${rows.length}.`);
}

function onSearchEnter(e) {
  gotoMatch(e.shiftKey ? -1 : 1);
}

watch(
  () => [props.namespace, props.pod, props.container],
  () => start(),
  { immediate: true },
);
watch([tail, timestamps, previous], () => start());

watch([query, useRegex, caseSensitive], () => {
  currentMatchSeq.value = -1;
  scheduleRebuild(true);
});
watch(onlyMatches, () => scheduleRebuild(false));

onBeforeUnmount(stop);

const { onKeydown: onReturnFocusKeydown } = useReturnFocus({
  focusTarget: headingEl,
  opener: props.opener,
  onClose: () => emit("close"),
});

defineExpose({ focusSearch: () => searchEl.value?.focus() });

// Ctrl/Cmd+F focuses the in-log search when focus is anywhere in this viewer,
// mirroring the familiar "find" shortcut without hijacking it app-wide.
// Escape closes the viewer (delegated to the shared return-focus handler).
function onSectionKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    searchEl.value?.focus();
    searchEl.value?.select?.();
    return;
  }
  onReturnFocusKeydown(e);
}

const headerButtons = computed(() => [
  streaming.value
    ? { label: "Stop", cls: "btn-outline-secondary", action: stop }
    : { label: "Restart", cls: "btn-outline-success", action: start },
  { label: "Save…", cls: "btn-outline-secondary", action: download },
  { label: "Copy", cls: "btn-outline-secondary", action: copyAll },
  { label: "Clear", cls: "btn-outline-secondary", action: clear },
  { label: "Close", cls: "btn-outline-secondary", action: () => emit("close") },
]);

const searchChecks = [
  {
    id: "opt-regex",
    label: "Regex",
    get: () => useRegex.value,
    set: (v) => (useRegex.value = v),
  },
  {
    id: "opt-case",
    label: "Match case",
    get: () => caseSensitive.value,
    set: (v) => (caseSensitive.value = v),
  },
  {
    id: "opt-only",
    label: "Only matches",
    get: () => onlyMatches.value,
    set: (v) => (onlyMatches.value = v),
    disabled: () => !query.value,
  },
];

const streamChecks = [
  {
    id: "opt-ts",
    label: "Timestamps",
    get: () => timestamps.value,
    set: (v) => (timestamps.value = v),
  },
  {
    id: "opt-prev",
    label: "Previous (crashed) instance",
    get: () => previous.value,
    set: (v) => (previous.value = v),
  },
];

const displayChecks = [
  {
    id: "opt-wrap",
    label: "Wrap lines",
    get: () => wrap.value,
    set: (v) => (wrap.value = v),
  },
  {
    id: "opt-scroll",
    label: "Auto-scroll",
    get: () => autoScroll.value,
    set: (v) => (autoScroll.value = v),
  },
];
</script>

<template>
  <section
    aria-labelledby="log-heading"
    class="d-flex flex-column h-100"
    @keydown="onSectionKeydown"
  >
    <div
      class="d-flex align-items-center justify-content-between mb-2 gap-2 flex-wrap"
    >
      <h2 id="log-heading" ref="headingEl" class="h5 mb-0" tabindex="-1">
        Logs: {{ pod }} / {{ container }}
        <span v-if="streaming" class="badge text-bg-success ms-1" role="status"
          >live</span
        >
        <span v-else class="badge text-bg-secondary ms-1">stopped</span>
        <span v-if="previous" class="badge text-bg-secondary ms-1"
          >previous</span
        >
      </h2>
      <div class="d-flex align-items-center gap-2">
        <button
          v-for="b in headerButtons"
          :key="b.label"
          type="button"
          class="btn btn-sm"
          :class="b.cls"
          @click="b.action"
        >
          {{ b.label }}
        </button>
      </div>
    </div>

    <div class="row g-2 align-items-end mb-2">
      <div class="col-12 col-lg">
        <label for="log-search" class="form-label mb-1 small"
          >Search logs</label
        >
        <div class="input-group input-group-sm">
          <input
            id="log-search"
            ref="searchEl"
            v-model="query"
            type="search"
            class="form-control"
            :class="{ 'is-invalid': regexError }"
            placeholder="Find in logs…"
            autocomplete="off"
            :aria-describedby="query ? 'match-status' : undefined"
            @keydown.enter="onSearchEnter"
          />
          <button
            type="button"
            class="btn btn-outline-secondary"
            :disabled="matchCount === 0"
            aria-label="Previous match"
            @click="gotoMatch(-1)"
          >
            <i class="bi bi-chevron-up" aria-hidden="true"></i>
          </button>
          <button
            type="button"
            class="btn btn-outline-secondary"
            :disabled="matchCount === 0"
            aria-label="Next match"
            @click="gotoMatch(1)"
          >
            <i class="bi bi-chevron-down" aria-hidden="true"></i>
          </button>
        </div>
        <p
          v-if="query"
          id="match-status"
          class="form-text mb-0"
          :class="{ 'text-danger': regexError }"
        >
          <template v-if="regexError"
            >Invalid pattern: {{ regexError }}</template
          >
          <template v-else-if="filtering">Filtering…</template>
          <template v-else>{{ matchCount }} matching lines</template>
        </p>
      </div>

      <div class="col-auto">
        <div class="d-flex flex-wrap gap-3">
          <div
            v-for="opt in searchChecks"
            :key="opt.id"
            class="form-check form-check-inline mb-0"
          >
            <input
              :id="opt.id"
              class="form-check-input"
              type="checkbox"
              :checked="opt.get()"
              :disabled="opt.disabled?.()"
              @change="opt.set($event.target.checked)"
            />
            <label class="form-check-label small" :for="opt.id">{{
              opt.label
            }}</label>
          </div>
        </div>
      </div>
    </div>

    <div class="d-flex flex-wrap align-items-center gap-3 mb-2">
      <div class="d-flex flex-wrap align-items-center gap-3">
        <div class="d-flex align-items-center gap-1">
          <label for="opt-tail" class="form-label mb-0 small">History</label>
          <Combobox
            id="opt-tail"
            v-model="tail"
            :options="TAIL_OPTIONS"
            readonly
            style="min-width: 8.5rem"
          />
        </div>
        <div
          class="form-check form-switch mb-0"
          v-for="opt in streamChecks"
          :key="opt.id"
        >
          <input
            :id="opt.id"
            class="form-check-input"
            type="checkbox"
            :checked="opt.get()"
            @change="opt.set($event.target.checked)"
          />
          <label class="form-check-label small" :for="opt.id">{{
            opt.label
          }}</label>
        </div>
      </div>
      <div class="d-flex flex-wrap align-items-center gap-3 border-start ps-3">
        <div
          class="form-check form-switch mb-0"
          v-for="opt in displayChecks"
          :key="opt.id"
        >
          <input
            :id="opt.id"
            class="form-check-input"
            type="checkbox"
            :checked="opt.get()"
            @change="opt.set($event.target.checked)"
          />
          <label class="form-check-label small" :for="opt.id">{{
            opt.label
          }}</label>
        </div>
      </div>
    </div>

    <p v-if="error" class="text-danger small" role="alert">{{ error }}</p>


    <div
      ref="logEl"
      class="log-view flex-grow-1"
      :class="{ 'log-nowrap': !wrap }"
      tabindex="0"
      role="log"
      aria-live="off"
      aria-label="Log output"
      @keydown="onLogKeydown"
      @focus="onLogFocus"
    >
      <div
        v-for="line in view"
        v-memo="[
          line.seq,
          line.text,
          line.hit,
          line.segments,
          line.seq === currentMatchSeq,
          line.seq === activeSeq,
        ]"
        :key="line.seq"
        :data-row="line.seq"
        class="log-line"
        :class="{
          'log-line-current': line.seq === currentMatchSeq,
          'log-line-active': line.seq === activeSeq,
        }"
        :tabindex="line.seq === activeSeq ? 0 : -1"
        @click="onLineClick(line.seq)"
      >
        <template v-if="line.segments">
          <template v-for="(seg, si) in line.segments" :key="si">
            <mark v-if="seg.hit" class="log-mark">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </template>
        <template v-else>{{ line.text }}</template>
      </div>
      <div v-if="view.length === 0 && streaming" class="text-body-secondary">
        Waiting for log output…
      </div>
      <div
        v-else-if="view.length === 0 && onlyMatches && query"
        class="text-body-secondary"
      >
        No lines match “{{ query }}”.
      </div>
    </div>
  </section>
</template>

<style scoped>
/* Cap the terminal so it stays a contained, internally-scrolling panel and
   never grows into — or under — the resource table beside it. */
.log-view {
  max-height: calc(100vh - 20rem);
}
.log-line {
  display: block;
}
.log-nowrap {
  white-space: pre;
}
.log-nowrap .log-line {
  white-space: pre;
}
.log-mark {
  background: #ffd54f;
  color: #000;
  padding: 0;
}
/* The active match gets a clear, non-colour-only indicator. */
.log-line-current {
  outline: 2px solid #ffd54f;
  outline-offset: -2px;
  background: rgba(255, 213, 79, 0.12);
}
/* The focused line gets a distinct, non-colour-only indicator. */
.log-line-active {
  background: rgba(13, 110, 253, 0.1);
  outline: 1px solid #6ea8fe;
  outline-offset: -1px;
}
</style>
