package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func enabledSettings() settings {
	return settings{Experimental: true}
}

func mustSaveTemplate(t *testing.T, s *Service, name string, fields ...string) LogTemplate {
	t.Helper()
	saved, err := s.SaveLogTemplate(LogTemplate{Name: name, FieldOrder: fields})
	if err != nil {
		t.Fatalf("SaveLogTemplate(%q) failed: %v", name, err)
	}
	return saved
}

func TestLogTemplateNormalize(t *testing.T) {
	tmpl := LogTemplate{Name: "  app  ", FieldOrder: []string{"msg", "msg", "ts", "", "level"}}
	if err := normalizeLogTemplate(&tmpl); err == nil || !strings.Contains(err.Error(), "must not be empty") {
		t.Fatalf("empty field must be rejected, got %v", err)
	}
	// The empty field aborts normalisation, so test the clean path separately.
	tmpl = LogTemplate{Name: "  app  ", FieldOrder: []string{"msg", "msg", "ts"}}
	if err := normalizeLogTemplate(&tmpl); err != nil {
		t.Fatal(err)
	}
	if tmpl.Name != "app" {
		t.Errorf("name not trimmed: %q", tmpl.Name)
	}
	if len(tmpl.FieldOrder) != 2 || tmpl.FieldOrder[0] != "msg" || tmpl.FieldOrder[1] != "ts" {
		t.Errorf("fields not deduped: %v", tmpl.FieldOrder)
	}
	if tmpl.ID == "" {
		t.Error("new templates must get an id")
	}
}

func TestLogTemplateValidationErrors(t *testing.T) {
	st := enabledSettings()
	cases := []struct {
		name   string
		tmpl   LogTemplate
		errSub string
	}{
		{"empty name", LogTemplate{Name: "  ", FieldOrder: []string{"msg"}}, "name is required"},
		{"long name", LogTemplate{Name: strings.Repeat("n", 65), FieldOrder: []string{"msg"}}, "too long"},
		{"no fields", LogTemplate{Name: "a", FieldOrder: nil}, "at least one field"},
		{"empty field", LogTemplate{Name: "a", FieldOrder: []string{"", "msg"}}, "must not be empty"},
		{"long field", LogTemplate{Name: "a", FieldOrder: []string{strings.Repeat("f", 257)}}, "too long"},
		{"long id", LogTemplate{ID: strings.Repeat("i", 65), Name: "a", FieldOrder: []string{"msg"}}, "too long"},
		{"quote in id", LogTemplate{ID: `x"y`, Name: "a", FieldOrder: []string{"msg"}}, "unsupported characters"},
	}
	for _, c := range cases {
		if _, err := upsertLogTemplate(&st, c.tmpl); err == nil || !strings.Contains(err.Error(), c.errSub) {
			t.Errorf("%s: got %v, want error containing %q", c.name, err, c.errSub)
		}
	}
}

func TestLogTemplateRoundTrip(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}

	created := mustSaveTemplate(t, s, "app", "msg", "level", "ts")
	if created.ID == "" {
		t.Fatal("created template has no id")
	}

	// A fresh service reloads from disk: templates persist.
	again, err := (&Service{}).GetLogTemplateSettings()
	if err != nil {
		t.Fatal(err)
	}
	if len(again.Templates) != 1 || again.Templates[0].Name != "app" {
		t.Fatalf("template did not persist: %+v", again)
	}
	if again.Templates[0].FieldOrder[0] != "msg" {
		t.Fatalf("field order not persisted: %+v", again.Templates[0])
	}
}

func TestLogTemplateUpdateAndUniqueNames(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}
	created := mustSaveTemplate(t, s, "app", "msg")

	// Updating the same id reorders its fields.
	created.FieldOrder = []string{"level", "msg"}
	updated, err := s.SaveLogTemplate(created)
	if err != nil {
		t.Fatal(err)
	}
	if updated.FieldOrder[0] != "level" {
		t.Fatalf("update lost field order: %+v", updated)
	}

	// A different template with the same name (any case) is refused.
	if _, err := s.SaveLogTemplate(LogTemplate{Name: "APP", FieldOrder: []string{"ts"}}); err == nil {
		t.Fatal("duplicate template name must be refused")
	}

	// Updating an id that no longer exists is refused, not silently created.
	if _, err := s.SaveLogTemplate(LogTemplate{ID: "gone", Name: "ghost", FieldOrder: []string{"ts"}}); err == nil {
		t.Fatal("update of an unknown id must be refused")
	}

	settings, err := s.GetLogTemplateSettings()
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Templates) != 1 {
		t.Fatalf("failed saves must not create templates: %+v", settings.Templates)
	}
}

func TestLogTemplateDeleteClearsActive(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}
	created := mustSaveTemplate(t, s, "app", "msg")
	if err := s.SetActiveLogTemplate(created.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteLogTemplate(created.ID); err != nil {
		t.Fatal(err)
	}
	settings, err := s.GetLogTemplateSettings()
	if err != nil {
		t.Fatal(err)
	}
	if len(settings.Templates) != 0 || settings.ActiveID != "" {
		t.Fatalf("deleting the active template must clear it: %+v", settings)
	}
	if err := s.DeleteLogTemplate(created.ID); err == nil {
		t.Fatal("deleting an unknown id must fail")
	}
}

func TestSetActiveLogTemplateValidates(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetActiveLogTemplate("nonexistent"); err == nil {
		t.Fatal("activating an unknown id must fail")
	}
	if err := s.SetActiveLogTemplate(""); err != nil {
		t.Fatalf("clearing the selection must always work: %v", err)
	}
}

func TestLogTemplateMethodsRefusedWhileDisabled(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if _, err := s.GetLogTemplateSettings(); err == nil || !strings.Contains(err.Error(), "experimental features are disabled") {
		t.Fatalf("GetLogTemplateSettings must be gated, got %v", err)
	}
	if _, err := s.SaveLogTemplate(LogTemplate{Name: "x", FieldOrder: []string{"msg"}}); err == nil {
		t.Fatal("SaveLogTemplate must be gated")
	}
	if err := s.DeleteLogTemplate("x"); err == nil {
		t.Fatal("DeleteLogTemplate must be gated")
	}
	if err := s.SetActiveLogTemplate("x"); err == nil {
		t.Fatal("SetActiveLogTemplate must be gated")
	}
	// The gate also prevents the persistence from being touched.
	if len(loadSettings().LogTemplates) != 0 {
		t.Fatal("gated calls must not write settings")
	}
}

func TestLogTemplateSettingsEmptyListIsNotNull(t *testing.T) {
	got := logTemplateSettings(settings{})
	if got.Templates == nil {
		t.Error("Templates must be an empty slice, not nil, so JSON marshals as []")
	}
}

func TestCorruptSettingsFileIsBackedUp(t *testing.T) {
	setUserConfigDir(t)
	p, err := settingsPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("{ not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := loadSettings(); !reflect.DeepEqual(got, settings{}) {
		t.Fatalf("corrupt file must yield zero settings, got %+v", got)
	}
	// The corrupt file is moved aside, so a later save starts fresh.
	if err := saveSettings(settings{KubeconfigPath: "kube"}); err != nil {
		t.Fatal(err)
	}
	if got := loadSettings(); got.KubeconfigPath != "kube" {
		t.Fatalf("settings did not recover after corruption: %+v", got)
	}
	backups, err := filepath.Glob(p + ".corrupt-*")
	if err != nil || len(backups) == 0 {
		t.Fatalf("corrupt file was not backed up (glob err %v, matches %v)", err, backups)
	}
}

func TestLogTemplateSavesKeepOtherSettings(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}
	if _, err := s.SetKubeconfig("kube"); err != nil {
		t.Fatal(err)
	}
	if err := s.SetAutoRefresh(true); err != nil {
		t.Fatal(err)
	}
	mustSaveTemplate(t, s, "app", "msg")
	st := loadSettings()
	if st.KubeconfigPath != "kube" {
		t.Errorf("template save clobbered kubeconfig path: %+v", st)
	}
	if !st.AutoRefresh {
		t.Error("template save clobbered auto-refresh")
	}
}

func TestLogTemplateFieldNamesAreNotTrimmed(t *testing.T) {
	// JSON keys may legitimately contain surrounding whitespace; validation
	// must not corrupt them, only drop empties and duplicates.
	tmpl := LogTemplate{Name: "app", FieldOrder: []string{" msg ", "ts"}}
	if err := normalizeLogTemplate(&tmpl); err != nil {
		t.Fatal(err)
	}
	if tmpl.FieldOrder[0] != " msg " {
		t.Fatalf("field name was trimmed: %q", tmpl.FieldOrder[0])
	}
}

func TestActiveLogTemplatePersists(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}
	created := mustSaveTemplate(t, s, "app", "msg")
	if err := s.SetActiveLogTemplate(created.ID); err != nil {
		t.Fatal(err)
	}
	// A fresh service reloads from disk and still reports the selection.
	again, err := (&Service{}).GetLogTemplateSettings()
	if err != nil {
		t.Fatal(err)
	}
	if again.ActiveID != created.ID {
		t.Fatalf("active template did not persist: %+v", again)
	}
}

func TestConcurrentTemplateSavesLoseNothing(t *testing.T) {
	setUserConfigDir(t)
	s := newTestService()
	if err := s.SetExperimental(true); err != nil {
		t.Fatal(err)
	}
	const n = 20
	errs := make(chan error, n)
	for i := 0; i < n; i++ {
		go func(i int) {
			_, err := s.SaveLogTemplate(LogTemplate{
				Name:       fmt.Sprintf("tpl-%02d", i),
				FieldOrder: []string{"msg", "ts"},
			})
			errs <- err
		}(i)
	}
	for i := 0; i < n; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent save %d failed: %v", i, err)
		}
	}
	st := loadSettings()
	if len(st.LogTemplates) != n {
		t.Fatalf("concurrent saves lost updates: got %d templates, want %d", len(st.LogTemplates), n)
	}
}

func TestLoadSettingsIgnoresUnknownFutureFields(t *testing.T) {
	setUserConfigDir(t)
	p, err := settingsPath()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	// A settings file written by a future version must not break loading.
	if err := os.WriteFile(p, []byte(`{"kubeconfigPath":"kube","someFutureField":42}`), 0o600); err != nil {
		t.Fatal(err)
	}
	st := loadSettings()
	if st.KubeconfigPath != "kube" {
		t.Fatalf("unknown fields must be ignored, got %+v", st)
	}
}
