package main

import (
	"encoding/json"
	"os"
	"path/filepath"
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
}

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
func loadSettings() settings {
	var s settings
	p, err := settingsPath()
	if err != nil {
		return s
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return s
	}
	_ = json.Unmarshal(data, &s)
	return s
}

// saveSettings writes settings to disk with restrictive permissions.
func saveSettings(s settings) error {
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
	return os.WriteFile(p, data, 0o600)
}
