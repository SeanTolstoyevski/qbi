package kube

import (
	"bufio"
	"bytes"
	"reflect"
	"strings"
	"testing"
)

type logEvent struct {
	text string
	part bool
}

// scanEvents runs data through the same scanner setup as service.go's log
// stream loop and returns every emitted event.
func scanEvents(t *testing.T, data []byte) []logEvent {
	t.Helper()
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 0, LogChunkSize), LogChunkSize)
	splitter := new(LogSplitter)
	scanner.Split(splitter.Split)
	var events []logEvent
	for scanner.Scan() {
		events = append(events, logEvent{text: scanner.Text(), part: splitter.LastWasPartial()})
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanner failed: %v", err)
	}
	return events
}

// reassemble merges part events into lines, mirroring the frontend handler.
func reassemble(events []logEvent) []string {
	var lines []string
	pending := ""
	for _, e := range events {
		if e.part {
			pending += e.text
			continue
		}
		lines = append(lines, pending+e.text)
		pending = ""
	}
	if pending != "" {
		lines = append(lines, pending) // stream died mid-line
	}
	return lines
}

func TestLogSplitterPlainLines(t *testing.T) {
	events := scanEvents(t, []byte("a\nbb\r\nccc\n"))
	if got, want := reassemble(events), []string{"a", "bb", "ccc"}; !reflect.DeepEqual(got, want) {
		t.Errorf("lines = %q, want %q", got, want)
	}
	for _, e := range events {
		if e.part {
			t.Errorf("unexpected part event %q", e.text)
		}
	}
}

func TestLogSplitterLongLineKeepsStreamAlive(t *testing.T) {
	long := strings.Repeat("x", 2*LogChunkSize+1000)
	events := scanEvents(t, []byte(long+"\nafter\n"))
	if got, want := reassemble(events), []string{long, "after"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lines mismatch: got %d lines, want %d", len(got), len(want))
	}
	parts := 0
	for _, e := range events {
		if e.part {
			parts++
			if len(e.text) != LogChunkSize {
				t.Errorf("part length = %d, want %d", len(e.text), LogChunkSize)
			}
		}
	}
	if parts != 2 {
		t.Errorf("expected 2 part events, got %d", parts)
	}
}

func TestLogSplitterExactMultipleLine(t *testing.T) {
	// The newline arrives only after the piece; the empty completer token
	// must close the line without swallowing the next one.
	long := strings.Repeat("y", LogChunkSize)
	got := reassemble(scanEvents(t, []byte(long+"\nnext\n")))
	if want := []string{long, "next"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lines mismatch: got %d lines", len(got))
	}
}

func TestLogSplitterFinalLineWithoutNewline(t *testing.T) {
	events := scanEvents(t, []byte("a\nb"))
	if got, want := reassemble(events), []string{"a", "b"}; !reflect.DeepEqual(got, want) {
		t.Errorf("lines = %q, want %q", got, want)
	}
	if events[len(events)-1].part {
		t.Error("final unterminated line must be a complete line")
	}
}

func TestLogSplitterHugeFinalLineWithoutNewline(t *testing.T) {
	long := strings.Repeat("z", 2*LogChunkSize+500)
	events := scanEvents(t, []byte("a\n" + long))
	if got, want := reassemble(events), []string{"a", long}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lines mismatch: got %d lines", len(got))
	}
	if events[len(events)-1].part {
		t.Error("final piece must be a complete line")
	}
}

func TestLogSplitterCRLFSplitAtChunkBoundary(t *testing.T) {
	// A CRLF ending that straddles a piece boundary must not leak the CR
	// into the rendered line.
	content := strings.Repeat("c", LogChunkSize-1)
	events := scanEvents(t, []byte(content+"\r\nnext\n"))
	if got, want := reassemble(events), []string{content, "next"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lines mismatch: got %d lines, want %d", len(got), len(want))
	}
}

func TestLogSplitterStripsTrailingCRAtEOF(t *testing.T) {
	// Parity with bufio.ScanLines: a stream ending in a bare CR (no LF) has
	// the CR stripped from the final line.
	events := scanEvents(t, []byte("a\nb\r"))
	if got, want := reassemble(events), []string{"a", "b"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("lines mismatch: got %q, want %q", got, want)
	}
}

func TestLogSplitterEmpty(t *testing.T) {
	if events := scanEvents(t, nil); len(events) != 0 {
		t.Fatalf("expected no events, got %d", len(events))
	}
}

func TestLogSplitterSplitAtEOFBeyondChunk(t *testing.T) {
	// The defensive atEOF split is unreachable through a scanner capped at
	// LogChunkSize; exercise it directly.
	s := new(LogSplitter)
	advance, token, err := s.Split([]byte(strings.Repeat("q", LogChunkSize+7)), true)
	if err != nil {
		t.Fatal(err)
	}
	if advance != LogChunkSize || len(token) != LogChunkSize {
		t.Errorf("advance=%d len=%d, want %d/%d", advance, len(token), LogChunkSize, LogChunkSize)
	}
	if !s.LastWasPartial() {
		t.Error("expected partial flag")
	}
}
