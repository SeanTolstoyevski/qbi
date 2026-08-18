package kube

import (
	"sync"
	"testing"
	"time"

	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"
)

// blockingWatch implements watch.Interface with a nil result channel: the
// stream never delivers an event, so runWatch can only end when its context
// is cancelled — which is exactly what Stop must do. It records that Stop was
// called on it.
type blockingWatch struct {
	stopped chan struct{}
}

func (b *blockingWatch) ResultChan() <-chan watch.Event { return nil }

func (b *blockingWatch) Stop() {
	select {
	case <-b.stopped:
	default:
		close(b.stopped)
	}
}

// Stop must cancel every running watch stream: a watcher left running after a
// disconnect would keep the backend talking to a dead cluster forever.
func TestWatcherStopCancelsStreams(t *testing.T) {
	c := &Client{}
	c.mu.Lock()
	cs := fake.NewSimpleClientset()
	c.clientset = cs
	c.mu.Unlock()

	// Route every watch to a blockingWatch so cancellation is the only thing
	// that can terminate a stream.
	var mu sync.Mutex
	var blocking []*blockingWatch
	cs.PrependWatchReactor("*", func(k8stesting.Action) (bool, watch.Interface, error) {
		b := &blockingWatch{stopped: make(chan struct{})}
		mu.Lock()
		blocking = append(blocking, b)
		mu.Unlock()
		return true, b, nil
	})

	// 2 cluster-scoped (Node, Namespace) + 7 namespace-scoped watches.
	const wantStreams = 9

	w := NewWatcher(c, func(WatchEvent) {})
	w.Start("default")

	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		n := len(blocking)
		mu.Unlock()
		if n >= wantStreams {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("only %d of %d watch streams started", n, wantStreams)
		}
		time.Sleep(5 * time.Millisecond)
	}

	w.Stop()

	mu.Lock()
	streams := make([]*blockingWatch, len(blocking))
	copy(streams, blocking)
	mu.Unlock()

	for i, b := range streams {
		select {
		case <-b.stopped:
		case <-time.After(3 * time.Second):
			t.Fatalf("watch stream %d was not stopped", i)
		}
	}
}
