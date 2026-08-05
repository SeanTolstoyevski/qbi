package kube

import (
	"os"
	"path/filepath"
	"strings"

	"k8s.io/client-go/tools/clientcmd"
)

// KubeconfigStatus describes which kubeconfig the client will use and whether
// it currently resolves to a readable file.
type KubeconfigStatus struct {
	Path   string `json:"path"`   // the resolved file path (may be empty)
	Source string `json:"source"` // "explicit" | "env" | "default" | "none"
	Exists bool   `json:"exists"` // whether Path points at a readable file
}

// Status reports the effective kubeconfig the client will load from, following
// the same precedence as the loader: an explicitly pinned path, then the
// KUBECONFIG environment variable, then the default ~/.kube/config.
func (c *Client) Status() KubeconfigStatus {
	if p := c.KubeconfigPath(); p != "" {
		return KubeconfigStatus{Path: p, Source: "explicit", Exists: fileExists(p)}
	}

	if env := os.Getenv("KUBECONFIG"); env != "" {
		// KUBECONFIG may list several files (merged by client-go); report them
		// all so the status shows the real merge list, and mark exists if any
		// of them is readable.
		files := filepath.SplitList(env)
		exists := false
		for _, f := range files {
			if fileExists(f) {
				exists = true
				break
			}
		}
		return KubeconfigStatus{Path: strings.Join(files, "; "), Source: "env", Exists: exists}
	}

	def := clientcmd.RecommendedHomeFile
	return KubeconfigStatus{Path: def, Source: "default", Exists: fileExists(def)}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
