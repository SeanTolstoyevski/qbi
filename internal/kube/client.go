package kube

import (
	"context"
	"encoding/base64"
	"fmt"
	"sort"
	"sync"
	"time"
	"unicode/utf8"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	clientcmdapi "k8s.io/client-go/tools/clientcmd/api"
	metricsclient "k8s.io/metrics/pkg/client/clientset/versioned"
)

// Client is a thread-safe wrapper around a Kubernetes clientset that can be
// reconfigured to point at any context found in the user's kubeconfig.
type Client struct {
	mu             sync.RWMutex
	clientset      kubernetes.Interface
	metrics        metricsclient.Interface // Metrics API client (metrics-server)
	rawConfig      clientcmdapi.Config
	current        string
	kubeconfigPath string
}

// maxListItems caps how many objects a single List call returns. This is a
// safety valve for very large clusters: an inspection tool never needs to pull
// tens of thousands of objects into memory at once, and doing so risks OOM and
// slow, unresponsive UI. Results beyond this cap are simply not shown.
const maxListItems = 1000

// listOptions returns the standard List options used throughout the client,
// bounding the result size to maxListItems.
func listOptions() metav1.ListOptions {
	return metav1.ListOptions{Limit: maxListItems}
}

// NewClient returns an unconnected client. Call Connect before use.
func NewClient() *Client {
	return &Client{}
}

// SetKubeconfigPath pins the client to a specific kubeconfig file. An empty
// path restores the default lookup (KUBECONFIG env, then ~/.kube/config).
func (c *Client) SetKubeconfigPath(path string) {
	c.mu.Lock()
	c.kubeconfigPath = path
	c.mu.Unlock()
}

// KubeconfigPath returns the explicitly pinned kubeconfig path, if any.
func (c *Client) KubeconfigPath() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.kubeconfigPath
}

// CurrentContext returns the name of the active Kubernetes context.
// Returns an empty string if Connect has not been called yet.
func (c *Client) CurrentContext() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.current
}

// loader returns the deferred kubeconfig loader. If an explicit path has been
// pinned it is used exclusively; otherwise KUBECONFIG and the default lookup
// paths are honoured. contextName optionally overrides the current context.
func (c *Client) loader(contextName string) clientcmd.ClientConfig {
	c.mu.RLock()
	path := c.kubeconfigPath
	c.mu.RUnlock()

	var rules clientcmd.ClientConfigLoader
	if path != "" {
		rules = &clientcmd.ClientConfigLoadingRules{ExplicitPath: path}
	} else {
		rules = clientcmd.NewDefaultClientConfigLoadingRules()
	}
	overrides := &clientcmd.ConfigOverrides{}
	if contextName != "" {
		overrides.CurrentContext = contextName
	}
	return clientcmd.NewNonInteractiveDeferredLoadingClientConfig(rules, overrides)
}

// clientConfigWithContext loads the rest config bounded by ctx. Some client-go
// versions expose a context-aware ClientConfigWithContext on the concrete
// loader; others do not, so we fall back to running the (possibly blocking)
// config load in a goroutine and giving up when the context expires. Either
// way a hanging exec auth plugin surfaces as a timeout instead of a frozen UI.
func clientConfigWithContext(ctx context.Context, cfg clientcmd.ClientConfig) (*rest.Config, error) {
	type contextAware interface {
		ClientConfigWithContext(context.Context) (*rest.Config, error)
	}
	if cc, ok := cfg.(contextAware); ok {
		return cc.ClientConfigWithContext(ctx)
	}

	type result struct {
		cfg *rest.Config
		err error
	}
	ch := make(chan result, 1)
	go func() {
		c, err := cfg.ClientConfig()
		ch <- result{c, err}
	}()
	select {
	case r := <-ch:
		return r.cfg, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Connect builds (or rebuilds) the clientset for the given context. An empty
// context name selects the current-context from the kubeconfig.
func (c *Client) Connect(contextName string) (ContextInfo, error) {
	cfg := c.loader(contextName)

	// Exec auth plugins (aws-eks, gke-gcloud-auth-plugin, OIDC login, ...) can
	// hang on a slow network or IdP. Bound the whole config load so Connect
	// never freezes the UI waiting on an auth plugin.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	restConfig, err := clientConfigWithContext(ctx, cfg)
	if err != nil {
		return ContextInfo{}, fmt.Errorf("load kubeconfig: %w", err)
	}

	raw, err := cfg.RawConfig()
	if err != nil {
		return ContextInfo{}, fmt.Errorf("read kubeconfig: %w", err)
	}

	clientset, err := kubernetes.NewForConfig(restConfig)
	if err != nil {
		return ContextInfo{}, fmt.Errorf("create client: %w", err)
	}

	// The metrics client talks to the Metrics API (metrics-server), built from
	// the same rest config. A missing metrics-server never fails Connect: the
	// individual metrics calls surface that as an unavailable API instead.
	metricsClient, err := metricsclient.NewForConfig(restConfig)
	if err != nil {
		return ContextInfo{}, fmt.Errorf("create metrics client: %w", err)
	}

	current := contextName
	if current == "" {
		current = raw.CurrentContext
	}

	c.mu.Lock()
	c.clientset = clientset
	c.metrics = metricsClient
	c.rawConfig = raw
	c.current = current
	c.mu.Unlock()

	return c.contextInfo(current), nil
}

// contextInfo builds a ContextInfo for the named context from the raw config.
func (c *Client) contextInfo(name string) ContextInfo {
	info := ContextInfo{Name: name, Current: name == c.current}
	if ctx, ok := c.rawConfig.Contexts[name]; ok && ctx != nil {
		info.Cluster = ctx.Cluster
		info.User = ctx.AuthInfo
		info.Namespace = ctx.Namespace
	}
	return info
}

// Contexts lists every context found in the kubeconfig.
func (c *Client) Contexts() ([]ContextInfo, error) {
	raw, err := c.loader("").RawConfig()
	if err != nil {
		return nil, fmt.Errorf("read kubeconfig: %w", err)
	}

	c.mu.RLock()
	current := c.current
	c.mu.RUnlock()
	if current == "" {
		current = raw.CurrentContext
	}

	out := make([]ContextInfo, 0, len(raw.Contexts))
	for name, ctx := range raw.Contexts {
		info := ContextInfo{Name: name, Current: name == current}
		if ctx != nil {
			info.Cluster = ctx.Cluster
			info.User = ctx.AuthInfo
			info.Namespace = ctx.Namespace
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// clientOrErr returns the active clientset or an error if not connected.
func (c *Client) clientOrErr() (kubernetes.Interface, error) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if c.clientset == nil {
		return nil, fmt.Errorf("not connected to a cluster")
	}
	return c.clientset, nil
}

// Namespaces returns every namespace visible to the current credentials.
func (c *Client) Namespaces(ctx context.Context) ([]NamespaceInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().Namespaces().List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	out := make([]NamespaceInfo, 0, len(list.Items))
	for i := range list.Items {
		ns := &list.Items[i]
		out = append(out, NamespaceInfo{
			Name:   ns.Name,
			Status: string(ns.Status.Phase),
			Age:    age(ns.CreationTimestamp),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// DeleteNamespace removes a namespace and everything it contains. Deletion is
// asynchronous: the API server marks the namespace Terminating and reclaims its
// contents in the background, so a nil error means the request was accepted,
// not that removal has completed.
func (c *Client) DeleteNamespace(ctx context.Context, name string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	return cs.CoreV1().Namespaces().Delete(ctx, name, metav1.DeleteOptions{})
}

// DeletePod removes a pod, causing its controller to recreate it. For pods
// with no controller (bare pods) this permanently removes it.
func (c *Client) DeletePod(ctx context.Context, namespace, name string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	return cs.CoreV1().Pods(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// Pods returns the pods in a namespace with a summarised status.
func (c *Client) Pods(ctx context.Context, namespace string) ([]PodInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().Pods(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	out := make([]PodInfo, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, summarisePod(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Pod returns the full describe-style detail of a single pod.
func (c *Client) Pod(ctx context.Context, namespace, name string) (PodDetail, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return PodDetail{}, err
	}

	p, err := cs.CoreV1().Pods(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return PodDetail{}, err
	}

	detail := PodDetail{
		Name:        p.Name,
		Namespace:   p.Namespace,
		Phase:       string(p.Status.Phase),
		Node:        p.Spec.NodeName,
		PodIP:       p.Status.PodIP,
		HostIP:      p.Status.HostIP,
		ServiceAcct: p.Spec.ServiceAccountName,
		QOSClass:    string(p.Status.QOSClass),
		Age:         age(p.CreationTimestamp),
		Labels:      p.Labels,
	}

	for _, cond := range p.Status.Conditions {
		detail.Conditions = append(detail.Conditions, PodConditionInfo{
			Type:   string(cond.Type),
			Status: string(cond.Status),
			Reason: cond.Reason,
		})
	}

	for i := range p.Status.ContainerStatuses {
		cs := &p.Status.ContainerStatuses[i]
		info := ContainerStatusInfo{
			Name:         cs.Name,
			Image:        cs.Image,
			Ready:        cs.Ready,
			RestartCount: cs.RestartCount,
		}
		switch {
		case cs.State.Running != nil:
			info.State = "Running"
		case cs.State.Waiting != nil:
			info.State = "Waiting"
			info.StateReason = cs.State.Waiting.Reason
			info.StateMessage = cs.State.Waiting.Message
		case cs.State.Terminated != nil:
			info.State = "Terminated"
			info.StateReason = cs.State.Terminated.Reason
			info.StateMessage = cs.State.Terminated.Message
		}
		detail.Containers = append(detail.Containers, info)
	}

	return detail, nil
}

// Secrets returns secret metadata (names, types, keys) without values.
func (c *Client) Secrets(ctx context.Context, namespace string) ([]SecretInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().Secrets(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	out := make([]SecretInfo, 0, len(list.Items))
	for i := range list.Items {
		s := &list.Items[i]
		keys := make([]string, 0, len(s.Data))
		for k := range s.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		out = append(out, SecretInfo{
			Name: s.Name,
			Type: string(s.Type),
			Keys: keys,
			Age:  age(s.CreationTimestamp),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// Secret returns a single secret with its values decoded to UTF-8 strings.
func (c *Client) Secret(ctx context.Context, namespace, name string) (SecretDetail, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return SecretDetail{}, err
	}

	s, err := cs.CoreV1().Secrets(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return SecretDetail{}, err
	}

	return decodeSecret(s), nil
}

// decodeSecret converts a corev1.Secret into a SecretDetail. Values that are
// valid UTF-8 are decoded to text; everything else is flagged binary. Every
// entry also carries the raw base64 of the stored bytes so the UI can show
// exact values in base64 mode (and display binary data at all).
func decodeSecret(s *corev1.Secret) SecretDetail {
	entries := make([]SecretEntry, 0, len(s.Data))
	for k, v := range s.Data {
		entry := SecretEntry{Key: k, Base64: base64.StdEncoding.EncodeToString(v)}
		if utf8.Valid(v) {
			entry.Value = string(v)
		} else {
			entry.IsBinary = true
			entry.Value = fmt.Sprintf("<%d bytes of binary data>", len(v))
		}
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Key < entries[j].Key })

	return SecretDetail{
		Name:    s.Name,
		Type:    string(s.Type),
		Entries: entries,
	}
}

// summarisePod condenses a corev1.Pod into a PodInfo.
func summarisePod(p *corev1.Pod) PodInfo {
	var ready, total, restarts int32
	for i := range p.Status.ContainerStatuses {
		cs := &p.Status.ContainerStatuses[i]
		total++
		if cs.Ready {
			ready++
		}
		restarts += cs.RestartCount
	}

	containers := make([]string, 0, len(p.Spec.Containers))
	for i := range p.Spec.Containers {
		containers = append(containers, p.Spec.Containers[i].Name)
	}

	// Derive the top-level owner so the UI can tell the user whether deleting
	// will cause a recreation or a permanent removal.
	owner := ""
	if refs := p.OwnerReferences; len(refs) > 0 {
		owner = refs[0].Kind + "/" + refs[0].Name
	}

	return PodInfo{
		Name:       p.Name,
		Namespace:  p.Namespace,
		Phase:      string(p.Status.Phase),
		Ready:      fmt.Sprintf("%d/%d", ready, total),
		Restarts:   restarts,
		Age:        age(p.CreationTimestamp),
		Node:       p.Spec.NodeName,
		Owner:      owner,
		Containers: containers,
	}
}

// age renders a compact human-readable duration since t (e.g. "3d", "5m").
func age(t metav1.Time) string {
	if t.IsZero() {
		return ""
	}
	d := time.Since(t.Time)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}
