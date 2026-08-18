import { createApp } from "vue";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./style.css";
import App from "./App.vue";
import { forwardError, initErrorForwarding } from "./logging";

// Apply the persisted theme BEFORE mount so the window never flashes the
// light theme; the toggle lives in Settings and writes localStorage.
try {
  if (localStorage.getItem("qba.theme") === "dark") {
    document.documentElement.setAttribute("data-bs-theme", "dark");
  }
} catch {
  /* storage may be unavailable; the light theme is a fine fallback */
}

const app = createApp(App);
app.config.errorHandler = (err) => {
  forwardError("error", err?.message ?? String(err), err?.stack ?? "");
};
initErrorForwarding();
app.mount("#app");
