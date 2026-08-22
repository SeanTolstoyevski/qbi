package kube

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
)

// fakeKubectl installs a stub "kubectl" on PATH. body is the executable
// content: a POSIX shell script, or a .bat on Windows. The stub receives the
// real argv (joined by spaces as $* / %*) and answers according to body.
func fakeKubectl(t *testing.T, body string) {
	t.Helper()
	dir := t.TempDir()
	name := "kubectl"
	if runtime.GOOS == "windows" {
		name += ".bat"
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
}

// shimBody picks the platform-appropriate stub for the current OS.
func shimBody(posix, windows string) string {
	if runtime.GOOS == "windows" {
		return windows
	}
	return posix
}

// hostShim answers `kubectl exec … cat /etc/hosts` and
// `… cat /etc/resolv.conf` with fixed, recognisable content.
const posixHostShim = `#!/bin/sh
case "$*" in
  */etc/hosts*)
    echo "127.0.0.1 localhost"
    exit 0 ;;
  */etc/resolv.conf*)
    echo "nameserver 10.96.0.10"
    exit 0 ;;
  *)
    echo "unexpected args: $*" >&2
    exit 1 ;;
esac
`

const windowsHostShim = `@echo off
echo %* | findstr /C:"/etc/hosts" >nul
if not errorlevel 1 (
  echo 127.0.0.1 localhost
  exit /b 0
)
echo %* | findstr /C:"/etc/resolv.conf" >nul
if not errorlevel 1 (
  echo nameserver 10.96.0.10
  exit /b 0
)
echo unexpected args: %* 1>&2
exit /b 1
`

// failShim always fails, with the actionable message on stderr.
const posixFailShim = `#!/bin/sh
echo "pods/exec is forbidden" >&2
exit 1
`

const windowsFailShim = `@echo off
echo pods/exec is forbidden 1>&2
exit /b 1
`

func TestPodFileReadsAllowedFiles(t *testing.T) {
	fakeKubectl(t, shimBody(posixHostShim, windowsHostShim))
	c := NewClient()
	ctx := context.Background()

	hosts, err := c.PodFile(ctx, "default", "web-abc", "", "/etc/hosts")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(hosts); got != "127.0.0.1 localhost" {
		t.Errorf("hosts content = %q, want the stub output", got)
	}

	resolv, err := c.PodFile(ctx, "default", "web-abc", "web", "/etc/resolv.conf")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(resolv); got != "nameserver 10.96.0.10" {
		t.Errorf("resolv.conf content = %q, want the stub output", got)
	}
}

func TestPodFileRejectsUnlistedPaths(t *testing.T) {
	c := NewClient()
	_, err := c.PodFile(context.Background(), "default", "web-abc", "", "/etc/passwd")
	if err == nil {
		t.Fatal("reading a path outside the allowlist must fail")
	}
	if !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestPodFileRequiresPodAndNamespace(t *testing.T) {
	c := NewClient()
	ctx := context.Background()
	if _, err := c.PodFile(ctx, "", "web-abc", "", "/etc/hosts"); err == nil {
		t.Error("missing namespace must fail")
	}
	if _, err := c.PodFile(ctx, "default", "", "", "/etc/hosts"); err == nil {
		t.Error("missing pod must fail")
	}
}

func TestPodFileRejectsInvalidNames(t *testing.T) {
	c := NewClient()
	ctx := context.Background()
	cases := []struct {
		ns, pod, container, what string
	}{
		{"default", "--kubeconfig=/tmp/evil", "", "flag-like pod name"},
		{"-n", "web-abc", "", "flag-like namespace"},
		{"default", "web-abc", "--token=x", "flag-like container"},
		{"default", "Bad_Name", "", "invalid pod characters"},
		{"not a namespace", "web-abc", "", "space in namespace"},
	}
	for _, tc := range cases {
		if _, err := c.PodFile(ctx, tc.ns, tc.pod, tc.container, "/etc/hosts"); err == nil {
			t.Errorf("%s must be rejected", tc.what)
		}
	}
}

func TestPodFilePropagatesKubectlFailure(t *testing.T) {
	fakeKubectl(t, shimBody(posixFailShim, windowsFailShim))
	c := NewClient()
	_, err := c.PodFile(context.Background(), "default", "web-abc", "", "/etc/hosts")
	if err == nil {
		t.Fatal("a failing kubectl must fail the read")
	}
	if !strings.Contains(err.Error(), "pods/exec is forbidden") {
		t.Fatalf("stderr message lost: %v", err)
	}
}

func TestKubectlBaseArgsPinsCluster(t *testing.T) {
	srv := versionServer()
	defer srv.Close()
	c := NewClient()
	c.SetKubeconfigPath(writeTestKubeconfig(t, srv.URL))
	if _, err := c.Connect(""); err != nil {
		t.Fatal(err)
	}

	want := []string{"--context", "test", "--kubeconfig", c.KubeconfigPath()}
	if got := kubectlBaseArgs(c); !reflect.DeepEqual(got, want) {
		t.Errorf("kubectlBaseArgs = %v, want %v", got, want)
	}
}

func TestBuildKubectlArgsStillTargetsShell(t *testing.T) {
	srv := versionServer()
	defer srv.Close()
	c := NewClient()
	c.SetKubeconfigPath(writeTestKubeconfig(t, srv.URL))
	if _, err := c.Connect(""); err != nil {
		t.Fatal(err)
	}

	got := buildKubectlArgs(c, "ns", "pod", "web")
	want := []string{
		"exec", "-it", "pod", "-n", "ns",
		"--context", "test", "--kubeconfig", c.KubeconfigPath(),
		"-c", "web", "--", "sh",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("buildKubectlArgs = %v, want %v", got, want)
	}
}
