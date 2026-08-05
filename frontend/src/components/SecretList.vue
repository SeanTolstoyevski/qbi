<script setup>
import { ref, computed, watch, nextTick } from "vue";
import { api } from "../api.js";
import { useWatch, watchAnnouncement } from "../useWatch.js";
import { useStore } from "../store.js";
import ListBox from "./ListBox.vue";
import SecretDetail from "./SecretDetail.vue";
import SecretCreate from "./SecretCreate.vue";

/*
 * Secrets tab — a full editor, not a viewer.
 *
 * Layout: a toolbar (New secret + value-mode toggle) above a two-column
 * split — the selectable list of secrets on the left, and on the right
 * either the create panel or the detail panel for the selected secret.
 *
 * The value-mode toggle is global to the tab and persisted: "Plain text"
 * (transparent — QBI encodes/decodes base64 for you) vs "Base64" (you see and
 * type raw base64; the system only validates it when saving).
 */

const { state, announce } = useStore();

const MODE_KEY = "qba.secretValueMode";
const mode = ref(localStorage.getItem(MODE_KEY) === "base64" ? "base64" : "transparent");

function setMode(m) {
  if (mode.value === m) return;
  mode.value = m;
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* storage may be unavailable; remembering is best-effort */
  }
  announce(
    m === "base64"
      ? "Base64 mode. Values are shown and entered as raw base64."
      : "Plain text mode. Values are shown and entered as text; QBI encodes them."
  );
}

const secrets = ref([]);
const loading = ref(false);
const error = ref("");
const filter = ref("");
const selected = ref(null);

// What the right column shows: a selected secret's detail panel, or the
// create panel. Both are keyed so opening a different item remounts cleanly.
const detailName = ref(null);
const creating = ref(false);

async function load() {
  if (!state.namespace) return;
  loading.value = true;
  error.value = "";
  try {
    const list = await api.listSecrets(state.namespace);
    secrets.value = list || [];
    // A refresh (manual or from a watch event) keeps the open detail panel if
    // the secret still exists, and closes it when the secret is gone.
    if (detailName.value && !secrets.value.some((s) => s.name === detailName.value)) {
      detailName.value = null;
      selected.value = null;
    }
    announce(`${secrets.value.length} secrets in ${state.namespace}.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load secrets: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

// A namespace switch invalidates every selection: names belong to the old
// namespace, and the detail/create panels would query the wrong scope.
watch(
  () => state.namespace,
  async (ns) => {
    detailName.value = null;
    creating.value = false;
    selected.value = null;
    if (ns) await load();
  },
  { immediate: true }
);

const options = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return secrets.value
    .filter((s) => !q || s.name.toLowerCase().includes(q))
    .map((s) => ({
      value: s.name,
      label: s.name,
      description: `${s.type} · ${s.keys.length} keys · ${s.age}`,
    }));
});

function open(name) {
  selected.value = name;
  detailName.value = name;
  creating.value = false;
}

// ── create panel ───────────────────────────────────────────────────────────
function openCreate() {
  // Focus the trigger before mounting the panel so useReturnFocus can return
  // focus here on close (same pattern as PodList's focusTriggerAndAct).
  document.getElementById("secret-create-btn")?.focus();
  detailName.value = null;
  selected.value = null;
  creating.value = true;
}
function closeCreate() {
  creating.value = false;
}
async function onCreated() {
  creating.value = false;
  await load();
}

// ── detail panel ───────────────────────────────────────────────────────────
async function onUpdated() {
  await load();
}
async function onDeleted() {
  detailName.value = null;
  selected.value = null;
  await load();
}
function onDetailClose() {
  detailName.value = null;
  selected.value = null;
  // Hand focus back to the list so a keyboard user isn't left stranded.
  nextTick(() => document.getElementById("secret-filter")?.focus());
}

useWatch("watch:secrets", {
  reload: load,
  summarize: (batch) => announce(watchAnnouncement("Secret", "secrets", batch)),
});

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="secrets-heading">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="secrets-heading" class="h6 mb-0">
        Secrets<span v-if="state.namespace"> in {{ state.namespace }}</span>
      </h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || !state.namespace"
        @click="load"
      >
        <span class="visually-hidden">Refresh secrets</span>
        <span aria-hidden="true">⟳</span>
      </button>
    </div>

    <!-- Toolbar: the write-action trigger + the global value mode. -->
    <div class="d-flex align-items-center justify-content-between gap-2 mb-2">
      <button
        id="secret-create-btn"
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="!state.namespace"
        @click="openCreate"
      >
        New secret
      </button>

      <div
        role="radiogroup"
        aria-label="Secret value mode"
        aria-describedby="secret-mode-hint"
        class="btn-group btn-group-sm"
      >
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'transparent'"
          class="btn"
          :class="mode === 'transparent' ? 'btn-secondary' : 'btn-outline-secondary'"
          @click="setMode('transparent')"
        >
          Plain text
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="mode === 'base64'"
          class="btn"
          :class="mode === 'base64' ? 'btn-secondary' : 'btn-outline-secondary'"
          @click="setMode('base64')"
        >
          Base64
        </button>
      </div>
    </div>
    <p id="secret-mode-hint" class="visually-hidden">
      In plain text mode values are shown and entered as text and encoded for you. In
      base64 mode values are shown and entered as raw base64 and only validated when you
      save.
    </p>

    <p v-if="!state.namespace" class="text-muted small">
      Select a namespace to list its secrets.
    </p>
    <p v-else-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>
    <p v-else-if="secrets.length === 0" class="text-muted small">
      No secrets found.
    </p>

    <div v-else class="row g-3">
      <div class="col-md-5 d-flex flex-column">
        <label for="secret-filter" class="visually-hidden">Filter secrets</label>
        <input
          id="secret-filter"
          v-model="filter"
          type="search"
          class="form-control form-control-sm mb-2"
          placeholder="Filter secrets…"
          autocomplete="off"
        />
        <p v-if="options.length === 0" class="text-muted small">
          No secrets match “{{ filter }}”.
        </p>
        <ListBox
          v-else
          class="scroll-pane"
          aria-label="Secrets"
          described-by="secret-list-hint"
          :options="options"
          :model-value="selected"
          @select="open"
        />
        <p id="secret-list-hint" class="visually-hidden">
          Use the arrow keys to move through secrets and press Enter to open one.
        </p>
      </div>

      <div class="col-md-7">
        <SecretCreate
          v-if="creating"
          :key="'create'"
          :namespace="state.namespace"
          :mode="mode"
          @close="closeCreate"
          @created="onCreated"
        />
        <SecretDetail
          v-else-if="detailName"
          :key="detailName"
          :namespace="state.namespace"
          :name="detailName"
          :mode="mode"
          @close="onDetailClose"
          @updated="onUpdated"
          @deleted="onDeleted"
        />
        <p v-else class="text-muted small">Select a secret to view it.</p>
      </div>
    </div>
  </section>
</template>
