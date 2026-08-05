package kube

import (
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
