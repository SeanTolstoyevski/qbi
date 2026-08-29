//go:build !windows

package kube

import (
	"os/exec"
	"syscall"
)

// setProcAttr configures the child process to run in a new process group on
// Unix-like systems so it is not sent SIGHUP when qbi closes its terminal.
func setProcAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
