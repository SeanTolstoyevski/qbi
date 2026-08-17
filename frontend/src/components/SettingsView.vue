<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";

const { state, announce, setAutoRefresh } = useStore();

const saving = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    const s = await api.getSettings();
    setAutoRefresh(s.autoRefresh);
  } catch (e) {
    error.value = String(e);
  }
});

async function toggleAutoRefresh() {
  const next = !state.autoRefresh;
  saving.value = true;
  error.value = "";
  try {
    await api.setAutoRefresh(next);
    setAutoRefresh(next);
    announce(next ? "Auto-refresh enabled." : "Auto-refresh disabled.");
  } catch (e) {
    error.value = String(e);
    announce(`Failed to save setting: ${error.value}`, "assertive");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="error" class="alert alert-danger" role="alert">{{ error }}</div>

  <div class="card mb-3" style="max-width: 32rem">
    <div class="card-body">
      <h3 class="card-title h6">Auto-refresh</h3>
      <p class="card-text text-body-secondary small mb-3">
        When enabled, QBI subscribes to live change events from the Kubernetes
        API server. The active view refreshes automatically and announces
        additions, modifications and deletions — no manual reload needed.
      </p>

      <div class="form-check form-switch">
        <input
          id="auto-refresh-toggle"
          class="form-check-input"
          type="checkbox"
          role="switch"
          :checked="state.autoRefresh"
          :disabled="saving"
          @change="toggleAutoRefresh"
        />
        <label class="form-check-label" for="auto-refresh-toggle">
          {{ state.autoRefresh ? "Enabled" : "Disabled" }}
          <span v-if="saving" class="visually-hidden"> — saving…</span>
        </label>
      </div>
    </div>
  </div>
</template>
