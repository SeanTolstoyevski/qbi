<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";
import { BrowserOpenURL } from "../../wailsjs/runtime/runtime.js";

const GITHUB_URL = "https://github.com/SeanTolstoyevski/qbi";

const info = ref(null);
const error = ref("");

onMounted(async () => {
  try {
    info.value = await api.buildInfo();
  } catch (e) {
    error.value = String(e);
  }
});

// The backend stamps RFC 3339 UTC ("2026-06-18T12:34:56Z"); show it in the
// user's locale. Unstamped (local/dev) builds return "unknown".
function formatBuildTime(raw) {
  if (!raw || raw === "unknown") return "";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString();
}

function openGitHub(e) {
  try {
    BrowserOpenURL(GITHUB_URL);
    // Only swallow navigation when the runtime actually handled the link.
    e.preventDefault();
  } catch {
    /* no Wails shell: let the anchor navigate normally */
  }
}
</script>

<template>
  <p class="lead" style="max-width: 32rem">
    QBI is a lightweight Kubernetes inspector: 100% open source &amp; 100%
    accessible.
  </p>

  <div v-if="error" class="alert alert-danger" role="alert">{{ error }}</div>

  <dl class="row" style="max-width: 32rem">
    <dt class="col-sm-3">Version</dt>
    <dd class="col-sm-9">{{ info?.version || "…" }}</dd>

    <dt class="col-sm-3">Build</dt>
    <dd class="col-sm-9">{{ info?.commit || "…" }}</dd>

    <dt class="col-sm-3">Built</dt>
    <dd class="col-sm-9">{{ formatBuildTime(info?.buildTime) || "…" }}</dd>
  </dl>

  <p class="mb-0">
    <a :href="GITHUB_URL" @click="openGitHub">
      SeanTolstoyevski/qbi on GitHub
    </a>
  </p>

  <h2 class="h6 mt-4 mb-2">Keyboard shortcuts</h2>
  <ul class="small mb-0" style="max-width: 32rem">
    <li>
      <kbd>Ctrl</kbd>+<kbd>1</kbd> to <kbd>4</kbd> - switch between Cluster,
      Namespace, Settings and About.
    </li>
    <li><kbd>Ctrl</kbd>+<kbd>E</kbd> - focus the namespace list.</li>
    <li>
      In the log viewer: <kbd>Ctrl</kbd>+<kbd>F</kbd> searches,
      <kbd>↑</kbd>/<kbd>↓</kbd> move between lines, <kbd>Ctrl</kbd>+<kbd>C</kbd>
      copies the focused line (or all when no line is focused),
      <kbd>Esc</kbd> closes the panel.
    </li>
    <li>
      In lists (namespaces, secrets, config maps): <kbd>↑</kbd>/<kbd>↓</kbd>
      move, <kbd>Enter</kbd> selects, type to jump to a matching name.
    </li>
  </ul>
</template>
