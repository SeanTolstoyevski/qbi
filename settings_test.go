package main

import (
	"path/filepath"
	"runtime"
	"testing"
)

// setUserConfigDir redirects os.UserConfigDir to a fresh temp directory for
// one test, so settings tests never touch the real user config.
func setUserConfigDir(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	switch runtime.GOOS {
	case "windows":
		t.Setenv("AppData", dir)
	case "darwin":
		t.Setenv("HOME", dir)
	default:
		t.Setenv("XDG_CONFIG_HOME", dir)
	}
}

func TestSettingsRoundTrip(t *testing.T) {
	setUserConfigDir(t)
	want := settings{
		KubeconfigPath: filepath.Join("some", "kubeconfig"),
		AutoRefresh:    true,
		WelcomeSeen:    true,
		Experimental:   true,
	}
	if err := saveSettings(want); err != nil {
		t.Fatal(err)
	}
	if got := loadSettings(); got != want {
		t.Errorf("round trip mismatch: got %+v, want %+v", got, want)
	}
}

func TestLoadSettingsDefaults(t *testing.T) {
	setUserConfigDir(t)
	if got := loadSettings(); got != (settings{}) {
		t.Errorf("expected zero settings on first run, got %+v", got)
	}
}

func TestWelcomeSeenDefaultsFalse(t *testing.T) {
	setUserConfigDir(t)
	if got := loadSettings().WelcomeSeen; got {
		t.Error("WelcomeSeen must default to false so the wizard shows on first launch")
	}
}

func TestExperimentalDefaultsFalse(t *testing.T) {
	setUserConfigDir(t)
	if got := loadSettings().Experimental; got {
		t.Error("Experimental must default to false so unproven features stay hidden")
	}
}

func TestAcknowledgeWelcomePersists(t *testing.T) {
	setUserConfigDir(t)
	s := &Service{}
	if s.GetSettings().WelcomeSeen {
		t.Fatal("fresh install must report the wizard as not yet acknowledged")
	}
	if err := s.AcknowledgeWelcome(); err != nil {
		t.Fatal(err)
	}
	// A new service reloads from disk, proving the acknowledgment persisted.
	if !(&Service{}).GetSettings().WelcomeSeen {
		t.Error("AcknowledgeWelcome must persist across service instances")
	}
}

func TestAcknowledgeWelcomeKeepsOtherSettings(t *testing.T) {
	setUserConfigDir(t)
	if err := saveSettings(settings{KubeconfigPath: "kube", AutoRefresh: true}); err != nil {
		t.Fatal(err)
	}
	s := &Service{}
	if err := s.AcknowledgeWelcome(); err != nil {
		t.Fatal(err)
	}
	st := loadSettings()
	if st.KubeconfigPath != "kube" || !st.AutoRefresh {
		t.Errorf("AcknowledgeWelcome clobbered unrelated settings: %+v", st)
	}
}

func TestSetKubeconfigKeepsWelcomeSeen(t *testing.T) {
	setUserConfigDir(t)
	s := NewService(NewApp())
	if err := s.AcknowledgeWelcome(); err != nil {
		t.Fatal(err)
	}
	// First-use order: acknowledge the wizard, then pick a kubeconfig. The
	// acknowledgment must survive the kubeconfig save.
	if _, err := s.SetKubeconfig("kube"); err != nil {
		t.Fatal(err)
	}
	st := loadSettings()
	if st.KubeconfigPath != "kube" {
		t.Errorf("kubeconfig path not saved: %+v", st)
	}
	if !st.WelcomeSeen {
		t.Error("SetKubeconfig must not reset WelcomeSeen, or the wizard would reappear on every launch")
	}
}
