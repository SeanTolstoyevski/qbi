package kube

import (
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
)

func TestValidatePortForwardSpec(t *testing.T) {
	valid := PortForwardSpec{Namespace: "default", Pod: "web-abc", LocalPort: 0, RemotePort: 8080}

	tests := []struct {
		name    string
		mutate  func(*PortForwardSpec)
		wantErr string // substring; empty = valid
	}{
		{"valid with auto local port", func(s *PortForwardSpec) {}, ""},
		{"valid with explicit local port", func(s *PortForwardSpec) { s.LocalPort = 9090 }, ""},
		{"valid with max ports", func(s *PortForwardSpec) { s.LocalPort = 65535; s.RemotePort = 65535 }, ""},
		{"missing namespace", func(s *PortForwardSpec) { s.Namespace = "" }, "pod and namespace are required"},
		{"missing pod", func(s *PortForwardSpec) { s.Pod = "" }, "pod and namespace are required"},
		{"invalid pod name", func(s *PortForwardSpec) { s.Pod = "UPPER_case" }, "invalid pod name"},
		{"invalid namespace", func(s *PortForwardSpec) { s.Namespace = "bad ns" }, "invalid namespace"},
		{"remote port zero", func(s *PortForwardSpec) { s.RemotePort = 0 }, "remote port must be between 1 and 65535"},
		{"remote port too large", func(s *PortForwardSpec) { s.RemotePort = 65536 }, "remote port must be between 1 and 65535"},
		{"remote port negative", func(s *PortForwardSpec) { s.RemotePort = -1 }, "remote port must be between 1 and 65535"},
		{"local port negative", func(s *PortForwardSpec) { s.LocalPort = -1 }, "local port must be between 0 (auto) and 65535"},
		{"local port too large", func(s *PortForwardSpec) { s.LocalPort = 65536 }, "local port must be between 0 (auto) and 65535"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			spec := valid
			tt.mutate(&spec)
			err := validatePortForwardSpec(spec)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error containing %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("error %q does not contain %q", err, tt.wantErr)
			}
		})
	}
}

func TestPickFreeLocalPort(t *testing.T) {
	port, err := pickFreeLocalPort()
	if err != nil {
		t.Fatal(err)
	}
	if port < 1 || port > 65535 {
		t.Fatalf("port out of range: %d", port)
	}
	// The port must actually be bindable afterwards.
	ln, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("picked port %d is not free: %v", port, err)
	}
	ln.Close()
}

func TestPortForwardRequestURL(t *testing.T) {
	cfg := &rest.Config{
		Host:    "https://k8s.example.com:6443",
		APIPath: "/api", // the clientset sets this; without it the group path is empty
		ContentConfig: rest.ContentConfig{
			GroupVersion:         &corev1.SchemeGroupVersion,
			NegotiatedSerializer: scheme.Codecs.WithoutConversion(),
		},
	}
	rc, err := rest.RESTClientFor(cfg)
	if err != nil {
		t.Fatal(err)
	}

	u := portForwardRequest(rc, "default", "web-abc").URL()
	want := "https://k8s.example.com:6443/api/v1/namespaces/default/pods/web-abc/portforward"
	if u.String() != want {
		t.Fatalf("url = %q, want %q", u.String(), want)
	}
}

func TestLockedBufferConcurrentWrites(t *testing.T) {
	b := &lockedBuffer{}
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				fmt.Fprintf(b, "writer %d line %d\n", n, j)
			}
		}(i)
	}
	wg.Wait()

	out := b.String()
	if !strings.Contains(out, "writer 7 line 99") {
		t.Errorf("missing expected content: %q", out)
	}
	if strings.Count(out, "\n") != 800 {
		t.Errorf("got %d lines, want 800", strings.Count(out, "\n"))
	}
}

func TestPortForwardSessionStopIdempotent(t *testing.T) {
	s := &PortForwardSession{
		stopCh:   make(chan struct{}),
		readyCh:  make(chan struct{}),
		resultCh: make(chan error, 1),
		errBuf:   &lockedBuffer{},
	}
	s.Stop()
	s.Stop() // must not panic
	select {
	case <-s.stopCh:
	default:
		t.Fatal("stopCh not closed after Stop")
	}
}

func TestPortForwardSessionErrorTextTrimmed(t *testing.T) {
	s := &PortForwardSession{errBuf: &lockedBuffer{}}
	s.errBuf.Write([]byte("  unable to forward port\n\n"))
	if got := s.ErrorText(); got != "unable to forward port" {
		t.Fatalf("ErrorText() = %q, want trimmed text", got)
	}
}
