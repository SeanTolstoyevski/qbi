package main

import (
	"context"

	"qbi/internal/kube"
)

// App holds application-wide state and the Wails runtime context.
type App struct {
	ctx  context.Context
	kube *kube.Client
}

// NewApp constructs the App with an unconnected Kubernetes client.
func NewApp() *App {
	return &App{kube: kube.NewClient()}
}

// startup stores the Wails runtime context and restores any previously chosen
// kubeconfig file so the user does not have to re-select it every launch.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx

	if s := loadSettings(); s.KubeconfigPath != "" {
		a.kube.SetKubeconfigPath(s.KubeconfigPath)
	}
}
