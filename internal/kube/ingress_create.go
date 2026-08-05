package kube

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
)

// CreateIngress creates an Ingress from the user-facing spec. The user
// chooses everything — class, host rules, TLS, default backend, annotations,
// labels; nothing is inferred. Only service backends are supported; a rule
// needs at least one path, and the ingress needs at least one rule or a
// default backend (what the API server requires).
func (c *Client) CreateIngress(ctx context.Context, namespace string, spec IngressCreate) error {
	if err := validateIngress(spec); err != nil {
		return err
	}
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	_, err = cs.NetworkingV1().Ingresses(namespace).Create(ctx, buildIngress(namespace, spec), metav1.CreateOptions{})
	return err
}

// RenderIngressYAML renders the exact manifest CreateIngress would apply,
// cleaned for drafting (like RenderServiceYAML). Pure serialization.
func (c *Client) RenderIngressYAML(namespace string, spec IngressCreate) (string, error) {
	if err := validateIngress(spec); err != nil {
		return "", err
	}
	return renderCleanYAML(buildIngress(namespace, spec))
}

// UpdateIngress replaces the fields the form owns (ingress class, rules, TLS,
// default backend, annotations, labels) on an existing Ingress. Everything
// else — identity, status, finalizers — is left to the server. The user sees
// the full replacement in the YAML preview before confirming.
func (c *Client) UpdateIngress(ctx context.Context, namespace, name string, spec IngressCreate) error {
	if err := validateIngress(spec); err != nil {
		return err
	}
	if spec.Name != name {
		return fmt.Errorf("ingress name %q does not match the update target %q", spec.Name, name)
	}
	cs, err := c.clientOrErr()
	if err != nil {
		return err
	}
	cur, err := cs.NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}

	built := buildIngress(namespace, spec)
	cur.Spec.IngressClassName = built.Spec.IngressClassName
	cur.Spec.Rules = built.Spec.Rules
	cur.Spec.TLS = built.Spec.TLS
	cur.Spec.DefaultBackend = built.Spec.DefaultBackend
	cur.Annotations = built.Annotations
	cur.Labels = built.Labels

	_, err = cs.NetworkingV1().Ingresses(namespace).Update(ctx, cur, metav1.UpdateOptions{})
	return err
}

// IngressClasses returns the names of the cluster's IngressClasses, sorted.
// The caller decides what to do when the list cannot be read (RBAC) — the
// error is returned, never swallowed.
func (c *Client) IngressClasses(ctx context.Context) ([]string, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}
	list, err := cs.NetworkingV1().IngressClasses().List(ctx, listOptions())
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, list.Items[i].Name)
	}
	sort.Strings(out)
	return out, nil
}

// IngressEditSpec loads an existing Ingress into the form shape. Constructs
// the form cannot express (a path or default backend using a resource
// backend instead of a service) are kept in the form with empty service
// fields and listed in Unsupported, so the user must resolve them explicitly
// before saving — nothing is dropped silently.
func (c *Client) IngressEditSpec(ctx context.Context, namespace, name string) (IngressEditSpec, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return IngressEditSpec{}, err
	}
	ing, err := cs.NetworkingV1().Ingresses(namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return IngressEditSpec{}, err
	}

	var unsupported []string
	spec := IngressCreate{
		Name:        ing.Name,
		Annotations: copyMap(ing.Annotations),
		Labels:      copyMap(ing.Labels),
		Rules:       []IngressRuleCreate{},
		TLS:         []IngressTLSCreate{},
	}
	if ing.Spec.IngressClassName != nil {
		spec.IngressClassName = *ing.Spec.IngressClassName
	}

	for _, t := range ing.Spec.TLS {
		if len(t.Hosts) == 0 && t.SecretName == "" {
			// A TLS block with neither hosts nor a secret means "default
			// certificate for all hosts" — legal but not expressible as a
			// form row. It loads as an empty row and is dropped on save,
			// which is only OK with an explicit warning.
			unsupported = append(unsupported,
				"A TLS block with no hosts and no secret (default certificate for all hosts) cannot be expressed in this form — enter hosts or a secret for it, or remove the row.")
		}
		spec.TLS = append(spec.TLS, IngressTLSCreate{Hosts: t.Hosts, SecretName: t.SecretName})
	}

	for _, rule := range ing.Spec.Rules {
		r := IngressRuleCreate{Host: rule.Host, Paths: []IngressPathCreate{}}
		if rule.HTTP != nil {
			for _, p := range rule.HTTP.Paths {
				ip := IngressPathCreate{Path: p.Path, ServicePort: ""}
				if p.PathType != nil {
					ip.PathType = string(*p.PathType)
				}
				if p.Backend.Service != nil {
					ip.ServiceName = p.Backend.Service.Name
					ip.ServicePort = backendPortText(p.Backend.Service.Port)
				} else {
					unsupported = append(unsupported, fmt.Sprintf(
						"Host %s, path %s uses a non-service backend (e.g. a resource backend), which the form cannot express — enter a service for it or remove the row.",
						displayHost(rule.Host), displayPath(p.Path)))
				}
				r.Paths = append(r.Paths, ip)
			}
		}
		spec.Rules = append(spec.Rules, r)
	}

	if db := ing.Spec.DefaultBackend; db != nil {
		if db.Service != nil {
			spec.DefaultBackend = &IngressBackendCreate{
				ServiceName: db.Service.Name,
				ServicePort: backendPortText(db.Service.Port),
			}
		} else {
			// Resource default backend: mapped as enabled-with-empty-fields so
			// validation blocks saving until the user enters a service or
			// unchecks the default backend — nothing is dropped silently.
			spec.DefaultBackend = &IngressBackendCreate{}
			unsupported = append(unsupported,
				"The default backend is a resource backend, which the form cannot express — enter a service for it, or uncheck the default backend to remove it.")
		}
	}

	return IngressEditSpec{Spec: spec, Unsupported: unsupported}, nil
}

// copyMap returns a shallow copy of m, or an empty map for nil input, so the
// form always has a non-nil map to bind rows against.
func copyMap(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// displayHost renders an empty rule host as "*" (the effective "all hosts").
func displayHost(h string) string {
	if h == "" {
		return "*"
	}
	return h
}

// backendPortText renders a ServiceBackendPort as text ("number" or "name"),
// the inverse of the form's port parsing.
func backendPortText(p networkingv1.ServiceBackendPort) string {
	if p.Name != "" {
		return p.Name
	}
	return strconv.Itoa(int(p.Number))
}

// stringPtr returns a pointer to s for optional string fields.
func stringPtr(s string) *string { return &s }

// validateHost checks an ingress host: it may be a precise DNS subdomain
// (example.com) or a wildcard (*.example.com), matching the documented
// Ingress hostname rules.
func validateHost(host, what string) error {
	if host == "" {
		return nil
	}
	if strings.HasPrefix(host, "*.") {
		if errs := validation.IsWildcardDNS1123Subdomain(host); len(errs) > 0 {
			return fmt.Errorf("invalid %s %q: %s", what, host, errs[0])
		}
		return nil
	}
	if errs := validation.IsDNS1123Subdomain(host); len(errs) > 0 {
		return fmt.Errorf("invalid %s %q: %s", what, host, errs[0])
	}
	return nil
}

// validateIngress checks the fields the form produces, mirroring what the
// API server enforces for networking.k8s.io/v1. Service ports may be a
// number (1-65535) or a named port (IANA service name); hosts may be a DNS
// subdomain or a wildcard like *.example.com.
func validateIngress(spec IngressCreate) error {
	if errs := validation.IsDNS1123Label(spec.Name); len(errs) > 0 {
		return fmt.Errorf("invalid ingress name %q: %s", spec.Name, errs[0])
	}

	if len(spec.Rules) == 0 && spec.DefaultBackend == nil {
		return errors.New("an ingress needs at least one rule or a default backend")
	}

	for ri, rule := range spec.Rules {
		if err := validateHost(rule.Host, "host"); err != nil {
			return fmt.Errorf("rule %d: %w", ri+1, err)
		}
		if len(rule.Paths) == 0 {
			return fmt.Errorf("host %s (rule %d) needs at least one path", displayHost(rule.Host), ri+1)
		}
		for pi, p := range rule.Paths {
			if err := validatePath(p); err != nil {
				return fmt.Errorf("host %s, path %q (rule %d, path %d): %w", displayHost(rule.Host), p.Path, ri+1, pi+1, err)
			}
		}
	}

	for _, t := range spec.TLS {
		for _, h := range t.Hosts {
			if err := validateHost(h, "TLS host"); err != nil {
				return err
			}
		}
		if t.SecretName != "" {
			if errs := validation.IsDNS1123Subdomain(t.SecretName); len(errs) > 0 {
				return fmt.Errorf("invalid TLS secret name %q: %s", t.SecretName, errs[0])
			}
		}
	}

	if db := spec.DefaultBackend; db != nil {
		if err := validateBackend(db.ServiceName, db.ServicePort); err != nil {
			return fmt.Errorf("default backend: %w", err)
		}
	}

	for kind, m := range map[string]map[string]string{"annotation": spec.Annotations, "label": spec.Labels} {
		for k, v := range m {
			if errs := validation.IsQualifiedName(k); len(errs) > 0 {
				return fmt.Errorf("invalid %s key %q: %s", kind, k, errs[0])
			}
			if kind == "label" {
				if errs := validation.IsValidLabelValue(v); len(errs) > 0 {
					return fmt.Errorf("invalid value %q for label %q: %s", v, k, errs[0])
				}
			}
		}
	}

	return nil
}

// validatePath checks one path rule: the path must start with "/" (for
// Prefix/Exact; empty is allowed only for ImplementationSpecific, matching
// the API server), the path type must be a real one, and the backend must
// name a service and a port.
func validatePath(p IngressPathCreate) error {
	switch p.PathType {
	case string(networkingv1.PathTypePrefix), string(networkingv1.PathTypeExact), string(networkingv1.PathTypeImplementationSpecific):
	case "":
		return errors.New("path type is required (Prefix, Exact or ImplementationSpecific)")
	default:
		return fmt.Errorf("invalid path type %q (want Prefix, Exact or ImplementationSpecific)", p.PathType)
	}
	if p.Path != "" && !strings.HasPrefix(p.Path, "/") {
		return errors.New("path must start with \"/\" (use \"/\" for the root)")
	}
	if p.Path == "" && p.PathType != string(networkingv1.PathTypeImplementationSpecific) {
		return errors.New("path must start with \"/\" (use \"/\" for the root)")
	}
	return validateBackend(p.ServiceName, p.ServicePort)
}

// validateBackend checks a service backend reference: a name and a port that
// is either a number in 1-65535 or a named port (IANA service name).
func validateBackend(serviceName, servicePort string) error {
	if errs := validation.IsDNS1123Label(serviceName); len(errs) > 0 {
		return fmt.Errorf("backend service name %q is not a valid service name", serviceName)
	}
	if servicePort == "" {
		return errors.New("backend port is required (a number or a named port)")
	}
	if n, err := strconv.Atoi(servicePort); err == nil {
		if n < 1 || n > 65535 {
			return errors.New("backend port must be a number between 1 and 65535, or a named port")
		}
		return nil
	}
	if errs := validation.IsValidPortName(servicePort); len(errs) > 0 {
		return fmt.Errorf("backend port %q is neither a port number (1-65535) nor a valid service port name", servicePort)
	}
	return nil
}

// buildIngress turns the form spec into an Ingress object. Empty fields stay
// empty so the preview only shows what the user chose. A backend port is
// parsed: digits become a port number, anything else a named port.
func buildIngress(namespace string, spec IngressCreate) *networkingv1.Ingress {
	ing := &networkingv1.Ingress{
		TypeMeta:   metav1.TypeMeta{APIVersion: "networking.k8s.io/v1", Kind: "Ingress"},
		ObjectMeta: metav1.ObjectMeta{Name: spec.Name, Namespace: namespace},
		Spec:       networkingv1.IngressSpec{},
	}
	if spec.IngressClassName != "" {
		ing.Spec.IngressClassName = stringPtr(spec.IngressClassName)
	}
	if len(spec.Annotations) > 0 {
		ing.Annotations = spec.Annotations
	}
	if len(spec.Labels) > 0 {
		ing.Labels = spec.Labels
	}

	for _, t := range spec.TLS {
		ing.Spec.TLS = append(ing.Spec.TLS, networkingv1.IngressTLS{
			Hosts:      t.Hosts,
			SecretName: t.SecretName,
		})
	}

	for _, rule := range spec.Rules {
		r := networkingv1.IngressRule{Host: rule.Host}
		paths := make([]networkingv1.HTTPIngressPath, 0, len(rule.Paths))
		for _, p := range rule.Paths {
			pt := networkingv1.PathType(p.PathType)
			paths = append(paths, networkingv1.HTTPIngressPath{
				Path:     p.Path,
				PathType: &pt,
				Backend:  buildBackend(p.ServiceName, p.ServicePort),
			})
		}
		r.HTTP = &networkingv1.HTTPIngressRuleValue{Paths: paths}
		ing.Spec.Rules = append(ing.Spec.Rules, r)
	}

	if db := spec.DefaultBackend; db != nil {
		ing.Spec.DefaultBackend = &networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{
			Name: db.ServiceName,
			Port: parseBackendPort(db.ServicePort),
		}}
	}

	return ing
}

// buildBackend builds an IngressBackend pointing at a service.
func buildBackend(serviceName, servicePort string) networkingv1.IngressBackend {
	return networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{
		Name: serviceName,
		Port: parseBackendPort(servicePort),
	}}
}

// parseBackendPort parses the form's port text into a ServiceBackendPort.
// Only called after validation, so a numeric string is always in range and a
// non-numeric string is a valid port name.
func parseBackendPort(port string) networkingv1.ServiceBackendPort {
	if n, err := strconv.Atoi(port); err == nil {
		return networkingv1.ServiceBackendPort{Number: int32(n)}
	}
	return networkingv1.ServiceBackendPort{Name: port}
}
