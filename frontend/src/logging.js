import { LogFrontend } from "../wailsjs/go/main/Service.js";

const MAX_FORWARDED = 100;
let forwarded = 0;

export function forwardError(level, message, stack) {
  if (forwarded >= MAX_FORWARDED) return;
  try {
    // Throws synchronously when no Wails shell injected window.go — only
    // count attempts that actually reached the backend.
    const p = LogFrontend(
      level,
      String(message ?? "").slice(0, 2000),
      String(stack ?? "").slice(0, 4000),
    );
    forwarded += 1;
    p.catch(() => {});
  } catch {
    // Error reporting must never take the app down with it.
  }
}

export function initErrorForwarding() {
  window.addEventListener("error", (e) => {
    forwardError(
      "error",
      e.message,
      e.error?.stack ?? `${e.filename}:${e.lineno}`,
    );
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    forwardError(
      "error",
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : "",
    );
  });
}
