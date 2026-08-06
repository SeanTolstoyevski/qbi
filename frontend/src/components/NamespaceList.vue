<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
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
    }));
});

function select(name) {
  setNamespace(name);
  announce(`Namespace ${name} selected.`);
}

// ── Context menu ────────────────────────────────────────────────────────────
const listBoxRef = ref(null);
const menuRef = ref(null);
const menuOpen = ref(false);
const menuNs = ref("");
const menuX = ref(0);
const menuY = ref(0);

function openMenu({ value, x, y }) {
  menuNs.value = value;
  menuX.value = x;
  menuY.value = y;
  menuOpen.value = true;
  nextTick(() => {
    menuRef.value?.querySelector('[role="menuitem"]')?.focus();
  });
}

function closeMenu(returnFocus = false) {
  menuOpen.value = false;
  if (returnFocus) {
    nextTick(() => listBoxRef.value?.focusActive());
  }
}

// Close on click outside the menu.
function onDocMouseDown(e) {
  if (menuOpen.value && menuRef.value && !menuRef.value.contains(e.target)) {
    closeMenu(false);
  }
}

onMounted(() => document.addEventListener("mousedown", onDocMouseDown));
onUnmounted(() => document.removeEventListener("mousedown", onDocMouseDown));

async function removeFromMenu() {
  const name = menuNs.value;
  closeMenu(false);
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

watch(
  () => state.connected && state.context?.name,
  (val) => {
    if (val) load();
  },
  { immediate: true },
);

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="ns-heading" class="h-100 d-flex flex-column">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="ns-heading" class="h6 mb-0">Namespaces</h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || !state.connected"
        @click="load"
      >
        <span class="visually-hidden">Refresh namespaces</span>
        <span aria-hidden="true">⟳</span>
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
        described-by="ns-list-hint"
        :options="options"
        :has-context-menu="true"
        :model-value="state.namespace"
        @select="select"
        @context-action="openMenu"
      />

      <p id="ns-list-hint" class="visually-hidden">
        Use the arrow keys to move through namespaces and press Enter to select.
        Press the application key or right-click for actions.
      </p>
    </template>
  </section>

  <!-- Context menu rendered at body level to avoid overflow clipping. -->
  <Teleport to="body">
    <div
      v-if="menuOpen"
      ref="menuRef"
      role="menu"
      :aria-label="`Namespace ${menuNs} actions`"
      class="qba-ns-menu"
      :style="{ top: menuY + 'px', left: menuX + 'px' }"
      @keydown.esc.prevent="closeMenu(true)"
    >
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
        <span class="visually-hidden">{{ menuNs }}</span>
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

.qba-ns-menu-item:hover,
.qba-ns-menu-item:focus {
  background: var(--bs-danger-bg-subtle, #f8d7da);
  outline: 2px solid var(--bs-danger);
  outline-offset: -2px;
}

.qba-ns-menu-item:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
