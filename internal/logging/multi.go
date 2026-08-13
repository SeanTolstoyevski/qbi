package logging

import (
	"context"
	"log/slog"
)

// multiHandler fans a record out to several destination handlers.
type multiHandler struct {
	handlers []slog.Handler
}

func (h *multiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, hh := range h.handlers {
		if hh.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (h *multiHandler) Handle(ctx context.Context, r slog.Record) error {
	var first error
	for _, hh := range h.handlers {
		if hh.Enabled(ctx, r.Level) {
			if err := hh.Handle(ctx, r); err != nil && first == nil {
				first = err
			}
		}
	}
	return first
}

func (h *multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, len(h.handlers))
	for i, hh := range h.handlers {
		next[i] = hh.WithAttrs(attrs)
	}
	return &multiHandler{handlers: next}
}

func (h *multiHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, len(h.handlers))
	for i, hh := range h.handlers {
		next[i] = hh.WithGroup(name)
	}
	return &multiHandler{handlers: next}
}
