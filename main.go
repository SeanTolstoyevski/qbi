package main

import (
	"context"
	"embed"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	app := NewApp()
	service := NewService(app)

	err := wails.Run(&options.App{
		Title:  "QBI - Kubernetes inspector",
		Width:  1200,
		Height: 800,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		// Stop background Kubernetes watches on exit so no goroutines outlive
		// the process (log streams ride on the app context and stop with it).
		OnShutdown: func(ctx context.Context) {
			service.Shutdown()
		},
		Bind: []any{
			service,
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
