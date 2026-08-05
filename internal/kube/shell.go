package kube

import (
	"errors"
	"fmt"
	"os/exec"
	"runtime"
)

// OpenShell launches the OS default terminal and runs an interactive
// kubectl exec session for the given pod/container. It passes --context and
// --kubeconfig explicitly so the shell always connects to the same cluster
// that qbi is currently inspecting, regardless of the user's ambient
// KUBECONFIG or current-context setting.
//
// Shell selection inside the container: we try /bin/bash first; if not found
// kubectl will fall back to /bin/sh via the shell itself — we therefore just
// pass `sh` and let it be whatever the container provides (ash, dash, bash, …).
// The user can invoke bash manually once inside.
func (c *Client) OpenShell(namespace, pod, container string) error {
	if pod == "" || namespace == "" {
		return errors.New("pod and namespace are required")
	}

	args := buildKubectlArgs(c, namespace, pod, container)
	return launchTerminal(args)
}

// buildKubectlArgs constructs the full kubectl exec argument list.
func buildKubectlArgs(c *Client, namespace, pod, container string) []string {
	args := []string{
		"exec", "-it", pod,
		"-n", namespace,
	}
	if ctx := c.CurrentContext(); ctx != "" {
		args = append(args, "--context", ctx)
	}
	if kp := c.KubeconfigPath(); kp != "" {
		args = append(args, "--kubeconfig", kp)
	}
	if container != "" {
		args = append(args, "-c", container)
	}
	args = append(args, "--", "sh")
	return args
}

// launchTerminal opens the system terminal with `kubectl <args>`. The strategy
// differs per OS; we try preferred emulators first and fall back to safe
// defaults. All launches are non-blocking — the terminal opens in the
// background while qbi continues running.
func launchTerminal(kubectlArgs []string) error {
	switch runtime.GOOS {
	case "windows":
		return launchWindows(kubectlArgs)
	case "darwin":
		return launchMacOS(kubectlArgs)
	default:
		return launchLinux(kubectlArgs)
	}
}

// launchWindows tries Windows Terminal (wt), then falls back to PowerShell,
// then cmd. wt is preferred because it supports modern tab/profile handling.
func launchWindows(kubectlArgs []string) error {
	kubectl := "kubectl"

	// Windows Terminal: wt new-tab -- kubectl exec ...
	if wt, err := exec.LookPath("wt"); err == nil {
		args := append([]string{"new-tab", "--", kubectl}, kubectlArgs...)
		return startDetached(wt, args)
	}

	if ps, err := exec.LookPath("powershell.exe"); err == nil {
		// Combine kubectl + its args into a single string for -Command.
		cmdLine := shellQuoteArgs(append([]string{kubectl}, kubectlArgs...))
		return startDetached(ps, []string{"-NoLogo", "-Command", cmdLine})
	}

	// cmd.exe last resort.
	if cmd, err := exec.LookPath("cmd.exe"); err == nil {
		cmdLine := shellQuoteArgs(append([]string{kubectl}, kubectlArgs...))
		return startDetached(cmd, []string{"/C", cmdLine})
	}

	return errors.New("no suitable terminal emulator found (tried: wt, powershell, cmd)")
}

// launchMacOS uses the open(1) command to spawn Terminal.app with a kubectl
// exec invocation. The osascript approach is more reliable for keeping the
// window open after the exec ends, but open -a Terminal is universally present.
func launchMacOS(kubectlArgs []string) error {
	inner := shellQuoteArgs(append([]string{"kubectl"}, kubectlArgs...))
	script := fmt.Sprintf(
		`tell application "Terminal" to do script %q`,
		inner,
	)
	return startDetached("osascript", []string{"-e", script})
}

// launchLinux tries common terminal emulators in preference order.
func launchLinux(kubectlArgs []string) error {
	kubectl := "kubectl"
	candidates := []struct {
		bin  string
		args func([]string) []string
	}{
		{"xdg-terminal-exec", func(a []string) []string { return append([]string{kubectl}, a...) }},
		{"gnome-terminal", func(a []string) []string {
			return append([]string{"--"}, append([]string{kubectl}, a...)...)
		}},

		{"konsole", func(a []string) []string {
			return append([]string{"-e", kubectl}, a...)
		}},

		{"xfce4-terminal", func(a []string) []string {
			return append([]string{"-e", shellQuoteArgs(append([]string{kubectl}, a...))}, []string{}...)
		}},

		{"xterm", func(a []string) []string {
			return append([]string{"-e", kubectl}, a...)
		}},
	}

	for _, c := range candidates {
		if p, err := exec.LookPath(c.bin); err == nil {
			return startDetached(p, c.args(kubectlArgs))
		}
	}

	return errors.New("no suitable terminal emulator found (tried: xdg-terminal-exec, gnome-terminal, konsole, xfce4-terminal, xterm)")
}

// startDetached starts cmd with args as a fully detached process — no stdin/
// stdout/stderr inheritance from qbi, no wait. It returns an error only if the
// process could not be started at all.
func startDetached(cmd string, args []string) error {
	c := exec.Command(cmd, args...)
	setProcAttr(c)
	return c.Start()
}

// shellQuoteArgs joins arguments into a single shell-safe string. This is used
// only when the terminal emulator requires a single command string rather than
// an argv slice (PowerShell -Command, cmd /C).
func shellQuoteArgs(args []string) string {
	out := ""
	for i, a := range args {
		if i > 0 {
			out += " "
		}

		needsQuote := false
		for _, ch := range a {
			if ch == ' ' || ch == '\t' || ch == '"' || ch == '\\' || ch == '&' || ch == '|' || ch == '<' || ch == '>' || ch == '(' || ch == ')' {
				needsQuote = true
				break
			}
		}
		if needsQuote {
			escaped := ""
			for _, ch := range a {
				if ch == '"' || ch == '\\' {
					escaped += "\\"
				}
				escaped += string(ch)
			}
			out += `"` + escaped + `"`
		} else {
			out += a
		}
	}
	return out
}
