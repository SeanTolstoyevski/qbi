// Package version holds build-time version information for QBI.
//
// The canonical source of the version is the VERSION file in the repository
// root. The release workflow (.github/workflows/release.yml) reads that file
// and injects it here through Go linker flags, e.g.:
//
//	wails build -ldflags "-X qbi/internal/version.Version=0.2.0 -X qbi/internal/version.Commit=<sha>"
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
