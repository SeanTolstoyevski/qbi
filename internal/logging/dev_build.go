//go:build dev

package logging

// DevBuild is true when compiled with the "dev" build tag, which `wails dev`
// applies automatically (the same mechanism Wails itself uses to pick its dev
// runtime).
const DevBuild = true
