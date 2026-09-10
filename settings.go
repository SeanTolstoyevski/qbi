package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// settings holds the small amount of state we persist between runs.
type settings struct {
	KubeconfigPath string `json:"kubeconfigPath"`
	// AutoRefresh enables background Kubernetes Watch streams so the UI
	// updates automatically when cluster resources change.
	AutoRefresh bool `json:"autoRefresh"`
	// WelcomeSeen records that the user read the first-launch welcome wizard
	// and acknowledged responsibility for changes they make. Once true the
	// wizard is not shown again.
	WelcomeSeen bool `json:"welcomeSeen"`
	// Experimental unlocks features that are still being evaluated. They are
	// hidden and inert while false, so they can be removed without breaking
	// anyone's workflow if they prove unnecessary.
	Experimental bool `json:"experimental"`
	// LogTemplates holds the user's log field-order templates (experimental).
	LogTemplates []LogTemplate `json:"logTemplates"`
	// ActiveLogTemplate is the id of the template currently applied to the
	// log view, or "" for raw output.
	ActiveLogTemplate string `json:"activeLogTemplate"`
}

// settingsMu serializes all settings access. Every load-modify-save cycle is
// protected so concurrent Wails calls can never lose an update.
var settingsMu sync.Mutex

// settingsPath returns the location of the persisted settings file, creating no
// directories. It lives under the OS user-config directory (e.g. %AppData% on
// Windows, ~/.config on Linux).
func settingsPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "qbi", "settings.json"), nil
}

// loadSettings reads persisted settings, returning zero values if none exist.
// A file that exists but cannot be parsed is moved aside (best effort) so a
// single corrupted write can never strand the user with silently empty
// settings forever.
func loadSettings() settings {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	return loadSettingsLocked()
}

// loadSettingsLocked is loadSettings without taking settingsMu; callers that
// need an atomic load-modify-save cycle use updateSettings instead.
func loadSettingsLocked() settings {
	var s settings
	p, err := settingsPath()
	if err != nil {
		return s
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return s
	}
	if err := json.Unmarshal(data, &s); err != nil {
		backup := fmt.Sprintf("%s.corrupt-%s", p, time.Now().Format("20060102-150405.000"))
		_ = os.Rename(p, backup)
		return settings{}
	}
	return s
}

// saveSettings writes settings to disk with restrictive permissions. The
// write is atomic (temp file + rename) so a crash mid-write can never leave a
// truncated settings.json behind.
func saveSettings(s settings) error {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	return saveSettingsLocked(s)
}

// saveSettingsLocked is saveSettings without taking settingsMu.
func saveSettingsLocked(s settings) error {
	p, err := settingsPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// updateSettings applies mutate to the persisted settings atomically: one
// lock spans the whole load-modify-save cycle, so concurrent calls can never
// lose each other's changes.
func updateSettings(mutate func(*settings) error) error {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	st := loadSettingsLocked()
	if err := mutate(&st); err != nil {
		return err
	}
	return saveSettingsLocked(st)
}
