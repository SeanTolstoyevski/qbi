package kube

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

func strPtr(s string) *string { return &s }

func boolPtr(b bool) *bool { return &b }

func pathTypePtr(t networkingv1.PathType) *networkingv1.PathType { return &t }

// newTestClient builds a Client wired to a fake clientset seeded with objects.
func newTestClient(objs ...runtime.Object) *Client {
	c := &Client{}
	c.mu.Lock()
	c.clientset = fake.NewSimpleClientset(objs...)
	c.mu.Unlock()
	return c
}

func testIngress() *networkingv1.Ingress {
	return &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{
			Name:              "web",
			Namespace:         "default",
			CreationTimestamp: metav1.NewTime(time.Now().Add(-2 * time.Hour)),
			Annotations:       map[string]string{"nginx.ingress.kubernetes.io/rewrite-target": "/"},
		},
		Spec: networkingv1.IngressSpec{
			IngressClassName: strPtr("nginx"),
			TLS: []networkingv1.IngressTLS{
				{Hosts: []string{"a.example.com", "b.example.com"}, SecretName: "web-tls"},
			},
			Rules: []networkingv1.IngressRule{
				{
					Host: "a.example.com",
					IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{
						{Path: "/", PathType: pathTypePtr(networkingv1.PathTypePrefix), Backend: backend("web", 80)},
						{Path: "/api", PathType: pathTypePtr(networkingv1.PathTypeExact), Backend: backend("gone", 8080)},
					}}},
				},
				{
					Host: "b.example.com",
					IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{
						{Path: "/", Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "web", Port: networkingv1.ServiceBackendPort{Name: "http"}}}},
					}}},
				},
			},
		},
		Status: networkingv1.IngressStatus{LoadBalancer: networkingv1.IngressLoadBalancerStatus{Ingress: []networkingv1.IngressLoadBalancerIngress{
			{IP: "1.2.3.4"},
			{Hostname: "lb.example.com"},
		}}},
	}
}

func backend(name string, port int32) networkingv1.IngressBackend {
	return networkingv1.IngressBackend{
		Service: &networkingv1.IngressServiceBackend{
			Name: name,
			Port: networkingv1.ServiceBackendPort{Number: port},
		},
	}
}

// TestIngressesEnrichment covers the multi-address bug fix (every load
// balancer entry must survive, not just the last), TLS secret checking,
// backend health statuses and the issue list.
func TestIngressesEnrichment(t *testing.T) {
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"}}
	eps := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "web-abc",
			Namespace: "default",
			Labels:    map[string]string{discoveryv1.LabelServiceName: "web"},
		},
		AddressType: discoveryv1.AddressTypeIPv4,
		Endpoints: []discoveryv1.Endpoint{
			{Addresses: []string{"10.0.0.1"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(true)}},
			{Addresses: []string{"10.0.0.2"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(true)}},
			{Addresses: []string{"10.0.0.9"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(false)}},
		},
	}
	orphan := &discoveryv1.EndpointSlice{
		ObjectMeta:  metav1.ObjectMeta{Name: "manual-xyz", Namespace: "default"},
		AddressType: discoveryv1.AddressTypeIPv4,
		Endpoints:   []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.77"}}},
	}
	sec := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "web-tls", Namespace: "default"}}

	c := newTestClient(testIngress(), svc, eps, orphan, sec)
	list, err := c.Ingresses(context.Background(), "default")
	if err != nil {
		t.Fatalf("Ingresses: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("expected 1 ingress, got %d", len(list))
	}
	info := list[0]

	if len(info.Addresses) != 2 || info.Addresses[0] != "1.2.3.4" || info.Addresses[1] != "lb.example.com" {
		t.Errorf("addresses = %v, want [1.2.3.4 lb.example.com]", info.Addresses)
	}
	if info.Class != "nginx" {
		t.Errorf("class = %q, want nginx", info.Class)
	}
	if info.Annotations["nginx.ingress.kubernetes.io/rewrite-target"] != "/" {
		t.Errorf("annotations lost: %v", info.Annotations)
	}

	if len(info.TLS) != 1 || info.TLS[0].SecretStatus != "ok" {
		t.Errorf("TLS = %+v, want secretStatus ok", info.TLS)
	}

	p0 := info.Rules[0].Paths[0]
	if p0.Status != "ok" || p0.ReadyEndpoints != 2 {
		t.Errorf("path / status = %q ready=%d, want ok/2", p0.Status, p0.ReadyEndpoints)
	}
	p1 := info.Rules[0].Paths[1]
	if p1.Status != "no-service" {
		t.Errorf("path /api status = %q, want no-service", p1.Status)
	}
	if p1.ServicePort != "8080" {
		t.Errorf("path /api port = %q, want 8080", p1.ServicePort)
	}
	if got := info.Rules[1].Paths[0].ServicePort; got != "http" {
		t.Errorf("named port = %q, want http", got)
	}

	if len(info.Issues) != 1 {
		t.Errorf("issues = %v, want exactly the missing-service issue", info.Issues)
	}
}

func TestIngressIssues(t *testing.T) {
	ing := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "broken", Namespace: "default"},
		Spec: networkingv1.IngressSpec{
			TLS: []networkingv1.IngressTLS{
				{Hosts: []string{"a.example.com"}, SecretName: "missing-tls"},
			},
			Rules: []networkingv1.IngressRule{{
				Host: "a.example.com",
				IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{
					{Path: "/", Backend: backend("web", 80)},
				}}},
			}},
			DefaultBackend: &networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{
				Name: "fallback", Port: networkingv1.ServiceBackendPort{Number: 80},
			}},
		},
	}
	// web exists but has no ready endpoints; fallback does not exist at all.
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"}}

	c := newTestClient(ing, svc)
	list, err := c.Ingresses(context.Background(), "default")
	if err != nil {
		t.Fatalf("Ingresses: %v", err)
	}
	info := list[0]

	if len(info.Addresses) != 0 {
		t.Errorf("addresses = %v, want none", info.Addresses)
	}
	if info.TLS[0].SecretStatus != "missing" {
		t.Errorf("TLS secretStatus = %q, want missing", info.TLS[0].SecretStatus)
	}
	if got := info.Rules[0].Paths[0].Status; got != "no-endpoints" {
		t.Errorf("path status = %q, want no-endpoints", got)
	}
	if db := info.DefaultBackend; db == nil || db.Status != "no-service" {
		t.Errorf("default backend = %+v, want no-service", db)
	}

	// 1 (no address) + 1 (missing TLS secret) + 1 (no endpoints) + 1 (default
	// backend missing) = 4 issues.
	if len(info.Issues) != 4 {
		t.Errorf("issues = %v, want 4", info.Issues)
	}
	for _, want := range []string{"missing-tls", "no ready endpoints", "fallback", "No external address"} {
		found := false
		for _, iss := range info.Issues {
			if contains(iss, want) {
				found = true
			}
		}
		if !found {
			t.Errorf("issues %v: missing mention of %q", info.Issues, want)
		}
	}
}

// TestIngressNoRulesIssues: an ingress that routes nothing is flagged.
func TestIngressNoRulesIssues(t *testing.T) {
	ing := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "empty", Namespace: "default"},
	}
	c := newTestClient(ing)
	list, err := c.Ingresses(context.Background(), "default")
	if err != nil {
		t.Fatalf("Ingresses: %v", err)
	}
	// Regression: empty slices must stay non-nil so they marshal to JSON []
	// rather than null (a null rules array crashes the frontend's .length).
	if list[0].Rules == nil || list[0].TLS == nil || list[0].Addresses == nil || list[0].Issues == nil {
		t.Errorf("empty slices became nil: %+v", list[0])
	}
	issues := list[0].Issues
	found := false
	for _, iss := range issues {
		if contains(iss, "No routing rules defined") {
			found = true
		}
	}
	if !found {
		t.Errorf("issues = %v, want a no-rules warning", issues)
	}
}

// TestIngressHealthDegradesOnListError: when services/endpoints/secrets
// cannot be listed (RBAC), statuses become "unknown" and a single degraded
// note appears instead of false "missing" claims.
func TestIngressHealthDegradesOnListError(t *testing.T) {
	c := newTestClient(testIngress())
	c.clientset.(*fake.Clientset).PrependReactor("list", "services", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("services is forbidden")
	})

	list, err := c.Ingresses(context.Background(), "default")
	if err != nil {
		t.Fatalf("Ingresses: %v", err)
	}
	info := list[0]
	for _, p := range info.Rules[0].Paths {
		if p.Status != "unknown" {
			t.Errorf("path status = %q, want unknown under RBAC failure", p.Status)
		}
	}
	if info.TLS[0].SecretStatus != "unknown" {
		t.Errorf("secretStatus = %q, want unknown under RBAC failure", info.TLS[0].SecretStatus)
	}
	found := false
	for _, iss := range info.Issues {
		if contains(iss, "could not be fully checked") {
			found = true
		}
	}
	if !found {
		t.Errorf("issues = %v, want a degraded-health note", info.Issues)
	}
}

func TestIngressHealthDegradesOnEndpointSliceError(t *testing.T) {
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"}}
	c := newTestClient(testIngress(), svc)
	c.clientset.(*fake.Clientset).PrependReactor("list", "endpointslices", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("endpointslices is forbidden")
	})

	list, err := c.Ingresses(context.Background(), "default")
	if err != nil {
		t.Fatalf("Ingresses: %v", err)
	}
	info := list[0]
	if p := info.Rules[0].Paths[0]; p.Status != "unknown" {
		t.Errorf("path / status = %q, want unknown under RBAC failure", p.Status)
	}
	if p := info.Rules[0].Paths[1]; p.Status != "no-service" {
		t.Errorf("path /api status = %q, want no-service (service truly missing)", p.Status)
	}
	found := false
	for _, iss := range info.Issues {
		if contains(iss, "could not be fully checked") {
			found = true
		}
	}
	if !found {
		t.Errorf("issues = %v, want a degraded-health note", info.Issues)
	}
}

func TestReadyEndpointIPs(t *testing.T) {
	ipv4 := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "web-abc",
			Namespace: "default",
			Labels:    map[string]string{discoveryv1.LabelServiceName: "web"},
		},
		AddressType: discoveryv1.AddressTypeIPv4,
		Endpoints: []discoveryv1.Endpoint{
			{Addresses: []string{"10.0.0.1"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(true)}},
			{Addresses: []string{"10.0.0.2"}}, // nil Ready = unknown, treat as ready
			{Addresses: []string{"10.0.0.3"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(false)}},
		},
	}

	ipv6 := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "web-xyz",
			Namespace: "default",
			Labels:    map[string]string{discoveryv1.LabelServiceName: "web"},
		},
		AddressType: discoveryv1.AddressTypeIPv6,
		Endpoints: []discoveryv1.Endpoint{
			{Addresses: []string{"fd00::1"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(true)}},
			{Addresses: []string{"10.0.0.1"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(true)}},
		},
	}

	fqdn := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "ext-abc",
			Namespace: "default",
			Labels:    map[string]string{discoveryv1.LabelServiceName: "ext"},
		},
		AddressType: discoveryv1.AddressTypeFQDN,
		Endpoints:   []discoveryv1.Endpoint{{Addresses: []string{"ext.example.com"}}},
	}

	orphan := &discoveryv1.EndpointSlice{
		ObjectMeta:  metav1.ObjectMeta{Name: "manual-abc", Namespace: "default"},
		AddressType: discoveryv1.AddressTypeIPv4,
		Endpoints:   []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.77"}}},
	}

	other := &discoveryv1.EndpointSlice{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "api-abc",
			Namespace: "default",
			Labels:    map[string]string{discoveryv1.LabelServiceName: "api"},
		},
		AddressType: discoveryv1.AddressTypeIPv4,
		Endpoints:   []discoveryv1.Endpoint{{Addresses: []string{"10.0.0.5"}, Conditions: discoveryv1.EndpointConditions{Ready: boolPtr(true)}}},
	}

	c := newTestClient(ipv4, ipv6, fqdn, orphan, other)
	got, err := readyEndpointIPs(context.Background(), c.clientset, "default")
	if err != nil {
		t.Fatalf("readyEndpointIPs: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("services with endpoints = %d, want 2 (web, api)", len(got))
	}
	if joined := strings.Join(got["web"], ","); joined != "10.0.0.1,10.0.0.2,fd00::1" {
		t.Errorf("web endpoints = %q, want 10.0.0.1,10.0.0.2,fd00::1", joined)
	}
	if joined := strings.Join(got["api"], ","); joined != "10.0.0.5" {
		t.Errorf("api endpoints = %q, want 10.0.0.5", joined)
	}
}

func TestIngressDetailFiltersEvents(t *testing.T) {
	now := time.Now()
	evOld := &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: "e1", Namespace: "default"},
		InvolvedObject: corev1.ObjectReference{Kind: "Ingress", Name: "web"},
		Type:           "Warning", Reason: "Sync",
		LastTimestamp: metav1.NewTime(now.Add(-2 * time.Minute)),
	}
	evNew := &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: "e2", Namespace: "default"},
		InvolvedObject: corev1.ObjectReference{Kind: "Ingress", Name: "web"},
		Type:           "Normal", Reason: "Updated",
		LastTimestamp: metav1.NewTime(now.Add(-1 * time.Minute)),
	}
	evOther := &corev1.Event{
		ObjectMeta:     metav1.ObjectMeta{Name: "e3", Namespace: "default"},
		InvolvedObject: corev1.ObjectReference{Kind: "Service", Name: "web"},
		Type:           "Normal", Reason: "CreatedLoadBalancer",
		LastTimestamp: metav1.NewTime(now.Add(-30 * time.Second)),
	}

	c := newTestClient(testIngress(), evOld, evNew, evOther)
	detail, err := c.IngressDetail(context.Background(), "default", "web")
	if err != nil {
		t.Fatalf("IngressDetail: %v", err)
	}
	if detail.Ingress.Name != "web" {
		t.Errorf("detail ingress name = %q, want web", detail.Ingress.Name)
	}
	if len(detail.Events) != 2 {
		t.Fatalf("events = %d, want 2 (service event filtered out)", len(detail.Events))
	}
	if detail.Events[0].Reason != "Updated" || detail.Events[1].Reason != "Sync" {
		t.Errorf("event order = %v, want most recent first", detail.Events)
	}
	if detail.EventsError != "" {
		t.Errorf("eventsError = %q, want empty", detail.EventsError)
	}
}

// TestIngressDetailEventsUnavailable: an events list failure must not sink the
// whole detail view; the ingress info survives and EventsError explains why.
func TestIngressDetailEventsUnavailable(t *testing.T) {
	c := newTestClient(testIngress())
	c.clientset.(*fake.Clientset).PrependReactor("list", "events", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("events is forbidden")
	})

	detail, err := c.IngressDetail(context.Background(), "default", "web")
	if err != nil {
		t.Fatalf("IngressDetail: %v", err)
	}
	if detail.Ingress.Name != "web" || len(detail.Ingress.Addresses) != 2 {
		t.Errorf("ingress info lost on events failure: %+v", detail.Ingress)
	}
	if detail.EventsError == "" {
		t.Error("eventsError = empty, want the failure reason")
	}
	if len(detail.Events) != 0 {
		t.Errorf("events = %v, want none", detail.Events)
	}
}

// TestIngressResourceDefaultBackend: a default backend pointing at a custom
// resource (not a service) must not be reported as "no default backend".
func TestIngressResourceDefaultBackend(t *testing.T) {
	ing := &networkingv1.Ingress{
		ObjectMeta: metav1.ObjectMeta{Name: "resource-db", Namespace: "default"},
		Spec: networkingv1.IngressSpec{
			DefaultBackend: &networkingv1.IngressBackend{
				Resource: &corev1.TypedLocalObjectReference{
					APIGroup: strPtr("example.com"),
					Kind:     "StorageBucket",
					Name:     "assets",
				},
			},
		},
	}
	c := newTestClient(ing)
	list, err := c.Ingresses(context.Background(), "default")
	if err != nil {
		t.Fatalf("Ingresses: %v", err)
	}
	info := list[0]
	if info.DefaultBackend == nil {
		t.Fatal("resource default backend lost")
	}
	if info.DefaultBackend.Status != "unknown" {
		t.Errorf("default backend status = %q, want unknown (not checkable)", info.DefaultBackend.Status)
	}
	for _, iss := range info.Issues {
		if contains(iss, "No routing rules defined") {
			t.Errorf("issues = %v: resource default backend must suppress the no-rules warning", info.Issues)
		}
	}
}

// TestDeleteIngress: removing an ingress deletes only the routing rules;
// services and pods in the namespace are untouched.
func TestDeleteIngress(t *testing.T) {
	ing := testIngress()
	svc := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "default"}}
	c := newTestClient(ing, svc)

	ctx := context.Background()
	if err := c.DeleteIngress(ctx, "default", "web"); err != nil {
		t.Fatalf("DeleteIngress: %v", err)
	}

	// The ingress is gone…
	ings, err := c.Ingresses(ctx, "default")
	if err != nil {
		t.Fatalf("Ingresses after delete: %v", err)
	}
	if len(ings) != 0 {
		t.Errorf("ingresses after delete = %v, want none", ings)
	}
	// …but the service it routed to still exists.
	svcs, err := c.Services(ctx, "default")
	if err != nil {
		t.Fatalf("Services after delete: %v", err)
	}
	if len(svcs) != 1 || svcs[0].Name != "web" {
		t.Errorf("services = %v, want web untouched", svcs)
	}
}

func contains(s, sub string) bool { return strings.Contains(s, sub) }
