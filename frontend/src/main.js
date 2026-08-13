import { createApp } from "vue";
import "bootstrap/dist/css/bootstrap.min.css";
import "bootstrap-icons/font/bootstrap-icons.css";
import "./style.css";
import App from "./App.vue";
import { forwardError, initErrorForwarding } from "./logging";

const app = createApp(App);
app.config.errorHandler = (err) => {
  forwardError("error", err?.message ?? String(err), err?.stack ?? "");
};
initErrorForwarding();
app.mount("#app");
