package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
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

	mu        sync.Mutex
	streams   map[string]*logStreamEntry
	streamSeq atomic.Int64

	watcher *kube.Watcher

	pfMu     sync.Mutex
	forwards map[string]*portForwardEntry
	pfSeq    atomic.Int64

	// startPortForward creates the underlying forward session; replaced in
	// tests to exercise the port-forward lifecycle without a cluster.
	startPortForward func(ctx context.Context, spec kube.PortForwardSpec) (portForwardSession, error)
	// emitPortForwardStatus delivers a status event to the frontend; replaced
	// in tests because runtime.EventsEmit requires the Wails runtime context.
	emitPortForwardStatus func(st kube.PortForwardStatus)
}

type logStreamEntry struct {
	ctx       context.Context
	cancel    context.CancelFunc
	started   bool
	namespace string
	pod       string
	container string
	opts      LogStreamOptions
}

// NewService creates the frontend-facing service.
func NewService(app *App) *Service {
	s := &Service{
		app:      app,
		streams:  make(map[string]*logStreamEntry),
		forwards: make(map[string]*portForwardEntry),
		emitPortForwardStatus: func(st kube.PortForwardStatus) {
			runtime.EventsEmit(app.ctx, "portforward:status", st)
		},
	}
	s.startPortForward = func(ctx context.Context, spec kube.PortForwardSpec) (portForwardSession, error) {
		return app.kube.StartPortForward(ctx, spec)
	}
	s.watcher = kube.NewWatcher(app.kube, s.emitWatchEvent)
	return s
}

// BuildInfo returns the version, git commit, and build time of this binary
// as a single payload for the About view. The values are injected at build
// time from the VERSION file; see internal/version.
func (s *Service) BuildInfo() version.BuildInfo {
	return version.Info()
}

// AppSettings is the settings payload exchanged with the frontend.
type AppSettings struct {
	AutoRefresh  bool `json:"autoRefresh"`
	WelcomeSeen  bool `json:"welcomeSeen"`
	Experimental bool `json:"experimental"`
}

// GetSettings returns the current persisted settings.
func (s *Service) GetSettings() AppSettings {
	st := loadSettings()
	return AppSettings{
		AutoRefresh:  st.AutoRefresh,
		WelcomeSeen:  st.WelcomeSeen,
		Experimental: st.Experimental,
	}
}

// AcknowledgeWelcome records that the user has read the first-launch welcome
// wizard and accepted responsibility for cluster changes. The frontend calls
// it when the wizard is completed; it is never shown again afterwards.
// Merely closing the wizard does not call this — only the explicit
// acknowledgment on the final step does.
func (s *Service) AcknowledgeWelcome() error {
	st := loadSettings()
	st.WelcomeSeen = true
	if err := saveSettings(st); err != nil {
		return s.opErr("AcknowledgeWelcome", err)
	}
	return nil
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

// SetExperimental persists the experimental-features switch. Experimental
// features stay hidden and inert while disabled, so they can be removed
// later without breaking anyone's workflow.
func (s *Service) SetExperimental(enabled bool) error {
	st := loadSettings()
	st.Experimental = enabled
	if err := saveSettings(st); err != nil {
		return s.opErr("SetExperimental", err)
	}
	return nil
}

// experimentalEnabled reports whether the persisted experimental-features
// switch is on. Gated Service methods check this themselves: the flag must be
// enforced server-side, not just hidden in the UI.
func experimentalEnabled() bool {
	return loadSettings().Experimental
}

// SetWatchNamespace (re)starts namespace-scoped watch streams for the given
// namespace. An empty namespace means no cluster data is being viewed (for
// example after a failed reconnect tore the connection down), so any running
// streams are stopped. Has no effect when auto-refresh is disabled.
func (s *Service) SetWatchNamespace(namespace string) {
	st := loadSettings()
	if namespace == "" {
		s.watcher.Stop()
		return
	}
	if !st.AutoRefresh {
		return
	}
	s.watcher.Start(namespace)
}

// Shutdown stops background watchers when the app closes. Log streams ride on
// the Wails app context and are cancelled with it, so only the watcher and
// the port-forward sessions need an explicit stop here.
func (s *Service) Shutdown() {
	s.watcher.Stop()
	s.stopAllPortForwards()
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
	// Load-then-save: a fresh struct would silently wipe AutoRefresh and
	// WelcomeSeen (e.g. acknowledging the wizard, then picking a kubeconfig).
	st := loadSettings()
	st.KubeconfigPath = path
	if err := saveSettings(st); err != nil {
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
	if err != nil {
		return info, s.opErr("Connect", err)
	}
	// A new connection carries a fresh REST config; port-forwards built on
	// the old one cannot survive it, so tear them all down. The UI remounts
	// its panels afterwards and rehydrates from ListPortForwards.
	s.stopAllPortForwards()
	return info, nil
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

// GetPodNetworkFiles returns the pod's own DNS view — /etc/hosts and
// /etc/resolv.conf read via kubectl exec. It is an experimental feature: the
// call is refused while the experimental switch is off, so the gate is
// enforced server-side rather than only hidden in the UI. Read-only, so no
// confirmation is needed. Per-file errors are folded into the payload; only
// when both reads fail does the call itself fail.
func (s *Service) GetPodNetworkFiles(namespace, pod, container string) (kube.PodNetworkFiles, error) {
	if !experimentalEnabled() {
		return kube.PodNetworkFiles{}, s.opErr("GetPodNetworkFiles",
			fmt.Errorf("experimental features are disabled; enable them in Settings"))
	}
	ctx, cancel := s.opCtx()
	defer cancel()

	files := kube.PodNetworkFiles{Container: container}
	if content, err := s.app.kube.PodFile(ctx, namespace, pod, container, "/etc/hosts"); err != nil {
		files.HostsError = err.Error()
	} else {
		files.Hosts = content
	}
	if content, err := s.app.kube.PodFile(ctx, namespace, pod, container, "/etc/resolv.conf"); err != nil {
		files.ResolvConfError = err.Error()
	} else {
		files.ResolvConf = content
	}
	if files.HostsError != "" && files.ResolvConfError != "" {
		return kube.PodNetworkFiles{}, s.opErr("GetPodNetworkFiles",
			fmt.Errorf("could not read pod network files — hosts: %s; resolv.conf: %s",
				files.HostsError, files.ResolvConfError))
	}
	return files, nil
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

// ListWorkloadRevisions returns the rollout history of a Deployment,
// StatefulSet or DaemonSet, newest first, with the current revision marked.
// This is what the rollback picker renders; a revision whose template already
// matches the live one is a rollback no-op.
func (s *Service) ListWorkloadRevisions(namespace, kind, name string) ([]kube.WorkloadRevision, error) {
	ctx, cancel := s.opCtx()
	defer cancel()
	revs, err := s.app.kube.WorkloadRevisions(ctx, namespace, kind, name)
	return revs, s.opErr("ListWorkloadRevisions", err)
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

// RollbackWorkload restores a workload to a past revision (the equivalent of
// `kubectl rollout undo --to-revision=N`) after a native confirmation prompt.
// The result tells the three outcomes apart: applied (template restored),
// skipped (the target revision's template already matches — kubectl reports
// the same as a skipped rollback), or neither (the user cancelled).
func (s *Service) RollbackWorkload(namespace, kind, name string, revision int64) (kube.RollbackResult, error) {
	ok, err := s.confirm(
		"Roll back workload",
		fmt.Sprintf("Roll back %s %q in namespace %q to revision %d?\n\nPods will be replaced gradually according to the workload's update strategy.", kind, name, namespace, revision),
	)
	if err != nil || !ok {
		return kube.RollbackResult{}, s.opErr("RollbackWorkload", err)
	}
	ctx, cancel := s.opCtx()
	defer cancel()
	result, err := s.app.kube.RollbackWorkload(ctx, namespace, kind, name, revision)
	return result, s.opErr("RollbackWorkload", err)
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

const (
	logBatchSize          = 200
	logBatchFlushInterval = 50 * time.Millisecond
)

// finishStream removes the stream entry only if it is still the current one,
// so a stale goroutine can never remove the entry of a newer stream.
func (s *Service) finishStream(key string, entry *logStreamEntry) {
	s.mu.Lock()
	if s.streams[key] == entry {
		delete(s.streams, key)
	}
	s.mu.Unlock()
}

// StartLogStream reserves a fresh, unique stream key for a container's logs
// and returns it WITHOUT opening the Kubernetes stream. The frontend must
// call FollowLogStream(key) after subscribing to the stream's events: with
// follow streams the kube API delivers the history first, and a fast pod can
// produce it quicker than the frontend can register handlers, silently losing
// the first lines. A unique key also isolates every restart — events emitted
// by a previous stream, which keeps draining for a moment after its context
// is cancelled, can never leak into the new one's namespace.
func (s *Service) StartLogStream(namespace, pod, container string, opts LogStreamOptions) (string, error) {
	key := fmt.Sprintf("%s#%d", streamKey(namespace, pod, container), s.streamSeq.Add(1))
	ctx, cancel := context.WithCancel(s.app.ctx)
	entry := &logStreamEntry{
		ctx:       ctx,
		cancel:    cancel,
		namespace: namespace,
		pod:       pod,
		container: container,
		opts:      opts,
	}
	s.mu.Lock()
	s.streams[key] = entry
	s.mu.Unlock()
	return key, nil
}

// FollowLogStream opens the Kubernetes log stream for a reserved key and
// starts pumping it to the frontend. Log lines are emitted as batched
// "log:batch:<key>" events (oversized-line pieces as "log:part:<key>"); a
// "log:end:<key>" event signals the end. The key must come from
// StartLogStream and can be followed at most once.
func (s *Service) FollowLogStream(key string) error {
	s.mu.Lock()
	entry, ok := s.streams[key]
	if ok {
		if entry.started {
			ok = false
		} else {
			entry.started = true
		}
	}
	s.mu.Unlock()
	if !ok {
		return s.opErr("FollowLogStream", fmt.Errorf("unknown or already-started stream key"))
	}

	stream, err := s.app.kube.StreamLogs(entry.ctx, entry.namespace, entry.pod, kube.LogOptions{
		Container:  entry.container,
		TailLines:  int64(entry.opts.TailLines),
		Timestamps: entry.opts.Timestamps,
		Previous:   entry.opts.Previous,
	})
	if err != nil {
		entry.cancel()
		s.finishStream(key, entry)
		return s.opErr("FollowLogStream", err)
	}

	go func() {
		defer stream.Close()
		defer func() {
			entry.cancel()
			runtime.EventsEmit(s.app.ctx, "log:end:"+key)
			s.finishStream(key, entry)
		}()

		emit := func(name string, data any) {
			runtime.EventsEmit(s.app.ctx, name, data)
		}
		if err := pumpLogStream(key, stream, new(kube.LogSplitter), emit, logBatchFlushInterval, logBatchSize); err != nil && entry.ctx.Err() == nil {
			slog.Warn("log stream error", "key", key, "error", err)
			runtime.EventsEmit(s.app.ctx, "log:error:"+key, err.Error())
		}
	}()

	return nil
}

// pumpLogStream reads log lines from r and forwards them to the frontend as
// batched events. A pending batch is flushed before a partial piece so pieces
// never overtake the lines that precede them; whatever is still pending is
// flushed when the stream ends. The scan runs in its own goroutine because
// bufio.Scanner blocks between lines: a select between scan results and the
// flush ticker is what makes low-rate streams (2-5 lines/sec) appear on time.
func pumpLogStream(key string, r io.Reader, splitter *kube.LogSplitter, emit func(name string, data any), flushInterval time.Duration, batchSize int) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, kube.LogChunkSize), kube.LogChunkSize)
	scanner.Split(splitter.Split)

	type item struct {
		text    string
		partial bool
	}
	items := make(chan item)
	scanErr := make(chan error, 1)
	go func() {
		for scanner.Scan() {
			items <- item{text: scanner.Text(), partial: splitter.LastWasPartial()}
		}
		scanErr <- scanner.Err()
	}()

	pending := make([]string, 0, batchSize)
	flush := func() {
		if len(pending) == 0 {
			return
		}
		emit("log:batch:"+key, strings.Join(pending, "\n"))
		pending = pending[:0]
	}

	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			flush()
		case it := <-items:
			if it.partial {
				flush()
				emit("log:part:"+key, it.text)
				continue
			}
			pending = append(pending, it.text)
			if len(pending) >= batchSize {
				flush()
			}
		case err := <-scanErr:
			flush()
			return err
		}
	}
}

// StopLogStream stops a reserved or running log stream identified by its key.
// A stream that was never followed has no goroutine to clean up after it, so
// StopLogStream removes its entry itself.
func (s *Service) StopLogStream(key string) {
	s.mu.Lock()
	entry, ok := s.streams[key]
	if ok && !entry.started {
		delete(s.streams, key)
	}
	s.mu.Unlock()
	if ok {
		entry.cancel()
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
		return "", nil
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		return "", s.opErr("SaveLogs", err)
	}
	return path, nil
}

// ── Port forwarding ────────────────────────────────────────────────────────

// portForwardEntry tracks one running port-forward session: the underlying
// session, the owning context, and the state the frontend sees. Entries live
// in Service.forwards while the forward is alive and are removed once it
// reaches a terminal state (stopped or failed), after the final event.
type portForwardEntry struct {
	id         string
	ctx        context.Context
	cancel     context.CancelFunc
	session    portForwardSession
	namespace  string
	pod        string
	localPort  int
	remotePort int
	state      string // starting | active | stopped | failed
	errText    string
	teardown   bool // set by stopAllPortForwards: suppress final events
}

// portForwardSession is the subset of kube.PortForwardSession the Service
// lifecycle uses. It is an interface so tests can drive the lifecycle with a
// fake instead of a live cluster.
type portForwardSession interface {
	LocalPort() int
	Ready() <-chan struct{}
	Result() <-chan error
	Stop()
	ErrorText() string
}

// portForwardReadyTimeout bounds how long a forward may take to bind its
// local port before it is declared failed. A package variable so tests can
// shorten it.
var portForwardReadyTimeout = 10 * time.Second

// StartPortForward opens a TCP port-forward from 127.0.0.1 to a port inside
// a pod. It is an experimental feature: the call is refused while the
// experimental switch is off, server-side, so the gate cannot be bypassed
// from the UI. The call returns as soon as the session is registered
// ("starting"); progress is delivered to the frontend as "portforward:status"
// events (active / stopped / failed).
func (s *Service) StartPortForward(namespace, pod string, localPort, remotePort int) (kube.PortForwardStatus, error) {
	if !experimentalEnabled() {
		return kube.PortForwardStatus{}, s.opErr("StartPortForward",
			fmt.Errorf("experimental features are disabled; enable them in Settings"))
	}

	// One forward per (pod, remote port): a duplicate would silently shadow
	// the existing one and leak its local port.
	s.pfMu.Lock()
	for _, e := range s.forwards {
		if e.namespace == namespace && e.pod == pod && e.remotePort == remotePort &&
			e.state != "stopped" && e.state != "failed" {
			s.pfMu.Unlock()
			return kube.PortForwardStatus{}, s.opErr("StartPortForward",
				fmt.Errorf("a port forward to %s/%s:%d is already active", namespace, pod, remotePort))
		}
	}
	s.pfMu.Unlock()

	id := fmt.Sprintf("pf-%d", s.pfSeq.Add(1))
	ctx, cancel := context.WithCancel(s.app.ctx)
	entry := &portForwardEntry{
		id:         id,
		ctx:        ctx,
		cancel:     cancel,
		namespace:  namespace,
		pod:        pod,
		localPort:  localPort,
		remotePort: remotePort,
		state:      "starting",
	}

	session, err := s.startPortForward(ctx, kube.PortForwardSpec{
		Namespace:  namespace,
		Pod:        pod,
		LocalPort:  localPort,
		RemotePort: remotePort,
	})
	if err != nil {
		cancel()
		return kube.PortForwardStatus{}, s.opErr("StartPortForward", err)
	}
	entry.session = session
	entry.localPort = session.LocalPort()

	s.pfMu.Lock()
	s.forwards[id] = entry
	s.pfMu.Unlock()
	s.emitPortForwardStatus(s.portForwardStatus(entry))

	go s.runPortForwardLifecycle(entry)
	return s.portForwardStatus(entry), nil
}

// runPortForwardLifecycle watches one forward from registration to its
// terminal state, emitting a status event on every transition. It owns the
// entry's cleanup: the entry leaves the registry and its context is cancelled
// when the forward ends.
func (s *Service) runPortForwardLifecycle(entry *portForwardEntry) {
	defer s.finishPortForward(entry)

	select {
	case <-entry.session.Ready():
		s.setPortForwardState(entry, "active", "")
	case err := <-entry.session.Result():
		s.setPortForwardState(entry, "failed", portForwardErrorText(err, entry.session))
		return
	case <-time.After(portForwardReadyTimeout):
		entry.session.Stop()
		s.setPortForwardState(entry, "failed", "timed out waiting for the port forward to become ready")
		return
	}

	select {
	case err := <-entry.session.Result():
		if err != nil {
			s.setPortForwardState(entry, "failed", portForwardErrorText(err, entry.session))
			return
		}
		// Clean end: either Stop was requested (state already "stopped" and
		// announced) or the connection ended on its own — surface that.
		s.setPortForwardState(entry, "stopped", "")
	case <-entry.ctx.Done():
		// Teardown (app shutdown / reconnect): the kube-layer watchdog stops
		// the session; nothing to emit — the UI is going away.
		entry.session.Stop()
	}
}

// StopPortForward ends a running forward by id. Stopping an already-finished
// forward is a no-op: the UI can race the terminal event.
func (s *Service) StopPortForward(id string) error {
	s.pfMu.Lock()
	entry, ok := s.forwards[id]
	if ok && (entry.state == "stopped" || entry.state == "failed") {
		ok = false // already terminal; nothing to stop
	}
	s.pfMu.Unlock()
	if !ok {
		return nil
	}
	entry.session.Stop()
	s.setPortForwardState(entry, "stopped", "")
	return nil
}

// ListPortForwards returns a snapshot of every running forward, sorted by pod
// then local port, so the UI can rebuild its list (e.g. after a panel
// remount).
func (s *Service) ListPortForwards() []kube.PortForwardStatus {
	s.pfMu.Lock()
	defer s.pfMu.Unlock()
	out := make([]kube.PortForwardStatus, 0, len(s.forwards))
	for _, e := range s.forwards {
		out = append(out, s.portForwardStatusLocked(e))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Pod != out[j].Pod {
			return out[i].Pod < out[j].Pod
		}
		return out[i].LocalPort < out[j].LocalPort
	})
	return out
}

// stopAllPortForwards ends every running forward (context switch, app
// shutdown). Final events are suppressed: the UI is being torn down or
// remounted anyway, and announcing "stopped" for a forward the user did not
// stop would be noise.
func (s *Service) stopAllPortForwards() {
	s.pfMu.Lock()
	entries := make([]*portForwardEntry, 0, len(s.forwards))
	for _, e := range s.forwards {
		e.teardown = true
		entries = append(entries, e)
	}
	s.pfMu.Unlock()
	for _, e := range entries {
		e.session.Stop()
	}
}

// setPortForwardState records a transition and emits it to the frontend.
// Re-setting the same state is a no-op, so racing goroutines (a Stop request
// vs. the lifecycle loop) emit at most one event per transition. Emissions
// are suppressed while the entry is being torn down.
func (s *Service) setPortForwardState(entry *portForwardEntry, state, errText string) {
	s.pfMu.Lock()
	if entry.state == state && entry.errText == errText {
		s.pfMu.Unlock()
		return
	}
	entry.state = state
	entry.errText = errText
	status := s.portForwardStatusLocked(entry)
	teardown := entry.teardown
	s.pfMu.Unlock()
	if !teardown {
		s.emitPortForwardStatus(status)
	}
}

// portForwardStatus renders the frontend-facing status of an entry.
func (s *Service) portForwardStatus(entry *portForwardEntry) kube.PortForwardStatus {
	s.pfMu.Lock()
	defer s.pfMu.Unlock()
	return s.portForwardStatusLocked(entry)
}

func (s *Service) portForwardStatusLocked(entry *portForwardEntry) kube.PortForwardStatus {
	return kube.PortForwardStatus{
		ID:         entry.id,
		Namespace:  entry.namespace,
		Pod:        entry.pod,
		LocalPort:  entry.localPort,
		RemotePort: entry.remotePort,
		State:      entry.state,
		Error:      entry.errText,
	}
}

// finishPortForward removes the entry from the registry — only if it is still
// the current one, so a stale goroutine can never remove the entry of a newer
// forward — and releases its context.
func (s *Service) finishPortForward(entry *portForwardEntry) {
	s.pfMu.Lock()
	if s.forwards[entry.id] == entry {
		delete(s.forwards, entry.id)
	}
	s.pfMu.Unlock()
	entry.cancel()
}

// portForwardErrorText prefers the machinery's own diagnostic (kubectl-style,
// e.g. "unable to forward port because pod is not running") over the raw Go
// error, with a final fallback for the case where neither carries a message.
func portForwardErrorText(err error, session portForwardSession) string {
	if msg := session.ErrorText(); msg != "" {
		return msg
	}
	if err != nil {
		return err.Error()
	}
	return "the port-forward connection ended unexpectedly"
}
