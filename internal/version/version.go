// Package version holds build-time version information for QBI.
//
// The canonical source of the version is the VERSION file in the repository
// root. The release workflow (.github/workflows/release.yml) reads that file
// and injects it here through Go linker flags, e.g.:
//
//	wails build -ldflags "-X qbi/internal/version.Version=0.2.0 -X qbi/internal/version.Commit=<sha> -X qbi/internal/version.BuildTime=2026-06-18T12:34:56Z"
//
// Local and CI (non-release) builds keep the fallback values below.
package version

// Version is the semantic version of QBI (e.g. "0.2.0"), set at build time
// via -ldflags. "dev" marks builds that were not produced by the release
// pipeline.
var Version = "dev"

// Commit is the git commit the binary was built from, set at build time via
// -ldflags.
var Commit = "unknown"

// BuildTime is the UTC timestamp when the binary was compiled (RFC 3339,
// e.g. "2026-06-18T12:34:56Z"), set at build time via -ldflags. The frontend
// formats it for display; "unknown" marks builds that were not stamped.
var BuildTime = "unknown"

// BuildInfo is the build metadata shown on the About page, returned as one
// payload instead of three separate calls.
type BuildInfo struct {
	Version   string `json:"version"`
	Commit    string `json:"commit"`
	BuildTime string `json:"buildTime"`
}

// Info assembles the current build metadata.
func Info() BuildInfo {
	return BuildInfo{Version: Version, Commit: Commit, BuildTime: BuildTime}
}

// String returns a human-readable version string, e.g. "0.2.0 (a1b2c3d)".
func String() string {
	if Commit == "" || Commit == "unknown" {
		return Version
	}
	short := Commit
	if len(short) > 7 {
		short = short[:7]
	}
	return Version + " (" + short + ")"
}
