<script setup>
import { ref, computed, watch } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";
import { copyToClipboard } from "../clipboard.js";

const { state, announce } = useStore();

const events = ref([]);
const loading = ref(false);
const error = ref("");
const warningsOnly = ref(false);
const filter = ref("");

async function load() {
  if (!state.namespace) return;
  loading.value = true;
  error.value = "";
  try {
    const list = await api.listEvents(state.namespace);
    events.value = list || [];
    const warnings = events.value.filter((e) => e.type === "Warning").length;
    announce(
      `${events.value.length} events in ${state.namespace}, ${warnings} warnings.`,
    );
  } catch (e) {
    error.value = String(e);
    announce(`Failed to load events: ${error.value}`, "assertive");
  } finally {
    loading.value = false;
  }
}

const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return events.value.filter((e) => {
    if (warningsOnly.value && e.type !== "Warning") return false;
    if (!q) return true;
    return (
      (e.reason || "").toLowerCase().includes(q) ||
      (e.message || "").toLowerCase().includes(q) ||
      (e.object || "").toLowerCase().includes(q) ||
      (e.component || "").toLowerCase().includes(q)
    );
  });
});

// Reload on namespace changes and on every (re)connect: reconnecting to the
// same context leaves the namespace unchanged, so the epoch is what forces
// the fresh load. load() itself guards on state.namespace.
watch(() => [state.namespace, state.connectionEpoch], load, {
  immediate: true,
});

defineExpose({ load });
</script>

<template>
  <section aria-labelledby="events-heading">
    <div class="d-flex align-items-center justify-content-between mb-2">
      <h2 id="events-heading" class="h6 mb-0">
        Events<span v-if="state.namespace"> in {{ state.namespace }}</span>
      </h2>
      <div class="d-flex align-items-center gap-2">
        <div class="form-check form-switch mb-0">
          <input
            id="warnings-only"
            v-model="warningsOnly"
            class="form-check-input"
            type="checkbox"
          />
          <label class="form-check-label small" for="warnings-only"
            >Warnings only</label
          >
        </div>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          :disabled="loading || !state.namespace"
          @click="load"
        >
          <span class="visually-hidden">Refresh activity</span>
          <span aria-hidden="true">⟳</span>
        </button>
      </div>
    </div>

    <p v-if="!state.namespace" class="text-muted small">
      Select a namespace to view its activity.
    </p>
    <p v-else-if="loading" class="text-muted small" role="status">Loading…</p>
    <p v-else-if="error" class="text-danger small" role="alert">{{ error }}</p>

    <template v-else>
      <!-- Events are a short-lived window: the API server drops them after
           about an hour, so a quiet namespace legitimately shows nothing. The
           honest empty state below says so instead of looking broken. Durable
           change history (rollouts) lives in the Workloads view, not here. -->
      <h3 class="h6 text-body-secondary mb-1">Events</h3>
      <p class="text-body-secondary small mb-2">
        Kubernetes keeps events for about an hour; only recent activity is
        available here.
      </p>
      <label for="event-filter" class="visually-hidden">Filter events</label>
      <input
        id="event-filter"
        v-model="filter"
        type="search"
        class="form-control form-control-sm mb-2"
        placeholder="Filter events…"
        autocomplete="off"
      />
      <p v-if="shown.length === 0" class="text-muted small">
        <template v-if="filter">No events match “{{ filter }}”.</template>
        <template v-else-if="warningsOnly">No warning events.</template>
        <template v-else
          >No events in the last hour. For change history, see
          Workloads.</template
        >
      </p>

      <table
        v-if="shown.length"
        class="table table-sm table-hover align-middle"
      >
        <caption class="visually-hidden">
          Events in namespace
          {{
            state.namespace
          }}, most recent first
        </caption>
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Reason</th>
            <th scope="col">Object</th>
            <th scope="col">Message</th>
            <th scope="col">Source</th>
            <th scope="col">Count</th>
            <th scope="col">First seen</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(e, i) in shown"
            :key="i"
            :class="{ 'table-warning': e.type === 'Warning' }"
          >
            <td>
              <span
                class="badge"
                :class="
                  e.type === 'Warning' ? 'text-bg-warning' : 'text-bg-secondary'
                "
                >{{ e.type }}</span
              >
            </td>
            <td>{{ e.reason }}</td>
            <td>
              <code class="small">{{ e.object }}</code>
            </td>
            <td>
              {{ e.message }}
              <button
                type="button"
                class="btn btn-link btn-sm p-0 ms-1 align-baseline"
                @click="copyToClipboard(e.message, 'Event message')"
              >
                Copy<span class="visually-hidden"> event message</span>
              </button>
            </td>
            <td class="small text-body-secondary">{{ e.component || "—" }}</td>
            <td>{{ e.count }}</td>
            <td>{{ e.firstSeen || "—" }}</td>
            <td>{{ e.lastSeen }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </section>
</template>
