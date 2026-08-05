# QBI - Kubernetes Inspector

You are working on **qbi**, an accessible desktop app for **inspecting and lightly
managing Kubernetes clusters**.

## Purpose & audience

- Primary user: a **visually impaired backend developer** who navigates by
  **keyboard and screen reader**. Accessibility is a feature, not a nicety.
- Scope: **observation-first** (namespaces, pods, logs, events, workloads,
  networking, config maps, secrets).
- It is a focused inspection tool, **not** a full cluster-management console.

## Tech stack

- **Backend:** Go (module `qbi`, Go 1.25) using `k8s.io/client-go` **v0.33.x**
  (pinned — do not bump past what Go 1.25 supports).
- **Desktop shell:** **Wails v2** (`github.com/wailsapp/wails/v2`). Go methods on
  the bound `Service` are callable from JS; use Wails runtime for events/dialogs.
- **Frontend:** **Vue 3** (`<script setup>`) + **Vite** + **Bootstrap 5**. No
  state library — a small reactive singleton store.

## Architecture (layers, in dependency order)

```
internal/kube/   Pure Kubernetes client-go wrapper. NO Wails imports here.
  client.go        Connect/contexts, namespaces, pods, pod detail, secrets(read)
  logs.go          Follow log streaming (LogOptions)
  networking.go    Services (+endpoints, DNS name), Ingresses
  events.go        Namespace events
  configmaps.go    ConfigMaps
  workloads.go     Deployments/StatefulSets/DaemonSets + rolling restart
  secrets_write.go Secret update/delete (RetryOnConflict)
  resolve.go       Kubeconfig source resolution/status
  types.go         DTOs shared with the frontend (json-tagged)
service.go       Wails-bound API. Wraps kube calls, adds timeouts, confirmations,
                 log-stream lifecycle. This is the ONLY layer JS calls.
app.go           App state + Wails runtime context (a.ctx)
main.go          Wails entry point; embeds frontend/dist
settings.go      Persisted settings (kubeconfig path) in OS config dir
frontend/src/
  api.js         Thin wrapper over window.go.main.Service + runtime events
  store.js       Reactive singleton: connection, namespace, aria-live announce()
  App.vue        Layout, landmarks, ARIA tabs, panel routing
  components/     One component per view; ListBox.vue is the shared a11y listbox
```

**Data flow:** Vue component → `api.js` → Wails binding → `Service` (adds
timeout/confirm) → `internal/kube` → client-go. Results are plain DTOs from
`types.go`. Never call client-go from Vue or add Wails deps to `internal/kube`.

## Non-negotiable design principles

1. **Accessibility first.** Every interactive element is keyboard-operable and
   labelled. Follow WAI-ARIA APG patterns (see `ListBox.vue` roving-tabindex
   listbox, the tab pattern in `App.vue`). Manage focus on view changes (move
   focus to the new region's heading with `tabindex="-1"`). Announce status/
   errors through the single shared aria-live region via `store.announce()` —
   do **not** sprinkle new live regions. The log area is `role="log"` and is
   deliberately **not** aria-live (a fast stream would flood the reader).
2. **Semantic, not cluttered.** Prefer correct HTML semantics over ARIA and over
   decorative helper text. No warning/description spam.
3. **Safety for a real cluster.** Every write (secret edit/delete, workload
   restart) goes through an explicit confirmation (`Service.confirm`, which is
   robust to Windows returning native Yes/No). Everything else is read-only.
   Secret values are masked until revealed; binary values are never mangled.
4. **Resilience.** All API calls are timeout-bounded (`Service.opCtx`, 30s) so a
   hung cluster never freezes the UI. `List` calls are capped (`listOptions`,
   1000 items). Secret writes use `RetryOnConflict`.
5. **Sustainable simplicity.** This is a production-grade prototype; keep the
   architecture small and boring. Don't add a state library, a router, or new
   abstractions for one-off needs.

## Conventions

- **Adding a resource view** = add a client method + DTO in `internal/kube`,
  bind a method on `Service` (with `opCtx()` timeout), expose it in `api.js`,
  build one component, and register a tab in `App.vue` (`tabs` array + panel).
- Keep Go DTOs `json`-tagged; the frontend consumes them directly.
- Vue: `<script setup>`, small focused components, reuse `ListBox.vue` for
  selectable lists; loading/error/empty states are always handled explicitly.
- Comments explain **why**, not what. Match the existing terse, purposeful style.

## Guardrails

- Do **not** import Wails into `internal/kube`.
- Do **not** widen write capabilities beyond secrets + workload restart without
  an explicit confirmation flow.
- Do **not** regress accessibility (unlabelled controls, focus loss, colour-only
  signalling, chatty/duplicated announcements).
- Verify changes build: `go build ./...`, `go vet ./...`, and
  `cd frontend && npm run build`.

