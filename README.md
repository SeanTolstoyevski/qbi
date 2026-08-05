# qbi —  another Kubernetes inspector

`qbi` is a lightweight desktop application for **inspecting** Kubernetes
clusters: browsing namespaces, viewing pods, streaming container logs, and
reading secrets. It is built for keyboard and screen-reader users first.

It is focused on observation and light secret management — not a full
cluster-management console. Everything except secret editing is read-only.

## Why

Terminal `kubectl` workflows are verbose and awkward with assistive technology,
and existing GUI tools have weak accessibility. `qbi` aims for a small,
semantic, fully keyboard-navigable interface.

## Features

- Pick any context from your kubeconfig and connect.
- List namespaces and select one.
- View pods with readiness, phase, restarts and age.
- Inspect a pod in detail (IP, node, container states/restart reasons,
  conditions and labels).
- Stream a container's logs live (with stop / restart / clear / auto-scroll).

### Workloads

- Deployments, StatefulSets and DaemonSets with ready / up-to-date / available
  replica counts and container images; degraded workloads are highlighted.
- Trigger a **rolling restart** of a workload (the equivalent of
  `kubectl rollout restart`) — with an explicit confirmation prompt.

### Events

- Namespace events (most recent first) for diagnosing scheduling failures,
  image pull errors, crash loops and probe failures — with a warnings-only
  filter.

### Config maps

- List config maps and view their full contents, with copy-to-clipboard.

### Networking

For each namespace, view the network wiring that matters when debugging
connectivity or DNS:

- **Services** — in-cluster DNS name (`<svc>.<ns>.svc.cluster.local`), type,
  ClusterIP, external IPs, ports, and pod selector.
- **Endpoints** — the actual pod IPs currently backing each service (with a
  clear warning when a service has no ready endpoints).
- **Ingresses** — external address(es), TLS hosts with the certificate
  secrets that serve them, and host → path → backend service routing rules.
  Every backend is health-checked, and problems are spelled out in plain
  language: no load-balancer address assigned yet, TLS secret missing from
  the namespace, backend service not found, or no ready endpoints. The
  list shows an issue badge per ingress; the **Inspect** panel adds the
  full issue list, annotations (nginx/cert-manager and friends), default
  backend, the ingress's own events, and a YAML view. Ingresses can be
  **deleted** (from the list or the Inspect panel) behind the same native
  confirmation used for other writes — only the routing rules are removed,
  the services and pods they pointed to keep running.

### Secrets

- List secrets and reveal/copy individual decoded values on demand.
- Edit secrets: change values, add or remove keys, or delete a secret
  entirely — each write goes through an explicit confirmation step.

### Log investigation

Built for incident response, the log viewer supports:

- **Search** with plain text or **regex**, optional case-sensitivity, live
  match count, and next/previous match navigation (`Enter` / `Shift+Enter`).
- **Only matches** filter to collapse the view to matching lines.
- **Timestamps** toggle (RFC3339 per line).
- **Previous (crashed) instance** logs — the equivalent of `kubectl logs -p`,
  essential for post-crash diagnosis.
- Adjustable **history** (tail 100 / 500 / 1000 / all).
- **Save…** the current view to a `.log` file, or **Copy** it to the clipboard.
- **Wrap** / auto-scroll toggles.

## Accessibility highlights

- Single, high-contrast focus ring on every interactive element.
- Skip-to-content link.
- Landmark regions (`header`, `nav`, `main`) and proper headings.
- Status and errors announced via a polite/assertive `aria-live` region,
  without stealing focus.
- Semantic ARIA tabs, listboxes and a `role="log"` output region.
- Respects `prefers-reduced-motion`.
- Secret values are hidden by default and revealed intentionally.

## Keyboard

| Where | Keys | Action |
| --- | --- | --- |
| Namespace / secret lists | `↑` `↓` | Move between items |
| Namespace / secret lists | `Home` / `End` | First / last item |
| Namespace / secret lists | type letters | Jump to a matching item (type-ahead) |
| Namespace / secret lists | `Enter` / `Space` | Select the focused item |
| Tabs (Pods / Secrets) | `←` `→` `Home` `End` | Switch tab |
| Anywhere | `Tab` / `Shift+Tab` | Move between regions and controls |

Choosing **Logs** for a pod moves focus into the log panel. Pods with a single
container open their logs directly; pods with several show a container chooser.

## Requirements

- [Go](https://go.dev/dl/) 1.25+
- [Node.js](https://nodejs.org/) 18+
- [Wails CLI](https://wails.io/) v2: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- A valid `~/.kube/config` (or `KUBECONFIG`) pointing at the cluster(s) you
  want to inspect.

## Development

```bash
# From the project root, run the app with hot reload:
wails dev
```

`wails dev` installs the frontend dependencies, starts Vite, and launches the
desktop window.

## Production build

```bash
wails build
# Output binary lands in build/bin/
```

## Architecture

```
main.go            Wails entry point, embeds the built frontend
app.go             App state + Wails runtime context
service.go         Frontend-facing API (bound to JS) + log-stream lifecycle
internal/kube/     Kubernetes client-go wrapper (no Wails dependency)
  types.go         DTOs shared with the frontend
  client.go        Contexts, namespaces, pods, secrets
  logs.go          Follow log streaming
frontend/          Vue 3 + Vite + Bootstrap 5
  src/api.js       Wraps the Wails-injected bindings
  src/store.js     Small reactive store (connection, namespace, announcements)
  src/components/  ContextBar, NamespaceList, PodList, SecretList, LogViewer
```

The `internal/kube` package has no knowledge of Wails, so it can be reused or
tested independently. Log streaming pushes lines to the frontend via Wails
events (`log:<key>`), keeping the UI responsive.

## Security notes

- The app is read-only except for two explicit actions: **editing/deleting
  secrets** and **triggering a rolling restart** of a workload.
- Every write (secret change, secret delete, workload restart) requires an
  explicit confirmation step in the UI.
- Restarting a workload does not delete or force-kill pods; it stamps the pod
  template so the controller rolls out replacements gradually, honouring the
  workload's own update strategy and availability guarantees.
- Secret values stay in memory and are only decoded when a secret is opened.
- Binary secret values cannot be edited as text and are preserved untouched
  when saving other keys.
- No data is sent anywhere except between the app and your Kubernetes API
  server using your existing kubeconfig credentials.

## License

TBD — intended to be open-sourced once past the prototype stage.
