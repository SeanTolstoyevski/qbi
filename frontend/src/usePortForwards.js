import { ref, computed, watch } from "vue";
import { api, onEvent } from "./api.js";
import { useStore } from "./store.js";

/*
 * Shared singleton state for port forwarding. One subscription and one
 * announcement owner for the whole app:
 *
 *   - the header nav badge (count) and the Forwards section (full list),
 *   - the pod detail panel (rows filtered to its pod).
 *
 * Every transition is announced here exactly once, so no view announces on
 * its own and the screen reader never hears the same event twice — a stop
 * initiated from any panel is announced, a failure is announced even when
 * the pod detail is closed.
 */

const forwards = ref([]);
const byId = new Map();
// ids that reached a terminal state: a stale event or a late hydrate result
// must never resurrect them (forward ids are never reused).
const finished = new Set();
// ids whose Stop was requested from the UI (any panel).
const stopping = new Set();

// Bound to the store's announce on the first usePortForwards() call, so
// onStatus can announce before any consumer initialises.
let announce = () => {};

let subscribed = false;

function upsert(status) {
  if (finished.has(status.id)) return;
  if (byId.has(status.id)) {
    const i = forwards.value.findIndex((f) => f.id === status.id);
    if (i >= 0) forwards.value[i] = status;
  } else {
    byId.set(status.id, status);
    forwards.value.push(status);
  }
}

function drop(id) {
  if (!byId.has(id)) return;
  byId.delete(id);
  stopping.delete(id);
  forwards.value = forwards.value.filter((f) => f.id !== id);
}

function onStatus(status) {
  if (status.state === "stopped" || status.state === "failed") {
    if (status.state === "failed") {
      announce(
        `Port forward to ${status.pod}:${status.remotePort} failed: ${
          status.error || "the connection ended"
        }.`,
        "assertive",
      );
    } else if (stopping.has(status.id)) {
      announce(`Port forward to ${status.pod}:${status.remotePort} stopped.`);
    }
    finished.add(status.id);
    drop(status.id);
    return;
  }

  if (status.state === "active") {
    const current = byId.get(status.id);
    if (!current || current.state !== "active") {
      announce(`Port forward started: 127.0.0.1:${status.localPort}.`);
    }
  }
  upsert(status);
}

// Full refresh: rows are replaced, not merged, so a forward that ended
// without an event (reconnect teardown suppresses them) is dropped here.
async function hydrate() {
  try {
    const list = await api.listPortForwards();
    byId.clear();
    forwards.value = [];
    for (const st of list) {
      if (st.state !== "stopped" && st.state !== "failed") {
        upsert(st);
      }
    }
  } catch {
    // Best-effort: events keep the list live anyway.
  }
}

async function stopForward(f) {
  stopping.add(f.id);
  try {
    await api.stopPortForward(f.id);
  } catch (e) {
    stopping.delete(f.id);
    announce(`Failed to stop port forward: ${String(e)}`, "assertive");
  }
  // The row disappears when the "stopped" event arrives.
}

export function usePortForwards() {
  const { state, announce: storeAnnounce } = useStore();
  announce = storeAnnounce;

  if (!subscribed) {
    subscribed = true;
    onEvent("portforward:status", onStatus);
    hydrate();
    // A reconnect tears down every forward server-side without emitting
    // events; rehydrate against the drained registry so stale rows vanish.
    watch(() => state.connectionEpoch, hydrate);
  }

  return {
    forwards,
    count: computed(() => forwards.value.length),
    stopForward,
    hydrate,
  };
}

// Test-only: resets the singleton (rows, tombstones, subscription) so each
// test starts from a clean slate. Not used by the app.
export function resetPortForwards() {
  forwards.value = [];
  byId.clear();
  finished.clear();
  stopping.clear();
  subscribed = false;
}
