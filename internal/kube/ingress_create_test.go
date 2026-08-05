package kube

import (
	"context"
	"errors"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// validIngressSpec is a minimal spec every validation test can build on.
func validIngressSpec() IngressCreate {
	return IngressCreate{
		Name: "web",
		Rules: []IngressRuleCreate{{
			Host: "example.com",
			Paths: []IngressPathCreate{{
				Path:        "/",
				PathType:    string(networkingv1.PathTypePrefix),
				ServiceName: "web",
				ServicePort: "80",
			}},
		}},
	}
}

func TestValidateIngress(t *testing.T) {
	tests := []struct {
		name    string
		mutate  func(*IngressCreate)
		wantErr string // substring; empty means valid
	}{
		{name: "minimal valid", mutate: func(*IngressCreate) {}},
		{name: "empty name", mutate: func(s *IngressCreate) { s.Name = "" }, wantErr: "invalid ingress name"},
		{name: "invalid name with uppercase", mutate: func(s *IngressCreate) { s.Name = "My-Ingress" }, wantErr: "invalid ingress name"},
		{name: "invalid name with underscore", mutate: func(s *IngressCreate) { s.Name = "my_ingress" }, wantErr: "invalid ingress name"},
		{name: "no rules and no default backend", mutate: func(s *IngressCreate) { s.Rules = nil }, wantErr: "at least one rule or a default backend"},
		{name: "rule without paths", mutate: func(s *IngressCreate) { s.Rules[0].Paths = nil }, wantErr: "needs at least one path"},
		{name: "missing path type", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].PathType = "" }, wantErr: "path type is required"},
		{name: "invalid path type", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].PathType = "StartsWith" }, wantErr: "invalid path type"},
		{name: "path without leading slash", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].Path = "api" }, wantErr: "path must start with"},
		{name: "empty path with Prefix", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].Path = "" }, wantErr: "path must start with"},
		{name: "empty path allowed for ImplementationSpecific", mutate: func(s *IngressCreate) {
			s.Rules[0].Paths[0].Path = ""
			s.Rules[0].Paths[0].PathType = string(networkingv1.PathTypeImplementationSpecific)
		}},
		{name: "invalid host", mutate: func(s *IngressCreate) { s.Rules[0].Host = "not a host!" }, wantErr: "invalid host"},
		{name: "wildcard host valid", mutate: func(s *IngressCreate) { s.Rules[0].Host = "*.example.com" }},
		{name: "empty host (all hosts) valid", mutate: func(s *IngressCreate) { s.Rules[0].Host = "" }},
		{name: "missing service name", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].ServiceName = "" }, wantErr: "backend service name"},
		{name: "port out of range", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].ServicePort = "70000" }, wantErr: "between 1 and 65535"},
		{name: "port zero", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].ServicePort = "0" }, wantErr: "between 1 and 65535"},
		{name: "named port valid", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].ServicePort = "http" }},
		{name: "invalid named port", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].ServicePort = "HTTP_Port" }, wantErr: "neither a port number"},
		{name: "missing port", mutate: func(s *IngressCreate) { s.Rules[0].Paths[0].ServicePort = "" }, wantErr: "backend port is required"},
		{name: "tls invalid host", mutate: func(s *IngressCreate) {
			s.TLS = []IngressTLSCreate{{Hosts: []string{"bad host!"}, SecretName: "tls"}}
		}, wantErr: "invalid TLS host"},
		{name: "tls valid", mutate: func(s *IngressCreate) {
			s.TLS = []IngressTLSCreate{{Hosts: []string{"example.com", "*.internal"}, SecretName: "web-tls"}}
		}},
		{name: "tls with secret only valid", mutate: func(s *IngressCreate) {
			s.TLS = []IngressTLSCreate{{SecretName: "web-tls"}}
		}},
		{name: "default backend valid", mutate: func(s *IngressCreate) {
			s.Rules = nil
			s.DefaultBackend = &IngressBackendCreate{ServiceName: "web", ServicePort: "http"}
		}},
		{name: "default backend invalid port", mutate: func(s *IngressCreate) {
			s.Rules = nil
			s.DefaultBackend = &IngressBackendCreate{ServiceName: "web", ServicePort: "99999"}
		}, wantErr: "default backend"},
		{name: "invalid annotation key", mutate: func(s *IngressCreate) {
			s.Annotations = map[string]string{"bad key!": "v"}
		}, wantErr: "invalid annotation key"},
		{name: "annotations valid", mutate: func(s *IngressCreate) {
			s.Annotations = map[string]string{"nginx.ingress.kubernetes.io/rewrite-target": "/"}
		}},
		{name: "invalid label value", mutate: func(s *IngressCreate) {
			s.Labels = map[string]string{"team": "R&D!"}
		}, wantErr: "invalid value"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spec := validIngressSpec()
			tt.mutate(&spec)
			err := validateIngress(spec)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("expected valid, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("expected error containing %q, got %q", tt.wantErr, err.Error())
			}
		})
	}
}

func TestBuildIngress(t *testing.T) {
	spec := IngressCreate{
		Name:             "web",
		IngressClassName: "nginx",
		Rules: []IngressRuleCreate{{
			Host: "example.com",
			Paths: []IngressPathCreate{
				{Path: "/", PathType: string(networkingv1.PathTypePrefix), ServiceName: "web", ServicePort: "80"},
				{Path: "/api", PathType: string(networkingv1.PathTypeExact), ServiceName: "api", ServicePort: "http"},
			},
		}},
		TLS: []IngressTLSCreate{{Hosts: []string{"example.com"}, SecretName: "web-tls"}},
		DefaultBackend: &IngressBackendCreate{
			ServiceName: "fallback", ServicePort: "8080",
		},
		Annotations: map[string]string{"nginx.ingress.kubernetes.io/rewrite-target": "/"},
		Labels:      map[string]string{"app": "web"},
	}

	ing := buildIngress("default", spec)

	if ing.Name != "web" || ing.Namespace != "default" {
		t.Fatalf("bad metadata: %+v", ing.ObjectMeta)
	}
	if ing.Spec.IngressClassName == nil || *ing.Spec.IngressClassName != "nginx" {
		t.Fatalf("class not set: %v", ing.Spec.IngressClassName)
	}
	if ing.Annotations["nginx.ingress.kubernetes.io/rewrite-target"] != "/" {
		t.Fatalf("annotations not set: %v", ing.Annotations)
	}
	if ing.Labels["app"] != "web" {
		t.Fatalf("labels not set: %v", ing.Labels)
	}
	if len(ing.Spec.Rules) != 1 || len(ing.Spec.Rules[0].HTTP.Paths) != 2 {
		t.Fatalf("rules not built: %+v", ing.Spec.Rules)
	}
	p0 := ing.Spec.Rules[0].HTTP.Paths[0]
	if p0.Path != "/" || p0.PathType == nil || *p0.PathType != networkingv1.PathTypePrefix {
		t.Fatalf("path 0 wrong: %+v", p0)
	}
	if p0.Backend.Service == nil || p0.Backend.Service.Name != "web" || p0.Backend.Service.Port.Number != 80 {
		t.Fatalf("path 0 backend wrong: %+v", p0.Backend)
	}
	p1 := ing.Spec.Rules[0].HTTP.Paths[1]
	if p1.Backend.Service.Port.Name != "http" || p1.Backend.Service.Port.Number != 0 {
		t.Fatalf("path 1 named port wrong: %+v", p1.Backend)
	}
	if len(ing.Spec.TLS) != 1 || ing.Spec.TLS[0].SecretName != "web-tls" {
		t.Fatalf("tls not built: %+v", ing.Spec.TLS)
	}
	if ing.Spec.DefaultBackend == nil || ing.Spec.DefaultBackend.Service.Name != "fallback" {
		t.Fatalf("default backend not built: %+v", ing.Spec.DefaultBackend)
	}
}

func TestBuildIngressOmitsEmptyFields(t *testing.T) {
	ing := buildIngress("default", validIngressSpec())
	if ing.Spec.IngressClassName != nil {
		t.Fatalf("empty class must stay nil, got %v", *ing.Spec.IngressClassName)
	}
	if ing.Annotations != nil || ing.Labels != nil {
		t.Fatalf("empty maps must stay nil, got %v %v", ing.Annotations, ing.Labels)
	}
	if ing.Spec.DefaultBackend != nil {
		t.Fatalf("no default backend must stay nil")
	}
}

func TestRenderIngressYAML(t *testing.T) {
	c := newTestClient()
	out, err := c.RenderIngressYAML("default", validIngressSpec())
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	for _, want := range []string{"apiVersion: networking.k8s.io/v1", "kind: Ingress", "name: web", "example.com", "pathType: Prefix"} {
		if !strings.Contains(out, want) {
			t.Fatalf("rendered YAML missing %q:\n%s", want, out)
		}
	}

	spec := validIngressSpec()
	spec.Name = "Bad_Name"
	if _, err := c.RenderIngressYAML("default", spec); err == nil {
		t.Fatal("expected validation error, got nil")
	}
}

func TestCreateIngress(t *testing.T) {
	c := newTestClient()
	err := c.CreateIngress(context.Background(), "default", validIngressSpec())
	if err != nil {
		t.Fatalf("create failed: %v", err)
	}
	got, err := c.clientset.NetworkingV1().Ingresses("default").Get(context.Background(), "web", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}
	if len(got.Spec.Rules) != 1 || got.Spec.Rules[0].Host != "example.com" {
		t.Fatalf("created object wrong: %+v", got.Spec)
	}

	// Invalid specs never reach the cluster.
	c2 := newTestClient()
	bad := validIngressSpec()
	bad.Name = ""
	if err := c2.CreateIngress(context.Background(), "default", bad); err == nil {
		t.Fatal("expected validation error")
	}
}

func TestIngressClasses(t *testing.T) {
	c := newTestClient(
		&networkingv1.IngressClass{ObjectMeta: metav1.ObjectMeta{Name: "traefik"}},
		&networkingv1.IngressClass{ObjectMeta: metav1.ObjectMeta{Name: "nginx"}},
	)
	got, err := c.IngressClasses(context.Background())
	if err != nil {
		t.Fatalf("list failed: %v", err)
	}
	want := []string{"nginx", "traefik"}
	if len(got) != 2 || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("classes = %v, want %v", got, want)
	}

	// A list error (e.g. RBAC) must propagate, never be swallowed.
	c2 := newTestClient()
	c2.clientset.(*fake.Clientset).PrependReactor("list", "ingressclasses", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("ingressclasses.rbac.authorization.k8s.io is forbidden")
	})
	if _, err := c2.IngressClasses(context.Background()); err == nil {
		t.Fatal("expected list error to propagate")
	}
}

func TestIngressEditSpec(t *testing.T) {
	c := newTestClient(testIngress())
	spec, err := c.IngressEditSpec(context.Background(), "default", "web")
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if len(spec.Unsupported) != 0 {
		t.Fatalf("unexpected unsupported entries: %v", spec.Unsupported)
	}
	s := spec.Spec
	if s.Name != "web" || s.IngressClassName != "nginx" {
		t.Fatalf("name/class wrong: %+v", s)
	}
	if s.Annotations["nginx.ingress.kubernetes.io/rewrite-target"] != "/" {
		t.Fatalf("annotations wrong: %v", s.Annotations)
	}
	if len(s.TLS) != 1 || s.TLS[0].SecretName != "web-tls" || len(s.TLS[0].Hosts) != 2 {
		t.Fatalf("tls wrong: %+v", s.TLS)
	}
	if len(s.Rules) != 2 {
		t.Fatalf("rules wrong: %+v", s.Rules)
	}
	r0 := s.Rules[0]
	if r0.Host != "a.example.com" || len(r0.Paths) != 2 {
		t.Fatalf("rule 0 wrong: %+v", r0)
	}
	if r0.Paths[0].Path != "/" || r0.Paths[0].PathType != "Prefix" || r0.Paths[0].ServiceName != "web" || r0.Paths[0].ServicePort != "80" {
		t.Fatalf("path 0 wrong: %+v", r0.Paths[0])
	}
	// Named port round-trips as text.
	if s.Rules[1].Paths[0].ServicePort != "http" {
		t.Fatalf("named port wrong: %+v", s.Rules[1].Paths[0])
	}
}

func TestIngressEditSpecResourceBackend(t *testing.T) {
	ing := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "res", Namespace: "default"},
		Spec: networkingv1.IngressSpec{
			TLS: []networkingv1.IngressTLS{
				{Hosts: nil, SecretName: ""}, // default certificate for all hosts
			},
			Rules: []networkingv1.IngressRule{{
				Host: "example.com",
				IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{{
					Path:     "/static",
					PathType: pathTypePtr(networkingv1.PathTypePrefix),
					Backend: networkingv1.IngressBackend{
						Resource: &corev1.TypedLocalObjectReference{},
					},
				}}}},
			}},
			DefaultBackend: &networkingv1.IngressBackend{Resource: &corev1.TypedLocalObjectReference{}},
		},
	}
	c := newTestClient(ing)
	spec, err := c.IngressEditSpec(context.Background(), "default", "res")
	if err != nil {
		t.Fatalf("load failed: %v", err)
	}
	if len(spec.Unsupported) != 3 {
		t.Fatalf("expected 3 unsupported entries (TLS, path, default backend), got %v", spec.Unsupported)
	}
	if !strings.Contains(spec.Unsupported[0], "default certificate") || !strings.Contains(spec.Unsupported[1], "non-service backend") || !strings.Contains(spec.Unsupported[2], "default backend") {
		t.Fatalf("unsupported entries unclear: %v", spec.Unsupported)
	}
	// The path row stays in the form with empty service fields (user must
	// resolve it) and the resource default backend maps to an enabled block
	// with empty fields (validation blocks saving until resolved). The empty
	// TLS block stays as a row too — dropping it on save is only OK because
	// it was explicitly flagged.
	if len(spec.Spec.Rules) != 1 || spec.Spec.Rules[0].Paths[0].ServiceName != "" {
		t.Fatalf("resource path not mapped for explicit resolution: %+v", spec.Spec.Rules)
	}
	if spec.Spec.DefaultBackend == nil || spec.Spec.DefaultBackend.ServiceName != "" {
		t.Fatalf("resource default backend must map to an empty enabled block: %+v", spec.Spec.DefaultBackend)
	}
	if len(spec.Spec.TLS) != 1 || spec.Spec.TLS[0].SecretName != "" || len(spec.Spec.TLS[0].Hosts) != 0 {
		t.Fatalf("empty TLS block must stay mapped: %+v", spec.Spec.TLS)
	}
}

func TestUpdateIngress(t *testing.T) {
	c := newTestClient(testIngress())
	newSpec := IngressCreate{
		Name: "web",
		Rules: []IngressRuleCreate{{
			Host: "new.example.com",
			Paths: []IngressPathCreate{{
				Path:        "/",
				PathType:    string(networkingv1.PathTypePrefix),
				ServiceName: "web",
				ServicePort: "8080",
			}},
		}},
		Annotations: map[string]string{"cert-manager.io/cluster-issuer": "letsencrypt"},
	}
	err := c.UpdateIngress(context.Background(), "default", "web", newSpec)
	if err != nil {
		t.Fatalf("update failed: %v", err)
	}
	got, err := c.clientset.NetworkingV1().Ingresses("default").Get(context.Background(), "web", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get failed: %v", err)
	}
	// Owned fields replaced.
	if got.Spec.IngressClassName != nil {
		t.Fatalf("class must be cleared, got %v", *got.Spec.IngressClassName)
	}
	if len(got.Spec.Rules) != 1 || got.Spec.Rules[0].Host != "new.example.com" {
		t.Fatalf("rules not replaced: %+v", got.Spec.Rules)
	}
	if got.Spec.Rules[0].HTTP.Paths[0].Backend.Service.Port.Number != 8080 {
		t.Fatalf("port not replaced: %+v", got.Spec.Rules[0].HTTP.Paths[0].Backend)
	}
	if len(got.Spec.TLS) != 0 {
		t.Fatalf("tls not cleared: %+v", got.Spec.TLS)
	}
	if got.Spec.DefaultBackend != nil {
		t.Fatalf("default backend not cleared: %+v", got.Spec.DefaultBackend)
	}
	if len(got.Annotations) != 1 || got.Annotations["cert-manager.io/cluster-issuer"] != "letsencrypt" {
		t.Fatalf("annotations not replaced: %v", got.Annotations)
	}
	// Server-owned state untouched.
	if len(got.Status.LoadBalancer.Ingress) != 2 {
		t.Fatalf("status must be preserved: %+v", got.Status)
	}
	if got.Name != "web" || got.Namespace != "default" {
		t.Fatalf("identity changed: %+v", got.ObjectMeta)
	}
}

func TestUpdateIngressValidatesFirst(t *testing.T) {
	c := newTestClient(testIngress())
	bad := IngressCreate{Name: "web", Rules: nil}
	err := c.UpdateIngress(context.Background(), "default", "web", bad)
	if err == nil {
		t.Fatal("expected validation error")
	}
}

func TestUpdateIngressRejectsNameMismatch(t *testing.T) {
	c := newTestClient(testIngress())
	// The UI never sends this (the name field is disabled in edit mode), but
	// the API boundary must not apply one object's spec under another name.
	spec := validIngressSpec()
	spec.Name = "other"
	err := c.UpdateIngress(context.Background(), "default", "web", spec)
	if err == nil || !strings.Contains(err.Error(), "does not match") {
		t.Fatalf("expected name mismatch error, got %v", err)
	}
}
