<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

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
  if (window.runtime?.BrowserOpenURL) {
    e.preventDefault();
    window.runtime.BrowserOpenURL(GITHUB_URL);
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
</template>
