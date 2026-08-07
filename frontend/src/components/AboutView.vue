<script setup>
import { ref, onMounted } from "vue";
import { api } from "../api.js";

const GITHUB_URL = "https://github.com/SeanTolstoyevski/qbi";

// Version/commit come from the Go build (injected from the VERSION file at
// release time via -ldflags; "dev"/"unknown" on local builds). Exposed here so
// users can report exactly which build they are running.
const version = ref("");
const commit = ref("");
const error = ref("");

onMounted(async () => {
  try {
    version.value = await api.version();
    commit.value = await api.commit();
  } catch (e) {
    error.value = String(e);
  }
});

// Open the repository in the system browser. The Wails webview cannot leave
// the app, so route through the runtime; fall back to plain navigation when
// the runtime is unavailable (e.g. in tests or the Vite dev browser).
function openGitHub(e) {
  if (window.runtime?.BrowserOpenURL) {
    e.preventDefault();
    window.runtime.BrowserOpenURL(GITHUB_URL);
  }
}
</script>

<template>
  <section aria-labelledby="about-heading">
    <h2 id="about-heading" tabindex="-1">About</h2>

    <div v-if="error" class="alert alert-danger" role="alert">{{ error }}</div>

    <dl class="row" style="max-width: 32rem">
      <dt class="col-sm-3">Application</dt>
      <dd class="col-sm-9">QBI</dd>

      <dt class="col-sm-3">Version</dt>
      <dd class="col-sm-9">{{ version || "…" }}</dd>

      <dt class="col-sm-3">Build</dt>
      <dd class="col-sm-9">{{ commit || "…" }}</dd>
    </dl>

    <!-- The application description text will be added here by the user.
         For now, link to the project's source on GitHub. -->
    <p class="mb-0">
      <a :href="GITHUB_URL" @click="openGitHub">
        SeanTolstoyevski/qbi on GitHub
      </a>
    </p>
  </section>
</template>
