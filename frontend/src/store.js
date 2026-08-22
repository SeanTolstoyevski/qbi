import { reactive, readonly } from "vue";

/*
 * A small central store shared via a module singleton. For an app of this size
 * this is simpler and easier to reason about than a full state-management
 * library, while still keeping components decoupled from each other.
 */

// Namespace of the last-used selection is remembered per context in
// localStorage so re-connecting drops the user back where they were.
const NS_KEY = "qba.lastNamespace";

function loadNsMap() {
  try {
    return JSON.parse(localStorage.getItem(NS_KEY) || "{}");
  } catch {
    return {};
  }
}

function rememberNamespace(contextName, namespace) {
  if (!contextName) return;
  const map = loadNsMap();
  map[contextName] = namespace;
  try {
    localStorage.setItem(NS_KEY, JSON.stringify(map));
  } catch {
    /* storage may be unavailable; remembering is best-effort */
  }
}

function recallNamespace(contextName) {
  return contextName ? loadNsMap()[contextName] || null : null;
}

const state = reactive({
  connected: false,
  context: null, // ContextInfo
  namespace: null, // string
  // Monotonic counter bumped on every successful connect. Cluster-data
  // components watch it so a reconnect to the same context still triggers a
  // full reload, even though connected/context/namespace values don't change.
  connectionEpoch: 0,
  // The most recent status message, mirrored into an aria-live region so
  // screen readers announce loading/errors without stealing focus.
  status: "",
  statusKind: "polite", // "polite" | "assertive"
  // Short-lived VISUAL confirmation (copy etc.) — the aria-live region is
  // invisible, so actions whose only feedback would be an announce leave
  // sighted users guessing. Rendered aria-hidden: never double-announced.
  flashMsg: "",
  flashSeq: 0, // bumped per message; the UI watches it to restart the timer
  autoRefresh: false,

  experimental: false,
});

// announce mirrors a message to the shared aria-live region.
// Use assertive only for errors that must interrupt.
function announce(message, kind = "polite") {
  state.status = "";
  requestAnimationFrame(() => {
    state.statusKind = kind;
    state.status = message;
  });
}

// flash shows a short-lived visual message (rendered aria-hidden in App.vue).
// Keep it for actions whose result is otherwise invisible to sighted users.
function flash(message) {
  state.flashMsg = message;
  state.flashSeq += 1;
}

function clearFlash() {
  state.flashMsg = "";
}

function setConnection(context) {
  state.connected = true;
  state.context = context;
  // Every successful connect (including reconnects to the same context) bumps
  // the epoch so cluster-data components reload instead of keeping stale data.
  state.connectionEpoch += 1;
  state.namespace =
    recallNamespace(context?.name) || context?.namespace || null;
}

function clearConnection() {
  state.connected = false;
  state.context = null;
  state.namespace = null;
}

function setNamespace(name) {
  state.namespace = name;
  rememberNamespace(state.context?.name, name);
}

function setAutoRefresh(enabled) {
  state.autoRefresh = enabled;
}

function setExperimental(enabled) {
  state.experimental = enabled;
}

export function useStore() {
  return {
    state: readonly(state),
    announce,
    flash,
    clearFlash,
    setConnection,
    clearConnection,
    setNamespace,
    setAutoRefresh,
    setExperimental,
  };
}
