package logging

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestParseLevel(t *testing.T) {
	for _, tc := range []struct {
		in   string
		want slog.Level
	}{
		{"debug", slog.LevelDebug},
		{"info", slog.LevelInfo},
		{"warn", slog.LevelWarn},
		{"warning", slog.LevelWarn},
		{"ERROR", slog.LevelError},
	} {
		got, err := parseLevel(tc.in)
		if err != nil {
			t.Fatalf("parseLevel(%q): %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("parseLevel(%q) = %v, want %v", tc.in, got, tc.want)
		}
	}
	if _, err := parseLevel("bogus"); err == nil {
		t.Error("parseLevel(bogus) should fail")
	}
}

func TestSetupFileOutputRedactsAndFilters(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	path := filepath.Join(t.TempDir(), "qbi.log")
	cfg := Config{
		Level:   "info",
		Outputs: []Output{{Type: "file", Format: "text", Path: path}},
	}
	closer, err := Setup(cfg)
	if err != nil {
		t.Fatalf("Setup: %v", err)
	}
	defer closer.Close()

	slog.Error("connect to 10.0.0.5 failed", "server", "https://10.0.0.5:6443", "cluster", "prod-eu")
	slog.Debug("verbose", "x", "y") // below info level, must be filtered out

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read log file: %v", err)
	}
	out := string(data)
	if strings.Contains(out, "10.0.0.5") {
		t.Errorf("log leaked an IP address:\n%s", out)
	}
	if strings.Contains(out, "prod-eu") {
		t.Errorf("log leaked the cluster name:\n%s", out)
	}
	if !strings.Contains(out, "[redacted]") {
		t.Errorf("expected masked values:\n%s", out)
	}
	if !strings.Contains(out, "ip#") {
		t.Errorf("expected hashed IP:\n%s", out)
	}
	if strings.Contains(out, "verbose") {
		t.Errorf("debug record leaked past info level:\n%s", out)
	}
}

func TestTimestampsAreUTC(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	path := filepath.Join(t.TempDir(), "utc.log")
	closer, err := Setup(Config{
		Level:   "info",
		Outputs: []Output{{Type: "file", Format: "text", Path: path}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer closer.Close()
	slog.Info("stamp")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	m := regexp.MustCompile(`time=(\S+)`).FindSubmatch(data)
	if m == nil {
		t.Fatalf("no time= attribute in %q", data)
	}
	if ts := string(m[1]); !strings.HasSuffix(ts, "Z") {
		t.Errorf("timestamp %q is not UTC", ts)
	}
}

func TestSourceIncludesModuleRelativeFileLine(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	path := filepath.Join(t.TempDir(), "src.log")
	closer, err := Setup(Config{
		Level:   "info",
		Outputs: []Output{{Type: "file", Format: "text", Path: path}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer closer.Close()
	slog.Info("here")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	out := string(data)
	m := regexp.MustCompile(`source=(\S+)`).FindStringSubmatch(out)
	if m == nil {
		t.Fatalf("no source= attribute in %q", out)
	}
	src := m[1]
	if !strings.HasPrefix(src, "qbi/") || !strings.Contains(src, ":") {
		t.Errorf("source %q should be module-relative file:line", src)
	}
	if strings.Contains(out, `\`) || regexp.MustCompile(`^[A-Za-z]:`).MatchString(src) {
		t.Errorf("machine path leaked into source: %q", out)
	}
}

func TestModulePath(t *testing.T) {
	for in, want := range map[string]string{
		`C:\Users\alice\code\qbi\internal\logging\logging.go`: "qbi/internal/logging/logging.go",
		`/home/alice/code/qbi/service.go`:                     "qbi/service.go",
		`qbi/main.go`:                                         "qbi/main.go",
		`/home/alice/code/app/main.go`:                        "app/main.go",
	} {
		if got := modulePath(in); got != want {
			t.Errorf("modulePath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSetupRejectsBadConfig(t *testing.T) {
	for _, cfg := range []Config{
		{Level: "bogus", Outputs: []Output{{Type: "stdout", Format: "text"}}},
		{Level: "info"},
		{Level: "info", Outputs: []Output{{Type: "pipe", Format: "text"}}},
		{Level: "info", Outputs: []Output{{Type: "file", Format: "xml", Path: "x.log"}}},
	} {
		if _, err := Setup(cfg); err == nil {
			t.Errorf("Setup(%+v) should fail", cfg)
		}
	}
}

func TestLoadFromEnvConfigFile(t *testing.T) {
	dir := t.TempDir()
	cfgFile := filepath.Join(dir, "logging.json")
	os.WriteFile(cfgFile, []byte(`{
		"level": "warn",
		"outputs": [{"type": "file", "format": "json", "path": "logs/app.log"}]
	}`), 0o600)

	t.Setenv("QBI_LOG_CONFIG", cfgFile)
	t.Setenv("QBI_LOG_LEVEL", "error")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Level != "error" {
		t.Errorf("level = %q, want env override \"error\"", cfg.Level)
	}
	if len(cfg.Outputs) != 1 || cfg.Outputs[0].Type != "file" {
		t.Fatalf("outputs = %+v", cfg.Outputs)
	}
	want := filepath.Join(dir, "logs", "app.log")
	if cfg.Outputs[0].Path != want {
		t.Errorf("path = %q, want %q (resolved against config dir)", cfg.Outputs[0].Path, want)
	}
}

func TestLoadFallsBackToBuiltInProfile(t *testing.T) {
	wantProfile := ProdProfile()
	if DevBuild {
		wantProfile = DevProfile()
	}

	// Missing file.
	t.Setenv("QBI_LOG_CONFIG", filepath.Join(t.TempDir(), "nope.json"))
	if cfg, err := Load(); err == nil {
		t.Error("missing config file must return an error")
	} else if len(cfg.Outputs) == 0 {
		t.Error("fallback config must still have outputs")
	}

	// Malformed file.
	bad := filepath.Join(t.TempDir(), "bad.json")
	os.WriteFile(bad, []byte("{not json"), 0o600)
	t.Setenv("QBI_LOG_CONFIG", bad)
	if cfg, err := Load(); err == nil {
		t.Error("malformed config must return an error")
	} else if len(cfg.Outputs) == 0 {
		t.Error("fallback config must still have outputs")
	}

	// Valid JSON with invalid contents.
	invalid := filepath.Join(t.TempDir(), "invalid.json")
	os.WriteFile(invalid, []byte(`{"level": "loud", "outputs": [{"type": "pipe", "format": "text"}]}`), 0o600)
	t.Setenv("QBI_LOG_CONFIG", invalid)
	cfg, err := Load()
	if err == nil {
		t.Error("invalid config must return an error")
	}
	if cfg.Level != wantProfile.Level || len(cfg.Outputs) != len(wantProfile.Outputs) {
		t.Errorf("fallback cfg = %+v, want built-in profile %+v", cfg, wantProfile)
	}

	// Invalid env level is ignored, not fatal.
	valid := filepath.Join(t.TempDir(), "valid.json")
	os.WriteFile(valid, []byte(`{"level": "info", "outputs": [{"type": "stdout", "format": "text"}]}`), 0o600)
	t.Setenv("QBI_LOG_CONFIG", valid)
	t.Setenv("QBI_LOG_LEVEL", "screaming")
	if cfg, err := Load(); err != nil {
		t.Fatalf("valid config with bad env level must still load: %v", err)
	} else if cfg.Level != "info" {
		t.Errorf("level = %q, want \"info\" (bad env override ignored)", cfg.Level)
	}
}

func TestMultiHandlerFansOutPerHandlerLevel(t *testing.T) {
	var debugBuf, errorBuf bytes.Buffer
	h := &multiHandler{handlers: []slog.Handler{
		slog.NewTextHandler(&debugBuf, &slog.HandlerOptions{Level: slog.LevelDebug}),
		slog.NewTextHandler(&errorBuf, &slog.HandlerOptions{Level: slog.LevelError}),
	}}
	logger := slog.New(h)
	logger.Debug("dbg")
	logger.Error("err")

	if !strings.Contains(debugBuf.String(), "dbg") || !strings.Contains(debugBuf.String(), "err") {
		t.Errorf("debug handler missing records: %q", debugBuf.String())
	}
	if strings.Contains(errorBuf.String(), "dbg") || !strings.Contains(errorBuf.String(), "err") {
		t.Errorf("error handler level filter wrong: %q", errorBuf.String())
	}
}

func TestGroupAndWithAttrsSurviveRedaction(t *testing.T) {
	var buf bytes.Buffer
	h := newRedactHandler(slog.NewTextHandler(&buf, nil), nil)
	logger := slog.New(h).With("component", "watch").WithGroup("req")
	logger.Error("boom", "server", "https://10.1.2.3:6443")

	out := buf.String()
	if !strings.Contains(out, "component=watch") || !strings.Contains(out, "req.server=") {
		t.Errorf("group/withattrs lost: %q", out)
	}
	if strings.Contains(out, "10.1.2.3") {
		t.Errorf("IP inside group leaked: %q", out)
	}
}

func TestWithAttrsAfterWithGroupStaysInGroup(t *testing.T) {
	var buf bytes.Buffer
	h := newRedactHandler(slog.NewTextHandler(&buf, nil), nil)
	logger := slog.New(h).WithGroup("req").With("component", "watch")
	logger.Error("boom")
	out := buf.String()
	if !strings.Contains(out, "req.component=watch") {
		t.Errorf("WithAttrs after WithGroup escaped the group: %q", out)
	}
}
