package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The fake-kubectl helpers are duplicated from internal/kube/podfiles_test.go
// because the two test binaries cannot share unexported helpers.

func installFakeKubectl(t *testing.T, body string) {
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

const svcPosixHostShim = `#!/bin/sh
case "$*" in
  */etc/hosts*) echo "127.0.0.1 localhost"; exit 0 ;;
  */etc/resolv.conf*) echo "nameserver 10.96.0.10"; exit 0 ;;
  *) echo "unexpected args: $*" >&2; exit 1 ;;
esac
`

const svcWindowsHostShim = `@echo off
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

const svcPosixFailShim = `#!/bin/sh
echo "pods/exec is forbidden" >&2
exit 1
`

const svcWindowsFailShim = `@echo off
echo pods/exec is forbidden 1>&2
exit /b 1
`

// partialShim answers /etc/hosts successfully but fails /etc/resolv.conf, to
// exercise the per-file error fold.
const svcPosixPartialShim = `#!/bin/sh
case "$*" in
  */etc/hosts*) echo "127.0.0.1 localhost"; exit 0 ;;
  *) echo "resolv.conf unreadable" >&2; exit 1 ;;
esac
`

const svcWindowsPartialShim = `@echo off
echo %* | findstr /C:"/etc/hosts" >nul
if not errorlevel 1 (
  echo 127.0.0.1 localhost
  exit /b 0
)
echo resolv.conf unreadable 1>&2
exit /b 1
`

func svcShim(posix, windows string) string {
	if runtime.GOOS == "windows" {
		return windows
	}
	return posix
}

// newTestService returns a Service whose app context is set, so opCtx works.
func newTestService() *Service {
	s := NewService(NewApp())
	s.app.ctx = context.Background()
	return s
}

func TestSetExperimentalPersists(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}
	if !loadSettings().Experimental {
		t.Fatal("SetExperimental(true) did not persist")
	}
	// A fresh service reloads from disk, so the flag survives instances.
	if !(&Service{}).GetSettings().Experimental {
		t.Error("experimental flag must persist across service instances")
	}
	if err := s.SetExperimental(false); err != nil {
		t.Fatal(err)
	}
	if loadSettings().Experimental {
		t.Error("SetExperimental(false) did not persist")
	}
}

func TestGetPodNetworkFilesRefusedWhileDisabled(t *testing.T) {
	setUserConfigDir(t)
	// A working kubectl shim: if the gate were only cosmetic, this call
	// would succeed and return file content.
	installFakeKubectl(t, svcShim(svcPosixHostShim, svcWindowsHostShim))
	s := newTestService()

	_, err := s.GetPodNetworkFiles("default", "web-abc", "")
	if err == nil {
		t.Fatal("gated call must fail while experimental features are disabled")
	}
	if !strings.Contains(err.Error(), "experimental features are disabled") {
		t.Fatalf("unexpected gate error: %v", err)
	}
}

func TestGetPodNetworkFilesEnabledReadsBothFiles(t *testing.T) {
	setUserConfigDir(t)
	if err := saveSettings(settings{Experimental: true}); err != nil {
		t.Fatal(err)
	}
	installFakeKubectl(t, svcShim(svcPosixHostShim, svcWindowsHostShim))
	s := newTestService()

	files, err := s.GetPodNetworkFiles("default", "web-abc", "web")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(files.Hosts, "127.0.0.1 localhost") {
		t.Errorf("hosts content missing: %+v", files)
	}
	if !strings.Contains(files.ResolvConf, "nameserver") {
		t.Errorf("resolv.conf content missing: %+v", files)
	}
	if files.HostsError != "" || files.ResolvConfError != "" {
		t.Errorf("unexpected per-file errors: %+v", files)
	}
	if files.Container != "web" {
		t.Errorf("container not echoed back: %+v", files)
	}
}

func TestGetPodNetworkFilesBothFailingFailsCall(t *testing.T) {
	setUserConfigDir(t)
	if err := saveSettings(settings{Experimental: true}); err != nil {
		t.Fatal(err)
	}
	installFakeKubectl(t, svcShim(svcPosixFailShim, svcWindowsFailShim))
	s := newTestService()

	_, err := s.GetPodNetworkFiles("default", "web-abc", "")
	if err == nil {
		t.Fatal("both reads failing must fail the call")
	}
	if !strings.Contains(err.Error(), "pods/exec is forbidden") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestGetPodNetworkFilesPartialFailureFoldsIntoPayload(t *testing.T) {
	setUserConfigDir(t)
	if err := saveSettings(settings{Experimental: true}); err != nil {
		t.Fatal(err)
	}
	installFakeKubectl(t, svcShim(svcPosixPartialShim, svcWindowsPartialShim))
	s := newTestService()

	files, err := s.GetPodNetworkFiles("default", "web-abc", "")
	if err != nil {
		t.Fatalf("one readable file must not fail the call: %v", err)
	}
	if !strings.Contains(files.Hosts, "127.0.0.1") {
		t.Errorf("hosts content missing: %+v", files)
	}
	if files.HostsError != "" {
		t.Errorf("unexpected hosts error: %+v", files)
	}
	if files.ResolvConf != "" {
		t.Errorf("resolv.conf content must stay empty on failure: %+v", files)
	}
	if !strings.Contains(files.ResolvConfError, "resolv.conf unreadable") {
		t.Errorf("per-file error missing: %+v", files)
	}
}
