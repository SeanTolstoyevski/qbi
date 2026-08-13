// Package logging wires the process-wide slog logger. Logs exist so failures
// (bad YAML, kube edge cases, misconfigurations, crashes) can be diagnosed
// after the fact, they are never telemetry. Every record passes through a
// redacting handler that masks IP addresses and values under sensitive keys
// (cluster names, API endpoints, credentials) before reaching any
// destination, so a shared log cannot leak the user's cluster environment.
package logging

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-logr/logr/slogr"
	"k8s.io/klog/v2"
)

// Config selects where logs go and the minimum level recorded.
type Config struct {
	// Level is one of "debug", "info", "warn", "error".
	Level string `json:"level"`
	// Outputs lists the destinations; at least one is required.
	Outputs []Output `json:"outputs"`
	// RedactKeys adds attribute keys whose values are masked on top of the
	// built-in set (cluster, context, server, kubeconfig, tokens, ...).
	RedactKeys []string `json:"redactKeys,omitempty"`
}

// Output describes a single log destination.
type Output struct {
	// Type is "stdout" or "file".
	Type string `json:"type"`
	// Format is "text" or "json".
	Format string `json:"format"`
	// Path is the log file for type "file". Relative paths resolve against
	// the directory of the config file that declared them.
	Path string `json:"path,omitempty"`
}

// DevProfile is the built-in development config: everything at debug level,
// human-readable on stdout (where `wails dev` shows it) and JSON in a file.
func DevProfile() Config {
	return Config{
		Level: "debug",
		Outputs: []Output{
			{Type: "stdout", Format: "text"},
			{Type: "file", Format: "json", Path: filepath.Join(defaultLogDir(), "qbi.log")},
		},
	}
}

// ProdProfile is the built-in production config: info and above, JSON in a
// file. stdout is kept too: packaged GUI apps have no console, but terminal
// launches still show logs.
func ProdProfile() Config {
	return Config{
		Level: "info",
		Outputs: []Output{
			{Type: "file", Format: "json", Path: filepath.Join(defaultLogDir(), "qbi.log")},
			{Type: "stdout", Format: "text"},
		},
	}
}

// defaultLogDir returns the per-user log directory, falling back to the
// system temp dir when the user config dir cannot be resolved.
func defaultLogDir() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "qbi", "logs")
}

// Load resolves the effective config:
//   - $QBI_LOG_CONFIG, when set, is read as a JSON file;
//   - otherwise <UserConfigDir>/qbi/logging.json, when present;
//   - otherwise the built-in dev or production profile.
//
// $QBI_LOG_LEVEL overrides the level in every case (an invalid value is
// ignored). Relative file output paths are resolved against the config
// file's directory. A config that cannot be read, parsed or validated is
// replaced by the built-in profile — logging never degrades below it — and
// the problem is returned so the caller can log a warning.
func Load() (Config, error) {
	cfg := ProdProfile()
	if DevBuild {
		cfg = DevProfile()
	}
	profile := cfg
	base := ""
	if p := os.Getenv("QBI_LOG_CONFIG"); p != "" {
		data, err := os.ReadFile(p)
		if err != nil {
			return profile, fmt.Errorf("read log config: %w", err)
		}
		var fileCfg Config
		if err := json.Unmarshal(data, &fileCfg); err != nil {
			return profile, fmt.Errorf("parse log config: %w", err)
		}
		cfg, base = fileCfg, filepath.Dir(p)
	} else if dir, err := os.UserConfigDir(); err == nil {
		if data, rerr := os.ReadFile(filepath.Join(dir, "qbi", "logging.json")); rerr == nil {
			var fileCfg Config
			if jerr := json.Unmarshal(data, &fileCfg); jerr != nil {
				return profile, fmt.Errorf("parse log config: %w", jerr)
			}
			cfg, base = fileCfg, filepath.Join(dir, "qbi")
		}
	}
	if lvl := os.Getenv("QBI_LOG_LEVEL"); lvl != "" {
		if _, lerr := parseLevel(lvl); lerr == nil {
			cfg.Level = lvl
		}
	}
	for i := range cfg.Outputs {
		if cfg.Outputs[i].Type == "file" && !filepath.IsAbs(cfg.Outputs[i].Path) && base != "" {
			cfg.Outputs[i].Path = filepath.Join(base, cfg.Outputs[i].Path)
		}
	}
	if verr := validate(cfg); verr != nil {
		return profile, verr
	}
	return cfg, nil
}

// Setup installs the logger built from cfg as the process-wide default and
// routes klog (client-go's logger) through the same redacting pipeline. The
// returned closer closes log files and must be called on shutdown.
func Setup(cfg Config) (io.Closer, error) {
	if err := validate(cfg); err != nil {
		return nil, err
	}
	level, _ := parseLevel(cfg.Level)
	opts := &slog.HandlerOptions{
		Level:     level,
		AddSource: true,
		ReplaceAttr: func(groups []string, a slog.Attr) slog.Attr {
			if len(groups) != 0 {
				return a
			}
			switch a.Key {
			case slog.TimeKey:
				if a.Value.Kind() == slog.KindTime {
					return slog.Time(a.Key, a.Value.Time().UTC())
				}
			case slog.SourceKey:
				if src, ok := a.Value.Any().(*slog.Source); ok {
					src.File = modulePath(src.File)
					return slog.Any(a.Key, src)
				}
			}
			return a
		},
	}
	var handlers []slog.Handler
	var closers []io.Closer
	for _, out := range cfg.Outputs {
		h, closer, err := newOutputHandler(out, opts)
		if err != nil {
			for _, c := range closers {
				_ = c.Close()
			}
			return nil, err
		}
		handlers = append(handlers, h)
		if closer != nil {
			closers = append(closers, closer)
		}
	}
	root := newRedactHandler(&multiHandler{handlers: handlers}, cfg.RedactKeys)
	slog.SetDefault(slog.New(root))
	klog.SetLogger(slogr.NewLogr(root))
	return multiCloser(closers), nil
}

type multiCloser []io.Closer

func (c multiCloser) Close() error {
	var first error
	for _, cl := range c {
		if err := cl.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// validate returns an error describing the first problem in cfg, or nil.
func validate(cfg Config) error {
	if _, err := parseLevel(cfg.Level); err != nil {
		return err
	}
	if len(cfg.Outputs) == 0 {
		return errors.New("log config: no outputs")
	}
	for _, out := range cfg.Outputs {
		switch out.Type {
		case "stdout":
		case "file":
			if out.Path == "" {
				return errors.New("log config: file output needs a path")
			}
		default:
			return fmt.Errorf("log config: unknown output type %q", out.Type)
		}
		switch out.Format {
		case "text", "json":
		default:
			return fmt.Errorf("log config: unknown format %q", out.Format)
		}
	}
	return nil
}

// newOutputHandler builds one destination handler. The config has been
// validated by validate, so unknown types/formats cannot occur here.
func newOutputHandler(out Output, opts *slog.HandlerOptions) (slog.Handler, io.Closer, error) {
	var newHandler func(io.Writer) slog.Handler
	switch out.Format {
	case "text":
		newHandler = func(w io.Writer) slog.Handler { return slog.NewTextHandler(w, opts) }
	case "json":
		newHandler = func(w io.Writer) slog.Handler { return slog.NewJSONHandler(w, opts) }
	default:
		return nil, nil, fmt.Errorf("log config: unknown format %q", out.Format)
	}
	switch out.Type {
	case "stdout":
		return newHandler(os.Stdout), nil, nil
	case "file":
		fw, err := newFileWriter(out.Path)
		if err != nil {
			return nil, nil, fmt.Errorf("open log file: %w", err)
		}
		return newHandler(fw), fw, nil
	default:
		return nil, nil, fmt.Errorf("log config: unknown output type %q", out.Type)
	}
}

func parseLevel(s string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("log config: unknown level %q", s)
	}
}

// modulePath trims the build machine's directory prefix from a source file
// path, so logs carry "qbi/internal/kube/client.go" instead of the local
// checkout location. When the module marker is absent (renamed checkout
// dir), it falls back to the last two path segments, which still hides
// usernames and drive letters.
func modulePath(file string) string {
	file = filepath.ToSlash(file)
	if i := strings.LastIndex(file, "/qbi/"); i >= 0 {
		return file[i+1:]
	}
	parts := strings.Split(file, "/")
	if len(parts) > 2 {
		return strings.Join(parts[len(parts)-2:], "/")
	}
	return file
}
