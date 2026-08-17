<script setup>
import { ref, computed, watch } from "vue";
import { api } from "../api.js";
import { useWatch, watchAnnouncement } from "../useWatch.js";
import { useStore } from "../store.js";
import ListBox from "./ListBox.vue";
import InlineButton from "./InlineButton.vue";

const { state, announce } = useStore();

const configmaps = ref([]);
const loading = ref(false);
const error = ref("");
const filter = ref("");
const selected = ref(null);

const detail = ref(null);
const detailLoading = ref(false);

async function load() {
  if (!state.namespace) return;
  loading.value = true;
  error.value = "";
  detail.value = null;
  selected.value = null;
  try {
    const list = await api.listConfigMaps(state.namespace);
    configmaps.value = list || [];
    announce(`${configmaps.value.length} config maps in ${state.namespace}.`);
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load config maps: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

const options = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return configmaps.value
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .map((c) => ({
      value: c.name,
      label: c.name,
      description: `${c.keys.length} keys · ${c.age}`,
    }));
});

async function open(name) {
  selected.value = name;
  detailLoading.value = true;
  try {
    detail.value = await api.getConfigMap(state.namespace, name);
    announce(
      `Config map ${name} opened with ${detail.value.entries.length} keys.`,
    );
  } catch (e) {
    error.value = String(e);
    announce(`Failed to open config map: ${error.value}`, "assertive");
  } finally {
    detailLoading.value = false;
  }
}

watch(() => [state.namespace, state.connectionEpoch], load, {
  immediate: true,
});

useWatch("watch:configmaps", {
  reload: load,
  summarize: (batch) =>
    announce(watchAnnouncement("ConfigMap", "config maps", batch)),
});

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="cm-heading">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="cm-heading" class="h5 mb-0">
        Config maps<span v-if="state.namespace"> in {{ state.namespace }}</span>
      </h2>
      <button
        type="button"
        class="btn btn-sm btn-outline-secondary"
        :disabled="loading || !state.namespace"
        @click="load"
      >
        <span class="visually-hidden">Refresh config maps</span>
        <i class="bi bi-arrow-clockwise" aria-hidden="true"></i>
      </button>
    </div>

    <p v-if="!state.namespace" class="text-muted small">
      Select a namespace to list its config maps.
    </p>
    <p v-else-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>
    <p v-else-if="configmaps.length === 0" class="text-muted small">
      No config maps found.
    </p>

    <div v-else class="row g-3">
      <div class="col-md-5 d-flex flex-column">
        <label for="cm-filter" class="visually-hidden"
          >Filter config maps</label
        >
        <input
          id="cm-filter"
          v-model="filter"
          type="search"
          class="form-control form-control-sm mb-2"
          placeholder="Filter config maps…"
          autocomplete="off"
        />
        <p v-if="options.length === 0" class="text-muted small">
          No config maps match “{{ filter }}”.
        </p>
        <ListBox
          v-else
          class="scroll-pane"
          aria-label="Config maps"
          described-by="cm-list-hint"
          :options="options"
          :model-value="selected"
          @select="open"
        />
        <p id="cm-list-hint" class="visually-hidden">
          Use the arrow keys to move through config maps and press Enter to open
          one.
        </p>
      </div>

      <div class="col-md-7">
        <div v-if="detailLoading" role="status" class="text-muted small">
          Loading…
        </div>
        <div v-else-if="detail" aria-live="polite">
          <h3 class="h6">{{ detail.name }}</h3>
          <dl>
            <div
              v-for="entry in detail.entries"
              :key="entry.key"
              class="mb-3 border rounded p-2 hover-reveal"
            >
              <dt class="d-flex align-items-center justify-content-between">
                <span>{{ entry.key }}</span>
                <InlineButton
                  v-if="!entry.isBinary"
                  variant="inline"
                  :copy-text="entry.value"
                  announce="Value"
                  :title="`Copy ${entry.key}`"
                />
              </dt>
              <dd class="mb-0 mt-1">
                <code v-if="entry.isBinary" class="text-body-secondary">{{
                  entry.value
                }}</code>
                <pre v-else class="mb-0 log-view" style="max-height: 20rem">{{
                  entry.value
                }}</pre>
              </dd>
            </div>
          </dl>
        </div>
        <p v-else class="text-muted small">
          Select a config map to view its contents.
        </p>
      </div>
    </div>
  </section>
</template>
