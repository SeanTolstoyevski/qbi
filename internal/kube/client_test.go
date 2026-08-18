package kube

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// versionServer serves just enough of the API server for the reachability
// probe: an unauthenticated /version endpoint.
func versionServer() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/version" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"major":"1","minor":"30","gitVersion":"v1.30.0-test"}`)
			return
		}
		http.NotFound(w, r)
	}))
}

// writeTestKubeconfig writes a minimal kubeconfig pointing at server so that
// Connect has a real endpoint to reach.
func writeTestKubeconfig(t *testing.T, server string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config")
	cfg := fmt.Sprintf(`apiVersion: v1
kind: Config
clusters:
- name: test
  cluster:
    server: %s
contexts:
- name: test
  context:
    cluster: test
    user: test
users:
- name: test
  user: {}
current-context: test
`, server)
	if err := os.WriteFile(path, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// Connect is the frontend's green light for every cluster action, so it must
// only succeed against a reachable API server.
func TestConnectVerifiesReachability(t *testing.T) {
	srv := versionServer()
	defer srv.Close()

	c := NewClient()
	c.SetKubeconfigPath(writeTestKubeconfig(t, srv.URL))
	info, err := c.Connect("")
	if err != nil {
		t.Fatalf("Connect against a reachable server failed: %v", err)
	}
	if info.Name != "test" {
		t.Fatalf("Connect returned context %q, want %q", info.Name, "test")
	}
	if _, err := c.clientOrErr(); err != nil {
		t.Fatalf("Connect did not install a clientset: %v", err)
	}

	srv.Close()
	_, err = c.Connect("")
	if err == nil {
		t.Fatal("Connect against an unreachable server succeeded, want error")
	}
	if !strings.Contains(err.Error(), "reachability") {
		t.Fatalf("Connect error %q does not identify the reachability probe", err)
	}
}

// A failed reconnect must not clobber the previous clientset: the backend
// should stay on the last working connection instead of dropping to a client
// that was never verified.
func TestConnectFailureKeepsPreviousClient(t *testing.T) {
	srv := versionServer()
	defer srv.Close()

	c := NewClient()
	c.SetKubeconfigPath(writeTestKubeconfig(t, srv.URL))
	if _, err := c.Connect(""); err != nil {
		t.Fatalf("initial Connect failed: %v", err)
	}

	srv.Close()
	if _, err := c.Connect(""); err == nil {
		t.Fatal("Connect against the dead server succeeded, want error")
	}
	if _, err := c.clientOrErr(); err != nil {
		t.Fatalf("failed Connect dropped the previous clientset: %v", err)
	}
	if got := c.CurrentContext(); got != "test" {
		t.Fatalf("failed Connect changed the current context to %q", got)
	}
}
