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
  autoRefresh: false, // persisted setting, loaded on mount
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

export function useStore() {
  return {
    state: readonly(state),
    announce,
    setConnection,
    clearConnection,
    setNamespace,
    setAutoRefresh,
  };
}
