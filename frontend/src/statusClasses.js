/*
 * Shared badge color mapping for resource health states.
 *
 * One palette, one meaning: green = healthy, red = failed/unhealthy,
 * amber = unknown/attention, gray = neutral. Keeping the mapping in one
 * module stops views from drifting (a Failed pod used to be gray while a
 * NotReady node was red — the same concept, three colors).
 */

// Pod phase (k8s status.phase): Pending, Running, Succeeded, Failed, Unknown.
export function phaseBadgeClass(phase) {
  switch (phase) {
    case "Running":
      return "text-bg-success";
    case "Failed":
      return "text-bg-danger";
    case "Unknown":
      return "text-bg-warning";
    default:
      return "text-bg-secondary";
  }
}

// Node status: Ready | NotReady | Unknown (see internal/kube/types.go).
export function nodeStatusBadgeClass(status) {
  switch (status) {
    case "Ready":
      return "text-bg-success";
    case "NotReady":
      return "text-bg-danger";
    default:
      return "text-bg-warning"; // Unknown
  }
}

// Job status (k8s Job condition): Complete, Failed, Suspended, else.
export function jobStatusBadgeClass(status) {
  switch (status) {
    case "Complete":
      return "text-bg-success";
    case "Failed":
      return "text-bg-danger";
    case "Suspended":
      return "text-bg-warning";
    default:
      return "text-bg-secondary"; // Running, unknown
  }
}

// Container readiness: ready = healthy, not ready = attention.
export function containerReadyBadgeClass(ready) {
  return ready ? "text-bg-success" : "text-bg-warning";
}
