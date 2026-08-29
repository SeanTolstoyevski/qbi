package main

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"qbi/internal/kube"
)

// fakePortForward is a scriptable portForwardSession: the test decides when
// it becomes ready, what it reports, and never needs a real cluster.
type fakePortForward struct {
	localPort int
	readyCh   chan struct{}
	resultCh  chan error
	stopped   chan struct{}
	stopOnce  sync.Once
	errText   string
}

func newFakePortForward(localPort int) *fakePortForward {
	return &fakePortForward{
		localPort: localPort,
		readyCh:   make(chan struct{}),
		resultCh:  make(chan error, 1),
		stopped:   make(chan struct{}),
	}
}

func (f *fakePortForward) LocalPort() int         { return f.localPort }
func (f *fakePortForward) Ready() <-chan struct{} { return f.readyCh }
func (f *fakePortForward) Result() <-chan error   { return f.resultCh }
func (f *fakePortForward) Stop() {
	f.stopOnce.Do(func() {
		close(f.stopped)
		// Like the real session: ending via Stop delivers a nil result so
		// the lifecycle loop can finish and clean up the registry.
		f.resultCh <- nil
	})
}
func (f *fakePortForward) ErrorText() string { return f.errText }

// eventLog captures emitted status events, safe for concurrent access: the
// lifecycle goroutines emit while the test reads.
type eventLog struct {
	mu     sync.Mutex
	events []kube.PortForwardStatus
}

func (l *eventLog) add(st kube.PortForwardStatus) {
	l.mu.Lock()
	l.events = append(l.events, st)
	l.mu.Unlock()
}

func (l *eventLog) snapshot() []kube.PortForwardStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]kube.PortForwardStatus, len(l.events))
	copy(out, l.events)
	return out
}

func (l *eventLog) states() []string {
	var out []string
	for _, e := range l.snapshot() {
		out = append(out, e.State)
	}
	return out
}

func (l *eventLog) count(state string) int {
	n := 0
	for _, e := range l.snapshot() {
		if e.State == state {
			n++
		}
	}
	return n
}

// newPortForwardService returns a Service with the experimental flag on and
// the port-forward seams replaced by fakes. The ready timeout is shortened so
// timeout tests do not wait ten seconds; the previous value is restored when
// the test ends.
func newPortForwardService(t *testing.T, factory func(context.Context, kube.PortForwardSpec) (portForwardSession, error)) (*Service, *eventLog) {
	t.Helper()
	setUserConfigDir(t)
	if err := saveSettings(settings{Experimental: true}); err != nil {
		t.Fatal(err)
	}
	oldTimeout := portForwardReadyTimeout
	portForwardReadyTimeout = 200 * time.Millisecond
	t.Cleanup(func() { portForwardReadyTimeout = oldTimeout })

	s := newTestService()
	s.startPortForward = factory
	log := &eventLog{}
	s.emitPortForwardStatus = log.add
	return s, log
}

// waitFor polls cond until it holds or the deadline passes.
func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within deadline")
}

func TestStartPortForwardRefusedWhileDisabled(t *testing.T) {
	setUserConfigDir(t)
	// Default seams: the gate must refuse the call before any cluster work.
	s := newTestService()
	_, err := s.StartPortForward("default", "web-abc", 0, 8080)
	if err == nil {
		t.Fatal("gated call must fail while experimental features are disabled")
	}
	if !strings.Contains(err.Error(), "experimental features are disabled") {
		t.Fatalf("unexpected gate error: %v", err)
	}
}

func TestStartPortForwardLifecycle(t *testing.T) {
	fake := newFakePortForward(4242)
	s, log := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		return fake, nil
	})

	status, err := s.StartPortForward("default", "web-abc", 0, 8080)
	if err != nil {
		t.Fatal(err)
	}
	if status.State != "starting" {
		t.Fatalf("initial state = %q, want starting", status.State)
	}
	if status.LocalPort != 4242 {
		t.Fatalf("resolved local port = %d, want 4242", status.LocalPort)
	}
	if got := log.states(); len(got) != 1 || got[0] != "starting" {
		t.Fatalf("events after start = %v, want [starting]", got)
	}

	close(fake.readyCh)
	waitFor(t, func() bool { return log.count("active") == 1 })
	if got := log.states(); len(got) != 2 || got[1] != "active" {
		t.Fatalf("events after ready = %v, want [starting active]", got)
	}

	if err := s.StopPortForward(status.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(s.ListPortForwards()) == 0 })
	if got := log.count("stopped"); got != 1 {
		t.Fatalf("stopped events = %d, want exactly 1 (events: %v)", got, log.states())
	}

	// Stopping again is a no-op, not an error.
	if err := s.StopPortForward(status.ID); err != nil {
		t.Fatalf("second stop must be a no-op: %v", err)
	}
}

func TestStartPortForwardRejectsDuplicateTarget(t *testing.T) {
	s, _ := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		return newFakePortForward(0), nil
	})

	if _, err := s.StartPortForward("default", "web-abc", 0, 8080); err != nil {
		t.Fatal(err)
	}
	// Same pod and remote port: rejected while the first is still active.
	_, err := s.StartPortForward("default", "web-abc", 9090, 8080)
	if err == nil || !strings.Contains(err.Error(), "already active") {
		t.Fatalf("duplicate must be rejected, got %v", err)
	}
	// Same pod, different remote port: allowed.
	if _, err := s.StartPortForward("default", "web-abc", 0, 9090); err != nil {
		t.Fatalf("different remote port must be allowed: %v", err)
	}
	// Different pod, same remote port: allowed.
	if _, err := s.StartPortForward("default", "other-pod", 0, 8080); err != nil {
		t.Fatalf("different pod must be allowed: %v", err)
	}
}

func TestStartPortForwardFactoryError(t *testing.T) {
	s, log := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		return nil, errors.New("boom")
	})

	_, err := s.StartPortForward("default", "web-abc", 0, 8080)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("factory error must surface, got %v", err)
	}
	if got := log.snapshot(); len(got) != 0 {
		t.Fatalf("no events expected on factory failure, got %v", got)
	}
	if got := s.ListPortForwards(); len(got) != 0 {
		t.Fatalf("registry must stay empty, got %v", got)
	}
}

func TestStartPortForwardReadyTimeout(t *testing.T) {
	fake := newFakePortForward(4242) // readyCh never closes
	s, log := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		return fake, nil
	})

	if _, err := s.StartPortForward("default", "web-abc", 0, 8080); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		for _, e := range log.snapshot() {
			if e.State == "failed" && e.Error == "timed out waiting for the port forward to become ready" {
				return true
			}
		}
		return false
	})
	waitFor(t, func() bool { return len(s.ListPortForwards()) == 0 })
}

func TestStopPortForwardWhileStartingReportsStopped(t *testing.T) {
	fake := newFakePortForward(4242) // never becomes ready on its own
	s, log := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		return fake, nil
	})

	status, err := s.StartPortForward("default", "web-abc", 0, 8080)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.StopPortForward(status.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool { return len(s.ListPortForwards()) == 0 })

	if got := log.count("failed"); got != 0 {
		t.Fatalf("stop during starting must not be reported as failed (events: %v)", log.states())
	}
	if got := log.count("stopped"); got != 1 {
		t.Fatalf("stopped events = %d, want exactly 1 (events: %v)", got, log.states())
	}
}

func TestStartPortForwardConcurrentDuplicates(t *testing.T) {
	// A factory barrier: both starts pass the fast-fail pre-check and block
	// inside the factory, so only the authoritative check (under the insert
	// lock) can reject the loser.
	barrier := make(chan struct{})
	var mu sync.Mutex
	started := 0
	s, _ := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		mu.Lock()
		started++
		mu.Unlock()
		<-barrier
		return newFakePortForward(0), nil
	})

	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			_, err := s.StartPortForward("default", "web-abc", 0, 8080)
			results <- err
		}()
	}
	waitFor(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return started == 2
	})
	close(barrier)

	var okCount int
	for i := 0; i < 2; i++ {
		err := <-results
		if err == nil {
			okCount++
		} else if !strings.Contains(err.Error(), "already active") {
			t.Fatalf("unexpected error: %v", err)
		}
	}
	if okCount != 1 {
		t.Fatalf("exactly one concurrent start must succeed, got %d", okCount)
	}
	waitFor(t, func() bool { return len(s.ListPortForwards()) == 1 })
}

func TestStopPortForwardUnknownIsNoOp(t *testing.T) {
	s, log := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		t.Fatal("factory must not be called")
		return nil, errors.New("unreachable")
	})
	if err := s.StopPortForward("pf-nope"); err != nil {
		t.Fatalf("unknown id must be a no-op, got %v", err)
	}
	if got := log.snapshot(); len(got) != 0 {
		t.Fatalf("no events expected, got %v", got)
	}
}

func TestStopAllPortForwardsTearsDownSilently(t *testing.T) {
	fake := newFakePortForward(4242)
	s, log := newPortForwardService(t, func(_ context.Context, _ kube.PortForwardSpec) (portForwardSession, error) {
		return fake, nil
	})

	if _, err := s.StartPortForward("default", "web-abc", 0, 8080); err != nil {
		t.Fatal(err)
	}
	close(fake.readyCh)
	waitFor(t, func() bool { return log.count("active") == 1 })

	s.stopAllPortForwards()

	waitFor(t, func() bool { return len(s.ListPortForwards()) == 0 })
	select {
	case <-fake.stopped:
	default:
		t.Fatal("session was not stopped")
	}
	// Teardown must not emit terminal events: the UI is going away and would
	// announce "stopped" for a forward the user did not stop.
	for _, e := range log.snapshot() {
		if e.State != "starting" && e.State != "active" {
			t.Fatalf("unexpected teardown event: %+v", e)
		}
	}
}

func TestPortForwardErrorText(t *testing.T) {
	fake := newFakePortForward(0)
	fake.errText = "unable to forward port because pod is not running"

	if got := portForwardErrorText(errors.New("machinery error"), fake); got != "unable to forward port because pod is not running" {
		t.Fatalf("machinery text must win, got %q", got)
	}
	if got := portForwardErrorText(errors.New("plain error"), newFakePortForward(0)); got != "plain error" {
		t.Fatalf("Go error fallback wrong: %q", got)
	}
	if got := portForwardErrorText(nil, newFakePortForward(0)); got != "the port-forward connection ended unexpectedly" {
		t.Fatalf("fallback message wrong: %q", got)
	}
}
