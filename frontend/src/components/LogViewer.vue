<script setup>
import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";
import { api, onEvent } from "../api.js";
import { useStore } from "../store.js";
import { useReturnFocus } from "../useReturnFocus.js";
import { copyToClipboard } from "../clipboard.js";
import Combobox from "./Combobox.vue";

const props = defineProps({
  namespace: { type: String, required: true },
  pod: { type: String, required: true },
  container: { type: String, required: true },
});

const emit = defineEmits(["close"]);
const { announce } = useStore();

// --- raw log buffer --------------------------------------------------------
const lines = ref([]);
const streaming = ref(false);
const error = ref("");

// --- stream options (require a restart to take effect) ---------------------
const tail = ref(500); // history lines to fetch: number, or -1 for "all"
const timestamps = ref(false);
const previous = ref(false); // logs from the previous (crashed) container

// History choices keep numeric values: -1 means "all" (matches the API).
const TAIL_OPTIONS = [
  { value: 100, label: "100 lines" },
  { value: 500, label: "500 lines" },
  { value: 1000, label: "1000 lines" },
  { value: -1, label: "All" },
];

// --- view options ----------------------------------------------------------
const autoScroll = ref(true);
const wrap = ref(true);

// --- search / filter -------------------------------------------------------
const query = ref("");
const useRegex = ref(false);
const caseSensitive = ref(false);
const onlyMatches = ref(false);

const logEl = ref(null);
const headingEl = ref(null);
const searchEl = ref(null);

let streamKey = "";
let offLine = () => {};
let offEnd = () => {};
let offErr = () => {};

const MAX_LINES = 20000; // cap memory for long-running streams
const MAX_REGEX_LEN = 500; // guard against catastrophic backtracking (ReDoS)
const RE_NESTED_Q = /\)[\*\+]/; // closing paren + quantifier = likely nested quantifier

function validateRegexSource(source) {
  if (source.length > MAX_REGEX_LEN) {
    return "Pattern is too long (max 500 characters).";
  }
  if (RE_NESTED_Q.test(source)) {
    return "Pattern may hang the app — avoid nested quantifiers like (a+)+.";
  }
  return "";
}

// Compile the search query into a matcher, keeping any error separate. This is
// a pure computed (no side effects) so it is safe to read during render.
const compiled = computed(() => {
  const q = query.value;
  if (!q) return { re: null, error: "" };
  const flags = caseSensitive.value ? "g" : "gi";
  if (useRegex.value) {
    const safetyError = validateRegexSource(q);
    if (safetyError) return { re: null, error: safetyError };
  }
  try {
    const source = useRegex.value
      ? q
      : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { re: new RegExp(source, flags), error: "" };
  } catch (e) {
    return { re: null, error: String(e.message || e) };
  }
});

const matcher = computed(() => compiled.value.re);
const regexError = computed(() => compiled.value.error);

function lineMatches(text) {
  const m = matcher.value;
  if (!m) return false;
  m.lastIndex = 0;
  return m.test(text);
}

// The lines actually rendered, each annotated with its original index and
// pre-split highlight segments when a search is active.
const visibleLines = computed(() => {
  const m = matcher.value;
  const out = [];
  for (let i = 0; i < lines.value.length; i++) {
    const text = lines.value[i];
    const hit = m ? lineMatches(text) : false;
    if (onlyMatches.value && m && !hit) continue;
    out.push({
      index: i,
      text,
      hit,
      segments: hit ? segmentize(text, m) : null,
    });
  }
  return out;
});

// Derive the count from visibleLines, which already walked every line and
// computed hit flags — avoids a second O(n) pass on every incoming log line.
// With the "only matches" filter on, every visible line is a hit, so counting
// hits is correct in both modes.
const matchCount = computed(() =>
  visibleLines.value.reduce((n, l) => n + (l.hit ? 1 : 0), 0),
);

// Split a line into { text, hit } segments so matches can be wrapped in <mark>
// without using v-html (avoids any injection from log content).
function segmentize(text, regex) {
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

// --- match navigation ------------------------------------------------------
const currentMatch = ref(-1);

// Indices (into visibleLines) that contain a match.
const matchRows = computed(() =>
  visibleLines.value.reduce((acc, l, i) => {
    if (l.hit) acc.push(i);
    return acc;
  }, []),
);

function gotoMatch(step) {
  const rows = matchRows.value;
  if (rows.length === 0) return;
  let pos = rows.indexOf(currentMatch.value);
  pos =
    pos === -1
      ? step > 0
        ? 0
        : rows.length - 1
      : (pos + step + rows.length) % rows.length;
  currentMatch.value = rows[pos];
  autoScroll.value = false; // stop fighting the user while they navigate
  nextTick(() => {
    const el = logEl.value?.querySelector(`[data-row="${currentMatch.value}"]`);
    el?.scrollIntoView({ block: "center" });
  });
  announce(`Match ${pos + 1} of ${rows.length}.`);
}

function onSearchEnter(e) {
  gotoMatch(e.shiftKey ? -1 : 1);
}

// Announce match totals as the user refines the search.
watch([query, useRegex, caseSensitive], () => {
  currentMatch.value = -1;
  if (!query.value) return;
  if (regexError.value) {
    announce(`Invalid pattern: ${regexError.value}`, "assertive");
  } else {
    announce(`${matchCount.value} matching lines.`);
  }
});

// --- line navigation (desktop-style) --------------------------------------
// Logs behave like a simple list: the focused line carries a roving tabindex
// so arrow keys move between lines, Home/End jump, PageUp/PageDown page, and
// Ctrl+C copies the focused line. This mirrors a desktop list view rather
// than a plain scrolling text pane.
const activeRow = ref(-1); // roving-focus index into visibleLines

function focusRow(row) {
  const el = logEl.value?.querySelector(`[data-row="${row}"]`);
  el?.focus();
  el?.scrollIntoView({ block: "nearest" });
}

function moveRow(to) {
  const len = visibleLines.value.length;
  if (len === 0) return;
  const i = Math.min(Math.max(to, 0), len - 1);
  activeRow.value = i;
  focusRow(i);
}

// Estimate a page as one viewport of lines, so PageUp/PageDown feel natural
// even when long lines wrap.
function pageSize() {
  const height = logEl.value?.clientHeight || 0;
  const first = logEl.value?.querySelector(".log-line");
  const lineHeight = first?.offsetHeight || 18;
  return Math.max(1, Math.round(height / lineHeight) - 1);
}

async function copyFocused() {
  const len = visibleLines.value.length;
  const row = activeRow.value;
  if (row < 0 || row >= len) {
    await copyAll();
    return;
  }
  await copyToClipboard(
    visibleLines.value[row].text,
    `Line ${row + 1} of ${len}`,
  );
}

function onLogKeydown(e) {
  const len = visibleLines.value.length;
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
    activeRow.value >= 0 && activeRow.value < len ? activeRow.value : -1;
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
      // The tail is the newest content: land there and resume following.
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
  const len = visibleLines.value.length;
  if (len === 0) return;
  if (autoScroll.value) {
    activeRow.value = len - 1;
  } else if (activeRow.value < 0 || activeRow.value >= len) {
    activeRow.value = 0;
  }
  focusRow(activeRow.value);
}

function onLineClick(row) {
  activeRow.value = row;
}

// Keep the focused row valid when filtering hides lines.
watch(
  () => visibleLines.value.length,
  (len) => {
    if (activeRow.value >= len) activeRow.value = len - 1;
  },
);

// --- streaming lifecycle ---------------------------------------------------
async function scrollToBottom() {
  if (!autoScroll.value) return;
  await nextTick();
  if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
}

async function start() {
  await stop();
  lines.value = [];
  currentMatch.value = -1;
  activeRow.value = -1;
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

    offLine = onEvent(`log:${streamKey}`, (line) => {
      lines.value.push(line);
      if (lines.value.length > MAX_LINES) {
        lines.value.splice(0, lines.value.length - MAX_LINES);
      }
      scrollToBottom();
    });
    offEnd = onEvent(`log:end:${streamKey}`, () => {
      streaming.value = false;
      announce(`Log stream for ${props.container} ended.`);
    });
    offErr = onEvent(`log:error:${streamKey}`, (msg) => {
      error.value = String(msg);
      streaming.value = false;
      announce(`Log stream error: ${error.value}`, "assertive");
    });

    const mode = previous.value ? "previous instance of " : "";
    announce(`Streaming logs for ${mode}${props.pod} / ${props.container}.`);
  } catch (e) {
    error.value = String(e);
    streaming.value = false;
    announce(`Failed to start logs: ${error.value}`, "assertive");
  }
}

async function stop() {
  offLine();
  offEnd();
  offErr();
  offLine = offEnd = offErr = () => {};
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
  lines.value = [];
  currentMatch.value = -1;
  activeRow.value = -1;
  announce("Log view cleared.");
}

// --- export ---------------------------------------------------------------
// When an "only matches" filter is active, export what the user currently sees
// so the saved file matches the on-screen investigation.
function exportContent() {
  const source =
    onlyMatches.value && matcher.value
      ? visibleLines.value.map((l) => l.text)
      : lines.value;
  return source.join("\n");
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

// Restart when the target changes, or when stream-level options change.
watch(
  () => [props.namespace, props.pod, props.container],
  () => start(),
  { immediate: true },
);
watch([tail, timestamps, previous], () => start());

onBeforeUnmount(stop);

// Return focus to the trigger button on close, land focus on the heading on
// open, and close on Escape (handled in onSectionKeydown below).
const { onKeydown: onReturnFocusKeydown } = useReturnFocus({
  focusTarget: headingEl,
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
          v-if="streaming"
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="stop"
        >
          Stop
        </button>
        <button
          v-else
          type="button"
          class="btn btn-sm btn-outline-success"
          @click="start"
        >
          Restart
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="download"
        >
          Save…
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="copyAll"
        >
          Copy
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="clear"
        >
          Clear
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click="emit('close')"
        >
          Close
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
          <template v-else>{{ matchCount }} matching lines</template>
        </p>
      </div>

      <div class="col-auto">
        <div class="d-flex flex-wrap gap-3">
          <div class="form-check form-check-inline mb-0">
            <input
              id="opt-regex"
              v-model="useRegex"
              class="form-check-input"
              type="checkbox"
            />
            <label class="form-check-label small" for="opt-regex">Regex</label>
          </div>
          <div class="form-check form-check-inline mb-0">
            <input
              id="opt-case"
              v-model="caseSensitive"
              class="form-check-input"
              type="checkbox"
            />
            <label class="form-check-label small" for="opt-case"
              >Match case</label
            >
          </div>
          <div class="form-check form-check-inline mb-0">
            <input
              id="opt-only"
              v-model="onlyMatches"
              class="form-check-input"
              type="checkbox"
              :disabled="!query"
            />
            <label class="form-check-label small" for="opt-only"
              >Only matches</label
            >
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
        <div class="form-check form-switch mb-0">
          <input
            id="opt-ts"
            v-model="timestamps"
            class="form-check-input"
            type="checkbox"
          />
          <label class="form-check-label small" for="opt-ts">Timestamps</label>
        </div>
        <div class="form-check form-switch mb-0">
          <input
            id="opt-prev"
            v-model="previous"
            class="form-check-input"
            type="checkbox"
          />
          <label class="form-check-label small" for="opt-prev"
            >Previous (crashed) instance</label
          >
        </div>
      </div>
      <div class="d-flex flex-wrap align-items-center gap-3 border-start ps-3">
        <div class="form-check form-switch mb-0">
          <input
            id="opt-wrap"
            v-model="wrap"
            class="form-check-input"
            type="checkbox"
          />
          <label class="form-check-label small" for="opt-wrap"
            >Wrap lines</label
          >
        </div>
        <div class="form-check form-switch mb-0">
          <input
            id="opt-scroll"
            v-model="autoScroll"
            class="form-check-input"
            type="checkbox"
          />
          <label class="form-check-label small" for="opt-scroll"
            >Auto-scroll</label
          >
        </div>
      </div>
    </div>

    <p v-if="error" class="text-danger small" role="alert">{{ error }}</p>

    <!-- role="log" would imply a polite live region (ARIA implicit aria-live),
         so a fast stream would be announced line-by-line and flood the reader.
         Explicit aria-live="off" opts out; users read lines via the roving
         focus (arrow keys) instead, exactly as the comment below intends. -->
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
        v-for="(line, row) in visibleLines"
        :key="line.index"
        :data-row="row"
        class="log-line"
        :class="{
          'log-line-current': row === currentMatch,
          'log-line-active': row === activeRow,
        }"
        :tabindex="row === activeRow ? 0 : -1"
        @click="onLineClick(row)"
      >
        <template v-if="line.segments">
          <template v-for="(seg, si) in line.segments" :key="si">
            <mark v-if="seg.hit" class="log-mark">{{ seg.text }}</mark>
            <template v-else>{{ seg.text }}</template>
          </template>
        </template>
        <template v-else>{{ line.text }}</template>
      </div>
      <div
        v-if="visibleLines.length === 0 && streaming"
        class="text-body-secondary"
      >
        Waiting for log output…
      </div>
      <div
        v-else-if="visibleLines.length === 0 && onlyMatches && query"
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
