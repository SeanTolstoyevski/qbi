package kube

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/portforward"
	"k8s.io/client-go/transport/spdy"
)

// PortForwardSpec describes one TCP port-forward: a local port on this
// machine (bound to 127.0.0.1 only) mapped to a port inside a pod. Only TCP
// is supported — the port-forward protocol the API server speaks carries TCP
// streams, exactly like kubectl port-forward.
type PortForwardSpec struct {
	Namespace  string
	Pod        string
	LocalPort  int // 0 = pick a free port automatically
	RemotePort int
}

// validatePortForwardSpec rejects malformed forward requests before any
// network work happens. LocalPort 0 is the "auto" marker.
func validatePortForwardSpec(spec PortForwardSpec) error {
	if spec.Namespace == "" || spec.Pod == "" {
		return errors.New("pod and namespace are required")
	}
	if errs := validation.IsDNS1123Subdomain(spec.Pod); len(errs) > 0 {
		return fmt.Errorf("invalid pod name %q", spec.Pod)
	}
	if errs := validation.IsDNS1123Label(spec.Namespace); len(errs) > 0 {
		return fmt.Errorf("invalid namespace %q", spec.Namespace)
	}
	if spec.RemotePort < 1 || spec.RemotePort > 65535 {
		return fmt.Errorf("remote port must be between 1 and 65535, got %d", spec.RemotePort)
	}
	if spec.LocalPort < 0 || spec.LocalPort > 65535 {
		return fmt.Errorf("local port must be between 0 (auto) and 65535, got %d", spec.LocalPort)
	}
	return nil
}

// pickFreeLocalPort reserves a free TCP port on the loopback interface and
// returns it. The listener is closed before the forward binds, so another
// process could claim the port in the meantime; if that happens the forward
// fails with a clear bind error instead of silently picking a busy port.
func pickFreeLocalPort() (int, error) {
	ln, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("find a free local port: %w", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port, nil
}

// lockedBuffer is an io.Writer that collects the port-forward machinery's
// stderr output for later inspection. Safe for concurrent writes: the
// machinery writes from its own goroutine while the caller reads the result.
type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

// PortForwardSession is a running port-forward connection. The forward runs
// in the background once StartPortForward returns; the caller observes it
// through Ready and Result, and ends it with Stop.
type PortForwardSession struct {
	localPort int

	stopCh   chan struct{}
	readyCh  chan struct{}
	resultCh chan error // exactly one value, then closed
	errBuf   *lockedBuffer
	stopOnce sync.Once
}

// LocalPort returns the resolved local port: the explicitly requested one,
// or the free port that was picked when the request asked for auto (0).
func (s *PortForwardSession) LocalPort() int { return s.localPort }

// Stop ends the forward. It is idempotent and safe to call from any
// goroutine; ForwardPorts returns nil once the stop takes effect.
func (s *PortForwardSession) Stop() {
	s.stopOnce.Do(func() { close(s.stopCh) })
}

// Ready is closed once the local port is bound and traffic can flow.
func (s *PortForwardSession) Ready() <-chan struct{} { return s.readyCh }

// Result yields the forward's outcome exactly once: nil when it ended via
// Stop, an error when the connection died or never became ready.
func (s *PortForwardSession) Result() <-chan error { return s.resultCh }

// ErrorText returns the diagnostic output the port-forward machinery wrote
// (e.g. "unable to forward port because pod is not running"), trimmed. Empty
// when nothing was reported.
func (s *PortForwardSession) ErrorText() string {
	return strings.TrimSpace(s.errBuf.String())
}

// portForwardRequest builds the API-server request for a pod's portforward
// subresource. Extracted from StartPortForward so tests can assert the exact
// URL without a live server.
func portForwardRequest(rc rest.Interface, namespace, pod string) *rest.Request {
	return rc.Post().
		Resource("pods").
		Namespace(namespace).
		Name(pod).
		SubResource("portforward")
}

// StartPortForward opens a TCP port-forward from 127.0.0.1 on this machine to
// RemotePort inside the given pod, using the SPDY stream protocol the API
// server speaks. The local port is bound to the loopback address only — never
// to a network interface — so the pod is never exposed beyond this machine.
// The forward runs in the background; Stop ends it, and cancelling ctx also
// stops it (app shutdown, teardown).
func (c *Client) StartPortForward(ctx context.Context, spec PortForwardSpec) (*PortForwardSession, error) {
	if err := validatePortForwardSpec(spec); err != nil {
		return nil, err
	}
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}
	cfg, err := c.restConfigCopy()
	if err != nil {
		return nil, err
	}

	localPort := spec.LocalPort
	if localPort == 0 {
		localPort, err = pickFreeLocalPort()
		if err != nil {
			return nil, err
		}
	}

	transport, upgrader, err := spdy.RoundTripperFor(cfg)
	if err != nil {
		return nil, fmt.Errorf("create port-forward transport: %w", err)
	}
	dialer := spdy.NewDialer(
		upgrader,
		&http.Client{Transport: transport},
		http.MethodPost,
		portForwardRequest(cs.CoreV1().RESTClient(), spec.Namespace, spec.Pod).URL(),
	)

	stopCh := make(chan struct{})
	readyCh := make(chan struct{})
	errBuf := &lockedBuffer{}
	fw, err := portforward.NewOnAddresses(
		dialer,
		[]string{"127.0.0.1"},
		[]string{strconv.Itoa(localPort) + ":" + strconv.Itoa(spec.RemotePort)},
		stopCh,
		readyCh,
		io.Discard,
		errBuf,
	)
	if err != nil {
		return nil, fmt.Errorf("create port-forward: %w", err)
	}

	session := &PortForwardSession{
		localPort: localPort,
		stopCh:    stopCh,
		readyCh:   readyCh,
		resultCh:  make(chan error, 1),
		errBuf:    errBuf,
	}

	go func() {
		// If the caller's context ends (app shutdown, teardown), stop the
		// forward instead of leaving the local port bound indefinitely.
		go func() {
			select {
			case <-ctx.Done():
				session.Stop()
			case <-session.stopCh:
			}
		}()
		session.resultCh <- fw.ForwardPorts()
		close(session.resultCh)
	}()

	return session, nil
}
