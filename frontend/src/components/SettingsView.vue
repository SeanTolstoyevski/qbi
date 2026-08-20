<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";
import { useStore } from "../store.js";

const { state, announce, setAutoRefresh, setExperimental } = useStore();

const THEME_KEY = "qba.theme"; // frontend-only preference: no backend round-trip
const darkMode = ref(localStorage.getItem(THEME_KEY) === "dark");

function applyTheme(dark) {
  if (dark) {
    document.documentElement.setAttribute("data-bs-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-bs-theme");
  }
}

function toggleDarkMode(e) {
  const dark = e.target.checked;
  darkMode.value = dark;
  applyTheme(dark);
  try {
    localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
  } catch {
    /* storage may be unavailable; remembering is best-effort */
  }
  announce(dark ? "Dark mode enabled." : "Dark mode disabled.");
}

const saving = ref(false);
const error = ref("");

onMounted(async () => {
  try {
    const s = await api.getSettings();
    setAutoRefresh(s.autoRefresh);
    setExperimental(!!s.experimental);
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

async function toggleExperimental() {
  const next = !state.experimental;
  saving.value = true;
  error.value = "";
  try {
    await api.setExperimental(next);
    setExperimental(next);
    announce(next ? "Experimental features enabled." : "Experimental features disabled.");
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
      <h3 class="card-title h6">Appearance</h3>
      <p class="card-text text-body-secondary small mb-3">
        Dark mode reduces glare during long sessions. The choice is saved on
        this computer and applies to the whole app.
      </p>

      <div class="form-check form-switch">
        <input
          id="dark-mode-toggle"
          class="form-check-input"
          type="checkbox"
          role="switch"
          :checked="darkMode"
          @change="toggleDarkMode"
        />
        <label class="form-check-label" for="dark-mode-toggle">
          {{ darkMode ? "Enabled" : "Disabled" }}
        </label>
      </div>
    </div>
  </div>

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

  <div class="card mb-3" style="max-width: 32rem">
    <div class="card-body">
      <h3 class="card-title h6">Experimental features</h3>
      <p class="card-text text-body-secondary small mb-3">
        Experimental features are early, optional tools that are still being
        evaluated. They may change or disappear in a future version without
        notice.
      </p>

      <div class="form-check form-switch">
        <input
          id="experimental-toggle"
          class="form-check-input"
          type="checkbox"
          role="switch"
          :checked="state.experimental"
          :disabled="saving"
          @change="toggleExperimental"
        />
        <label class="form-check-label" for="experimental-toggle">
          {{ state.experimental ? "Enabled" : "Disabled" }}
          <span v-if="saving" class="visually-hidden"> — saving…</span>
        </label>
      </div>
    </div>
  </div>
</template>
