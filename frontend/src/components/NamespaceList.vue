<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { copyToClipboard } from "../clipboard.js";
import { useActionMenu } from "../useActionMenu.js";
import ListBox from "./ListBox.vue";

const { state, announce, setNamespace } = useStore();

const namespaces = ref([]);
const loading = ref(false);
const error = ref("");
const filter = ref("");
const deleting = ref(false);

async function load() {
  if (!state.connected) return;
  loading.value = true;
  error.value = "";
  try {
    const list = await api.listNamespaces();
    namespaces.value = list || [];
    announce(`${namespaces.value.length} namespaces loaded.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load namespaces: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

const options = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return namespaces.value
    .filter((ns) => !q || ns.name.toLowerCase().includes(q))
    .map((ns) => ({
      value: ns.name,
      label: ns.name,
      description: `${ns.status} · ${ns.age}`,
      // A namespace being deleted deserves a glance-level cue, not just text.
      descriptionClass: ns.status === "Terminating" ? "text-warning" : "",
    }));
});

function select(name) {
  setNamespace(name);
  announce(`Namespace ${name} selected.`);
}

const listBoxRef = ref(null);
const menuRef = ref(null);
const menuX = ref(0);
const menuY = ref(0);

const { menuOpen, closeMenu, onMenuKeydown } = useActionMenu(null, {
  getTrigger: () =>
    listBoxRef.value?.$el?.querySelector('[role="option"][tabindex="0"]'),
});

function openMenu({ value, x, y }) {
  menuX.value = x;
  menuY.value = y;
  menuOpen.value = value;
  nextTick(() => {
    menuRef.value
      ?.querySelector('[role="menuitem"]:not(:disabled)')
      ?.focus();
  });
}

async function removeFromMenu() {
  const name = menuOpen.value;
  closeMenu(name, { skipFocus: true });
  deleting.value = true;
  error.value = "";
  try {
    const requested = await api.deleteNamespace(name);
    if (!requested) return;
    announce(
      `Deletion requested for namespace ${name}. It is now terminating.`,
    );
    await load();
  } catch (e) {
    error.value = String(e);
    announce(`Failed to delete namespace ${name}: ${error.value}`, "assertive");
  } finally {
    deleting.value = false;
  }
}

function copyFromMenu() {
  const name = menuOpen.value;
  closeMenu(name); // convention: focus returns to the list option
  copyToClipboard(name, `Namespace ${name}`);
}

function copyFromList(value) {
  copyToClipboard(value, `Namespace ${value}`);
}

watch(
  () => [state.connected, state.context?.name, state.connectionEpoch],
  ([connected, ctxName]) => {
    if (connected && ctxName) load();
  },
  { immediate: true },
);

// A failed reconnect tears the connection down; an open action menu must not
// survive it — its Delete action would still hit the (now unverified) cluster.
watch(
  () => state.connected,
  (connected) => {
    if (!connected) closeMenu(menuOpen.value, { skipFocus: true });
  },
);

const listReady = computed(
  () =>
    state.connected &&
    !loading.value &&
    !error.value &&
    namespaces.value.length > 0 &&
    options.value.length > 0,
);

// Move focus into the namespace listbox (the active option). Callers should
// check listReady first so this only runs when there is a list to land on.
function focusList() {
  listBoxRef.value?.focusActive();
}

defineExpose({ load, listReady, focusList });
</script>

<template>
  <section aria-labelledby="ns-heading" class="h-100 d-flex flex-column">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="ns-heading" class="h5 mb-0">Namespaces</h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || !state.connected"
        @click="load"
      >
        <span class="visually-hidden">Refresh namespaces</span>
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
      </button>
    </div>

    <p v-if="!state.connected" class="text-muted small">
      Connect to a cluster to list namespaces.
    </p>
    <p v-else-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>
    <p v-else-if="namespaces.length === 0" class="text-muted small">
      No namespaces visible.
    </p>

    <template v-else>
      <label for="ns-filter" class="visually-hidden">Filter namespaces</label>
      <input
        id="ns-filter"
        v-model="filter"
        type="search"
        class="form-control form-control-sm mb-2"
        placeholder="Filter namespaces…"
        autocomplete="off"
      />

      <p v-if="options.length === 0" class="text-muted small">
        No namespaces match “{{ filter }}”.
      </p>

      <ListBox
        v-else
        ref="listBoxRef"
        class="scroll-pane"
        aria-label="Namespaces"
        :options="options"
        :has-context-menu="true"
        :context-open-value="menuOpen"
        :copy-on-ctrl-c="true"
        :model-value="state.namespace"
        @select="select"
        @context-action="openMenu"
        @copy="copyFromList"
      />
    </template>
  </section>

  <Teleport to="body">
    <div
      v-if="menuOpen"
      ref="menuRef"
      role="menu"
      :aria-label="`Namespace ${menuOpen} actions`"
      class="qba-ns-menu"
      :data-menu="menuOpen"
      :style="{ top: menuY + 'px', left: menuX + 'px' }"
      @keydown="onMenuKeydown($event, menuOpen)"
    >
      <button
        role="menuitem"
        type="button"
        class="qba-ns-menu-item"
        @click="copyFromMenu"
      >
        Copy name
        <span class="visually-hidden">{{ menuOpen }}</span>
      </button>
      <button
        role="menuitem"
        type="button"
        class="qba-ns-menu-item text-danger"
        :disabled="deleting"
        @click="removeFromMenu"
      >
        <span
          v-if="deleting"
          class="spinner-border spinner-border-sm me-1"
          aria-hidden="true"
        ></span>
        Delete namespace
        <span class="visually-hidden">{{ menuOpen }}</span>
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.qba-ns-menu {
  position: fixed;
  z-index: 1050;
  min-width: 11rem;
  padding: 0.25rem 0;
  background: var(--bs-body-bg);
  border: 1px solid var(--bs-border-color);
  border-radius: var(--bs-border-radius);
  box-shadow: 0 0.25rem 0.5rem rgba(0, 0, 0, 0.15);
}

.qba-ns-menu-item {
  display: block;
  width: 100%;
  padding: 0.375rem 1rem;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}

.qba-ns-menu-item:not(:disabled):hover,
.qba-ns-menu-item:focus {
  background: var(--bs-secondary-bg-subtle, #e2e3e5);
  outline: 2px solid var(--bs-secondary);
  outline-offset: -2px;
}

.qba-ns-menu-item.text-danger:not(:disabled):hover,
.qba-ns-menu-item.text-danger:focus {
  background: var(--bs-danger-bg-subtle, #f8d7da);
  outline-color: var(--bs-danger);
}

.qba-ns-menu-item:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
