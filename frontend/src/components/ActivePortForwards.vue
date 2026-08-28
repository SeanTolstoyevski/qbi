<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from "vue";
import { api, onEvent } from "../api.js";
import { useStore } from "../store.js";

// Global view of every running port forward, independent of the pod detail
// panel: forwards survive panel closes and namespace switches, so this chip
// is the only place that always shows them and can stop them. Rendered only
// while at least one forward is active.
const { state, announce } = useStore();

const forwards = ref([]);
const byId = new Map();
const stopping = new Set(); // ids whose Stop was requested from this panel
const open = ref(false);

let offStatus = () => {};

function upsert(status) {
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
    // Announce only our own stops: the pod detail panel owns the "started"
    // and "failed" announcements for the pod it is showing, and announcing
    // from both places would double-announce.
    if (status.state === "stopped" && stopping.has(status.id)) {
      announce(`Port forward to ${status.pod}:${status.remotePort} stopped.`);
    }
    drop(status.id);
    return;
  }
  upsert(status);
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
    // Best-effort: the chip is cosmetic; events keep arriving anyway.
  }
}

function onListKeydown(e) {
  if (e.key === "Escape") open.value = false;
}

onMounted(() => {
  offStatus = onEvent("portforward:status", onStatus);
  hydrate();
});

// A reconnect tears down every forward server-side without emitting events;
// rehydrate against the drained registry so stale rows disappear.
watch(() => state.connectionEpoch, hydrate);

onBeforeUnmount(() => offStatus());
</script>

<template>
  <div v-if="forwards.length" class="position-relative">
    <button
      type="button"
      class="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
      :aria-expanded="open"
      aria-controls="active-forwards-list"
      @click="open = !open"
    >
      <i class="bi bi-link-45deg" aria-hidden="true"></i>
      <span>Port forwards</span>
      <span class="badge text-bg-secondary">{{ forwards.length }}</span>
    </button>

    <ul
      v-if="open"
      id="active-forwards-list"
      class="active-forwards-list"
      role="list"
      @keydown="onListKeydown"
    >
      <li
        v-for="f in forwards"
        :key="f.id"
        class="d-flex align-items-center gap-2"
      >
        <code>127.0.0.1:{{ f.localPort }}</code>
        <span class="text-body-secondary" aria-hidden="true">→</span>
        <code>{{ f.pod }}:{{ f.remotePort }}</code>
        <span class="text-body-secondary small ms-auto">{{ f.namespace }}</span>
        <button
          type="button"
          class="btn btn-sm btn-outline-danger"
          :disabled="f.state === 'starting'"
          @click="stopForward(f)"
        >
          <span class="visually-hidden"
            >Stop port forward 127.0.0.1:{{ f.localPort }}</span
          >
          <i class="bi bi-stop-circle" aria-hidden="true"></i>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.active-forwards-list {
  position: absolute;
  right: 0;
  top: calc(100% + 0.25rem);
  z-index: 1050;
  min-width: 22rem;
  max-height: 16rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--bs-body-bg, #fff);
  border: 1px solid var(--bs-border-color, #dee2e6);
  border-radius: var(--bs-border-radius, 0.375rem);
  box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.15);
}
</style>
