import { onMounted, onUnmounted } from "vue";
import { onEvent } from "./api.js";

/*
 * Subscribe to a Kubernetes watch event, coalescing bursts into a single
 * reload and a single announcement.
 *
 * A busy cluster (autoscaling, CI/CD) can emit many ADDED/DELETED events in a
 * second; reloading and announcing per event would hammer the API server and
 * flood a screen reader. We buffer events for a short window, then reload once
 * and let the caller summarize the whole batch.
 *
 * Usage:
 *   useWatch("watch:pods", {
 *     reload: load,
 *     summarize: (batch) => announce(watchAnnouncement("Pod", "pods", batch)),
 *   });
 */
const BATCH_WINDOW = 300; // ms to wait for more events before flushing

export function useWatch(eventName, { reload, summarize }) {
  let unsub = () => {};
  let timer = null;
  const events = [];

  onMounted(() => {
    unsub = onEvent(eventName, (ev) => {
      events.push(ev);
      clearTimeout(timer);
      timer = setTimeout(flush, BATCH_WINDOW);
    });
  });

  onUnmounted(() => {
    clearTimeout(timer);
    unsub();
  });

  function flush() {
    const batch = events.splice(0);
    if (batch.length && summarize) summarize(batch);
    reload();
  }
}

// Build a "1 Pod web-abc12 added" / "3 pods added" style announcement from a
// batch of watch events for a single resource kind.
export function watchAnnouncement(label, plural, batch) {
  const added = batch.filter((e) => e.type === "ADDED");
  const deleted = batch.filter((e) => e.type === "DELETED");
  const parts = [];
  if (added.length === 1) parts.push(`${label} ${added[0].name} added.`);
  else if (added.length > 1) parts.push(`${added.length} ${plural} added.`);
  if (deleted.length === 1) parts.push(`${label} ${deleted[0].name} deleted.`);
  else if (deleted.length > 1)
    parts.push(`${deleted.length} ${plural} deleted.`);
  return parts.join(" ");
}
