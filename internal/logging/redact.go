package logging

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"regexp"
	"strings"
)

// sensitiveKeys are attribute keys whose values never appear in logs: the
// cluster a user is connected to, its API endpoint, and any credentials.
// Matching is case-insensitive and also applies to the last segment of a
// dotted key ("server" masks "http.server" too).
var sensitiveKeys = map[string]struct{}{
	"cluster":       {},
	"context":       {},
	"server":        {},
	"host":          {},
	"hostname":      {},
	"kubeconfig":    {},
	"password":      {},
	"token":         {},
	"secret":        {},
	"authorization": {},
	"cookie":        {},
	"apikey":        {},
	"api_key":       {},
}

// ipv4RE matches an IPv4 literal bounded by non-digit, non-dot characters so
// dotted numbers (versions, dates) are left alone.
var ipv4RE = regexp.MustCompile(
	`(^|[^0-9.])((?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.` +
		`(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.(?:25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9]))([^0-9.]|$)`,
)

// ipv6RE matches IPv6 literals (full or ::-compressed form). It requires at
// least three colons or a "::", so times ("12:30:45") and MAC addresses are
// not mistaken for addresses.
var ipv6RE = regexp.MustCompile(
	`(^|[^0-9a-fA-F:])((?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}` +
		`|(?:[0-9a-fA-F]{1,4}:){1,7}:` +
		`|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}` +
		`|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}` +
		`|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}` +
		`|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}` +
		`|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}` +
		`|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}` +
		`|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:))([^0-9a-fA-F:]|$)`,
)

// redactIPs replaces every IP literal with a stable short hash so repeated
// occurrences stay correlatable while the address itself is unrecoverable.
func redactIPs(s string) string {
	s = ipv6RE.ReplaceAllStringFunc(s, func(m string) string {
		parts := ipv6RE.FindStringSubmatch(m)
		return parts[1] + ipHash(parts[2]) + parts[3]
	})
	s = ipv4RE.ReplaceAllStringFunc(s, func(m string) string {
		parts := ipv4RE.FindStringSubmatch(m)
		return parts[1] + ipHash(parts[2]) + parts[3]
	})
	return s
}

func attrsToAny(attrs []slog.Attr) []any {
	out := make([]any, len(attrs))
	for i, a := range attrs {
		out[i] = a
	}
	return out
}

func ipHash(ip string) string {
	sum := sha256.Sum256([]byte(ip))
	return "ip#" + hex.EncodeToString(sum[:4])
}

// groupedAttrs are attributes attached via WithAttrs, together with the
// group stack that was active at the time — slog semantics place WithAttrs
// inside whatever groups were opened before it.
type groupedAttrs struct {
	groups []string
	attrs  []slog.Attr
}

// redactHandler rewrites every record before passing it on: messages have IP
// literals replaced by hashes, values under sensitive keys are masked, and
// Any values are serialized and redacted so structured cluster data cannot
// leak through.
type redactHandler struct {
	next    slog.Handler
	keys    map[string]struct{}
	goAttrs []groupedAttrs
	groups  []string // group prefix from WithGroup
}

func newRedactHandler(next slog.Handler, extraKeys []string) *redactHandler {
	keys := make(map[string]struct{}, len(sensitiveKeys)+len(extraKeys))
	for k := range sensitiveKeys {
		keys[k] = struct{}{}
	}
	for _, k := range extraKeys {
		keys[strings.ToLower(strings.TrimSpace(k))] = struct{}{}
	}
	return &redactHandler{next: next, keys: keys}
}

func (h *redactHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *redactHandler) Handle(ctx context.Context, r slog.Record) error {
	rec := slog.NewRecord(r.Time, r.Level, redactIPs(r.Message), r.PC)
	for _, ga := range h.goAttrs {
		for _, a := range h.buildAttrs(ga.groups, ga.attrs) {
			rec.AddAttrs(a)
		}
	}
	var attrs []slog.Attr
	r.Attrs(func(a slog.Attr) bool {
		attrs = append(attrs, a)
		return true
	})
	for _, a := range h.buildAttrs(h.groups, attrs) {
		rec.AddAttrs(a)
	}
	return h.next.Handle(ctx, rec)
}

func (h *redactHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	h2 := h.clone()
	h2.goAttrs = append(h2.goAttrs, groupedAttrs{groups: h2.groups, attrs: attrs})
	return h2
}

func (h *redactHandler) WithGroup(name string) slog.Handler {
	h2 := h.clone()
	h2.groups = append(append([]string{}, h.groups...), name)
	return h2
}

func (h *redactHandler) clone() *redactHandler {
	return &redactHandler{next: h.next, keys: h.keys, goAttrs: h.goAttrs, groups: h.groups}
}

// buildAttrs redacts the attributes and wraps them in the given group stack,
// since rebuilt records are plain and carry no group information.
func (h *redactHandler) buildAttrs(groups []string, attrs []slog.Attr) []slog.Attr {
	if len(attrs) == 0 {
		return nil
	}
	out := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		out = append(out, h.redact(a, groups))
	}
	for i := len(groups) - 1; i >= 0; i-- {
		out = []slog.Attr{slog.Group(groups[i], attrsToAny(out)...)}
	}
	return out
}

// redact returns the sanitized form of a single attribute.
func (h *redactHandler) redact(a slog.Attr, groups []string) slog.Attr {
	if a.Value.Kind() == slog.KindLogValuer {
		a.Value = a.Value.Resolve()
	}
	key := a.Key
	if len(groups) > 0 {
		key = strings.Join(append(append([]string{}, groups...), a.Key), ".")
	}

	if h.masked(key) {
		return slog.String(a.Key, "[redacted]")
	}
	switch a.Value.Kind() {
	case slog.KindString:
		return slog.String(a.Key, redactIPs(a.Value.String()))
	case slog.KindAny:
		if err, ok := a.Value.Any().(error); ok {
			return slog.String(a.Key, redactIPs(err.Error()))
		}
		if data, err := json.Marshal(a.Value.Any()); err == nil {
			return slog.String(a.Key, redactIPs(string(data)))
		}
		return slog.String(a.Key, redactIPs(fmt.Sprint(a.Value.Any())))
	case slog.KindGroup:
		group := a.Value.Group()
		out := make([]slog.Attr, 0, len(group))
		for _, ga := range group {
			out = append(out, h.redact(ga, append(groups, a.Key)))
		}
		return slog.Group(a.Key, attrsToAny(out)...)
	default:
		return a
	}
}

// masked reports whether the value under key must be hidden entirely. Any
// segment of the dotted key can be sensitive: WithGroup("token") produces
// keys like "token.x", and "http.server" must match "server".
func (h *redactHandler) masked(key string) bool {
	for _, seg := range strings.Split(key, ".") {
		if _, ok := h.keys[strings.ToLower(seg)]; ok {
			return true
		}
	}
	return false
}
