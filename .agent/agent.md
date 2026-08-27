You are working on **qbi**, a desktop app for inspecting and lightly managing Kubernetes clusters.

## Purpose & Audience

- **Universal design.** qbi is built so **everyone** can use it: sighted mouse users, keyboard-only users, screen-reader users and people with colour-vision deficiencies alike. Accessibility is a feature, not a nicety and never comes at the expense of usability for the majority. Think Apple: every product works for every person.
- **Scope.** Inspection and light management: namespaces, pods, logs, events, workloads, networking, config maps, secrets, cronjobs. It is a focused tool, not a full cluster-management console, but covers the common read/write operations a developer needs day-to-day.

## Tech Stack

- **Backend:** Go (module `qbi`, Go 1.25) using `k8s.io/client-go` **v0.33.x** (pinned, do not bump past what Go 1.25 supports).
- **Desktop shell:** **Wails v2** (`github.com/wailsapp/wails/v2`). Go methods on the bound `Service` are callable from JS; use Wails runtime for events/dialogs. `wails dev`/`wails build` regenerate the `frontend/wailsjs/` bindings – the frontend calls through them, never through hand-written `window.go` code.
- **Frontend:** **Vue 3** (`<script setup>`) + **Vite** + **Bootstrap 5**. No state library – a small reactive singleton store.

## Architecture

Layers in dependency order:

```
internal/kube/    Pure Kubernetes client-go wrapper. NO Wails imports here.
  client.go         Connect/contexts, namespaces, pods, pod detail, secrets
  logs.go           Follow log streaming (LogOptions)
  networking.go     Services (+endpoints, DNS name), Ingresses
  events.go         Namespace events
  configmaps.go     ConfigMaps
  workloads.go      Deployments/StatefulSets/DaemonSets + rolling restart
  secrets_write.go  Secret update/delete (RetryOnConflict)
  resolve.go        Kubeconfig source resolution/status
  types.go          DTOs shared with the frontend (json-tagged)
service.go        Wails-bound API. Wraps kube calls, adds timeouts, confirmations,
                  log-stream lifecycle. This is the ONLY layer JS calls.
app.go            App state + Wails runtime context (a.ctx)
main.go           Wails entry point; embeds frontend/dist
settings.go       Persisted settings (kubeconfig path) in OS config dir
frontend/wailsjs/ Generated bindings (git-ignored; never edit by hand): one
                  named export per bound Service method + runtime helpers
                  (EventsOn/Off, BrowserOpenURL, ...).
frontend/src/
  api.js          THE ONLY bridge to the backend: imports the generated wailsjs
                  bindings and wraps each with friendlyError() so raw client-go
                  errors become short, actionable messages. camelCase aliases
                  over the generated PascalCase names.
  logging.js      Forwards uncaught JS errors to the backend (LogFrontend).
  store.js        Reactive singleton: connection, namespace, aria-live announce()
  App.vue         Layout, landmarks, ARIA tabs, panel routing
  components/     One component per view; ListBox.vue is the shared a11y listbox
```

**Data flow:** Vue component → `api.js` (friendly-error wrapper) → generated `frontend/wailsjs` binding → `Service` (adds timeout/confirm) → `internal/kube` → client-go. Results are plain DTOs from `types.go`. Never call client-go from Vue, never touch `window.go` outside `api.js` and never add Wails deps to `internal/kube`.

## Non‑Negotiable Design Principles

1. **Accessibility first.** Every interactive element is keyboard-operable and labelled. Follow WAI-ARIA APG patterns (see `ListBox.vue` roving-tabindex listbox, the tab pattern in `App.vue`). Manage focus on view changes (move focus to the new region's heading with `tabindex="-1"`). Announce status/errors through the single shared aria-live region via `store.announce()` – do **not** sprinkle new live regions. The log area is `role="log"` and is deliberately **not** aria-live (a fast stream would flood the reader).
2. **Semantic, not cluttered.** Prefer correct HTML semantics over ARIA and over decorative helper text. No warning/description spam.
3. **Safety for a real cluster.** Every write – create, update or delete of secrets, services, ingresses, cronjobs, deployments, namespaces and pods; workload restart, scale and delete – goes through an explicit confirmation (`Service.confirm`, robust to Windows returning native Yes/No). Secret values are masked until revealed; binary values are never mangled.
4. **Resilience.** All API calls are timeout-bounded (`Service.opCtx`, 30s) so a hung cluster never freezes the UI. `List` calls are capped (`listOptions`, 1000 items). Secret writes use `RetryOnConflict`.
5. **Sustainable simplicity.** This is a production-grade prototype; keep the architecture small and boring. Don't add a state library, a router or new abstractions for one-off needs.

## Conventions

### Commit Structure
- Format: `<scope>: <short description>`
- Examples:
  - `frontend: fix ListBox focus with tab navigation`
  - `backend: bump abc module version`
  - `fix def and add tests`

### Adding a Resource View
1. Add a client method + DTO in `internal/kube`.
2. Bind a method on `Service` (with `opCtx()` timeout).
3. Add one alias line in `api.js` (`name: wrap(Service.MethodName)`).
4. Build one component.

The wailsjs binding regenerates automatically.

### Testing

- Tests are required when you add a function, method or behaviour or change existing logic. Include or update tests.
- Run `go test ./...` and `cd frontend && npm run test` before marking work done.

### Code Style

- Keep Go DTOs `json`-tagged; the frontend consumes them directly.
- Vue: `<script setup>`, small focused components, reuse `ListBox.vue` for selectable lists; loading/error/empty states are always handled explicitly.

## Guardrails

- Do **not** import Wails into `internal/kube`.
- Do **not** widen write capabilities beyond the current set (secrets, services, ingresses, cronjobs, deployments, workloads, namespaces, pods) without an explicit confirmation flow.
- Do **not** regress accessibility (unlabelled controls, focus loss, colour-only signalling, chatty/duplicated announcements).
- Verify changes build: `go build ./...`, `go vet ./...` and `cd frontend && npm run build`.
