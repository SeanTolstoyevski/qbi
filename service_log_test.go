package main

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// captureLogger redirects the process default logger into a buffer for the
// duration of a test.
func captureLogger(t *testing.T) *bytes.Buffer {
	t.Helper()
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })
	buf := &bytes.Buffer{}
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	return buf
}

func TestOpErrLogsAndReturns(t *testing.T) {
	buf := captureLogger(t)
	s := &Service{}
	err := errors.New("boom")
	if got := s.opErr("ListPods", err); got != err {
		t.Fatal("opErr must return the error unchanged")
	}
	out := buf.String()
	if !strings.Contains(out, "op=ListPods") || !strings.Contains(out, "boom") {
		t.Errorf("missing log entry: %q", out)
	}
}

func TestOpErrSilentOnNil(t *testing.T) {
	buf := captureLogger(t)
	s := &Service{}
	if got := s.opErr("ListPods", nil); got != nil {
		t.Fatal("nil must pass through")
	}
	if buf.Len() != 0 {
		t.Errorf("nil error logged: %q", buf.String())
	}
}

func TestLogFrontend(t *testing.T) {
	buf := captureLogger(t)
	s := &Service{}
	if err := s.LogFrontend("error", "uncaught boom", "at App.vue:3"); err != nil {
		t.Fatal(err)
	}
	if err := s.LogFrontend("warn", "soft warning", ""); err != nil {
		t.Fatal(err)
	}
	if err := s.LogFrontend("bogus", "x", ""); err == nil {
		t.Error("invalid level must be rejected")
	}
	out := buf.String()
	if !strings.Contains(out, "uncaught boom") || !strings.Contains(out, "source=frontend") {
		t.Errorf("missing frontend record: %q", out)
	}
}

func TestLogFrontendTruncates(t *testing.T) {
	buf := captureLogger(t)
	s := &Service{}
	msg := strings.Repeat("x", 20000)
	if err := s.LogFrontend("error", msg, ""); err != nil {
		t.Fatal(err)
	}
	if len(buf.String()) > 9000 {
		t.Errorf("message not truncated: %d bytes logged", len(buf.String()))
	}
}

func TestLogFrontendTruncatesMultibyteSafely(t *testing.T) {
	captureLogger(t)
	s := &Service{}
	// Byte-slicing would split these runes; must not panic or mangle.
	msg := strings.Repeat("é", 20000)
	if err := s.LogFrontend("error", msg, ""); err != nil {
		t.Fatal(err)
	}
}
