package main

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"qbi/internal/kube"
	"qbi/internal/version"

	"github.com/wailsapp/wails/v2/pkg/runtime"
	corev1 "k8s.io/api/core/v1"
)

// Service is the API surface bound to the frontend. Every exported method is
// callable from JavaScript via the generated Wails bindings.
type Service struct {
	app *App

	mu      sync.Mutex
	streams map[string]func()

	watcher *kube.Watcher
}

// NewService creates the frontend-facing service.
func NewService(app *App) *Service {
	s := &Service{app: app, streams: make(map[string]func())}
	s.watcher = kube.NewWatcher(app.kube, s.emitWatchEvent)
	return s
}

// Version returns the semantic version of QBI (e.g. "0.2.0"). It is injected
// at build time from the VERSION file; see internal/version.
func (s *Service) Version() string {
	return version.Version
}

// Commit returns the git commit this build was produced from, injected at
// build time; "unknown" for non-release builds.
func (s *Service) Commit() string {
	return version.Commit
}

// AppSettings is the settings payload exchanged with the frontend.
type AppSettings struct {
	AutoRefresh bool `json:"autoRefresh"`
}

// GetSettings returns the current persisted settings.
func (s *Service) GetSettings() AppSettings {
	st := loadSettings()
	return AppSettings{AutoRefresh: st.AutoRefresh}
}

// SetAutoRefresh persists the auto-refresh preference and starts or stops the
// background watch streams accordingly.
func (s *Service) SetAutoRefresh(enabled bool) error {
	st := loadSettings()
	st.AutoRefresh = enabled
	if err := saveSettings(st); err != nil {
		return s.opErr("SetAutoRefresh", err)
	}
	if !enabled {
		s.watcher.Stop()
	}
	return nil
}

// SetWatchNamespace (re)starts namespace-scoped watch streams for the given
// namespace. Called by the frontend whenever the active namespace changes.
// Has no effect when auto-refresh is disabled.
func (s *Service) SetWatchNamespace(namespace string) {
	st := loadSettings()
	if !st.AutoRefresh || namespace == "" {
		return
	}
	s.watcher.Start(namespace)
}

// Shutdown stops background watchers when the app closes. Log streams ride on
// the Wails app context and are cancelled with it, so only the watcher needs
// an explicit stop here.
func (s *Service) Shutdown() {
	s.watcher.Stop()
}

// emitWatchEvent translates a kube.WatchEvent into a Wails runtime event so
// that frontend views can react to cluster changes in real time.
func (s *Service) emitWatchEvent(ev kube.WatchEvent) {
	// Map the kind to a stable event name that the frontend subscribes to.
	var topic string
	switch ev.Kind {
	case "Pod":
		topic = "watch:pods"
	case "Deployment", "StatefulSet", "DaemonSet":
		topic = "watch:workloads"
	case "Service":
		topic = "watch:services"
	case "Ingress":
		topic = "watch:ingresses"
	case "ConfigMap":
		topic = "watch:configmaps"
	case "Secret":
		topic = "watch:secrets"
	case "Namespace":
		topic = "watch:namespaces"
	case "Node":
		topic = "watch:nodes"
	default:
		return
	}
	runtime.EventsEmit(s.app.ctx, topic, ev)
}

// Kubeconfig reports which kubeconfig file the app will use and whether it
// currently resolves to a readable file.
func (s *Service) Kubeconfig() kube.KubeconfigStatus {
	return s.app.kube.Status()
}

// SelectKubeconfig opens a native file picker so the user can choose a
// kubeconfig (.yml/.yaml) file. The chosen path is applied and persisted. It
// returns the resulting status; if the user cancels, the status is unchanged.
func (s *Service) SelectKubeconfig() (kube.KubeconfigStatus, error) {
	path, err := runtime.OpenFileDialog(s.app.ctx, runtime.OpenDialogOptions{
		Title: "Select a kubeconfig file",
		Filters: []runtime.FileFilter{
			{DisplayName: "Kubeconfig (*.yml;*.yaml;config)", Pattern: "*.yml;*.yaml;config"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return kube.KubeconfigStatus{}, s.opErr("SelectKubeconfig", err)
	}
	if path == "" {
		// User cancelled; report the current status without changes.
		return s.app.kube.Status(), nil
	}
	return s.SetKubeconfig(path)
}

// SetKubeconfig pins the app to a specific kubeconfig file path and persists
// the choice for future launches. An empty path restores default resolution.
func (s *Service) SetKubeconfig(path string) (kube.KubeconfigStatus, error) {
	s.app.kube.SetKubeconfigPath(path)
	if err := saveSettings(settings{KubeconfigPath: path}); err != nil {
		// Persisting is best-effort; the in-memory choice still applies.
		slog.Warn("could not persist kubeconfig path", "error", err)
	}
	return s.app.kube.Status(), nil
}

// ListContexts returns every context in the user's kubeconfig.
func (s *Service) ListContexts() ([]kube.ContextInfo, error) {
	contexts, err := s.app.kube.Contexts()
	return contexts, s.opErr("ListContexts", err)
}

// Connect activates the given context (empty selects the current-context).
func (s *Service) Connect(contextName string) (kube.ContextInfo, error) {
	info, err := s.app.kube.Connect(contextName)
	return info, s.opErr("Connect", err)
}

// opCtx returns a context bounded by a timeout for a single API operation, so
// an unreachable or hanging API server surfaces an error instead of freezing
// the UI indefinitely. Callers must defer the returned cancel func.
func (s *Service) opCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(s.app.ctx, 30*time.Second)
}

// opErr logs a failed service call and returns the error unchanged, so every
// backend failure the frontend sees is also recorded for later debugging.
// The logging package redacts sensitive values before they reach a log file.
func (s *Service) opErr(op string, err error) error {
	if err != nil {
		slog.Error("service call failed", "op", op, "error", err)
	}
	return err
}

// LogFrontend records an error report from the frontend (uncaught JS
// exceptions, unhandled promise rejections). It goes through the same
// redacting pipeline as everything else, so it cannot leak cluster data.
func (s *Service) LogFrontend(level, message, stack string) error {
	lvl := slog.LevelError
	switch strings.ToLower(level) {
	case "error":
	case "warn", "warning":
		lvl = slog.LevelWarn
	case "info":
		lvl = slog.LevelInfo
	default:
		return fmt.Errorf("invalid log level %q", level)
	}
	// Truncate on rune boundaries: byte-slicing could split a UTF-8 char.
	if r := []rune(message); len(r) > 8000 {
		message = string(r[:8000])
	}
	if r := []rune(stack); len(r) > 8000 {
		stack = string(r[:8000])
	}
	slog.Log(context.Background(), lvl, message, "source", "frontend", "stack", stack)
	return nil
}

// ListNamespaces returns namespaces for the connected cluster.
func (s *Service) ListNamespaces() ([]kube.NamespaceInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	ns, err := s.app.kube.Namespaces(ctx)
	return ns, s.opErr("ListNamespaces", err)
}

// DeleteNamespace permanently removes a namespace and all of its contents after
// a native confirmation prompt. Because a namespace can hold arbitrary
// resources, the confirmation names the namespace explicitly. It returns true
// if deletion was requested, false if the user cancelled. Deletion is
// asynchronous — the namespace enters Terminating and is reclaimed in the
// background.
func (s *Service) DeleteNamespace(name string) (bool, error) {
	ok, err := s.confirm(
		"Delete namespace",
		fmt.Sprintf("Permanently delete namespace %q and everything inside it?\n\nThis cannot be undone. All resources in the namespace will be removed.", name),
	)
	if err != nil || !ok {
		return false, s.opErr("DeleteNamespace", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.DeleteNamespace(ctx, name); err != nil {
		return false, s.opErr("DeleteNamespace", err)
	}
	return true, nil
}

// ListPods returns pods in a namespace.
func (s *Service) ListPods(namespace string) ([]kube.PodInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	pods, err := s.app.kube.Pods(ctx, namespace)
	return pods, s.opErr("ListPods", err)
}

// ListNodes returns the cluster's nodes with health and capacity summaries.
// Nodes are cluster-scoped, so this call is independent of the selected
// namespace.
func (s *Service) ListNodes() ([]kube.NodeInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	nodes, err := s.app.kube.Nodes(ctx)
	return nodes, s.opErr("ListNodes", err)
}

// ListNodeMetrics returns live CPU/memory usage for every node plus a
// cluster-wide rollup (the `kubectl top nodes` equivalent). Requires the
// Metrics API (metrics-server); the response flags when it is unavailable.
func (s *Service) ListNodeMetrics() (kube.NodeMetricsView, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	view, err := s.app.kube.NodeMetricsView(ctx)
	return view, s.opErr("ListNodeMetrics", err)
}

// GetPodMetrics returns the live CPU/memory usage of a pod together with its
// requests/limits. Requires the Metrics API (metrics-server).
func (s *Service) GetPodMetrics(namespace, pod string) (kube.PodMetric, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	metrics, err := s.app.kube.PodMetrics(ctx, namespace, pod)
	return metrics, s.opErr("GetPodMetrics", err)
}

// DeletePod removes a pod, causing its owning controller to recreate it.
// For bare pods (no controller) this permanently removes it, so the
// confirmation message distinguishes the two cases. Returns true if the
// deletion was confirmed and sent, false if the user cancelled.
func (s *Service) DeletePod(namespace, name string) (bool, error) {
	// Look up the pod first so we can show the owner in the confirmation and
	// give the user an accurate description of what will happen.
	ctxLookup, cancelLookup := s.opCtx()
	defer cancelLookup()
	info, err := s.app.kube.Pods(ctxLookup, namespace)
	if err != nil {
		return false, s.opErr("DeletePod", err)
	}
	ownerLine := "This is a bare pod — it will be permanently removed."
	for _, p := range info {
		if p.Name == name && p.Owner != "" {
			ownerLine = fmt.Sprintf("Owned by %s — the controller will recreate it automatically.", p.Owner)
			break
		}
	}
	ok, err := s.confirm(
		"Delete pod",
		fmt.Sprintf("Delete pod %q in namespace %q?\n\n%s", name, namespace, ownerLine),
	)
	if err != nil || !ok {
		return false, s.opErr("DeletePod", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.DeletePod(ctx, namespace, name); err != nil {
		return false, s.opErr("DeletePod", err)
	}
	return true, nil
}

// ListJobs returns Jobs in a namespace with completion status.
func (s *Service) ListJobs(namespace string) ([]kube.JobInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	jobs, err := s.app.kube.Jobs(ctx, namespace)
	return jobs, s.opErr("ListJobs", err)
}

// OpenShell launches the OS terminal with an interactive kubectl exec session
// for the given pod. The correct --context and --kubeconfig flags are
// injected automatically so the shell always connects to the same cluster
// that qbi  is currently inspecting. container may be empty for single-container
// pods; for multi-container pods the caller should pass the chosen container.
func (s *Service) OpenShell(namespace, pod, container string) error {
	return s.opErr("OpenShell", s.app.kube.OpenShell(namespace, pod, container))
}

// ListCronJobs returns CronJobs in a namespace.
func (s *Service) ListCronJobs(namespace string) ([]kube.CronJobInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	jobs, err := s.app.kube.CronJobs(ctx, namespace)
	return jobs, s.opErr("ListCronJobs", err)
}

// GetCronJobDetail returns a CronJob with its recent runs and their pods, so
// the frontend can show run history and stream a run's logs.
func (s *Service) GetCronJobDetail(namespace, name string) (kube.CronJobDetail, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	detail, err := s.app.kube.CronJobDetail(ctx, namespace, name)
	return detail, s.opErr("GetCronJobDetail", err)
}

// CreateCronJob creates a CronJob after an explicit confirmation. Returns
// true if created, false if the user cancelled.
func (s *Service) CreateCronJob(namespace string, spec kube.CronJobCreate) (bool, error) {
	ok, err := s.confirm(
		"Create cron job",
		fmt.Sprintf("Create cron job %q in namespace %q?\n\nSchedule: %s\nImage: %s\nConcurrency: %s",
			spec.Name, namespace, spec.Schedule, spec.Image, cronPolicyLabel(spec.ConcurrencyPolicy)),
	)
	if err != nil || !ok {
		return false, s.opErr("CreateCronJob", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.CreateCronJob(ctx, namespace, spec); err != nil {
		return false, s.opErr("CreateCronJob", err)
	}
	return true, nil
}

// UpdateCronJob applies schedule/suspend edits after an explicit confirmation.
// Returns true if applied, false if the user cancelled.
func (s *Service) UpdateCronJob(namespace, name string, upd kube.CronJobUpdate) (bool, error) {
	var parts []string
	if upd.Schedule != nil {
		parts = append(parts, fmt.Sprintf("schedule to %q", *upd.Schedule))
	}
	if upd.Suspend != nil {
		if *upd.Suspend {
			parts = append(parts, "suspend it (no new runs will be scheduled)")
		} else {
			parts = append(parts, "resume it")
		}
	}
	if upd.ConcurrencyPolicy != nil {
		parts = append(parts, fmt.Sprintf("set concurrency policy to %s", cronPolicyLabel(*upd.ConcurrencyPolicy)))
	}
	if len(parts) == 0 {
		return false, nil // nothing to change
	}
	ok, err := s.confirm(
		"Update cron job",
		fmt.Sprintf("Update cron job %q in namespace %q?\n\n%s", name, namespace, strings.Join(parts, " and ")),
	)
	if err != nil || !ok {
		return false, s.opErr("UpdateCronJob", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.UpdateCronJob(ctx, namespace, name, upd); err != nil {
		return false, s.opErr("UpdateCronJob", err)
	}
	return true, nil
}

// ScaleWorkload sets the replica count for a Deployment or StatefulSet after a
// native confirmation. Returns true if applied, false if the user cancelled.
func (s *Service) ScaleWorkload(namespace, kind, name string, replicas int32) (bool, error) {
	ok, err := s.confirm(
		"Scale workload",
		fmt.Sprintf("Set %s %q in namespace %q to %d replica(s)?", kind, name, namespace, replicas),
	)
	if err != nil || !ok {
		return false, s.opErr("ScaleWorkload", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.ScaleWorkload(ctx, namespace, kind, name, replicas); err != nil {
		return false, s.opErr("ScaleWorkload", err)
	}
	return true, nil
}

// GetResourceYAML returns the YAML representation of a named resource,
// with internal bookkeeping fields (managedFields) stripped.
func (s *Service) GetResourceYAML(namespace, kind, name string) (string, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	yamlDoc, err := s.app.kube.ResourceYAML(ctx, namespace, kind, name)
	return yamlDoc, s.opErr("GetResourceYAML", err)
}

// ListSecrets returns secret metadata (no values) in a namespace.
func (s *Service) ListSecrets(namespace string) ([]kube.SecretInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	secrets, err := s.app.kube.Secrets(ctx, namespace)
	return secrets, s.opErr("ListSecrets", err)
}

// ListServices returns services (with DNS names and backing endpoints).
func (s *Service) ListServices(namespace string) ([]kube.ServiceInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	services, err := s.app.kube.Services(ctx, namespace)
	return services, s.opErr("ListServices", err)
}

// RenderServiceYAML renders the manifest that CreateService would apply, so
// the UI can preview the YAML before the user commits. Pure serialization.
func (s *Service) RenderServiceYAML(namespace string, spec kube.ServiceCreate) (string, error) {
	yamlDoc, err := s.app.kube.RenderServiceYAML(namespace, spec)
	return yamlDoc, s.opErr("RenderServiceYAML", err)
}

// DeleteService permanently removes a Service after a native confirmation.
// The confirmation makes clear that only the load-balancing entry is removed.
// Returns true if the deletion was requested, false if the user cancelled.
func (s *Service) DeleteService(namespace, name string) (bool, error) {
	ok, err := s.confirm(
		"Delete service",
		fmt.Sprintf("Permanently delete service %q in namespace %q?\n\nBacking pods are not affected; only the load-balancing entry is removed.", name, namespace),
	)
	if err != nil || !ok {
		return false, s.opErr("DeleteService", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.DeleteService(ctx, namespace, name); err != nil {
		return false, s.opErr("DeleteService", err)
	}
	return true, nil
}

// DeleteIngress removes an Ingress after a native confirmation. The
// confirmation makes clear that only the routing rules are removed — the
// services and pods they pointed at keep running unchanged. Returns true if
// the deletion was requested, false if the user cancelled.
func (s *Service) DeleteIngress(namespace, name string) (bool, error) {
	ok, err := s.confirm(
		"Delete ingress",
		fmt.Sprintf("Permanently delete ingress %q in namespace %q?\n\nThe routing rules are removed. The services and pods they pointed to keep running unchanged.", name, namespace),
	)
	if err != nil || !ok {
		return false, s.opErr("DeleteIngress", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.DeleteIngress(ctx, namespace, name); err != nil {
		return false, s.opErr("DeleteIngress", err)
	}
	return true, nil
}

// CreateService creates a Service after an explicit confirmation. Returns
// true if created, false if the user cancelled.
func (s *Service) CreateService(namespace string, spec kube.ServiceCreate) (bool, error) {
	ok, err := s.confirm(
		"Create service",
		fmt.Sprintf("Create service %q in namespace %q?\n\nType: %s\nPorts: %s",
			spec.Name, namespace, svcTypeLabel(spec.Type), servicePortsSummary(spec.Ports)),
	)
	if err != nil || !ok {
		return false, s.opErr("CreateService", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.CreateService(ctx, namespace, spec); err != nil {
		return false, s.opErr("CreateService", err)
	}
	return true, nil
}

// svcTypeLabel renders the effective Service type for confirmation text.
func svcTypeLabel(t string) string {
	if t == "" {
		return "ClusterIP"
	}
	return t
}

// servicePortsSummary renders "80 → 8080/TCP, 443 → 443/TCP" for confirmations.
func servicePortsSummary(ports []kube.ServicePortCreate) string {
	parts := make([]string, 0, len(ports))
	for _, p := range ports {
		tp := p.TargetPort
		if tp == "" {
			tp = strconv.Itoa(int(p.Port))
		}
		proto := p.Protocol
		if proto == "" {
			proto = "TCP"
		}
		parts = append(parts, fmt.Sprintf("%d → %s/%s", p.Port, tp, proto))
	}
	return strings.Join(parts, ", ")
}

// ListIngresses returns ingresses (host rules, TLS and address) in a namespace.
func (s *Service) ListIngresses(namespace string) ([]kube.IngressInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	ingresses, err := s.app.kube.Ingresses(ctx, namespace)
	return ingresses, s.opErr("ListIngresses", err)
}

// IngressDetail returns one ingress with its TLS/backend health checks plus
// the events referencing it — the debugging view for "why is my ingress not
// working".
func (s *Service) IngressDetail(namespace, name string) (kube.IngressDetail, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	detail, err := s.app.kube.IngressDetail(ctx, namespace, name)
	return detail, s.opErr("IngressDetail", err)
}

// ListIngressClasses returns the cluster's ingress class names, so the form
// can offer them as choices instead of making the user guess what is
// installed. The error is surfaced when the list cannot be read (RBAC).
func (s *Service) ListIngressClasses() ([]string, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	classes, err := s.app.kube.IngressClasses(ctx)
	return classes, s.opErr("ListIngressClasses", err)
}

// RenderIngressYAML renders the manifest that CreateIngress would apply, so
// the UI can preview the YAML before the user commits. Pure serialization.
func (s *Service) RenderIngressYAML(namespace string, spec kube.IngressCreate) (string, error) {
	yamlDoc, err := s.app.kube.RenderIngressYAML(namespace, spec)
	return yamlDoc, s.opErr("RenderIngressYAML", err)
}

// CreateIngress creates an Ingress after an explicit confirmation. Returns
// true if created, false if the user cancelled.
func (s *Service) CreateIngress(namespace string, spec kube.IngressCreate) (bool, error) {
	ok, err := s.confirm(
		"Create ingress",
		fmt.Sprintf("Create ingress %q in namespace %q?\n\nClass: %s\nHosts: %s\nTLS: %s",
			spec.Name, namespace, ingressClassLabel(spec.IngressClassName),
			ingressHostsSummary(spec.Rules), ingressTLSSummary(spec.TLS)),
	)
	if err != nil || !ok {
		return false, s.opErr("CreateIngress", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.CreateIngress(ctx, namespace, spec); err != nil {
		return false, s.opErr("CreateIngress", err)
	}
	return true, nil
}

// IngressEdit loads an existing ingress into the form shape, including a
// list of constructs the form cannot express (resource backends) that the
// user must resolve before saving.
func (s *Service) IngressEdit(namespace, name string) (kube.IngressEditSpec, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	specResult, err := s.app.kube.IngressEditSpec(ctx, namespace, name)
	return specResult, s.opErr("IngressEdit", err)
}

// UpdateIngress replaces the form-owned fields (class, rules, TLS, default
// backend, annotations, labels) of an existing ingress after an explicit
// confirmation. Returns true if applied, false if the user cancelled.
func (s *Service) UpdateIngress(namespace, name string, spec kube.IngressCreate) (bool, error) {
	ok, err := s.confirm(
		"Update ingress",
		fmt.Sprintf("Replace the routing rules of ingress %q in namespace %q?\n\nThe form contents (rules, TLS, class, default backend, annotations, labels) replace the current values exactly as shown in the preview.", name, namespace),
	)
	if err != nil || !ok {
		return false, s.opErr("UpdateIngress", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.UpdateIngress(ctx, namespace, name, spec); err != nil {
		return false, s.opErr("UpdateIngress", err)
	}
	return true, nil
}

// ingressClassLabel renders the effective ingress class for confirmation text.
func ingressClassLabel(c string) string {
	if c == "" {
		return "(cluster default)"
	}
	return c
}

// ingressHostsSummary renders "example.com, *.internal (2 rules)" for
// confirmations.
func ingressHostsSummary(rules []kube.IngressRuleCreate) string {
	if len(rules) == 0 {
		return "(none)"
	}
	hosts := make([]string, 0, len(rules))
	for _, r := range rules {
		if r.Host == "" {
			hosts = append(hosts, "*")
		} else {
			hosts = append(hosts, r.Host)
		}
	}
	return fmt.Sprintf("%s (%d rule%s)", strings.Join(hosts, ", "), len(rules), plural(len(rules)))
}

// ingressTLSSummary renders "2 block(s)" or "(none)" for confirmations.
func ingressTLSSummary(tls []kube.IngressTLSCreate) string {
	if len(tls) == 0 {
		return "(none)"
	}
	return fmt.Sprintf("%d block%s", len(tls), plural(len(tls)))
}

// plural appends "s" unless n is 1.
func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// GetPod returns the full describe-style detail of a single pod.
func (s *Service) GetPod(namespace, name string) (kube.PodDetail, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	detail, err := s.app.kube.Pod(ctx, namespace, name)
	return detail, s.opErr("GetPod", err)
}

// ListEvents returns events in a namespace, most recent first.
func (s *Service) ListEvents(namespace string) ([]kube.EventInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	events, err := s.app.kube.Events(ctx, namespace)
	return events, s.opErr("ListEvents", err)
}

// History returns durable activity in a namespace — Deployment rollout
// history derived from retained ReplicaSets. Events are garbage-collected
// after about an hour, so this is what answers "what changed here recently"
// once the events feed has gone quiet. opts are the user's own choices for
// how much history to see (filter, deployment and revision caps).
func (s *Service) History(namespace string, opts kube.HistoryOptions) (kube.NamespaceHistory, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	history, err := s.app.kube.History(ctx, namespace, opts)
	return history, s.opErr("History", err)
}

// ListConfigMaps returns ConfigMap metadata (names and keys) in a namespace.
func (s *Service) ListConfigMaps(namespace string) ([]kube.ConfigMapInfo, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	maps, err := s.app.kube.ConfigMaps(ctx, namespace)
	return maps, s.opErr("ListConfigMaps", err)
}

// GetConfigMap returns a single ConfigMap's full contents.
func (s *Service) GetConfigMap(namespace, name string) (kube.ConfigMapDetail, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	detail, err := s.app.kube.ConfigMap(ctx, namespace, name)
	return detail, s.opErr("GetConfigMap", err)
}

// ListWorkloads returns Deployments, StatefulSets and DaemonSets in a
// namespace, plus per-kind errors when the caller lacks RBAC on a type.
func (s *Service) ListWorkloads(namespace string) (kube.WorkloadsView, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	view, err := s.app.kube.Workloads(ctx, namespace)
	return view, s.opErr("ListWorkloads", err)
}

// RenderDeploymentYAML renders the manifest that CreateDeployment would
// apply, so the UI can preview the YAML before the user commits. Pure
// serialization — no cluster call.
func (s *Service) RenderDeploymentYAML(namespace string, spec kube.DeploymentCreate) (string, error) {
	yamlDoc, err := s.app.kube.RenderDeploymentYAML(namespace, spec)
	return yamlDoc, s.opErr("RenderDeploymentYAML", err)
}

// CreateDeployment creates a Deployment from the UI form spec after an
// explicit confirmation. Returns true if created, false if the user cancelled.
func (s *Service) CreateDeployment(namespace string, spec kube.DeploymentCreate) (bool, error) {
	ok, err := s.confirm(
		"Create deployment",
		fmt.Sprintf("Create deployment %q in namespace %q?\n\nImage: %s\nReplicas: %d",
			spec.Name, namespace, spec.Image, spec.Replicas),
	)
	if err != nil || !ok {
		return false, s.opErr("CreateDeployment", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.CreateDeployment(ctx, namespace, spec); err != nil {
		return false, s.opErr("CreateDeployment", err)
	}
	return true, nil
}

// DeleteWorkload permanently removes a Deployment, StatefulSet or DaemonSet
// after a native confirmation. The confirmation names the kind explicitly so
// a user cannot mistake a Deployment for a DaemonSet. Returns true if the
// deletion was requested, false if the user cancelled.
func (s *Service) DeleteWorkload(namespace, kind, name string) (bool, error) {
	extra := ""
	if kind == "StatefulSet" {
		extra = "\n\nIts persistent volumes (PVCs) are retained; only the controller and its pods are removed."
	}
	ok, err := s.confirm(
		"Delete workload",
		fmt.Sprintf("Permanently delete %s %q in namespace %q?\n\nAll of its pods will be terminated.%s", kind, name, namespace, extra),
	)
	if err != nil || !ok {
		return false, s.opErr("DeleteWorkload", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.DeleteWorkload(ctx, namespace, kind, name); err != nil {
		return false, s.opErr("DeleteWorkload", err)
	}
	return true, nil
}

// RestartWorkload triggers a rolling restart of a workload (the equivalent of
// `kubectl rollout restart`) after a native confirmation prompt. It returns
// true if the restart was triggered, false if the user cancelled.
func (s *Service) RestartWorkload(namespace, kind, name string) (bool, error) {
	ok, err := s.confirm(
		"Restart workload",
		fmt.Sprintf("Trigger a rolling restart of %s %q in namespace %q?\n\nPods will be replaced gradually according to the workload's update strategy.", kind, name, namespace),
	)
	if err != nil || !ok {
		return false, s.opErr("RestartWorkload", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.RestartWorkload(ctx, namespace, kind, name); err != nil {
		return false, s.opErr("RestartWorkload", err)
	}
	return true, nil
}

// GetSecret returns a single secret with decoded values.
func (s *Service) GetSecret(namespace, name string) (kube.SecretDetail, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	detail, err := s.app.kube.Secret(ctx, namespace, name)
	return detail, s.opErr("GetSecret", err)
}

// UpdateSecret applies a set of key changes (set or delete) to a secret and
// returns the refreshed detail. Binary keys not included are preserved. The
// mode ("transparent" or "base64") says how the UI is representing values: in
// base64 mode the backend validates each value before storing it.
func (s *Service) UpdateSecret(namespace, name string, changes []kube.SecretChange, mode string) (kube.SecretDetail, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	detail, err := s.app.kube.UpdateSecret(ctx, namespace, name, changes, mode)
	return detail, s.opErr("UpdateSecret", err)
}

// CreateSecret creates a secret from the form spec after an explicit
// confirmation. Returns true if created, false if the user cancelled. mode is
// passed through so the backend validates base64 values when the UI is in
// base64 mode.
func (s *Service) CreateSecret(namespace string, spec kube.SecretCreate, mode string) (bool, error) {
	ok, err := s.confirm(
		"Create secret",
		fmt.Sprintf("Create secret %q in namespace %q?\n\nType: %s\nKeys: %d",
			spec.Name, namespace, secretTypeLabel(spec.Type), len(spec.Data)),
	)
	if err != nil || !ok {
		return false, s.opErr("CreateSecret", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.CreateSecret(ctx, namespace, spec, mode); err != nil {
		return false, s.opErr("CreateSecret", err)
	}
	return true, nil
}

// GetSecretYAML returns the manifest for a secret. When transparent is true
// the values are rendered as stringData (plain text) instead of base64 data.
func (s *Service) GetSecretYAML(namespace, name string, transparent bool) (string, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	yamlDoc, err := s.app.kube.SecretYAML(ctx, namespace, name, transparent)
	return yamlDoc, s.opErr("GetSecretYAML", err)
}

// CreateSecretFromYAML creates a secret from a raw manifest after an explicit
// confirmation. The name shown in the confirmation comes from the manifest so
// the user knows exactly what they are about to create.
func (s *Service) CreateSecretFromYAML(namespace, yaml string) (bool, error) {
	spec, err := kube.ParseSecretYAML(yaml)
	if err != nil {
		return false, s.opErr("CreateSecretFromYAML", err)
	}
	ok, err := s.confirm(
		"Create secret from YAML",
		fmt.Sprintf("Create secret %q in namespace %q from the YAML editor?", spec.Name, namespace),
	)
	if err != nil || !ok {
		return false, s.opErr("CreateSecretFromYAML", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.CreateSecretFromYAML(ctx, namespace, yaml); err != nil {
		return false, s.opErr("CreateSecretFromYAML", err)
	}
	return true, nil
}

// UpdateSecretFromYAML replaces a secret with the contents of a raw manifest
// after an explicit confirmation. This is a full replace: keys not present in
// the YAML are removed.
func (s *Service) UpdateSecretFromYAML(namespace, name, yaml string) (bool, error) {
	spec, err := kube.ParseSecretYAML(yaml)
	if err != nil {
		return false, s.opErr("UpdateSecretFromYAML", err)
	}
	ok, err := s.confirm(
		"Replace secret from YAML",
		fmt.Sprintf("Replace secret %q in namespace %q with the YAML editor contents?\n\nThe manifest has %d key(s). This is a full replace.", name, namespace, manifestKeyCount(spec)),
	)
	if err != nil || !ok {
		return false, s.opErr("UpdateSecretFromYAML", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.UpdateSecretYAML(ctx, namespace, name, yaml); err != nil {
		return false, s.opErr("UpdateSecretFromYAML", err)
	}
	return true, nil
}

// secretTypeLabel renders the effective secret type for confirmation text.
func secretTypeLabel(t string) string {
	if t == "" {
		return "Opaque"
	}
	return t
}

// manifestKeyCount counts the data keys in a parsed manifest, including those
// provided as stringData (which Kubernetes folds into data on write).
func manifestKeyCount(s *corev1.Secret) int {
	return len(s.Data) + len(s.StringData)
}

// DeleteSecret permanently removes a secret after a native confirmation prompt.
// It returns true if the secret was deleted, false if the user cancelled.
func (s *Service) DeleteSecret(namespace, name string) (bool, error) {
	ok, err := s.confirm(
		"Delete secret",
		fmt.Sprintf("Permanently delete secret %q in namespace %q?\n\nThis cannot be undone.", name, namespace),
	)
	if err != nil || !ok {
		return false, s.opErr("DeleteSecret", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	if err := s.app.kube.DeleteSecret(ctx, namespace, name); err != nil {
		return false, s.opErr("DeleteSecret", err)
	}
	return true, nil
}

// cronPolicyLabel renders a concurrency policy for human confirmation text;
// the empty value means the cluster default, Allow.
func cronPolicyLabel(p string) string {
	if p == "" {
		return "Allow (may overlap)"
	}
	switch p {
	case "Forbid":
		return "Forbid (single run at a time)"
	case "Replace":
		return "Replace (cancel running job)"
	default:
		return p
	}
}

// confirm shows a native yes/no question dialog and reports whether the user
// confirmed. It is deliberately robust to platform differences: on Windows the
// dialog buttons are the OS-native "Yes"/"No" (custom captions are ignored),
// so we treat any non-affirmative result — including "No", "Cancel" and an
// empty string — as a cancellation rather than matching a specific label.
func (s *Service) confirm(title, message string) (bool, error) {
	choice, err := runtime.MessageDialog(s.app.ctx, runtime.MessageDialogOptions{
		Type:          runtime.QuestionDialog,
		Title:         title,
		Message:       message,
		Buttons:       []string{"Yes", "No"},
		DefaultButton: "No",
		CancelButton:  "No",
	})
	if err != nil {
		return false, err
	}
	switch strings.ToLower(strings.TrimSpace(choice)) {
	case "yes", "ok":
		return true, nil
	default:
		return false, nil
	}
}

// streamKey identifies a running log stream for a container.
func streamKey(namespace, pod, container string) string {
	return fmt.Sprintf("%s/%s/%s", namespace, pod, container)
}

// LogStreamOptions mirrors kube.LogOptions for the frontend binding.
type LogStreamOptions struct {
	TailLines  int  `json:"tailLines"`
	Timestamps bool `json:"timestamps"`
	Previous   bool `json:"previous"`
}

// StartLogStream begins following a container's logs. Log lines are emitted to
// the frontend as "log:<key>" events; a "log:end:<key>" event signals the end.
// The returned key must be passed to StopLogStream to stop following.
func (s *Service) StartLogStream(namespace, pod, container string, opts LogStreamOptions) (string, error) {
	key := streamKey(namespace, pod, container)

	s.mu.Lock()
	if _, exists := s.streams[key]; exists {
		s.mu.Unlock()
		return key, nil
	}

	ctx, cancel := context.WithCancel(s.app.ctx)
	s.streams[key] = cancel
	s.mu.Unlock()

	stream, err := s.app.kube.StreamLogs(ctx, namespace, pod, kube.LogOptions{
		Container:  container,
		TailLines:  int64(opts.TailLines),
		Timestamps: opts.Timestamps,
		Previous:   opts.Previous,
	})
	if err != nil {
		s.mu.Lock()
		delete(s.streams, key)
		s.mu.Unlock()
		cancel()
		return "", s.opErr("StartLogStream", err)
	}

	go func() {
		defer stream.Close()
		defer func() {
			s.mu.Lock()
			delete(s.streams, key)
			s.mu.Unlock()
			cancel()
			runtime.EventsEmit(s.app.ctx, "log:end:"+key)
		}()

		scanner := bufio.NewScanner(stream)
		scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for scanner.Scan() {
			runtime.EventsEmit(s.app.ctx, "log:"+key, scanner.Text())
		}
		if err := scanner.Err(); err != nil && ctx.Err() == nil {
			slog.Warn("log stream error", "key", key, "error", err)
			runtime.EventsEmit(s.app.ctx, "log:error:"+key, err.Error())
		}
	}()

	return key, nil
}

// StopLogStream stops a running log stream identified by its key.
func (s *Service) StopLogStream(key string) {
	s.mu.Lock()
	cancel, ok := s.streams[key]
	s.mu.Unlock()
	if ok {
		cancel()
	}
}

// SaveLogs prompts for a location and writes the given log content to a file.
// It returns the chosen path, or an empty string if the user cancelled.
func (s *Service) SaveLogs(suggestedName, content string) (string, error) {
	path, err := runtime.SaveFileDialog(s.app.ctx, runtime.SaveDialogOptions{
		Title:           "Save logs",
		DefaultFilename: suggestedName,
		Filters: []runtime.FileFilter{
			{DisplayName: "Log file (*.log)", Pattern: "*.log"},
			{DisplayName: "Text file (*.txt)", Pattern: "*.txt"},
			{DisplayName: "All files (*.*)", Pattern: "*.*"},
		},
	})
	if err != nil {
		return "", s.opErr("SaveLogs", err)
	}
	if path == "" {
		return "", nil // user cancelled
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return "", s.opErr("SaveLogs", err)
	}
	return path, nil
}
