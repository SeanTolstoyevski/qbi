package main

import (
	"context"
	"io"
	"strconv"
	"strings"
	"testing"
	"time"

	"qbi/internal/kube"
)

// emittedEvent records one event forwarded by pumpLogStream.
type emittedEvent struct {
	name string
	data string
}

func collector(events *[]emittedEvent) func(string, any) {
	return func(name string, data any) {
		*events = append(*events, emittedEvent{name: name, data: data.(string)})
	}
}

func TestPumpLogStreamBatchesLines(t *testing.T) {
	var src strings.Builder
	for i := 0; i < 10; i++ {
		src.WriteString("line " + strconv.Itoa(i) + "\n")
	}
	var events []emittedEvent
	err := pumpLogStream("k", strings.NewReader(src.String()), new(kube.LogSplitter), collector(&events), time.Hour, 3)
	if err != nil {
		t.Fatalf("pumpLogStream: %v", err)
	}
	var batches []string
	for _, e := range events {
		if e.name != "log:batch:k" {
			t.Fatalf("unexpected event %q", e.name)
		}
		batches = append(batches, e.data)
	}
	want := []string{
		"line 0\nline 1\nline 2",
		"line 3\nline 4\nline 5",
		"line 6\nline 7\nline 8",
		"line 9",
	}
	if len(batches) != len(want) {
		t.Fatalf("got %d batches %q, want %d", len(batches), batches, len(want))
	}
	for i := range want {
		if batches[i] != want[i] {
			t.Errorf("batch %d = %q, want %q", i, batches[i], want[i])
		}
	}
}

func TestPumpLogStreamFlushesSlowStreamsByInterval(t *testing.T) {
	pr, pw := io.Pipe()
	events := make(chan emittedEvent, 16)
	emit := func(name string, data any) {
		events <- emittedEvent{name: name, data: data.(string)}
	}
	done := make(chan error, 1)
	go func() {
		done <- pumpLogStream("k", pr, new(kube.LogSplitter), emit, 5*time.Millisecond, 100)
	}()

	if _, err := pw.Write([]byte("slow one\n")); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case e := <-events:
		if e.name != "log:batch:k" || e.data != "slow one" {
			t.Fatalf("got %q=%q, want a single-line batch", e.name, e.data)
		}
	case <-time.After(time.Second):
		t.Fatal("a lone line was not flushed by the interval ticker")
	}

	pw.Close()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("pumpLogStream: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("pumpLogStream did not return after EOF")
	}
}

func TestPumpLogStreamFlushesBeforePartialPieces(t *testing.T) {
	big := strings.Repeat("x", kube.LogChunkSize+10)
	src := "a\nb\n" + big + "\nc\n"
	var events []emittedEvent
	err := pumpLogStream("k", strings.NewReader(src), new(kube.LogSplitter), collector(&events), time.Hour, 2)
	if err != nil {
		t.Fatalf("pumpLogStream: %v", err)
	}

	if len(events) != 3 {
		t.Fatalf("got %d events, want 3: %q", len(events), events)
	}
	if e := events[0]; e.name != "log:batch:k" || e.data != "a\nb" {
		t.Errorf("event 0 = %q=%q, want batch \"a\\nb\"", e.name, e.data)
	}
	if e := events[1]; e.name != "log:part:k" || len(e.data) != kube.LogChunkSize {
		t.Errorf("event 1 = %q (%d bytes), want a %d-byte partial piece", e.name, len(e.data), kube.LogChunkSize)
	}
	// The 10-byte tail of the oversized line arrives as a complete line, so
	// the frontend reassembles it against the partial piece; "c" follows.
	if e := events[2]; e.name != "log:batch:k" || e.data != strings.Repeat("x", 10)+"\nc" {
		t.Errorf("event 2 = %q=%q, want the line tail plus \"c\"", e.name, e.data)
	}
}

func TestStartLogStreamReservesUniqueKeys(t *testing.T) {
	s := newTestService()
	opts := LogStreamOptions{TailLines: 500, Timestamps: true}

	k1, err := s.StartLogStream("ns", "pod", "c", opts)
	if err != nil {
		t.Fatalf("StartLogStream: %v", err)
	}
	k2, err := s.StartLogStream("ns", "pod", "c", opts)
	if err != nil {
		t.Fatalf("StartLogStream: %v", err)
	}
	if k1 == k2 {
		t.Fatalf("restarts must get unique keys, got %q twice", k1)
	}

	s.mu.Lock()
	e1, ok1 := s.streams[k1]
	e2, ok2 := s.streams[k2]
	s.mu.Unlock()
	if !ok1 || !ok2 {
		t.Fatal("both reserved keys must be present in the map")
	}
	if e1.cancel == nil || e2.cancel == nil {
		t.Fatal("reserved entries must carry a working cancel func")
	}
	if e1.started || e2.started {
		t.Fatal("reserved entries must not be marked started")
	}

	// Stopping a reserved (never followed) stream must remove its entry: no
	// goroutine exists to clean it up later.
	s.StopLogStream(k1)
	s.mu.Lock()
	_, exists := s.streams[k1]
	_, stillThere := s.streams[k2]
	s.mu.Unlock()
	if exists {
		t.Fatal("stopping an unfollowed stream must remove its entry")
	}
	if !stillThere {
		t.Fatal("stopping one stream must not touch the other")
	}

	s.StopLogStream(k2)
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.streams) != 0 {
		t.Fatalf("expected an empty stream map, got %d entries", len(s.streams))
	}
}

func TestStopLogStreamCancelsStartedEntry(t *testing.T) {
	s := newTestService()
	cancelCalled := make(chan struct{})
	s.streams["k"] = &logStreamEntry{cancel: func() { close(cancelCalled) }, started: true}

	s.StopLogStream("k")

	select {
	case <-cancelCalled:
	case <-time.After(time.Second):
		t.Fatal("cancel was not called")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.streams["k"]; !ok {
		t.Fatal("stopping a started stream must leave the entry for its goroutine to clean up")
	}
}

func TestFollowLogStreamRejectsUnknownOrRepeatedKey(t *testing.T) {
	s := newTestService()

	if err := s.FollowLogStream("ns/pod/c#99"); err == nil {
		t.Fatal("following an unknown key must fail")
	}

	s.streams["k"] = &logStreamEntry{cancel: func() {}, started: true}
	if err := s.FollowLogStream("k"); err == nil {
		t.Fatal("following an already-started key must fail")
	}
}

func TestFollowLogStreamErrorLeavesNoEntry(t *testing.T) {
	app := &App{ctx: context.Background(), kube: kube.NewClient()}
	s := &Service{app: app, streams: make(map[string]*logStreamEntry)}

	key, err := s.StartLogStream("ns", "pod", "container", LogStreamOptions{})
	if err != nil {
		t.Fatalf("StartLogStream: %v", err)
	}
	if err := s.FollowLogStream(key); err == nil {
		t.Fatal("expected an error from a disconnected client")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.streams) != 0 {
		t.Fatal("stream entry left behind after FollowLogStream error")
	}
}
