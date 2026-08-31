//go:build windows

package kube

import (
	"os/exec"
	"syscall"
)

// setProcAttr configures the child process to be fully detached from qbi's
// console on Windows. CREATE_NEW_PROCESS_GROUP ensures the new terminal is
// independent and not killed when qbi exits.
func setProcAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}
