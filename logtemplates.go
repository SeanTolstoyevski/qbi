package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
)

// LogTemplate describes how a JSON log line's top-level fields should be
// ordered when read aloud or on screen. It is user-local data (persisted in
// settings.json) and never touches the cluster. This is an experimental
// feature: every Service method that reads or writes templates is gated on
// the persisted experimental switch.
type LogTemplate struct {
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	FieldOrder []string `json:"fieldOrder"`
}

// LogTemplateSettings is the template payload exchanged with the frontend.
type LogTemplateSettings struct {
	Templates []LogTemplate `json:"templates"`
	// ActiveID is the template currently applied to the log view, or "" for
	// raw output.
	ActiveID string `json:"activeId"`
}

// Bounds keep the editor and the settings file from growing without limit.
// They are generous enough for real-world log formats.
const (
	maxLogTemplates        = 50
	maxLogTemplateNameLen  = 64
	maxLogTemplateFields   = 64
	maxLogTemplateFieldLen = 256
)

// newLogTemplateID returns a short random id. crypto/rand.Read never fails on
// supported platforms (Go 1.25).
func newLogTemplateID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// normalizeLogTemplate validates a template and cleans it up in place:
// trims the name, drops duplicate and empty fields (first occurrence wins),
// and fills in a fresh id for new templates. Field names are NOT trimmed —
// JSON keys may legitimately contain surrounding whitespace.
func normalizeLogTemplate(t *LogTemplate) error {
	t.Name = strings.TrimSpace(t.Name)
	if t.Name == "" {
		return fmt.Errorf("template name is required")
	}
	if len(t.Name) > maxLogTemplateNameLen {
		return fmt.Errorf("template name is too long (max %d characters)", maxLogTemplateNameLen)
	}

	fields := make([]string, 0, len(t.FieldOrder))
	seen := make(map[string]struct{}, len(t.FieldOrder))
	for _, f := range t.FieldOrder {
		if f == "" {
			return fmt.Errorf("field names must not be empty")
		}
		if len(f) > maxLogTemplateFieldLen {
			return fmt.Errorf("field name %q is too long (max %d characters)", f, maxLogTemplateFieldLen)
		}
		if _, dup := seen[f]; dup {
			continue
		}
		seen[f] = struct{}{}
		fields = append(fields, f)
	}
	if len(fields) == 0 {
		return fmt.Errorf("a template needs at least one field")
	}
	if len(fields) > maxLogTemplateFields {
		return fmt.Errorf("too many fields (max %d)", maxLogTemplateFields)
	}
	t.FieldOrder = fields

	if t.ID == "" {
		t.ID = newLogTemplateID()
	} else if len(t.ID) > 64 {
		// IDs are normally backend-generated; bound client-supplied ones so a
		// hostile caller cannot bloat settings.json.
		return fmt.Errorf("template id is too long (max 64 characters)")
	} else if !safeTemplateID(t.ID) {
		// The id flows into a DOM attribute selector on the frontend, so it
		// must never contain quotes or other selector syntax.
		return fmt.Errorf("template id contains unsupported characters")
	}
	return nil
}

// safeTemplateID restricts ids to the charset the backend itself generates.
func safeTemplateID(id string) bool {
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// upsertLogTemplate validates t and stores it in st. A template with an
// existing id must match one already stored (the frontend always passes an
// id back when editing); one without an id is created. Names are unique
// case-insensitively so the Format dropdown stays unambiguous.
func upsertLogTemplate(st *settings, t LogTemplate) (LogTemplate, error) {
	isNew := t.ID == ""
	if err := normalizeLogTemplate(&t); err != nil {
		return LogTemplate{}, err
	}
	for i := range st.LogTemplates {
		other := &st.LogTemplates[i]
		if other.ID != t.ID && strings.EqualFold(other.Name, t.Name) {
			return LogTemplate{}, fmt.Errorf("a template named %q already exists", other.Name)
		}
	}
	for i := range st.LogTemplates {
		if st.LogTemplates[i].ID == t.ID {
			st.LogTemplates[i] = t
			return t, nil
		}
	}
	if !isNew {
		return LogTemplate{}, fmt.Errorf("template not found")
	}
	if len(st.LogTemplates) >= maxLogTemplates {
		return LogTemplate{}, fmt.Errorf("too many templates (max %d)", maxLogTemplates)
	}
	st.LogTemplates = append(st.LogTemplates, t)
	return t, nil
}

// deleteLogTemplate removes a template by id and clears the active selection
// if it pointed at the deleted template.
func deleteLogTemplate(st *settings, id string) error {
	for i := range st.LogTemplates {
		if st.LogTemplates[i].ID == id {
			st.LogTemplates = append(st.LogTemplates[:i], st.LogTemplates[i+1:]...)
			if st.ActiveLogTemplate == id {
				st.ActiveLogTemplate = ""
			}
			return nil
		}
	}
	return fmt.Errorf("template not found")
}

// setActiveLogTemplate selects the template applied to the log view. An
// empty id means raw output; any other id must reference a stored template.
func setActiveLogTemplate(st *settings, id string) error {
	if id == "" {
		st.ActiveLogTemplate = ""
		return nil
	}
	for _, t := range st.LogTemplates {
		if t.ID == id {
			st.ActiveLogTemplate = id
			return nil
		}
	}
	return fmt.Errorf("template not found")
}

// logTemplateSettings builds the frontend payload, normalising a nil slice
// to an empty one so JSON clients never receive null for the list.
func logTemplateSettings(st settings) LogTemplateSettings {
	if st.LogTemplates == nil {
		st.LogTemplates = []LogTemplate{}
	}
	return LogTemplateSettings{Templates: st.LogTemplates, ActiveID: st.ActiveLogTemplate}
}
