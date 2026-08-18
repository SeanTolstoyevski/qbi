package kube

import (
	"context"
	"fmt"
	"sort"
	"strings"

	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Services returns the services in a namespace, each enriched with its
// in-cluster DNS name and the pod IPs currently backing it (endpoints).
func (c *Client) Services(ctx context.Context, namespace string) ([]ServiceInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	list, err := cs.CoreV1().Services(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	epByName, err := readyEndpointIPs(ctx, cs, namespace)
	if err != nil {
		epByName = nil
	}

	out := make([]ServiceInfo, 0, len(list.Items))
	for i := range list.Items {
		s := &list.Items[i]

		ports := make([]ServicePort, 0, len(s.Spec.Ports))
		for _, p := range s.Spec.Ports {
			ports = append(ports, ServicePort{
				Name:       p.Name,
				Protocol:   string(p.Protocol),
				Port:       p.Port,
				TargetPort: p.TargetPort.String(),
				NodePort:   p.NodePort,
			})
		}

		out = append(out, ServiceInfo{
			Name:        s.Name,
			Namespace:   s.Namespace,
			Type:        string(s.Spec.Type),
			ClusterIP:   s.Spec.ClusterIP,
			ExternalIPs: s.Spec.ExternalIPs,
			DNSName:     fmt.Sprintf("%s.%s.svc.cluster.local", s.Name, s.Namespace),
			Ports:       ports,
			Selector:    s.Spec.Selector,
			Endpoints:   epByName[s.Name],
			Age:         age(s.CreationTimestamp),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// DeleteService removes a Service from the namespace. Backing pods are
// untouched — only the load-balancing entry is removed.
func (c *Client) DeleteService(ctx context.Context, namespace, name string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	return cs.CoreV1().Services(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// DeleteIngress removes an Ingress (its routing rules) from the namespace.
// The services and pods it routed to are untouched — only the rules are
// removed, so traffic stops being routed through them.
func (c *Client) DeleteIngress(ctx context.Context, namespace, name string) error {
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	return cs.NetworkingV1().Ingresses(namespace).Delete(ctx, name, metav1.DeleteOptions{})
}

// ingressHealth carries the namespace-wide lookups needed to verify the
// backends and TLS secrets referenced by ingresses. A nil map means that
// particular lookup failed (RBAC or API error); statuses degrade to "unknown"
// instead of falsely reporting a resource as missing.
type ingressHealth struct {
	services  map[string]bool
	endpoints map[string][]string // ready backing pod IPs per service
	secrets   map[string]bool
}

// degraded reports whether any lookup failed, so callers can add a single
// "health could not be fully checked" note instead of guessing.
func (h *ingressHealth) degraded() bool {
	return h.services == nil || h.endpoints == nil || h.secrets == nil
}

// backendStatus returns the health of a backend service and its ready
// endpoint count. Vocabulary: ok | no-service | no-endpoints | unknown.
func (h *ingressHealth) backendStatus(serviceName string) (string, int) {
	if serviceName == "" || h.services == nil {
		return "unknown", 0
	}
	if !h.services[serviceName] {
		return "no-service", 0
	}
	if h.endpoints == nil {
		return "unknown", 0
	}
	ready := len(h.endpoints[serviceName])
	if ready == 0 {
		return "no-endpoints", 0
	}
	return "ok", ready
}

// secretStatus reports whether a TLS secret exists in the namespace.
// Vocabulary: ok | missing | unknown.
func (h *ingressHealth) secretStatus(secretName string) string {
	if secretName == "" || h.secrets == nil {
		return "unknown"
	}
	if !h.secrets[secretName] {
		return "missing"
	}
	return "ok"
}

// loadIngressHealth fetches services, EndpointSlices and secrets once per
// namespace so every ingress can be checked without an N+1 fan-out.
func loadIngressHealth(ctx context.Context, cs kubernetes.Interface, namespace string) *ingressHealth {
	h := &ingressHealth{}

	svcList, err := cs.CoreV1().Services(namespace).List(ctx, listOptions())
	if err != nil {
		return h
	}
	h.services = map[string]bool{}
	for i := range svcList.Items {
		h.services[svcList.Items[i].Name] = true
	}

	epByName, err := readyEndpointIPs(ctx, cs, namespace)
	if err != nil {
		return h
	}
	h.endpoints = epByName

	secList, err := cs.CoreV1().Secrets(namespace).List(ctx, listOptions())
	if err != nil {
		return h
	}
	h.secrets = map[string]bool{}
	for i := range secList.Items {
		h.secrets[secList.Items[i].Name] = true
	}

	return h
}

func readyEndpointIPs(ctx context.Context, cs kubernetes.Interface, namespace string) (map[string][]string, error) {
	list, err := cs.DiscoveryV1().EndpointSlices(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	perService := map[string]map[string]struct{}{}
	for i := range list.Items {
		es := &list.Items[i]
		svc := es.Labels[discoveryv1.LabelServiceName]
		if svc == "" {
			continue
		}

		if es.AddressType != discoveryv1.AddressTypeIPv4 && es.AddressType != discoveryv1.AddressTypeIPv6 {
			continue
		}
		set := perService[svc]
		if set == nil {
			set = map[string]struct{}{}
			perService[svc] = set
		}
		for _, ep := range es.Endpoints {
			if ep.Conditions.Ready != nil && !*ep.Conditions.Ready {
				continue
			}
			for _, a := range ep.Addresses {
				set[a] = struct{}{}
			}
		}
	}

	out := make(map[string][]string, len(perService))
	for svc, set := range perService {
		addrs := make([]string, 0, len(set))
		for a := range set {
			addrs = append(addrs, a)
		}
		sort.Strings(addrs)
		out[svc] = addrs
	}
	return out, nil
}

// backendPort renders a ServiceBackendPort as text ("name" or "number").
func backendPort(p networkingv1.ServiceBackendPort) string {
	if p.Name != "" {
		return p.Name
	}
	return fmt.Sprintf("%d", p.Number)
}

// displayPath renders an empty ingress path as "/", the effective default.
func displayPath(p string) string {
	if p == "" {
		return "/"
	}
	return p
}

// enrichIngress builds the user-facing IngressInfo for one ingress, checking
// TLS secrets and backend services against the namespace-wide health index.
func enrichIngress(ing *networkingv1.Ingress, h *ingressHealth) IngressInfo {
	info := IngressInfo{
		Name:        ing.Name,
		Namespace:   ing.Namespace,
		Age:         age(ing.CreationTimestamp),
		Annotations: map[string]string{},
		// Empty slices, never nil: a nil slice marshals to JSON null, which
		// would crash frontend `.length` checks for exactly the broken
		// ingresses this view exists to surface (e.g. one with no rules).
		Addresses: []string{},
		TLS:       []IngressTLS{},
		Rules:     []IngressRule{},
		Issues:    []string{},
	}
	if ing.Spec.IngressClassName != nil {
		info.Class = *ing.Spec.IngressClassName
	}

	// Keep every load balancer entry; an ingress can legitimately be backed by
	// several (dual-stack, multiple LB replicas), and dropping all but the
	// last one hid real addresses.
	for _, lb := range ing.Status.LoadBalancer.Ingress {
		switch {
		case lb.Hostname != "":
			info.Addresses = append(info.Addresses, lb.Hostname)
		case lb.IP != "":
			info.Addresses = append(info.Addresses, lb.IP)
		}
	}

	for k, v := range ing.Annotations {
		info.Annotations[k] = v
	}

	// TLS: the hosts each secret serves, checked for existence.
	for _, t := range ing.Spec.TLS {
		tls := IngressTLS{Hosts: t.Hosts, SecretName: t.SecretName}
		if t.SecretName != "" {
			tls.SecretStatus = h.secretStatus(t.SecretName)
		}
		info.TLS = append(info.TLS, tls)
	}

	for _, rule := range ing.Spec.Rules {
		r := IngressRule{Host: rule.Host}
		if r.Host == "" {
			r.Host = "*" // no host means "all hosts"
		}
		if rule.HTTP != nil {
			for i := range rule.HTTP.Paths {
				r.Paths = append(r.Paths, pathInfo(&rule.HTTP.Paths[i], h))
			}
		}
		info.Rules = append(info.Rules, r)
	}

	if db := ing.Spec.DefaultBackend; db != nil {
		if db.Service != nil {
			status, ready := h.backendStatus(db.Service.Name)
			info.DefaultBackend = &IngressBackend{
				ServiceName:    db.Service.Name,
				ServicePort:    backendPort(db.Service.Port),
				Status:         status,
				ReadyEndpoints: ready,
			}
		} else {
			// Resource backend (not a service) — exists, but nothing to
			// health-check; it must not look like "no default backend".
			info.DefaultBackend = &IngressBackend{Status: "unknown"}
		}
	}

	info.Issues = ingressIssues(&info, h)
	return info
}

// pathInfo converts one HTTP path rule, checking its backend service health.
func pathInfo(p *networkingv1.HTTPIngressPath, h *ingressHealth) IngressPath {
	path := IngressPath{Path: p.Path}
	if p.PathType != nil {
		path.PathType = string(*p.PathType)
	}
	if p.Backend.Service != nil {
		path.ServiceName = p.Backend.Service.Name
		path.ServicePort = backendPort(p.Backend.Service.Port)
		path.Status, path.ReadyEndpoints = h.backendStatus(path.ServiceName)
	} else {
		// Resource backend (not a service) — nothing to health-check.
		path.Status = "unknown"
	}
	return path
}

// ingressIssues turns the health findings into plain-language, standalone
// sentences that a screen reader can read one at a time.
func ingressIssues(info *IngressInfo, h *ingressHealth) []string {
	var issues []string

	if len(info.Addresses) == 0 {
		issues = append(issues,
			"No external address assigned yet. The load balancer may still be provisioning.")
	}
	if len(info.Rules) == 0 && info.DefaultBackend == nil {
		issues = append(issues,
			"No routing rules defined: this ingress forwards no traffic.")
	}

	for _, t := range info.TLS {
		if t.SecretStatus == "missing" {
			hosts := strings.Join(t.Hosts, ", ")
			if hosts == "" {
				hosts = "(all hosts)"
			}
			issues = append(issues, fmt.Sprintf(
				"TLS secret %q not found in this namespace (hosts: %s).", t.SecretName, hosts))
		}
	}

	for _, rule := range info.Rules {
		for _, p := range rule.Paths {
			switch p.Status {
			case "no-service":
				issues = append(issues, fmt.Sprintf(
					"Host %s, path %s routes to service %q, which does not exist in this namespace.",
					rule.Host, displayPath(p.Path), p.ServiceName))
			case "no-endpoints":
				issues = append(issues, fmt.Sprintf(
					"Host %s, path %s routes to service %q, which has no ready endpoints — requests will fail.",
					rule.Host, displayPath(p.Path), p.ServiceName))
			}
		}
	}

	if db := info.DefaultBackend; db != nil {
		switch db.Status {
		case "no-service":
			issues = append(issues, fmt.Sprintf(
				"Default backend service %q does not exist in this namespace.", db.ServiceName))
		case "no-endpoints":
			issues = append(issues, fmt.Sprintf(
				"Default backend service %q has no ready endpoints.", db.ServiceName))
		}
	}

	if h != nil && h.degraded() {
		issues = append(issues,
			"Backend health could not be fully checked (permission or API error).")
	}

	return issues
}

// Ingresses returns the ingresses in a namespace with their addresses, TLS
// entries and routing rules, enriched with backend and TLS health checks.
func (c *Client) Ingresses(ctx context.Context, namespace string) ([]IngressInfo, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	list, err := cs.NetworkingV1().Ingresses(namespace).List(ctx, listOptions())
	if err != nil {
		return nil, err
	}

	h := loadIngressHealth(ctx, cs, namespace)

	out := make([]IngressInfo, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, enrichIngress(&list.Items[i], h))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// IngressDetail returns the full inspection view of one ingress: the enriched
// ingress plus the events referencing it. Events are best-effort: if they
// cannot be read, the ingress information still loads and EventsError carries
// the reason.
func (c *Client) IngressDetail(ctx context.Context, namespace, name string) (IngressDetail, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return IngressDetail{}, err
	}

	ing, err := cs.NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return IngressDetail{}, err
	}

	h := loadIngressHealth(ctx, cs, namespace)
	detail := IngressDetail{Ingress: enrichIngress(ing, h)}

	events, err := eventsForObject(ctx, cs, namespace, "Ingress", name)
	if err != nil {
		detail.EventsError = err.Error()
	} else {
		detail.Events = events
	}
	return detail, nil
}
