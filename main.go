package main

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"runtime/debug"

	"qbi/internal/logging"
	"qbi/internal/version"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	cfg, cfgErr := logging.Load()
	closer, err := logging.Setup(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "logging setup failed: %v\n", err)
		closer = nil
	} else {
		defer closer.Close()
	}
	if cfgErr != nil {
		slog.Warn("using built-in log profile", "error", cfgErr)
	}

	defer func() {
		if r := recover(); r != nil {
			slog.Error("panic", "panic", fmt.Sprint(r), "stack", string(debug.Stack()))
			panic(r)
		}
	}()

	slog.Info("qbi starting", "version", version.Version, "commit", version.Commit)

	app := NewApp()
	service := NewService(app)

	err = wails.Run(&options.App{
		Title:     "QBI - Kubernetes inspector",
		Width:     1200,
		Height:    800,
		MinWidth:  768,
		MinHeight: 480,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		OnShutdown: func(ctx context.Context) {
			service.Shutdown()
		},
		Bind: []any{
			service,
		},
	})
	if err != nil {
		slog.Error("wails run failed", "error", err)
	}

	slog.Info("qbi exiting")
}
