package kube

import (
	"bytes"
	"context"
	"io"

	corev1 "k8s.io/api/core/v1"
)

// LogOptions controls how a container's logs are fetched.
type LogOptions struct {
	Container  string
	TailLines  int64 // negative means no limit
	Timestamps bool  // prefix each line with an RFC3339 timestamp
	Previous   bool  // read logs from the previous (crashed) container instance
}

// StreamLogs opens a follow stream for a container's logs. The caller owns the
// returned ReadCloser and must Close it to stop the stream.
func (c *Client) StreamLogs(ctx context.Context, namespace, pod string, o LogOptions) (io.ReadCloser, error) {
	cs, err := c.clientOrErr()
	if err != nil {
		return nil, err
	}

	opts := &corev1.PodLogOptions{
		Container:  o.Container,
		Follow:     !o.Previous, // previous-instance logs are terminal; don't follow
		Timestamps: o.Timestamps,
		Previous:   o.Previous,
	}
	if o.TailLines >= 0 {
		tail := o.TailLines
		opts.TailLines = &tail
	}

	req := cs.CoreV1().Pods(namespace).GetLogs(pod, opts)
	return req.Stream(ctx)
}

// LogChunkSize caps the size of a single token the log splitter yields, which
// in turn bounds the bufio.Scanner buffer. A single log line is never allowed
// to exceed this; longer lines are delivered in pieces instead of killing the
// stream with "token too long".
const LogChunkSize = 64 * 1024

// LogSplitter is a bufio.SplitFunc that yields one token per log line, like
// bufio.ScanLines, except it cannot fail: a line longer than LogChunkSize is
// yielded in LogChunkSize pieces so the scanner buffer stays bounded. The
// caller distinguishes a line from a piece of a line via LastWasPartial.
type LogSplitter struct {
	partial bool
}

// Split implements bufio.SplitFunc. Trailing CRLF endings are stripped, same
// as bufio.ScanLines, so emitted lines match what the caller saw before.
func (s *LogSplitter) Split(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if i := bytes.IndexByte(data, '\n'); i >= 0 {
		s.partial = false
		return i + 1, dropCR(data[:i]), nil
	}
	if atEOF {
		if len(data) == 0 {
			s.partial = false
			return 0, nil, nil
		}
		// A final line without a trailing newline, possibly longer than one
		// piece: emit pieces first, then the remainder as a complete line.
		if len(data) > LogChunkSize {
			s.partial = true
			return LogChunkSize, data[:LogChunkSize], nil
		}
		s.partial = false
		return len(data), dropCR(data), nil
	}
	// No newline yet and more input may arrive. Cap the token so the scanner
	// buffer never needs to grow beyond LogChunkSize.
	if len(data) >= LogChunkSize {
		n := LogChunkSize
		if n > 1 && data[n-1] == '\r' {
			n-- // could be the CR half of a CRLF split here; keep it with its LF
		}
		s.partial = true
		return n, data[:n], nil
	}
	return 0, nil, nil // need more data
}

// LastWasPartial reports whether the last yielded token was a piece of a line
// that has not ended yet.
func (s *LogSplitter) LastWasPartial() bool { return s.partial }

func dropCR(data []byte) []byte {
	if len(data) > 0 && data[len(data)-1] == '\r' {
		return data[:len(data)-1]
	}
	return data
}
