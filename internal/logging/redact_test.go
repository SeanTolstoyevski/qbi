package logging

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func logThrough(t *testing.T, attrs ...slog.Attr) string {
	t.Helper()
	var buf bytes.Buffer
	h := newRedactHandler(slog.NewTextHandler(&buf, nil), nil)
	logger := slog.New(h)
	logger.Error("probe", attrsToAny(attrs)...)
	return buf.String()
}

func TestRedactIPs(t *testing.T) {
	cases := []struct {
		in       string
		wantHash bool
	}{
		{"dial tcp 10.0.0.5:6443: connect: connection refused", true},
		{"endpoint https://192.168.1.10/healthz unreachable", true},
		{"loopback ::1 refused", true},
		{"pod on fd00:abcd::1:2 failed", true},
		// Non-addresses must survive untouched.
		{"12:30:45", false},
		{"deployment v1.29.3 ready", false},
		{"aa:bb:cc:dd:ee:ff", false},
	}
	for _, tc := range cases {
		got := redactIPs(tc.in)
		hasHash := strings.Contains(got, "ip#")
		if hasHash != tc.wantHash {
			t.Errorf("redactIPs(%q) = %q (hash=%v, want %v)", tc.in, got, hasHash, tc.wantHash)
		}
	}
}

func TestSameIPGetsStableHash(t *testing.T) {
	a := redactIPs("from 10.0.0.5 to 10.0.0.5")
	if strings.Count(a, "ip#") != 2 {
		t.Fatalf("both IPs should be hashed: %q", a)
	}
	first := a[strings.Index(a, "ip#"):strings.Index(a, "ip#")+11]
	second := a[strings.LastIndex(a, "ip#"):strings.LastIndex(a, "ip#")+11]
	if first != second {
		t.Errorf("hash not stable: %q vs %q", first, second)
	}
}

func TestRedactSensitiveAttrKeys(t *testing.T) {
	out := logThrough(t,
		slog.String("cluster", "prod-eu"),
		slog.String("context", "k8s-admin@example"),
		slog.String("token", "sekret"),
		slog.String("http.server", "https://api.example.com"),
	)
	for _, want := range []string{"[redacted]", "http.server"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in %q", want, out)
		}
	}
	if strings.Contains(out, "prod-eu") || strings.Contains(out, "sekret") {
		t.Errorf("sensitive value leaked: %q", out)
	}
}

func TestRedactErrorValueAndAnyValue(t *testing.T) {
	out := logThrough(t,
		slog.Any("error", errors.New("dial tcp 10.9.9.9:6443: refused")),
		slog.Any("obj", map[string]any{"addr": "10.8.8.8", "name": "web"}),
	)
	if strings.Contains(out, "10.9.9.9") || strings.Contains(out, "10.8.8.8") {
		t.Errorf("IP inside structured value leaked: %q", out)
	}
	if !strings.Contains(out, "web") {
		t.Errorf("innocent value lost: %q", out)
	}
}

func TestExtraRedactKeys(t *testing.T) {
	var buf bytes.Buffer
	h := newRedactHandler(slog.NewTextHandler(&buf, nil), []string{"publicIP"})
	logger := slog.New(h)
	logger.Error("probe", slog.String("publicIP", "203.0.113.7"), slog.String("publicip", "203.0.113.7"))
	if strings.Contains(buf.String(), "203.0.113.7") {
		t.Errorf("extra key not masked (case-insensitively): %q", buf.String())
	}
}

func TestRedactSensitiveKeysRegardlessOfKind(t *testing.T) {
	// A token logged as Any or hidden in a group must be masked too.
	out := logThrough(t,
		slog.Any("token", map[string]any{"value": "sekret"}),
		slog.Group("creds", slog.Any("password", "hunter2")),
	)
	if strings.Contains(out, "sekret") || strings.Contains(out, "hunter2") {
		t.Errorf("sensitive Any/group value leaked: %q", out)
	}
}

func TestRedactWithGroupPrefix(t *testing.T) {
	var buf bytes.Buffer
	h := newRedactHandler(slog.NewTextHandler(&buf, nil), nil)
	logger := slog.New(h).WithGroup("token")
	logger.Error("probe", slog.String("value", "sekret"))
	if strings.Contains(buf.String(), "sekret") {
		t.Errorf("value under WithGroup(sensitive) leaked: %q", buf.String())
	}
	if !strings.Contains(buf.String(), "[redacted]") {
		t.Errorf("value under WithGroup(sensitive) not masked: %q", buf.String())
	}
}

func TestNonStringKindsPassThrough(t *testing.T) {
	out := logThrough(t, slog.Int("replicas", 3), slog.Bool("ready", true))
	if !strings.Contains(out, "replicas=3") || !strings.Contains(out, "ready=true") {
		t.Errorf("scalar attrs lost: %q", out)
	}
}
