// Package version holds build-time version information for QBI.
//
// The canonical source of the version is the VERSION file in the repository
// root. It holds either a stable semantic version ("0.2.0") or a beta
// ("0.2.0-beta" for a first beta, "0.2.0-beta.1" for a repeated one); the
// channel is derived from that string, never stored separately. The release
// workflow (.github/workflows/release.yml) reads the file and injects the
// values here through Go linker flags, e.g.:
//
//	wails build -ldflags "-X qbi/internal/version.Version=0.2.0-beta.1 -X qbi/internal/version.Commit=<sha> -X qbi/internal/version.BuildTime=2026-06-18T12:34:56Z"
//
// Local and CI (non-release) builds keep the fallback values below.
package version

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Build channels. Every build belongs to exactly one:
//
//   - ChannelRelease: a stable version with no prerelease suffix.
//   - ChannelBeta: a prerelease, written "-beta" or "-beta.<n>" by the release
//     pipeline (e.g. "0.2.0-beta", "0.2.0-beta.1"). Beta builds are published
//     as GitHub pre-releases and never become "latest".
//   - ChannelDev: a build the release pipeline did not stamp (Version is the
//     "dev" fallback) or a version string that does not parse.
const (
	ChannelRelease = "release"
	ChannelBeta    = "beta"
	ChannelDev     = "dev"
)

// Version is the semantic version of QBI (e.g. "0.2.0", "0.2.0-beta" or
// "0.2.0-beta.1"), set at build time via -ldflags. "dev" marks builds that
// were not produced by the release pipeline.
var Version = "dev"

// Commit is the git commit the binary was built from, set at build time via
// -ldflags.
var Commit = "unknown"

// BuildTime is the UTC timestamp when the binary was compiled (RFC 3339,
// e.g. "2026-06-18T12:34:56Z"), set at build time via -ldflags. The frontend
// formats it for display; "unknown" marks builds that were not stamped.
var BuildTime = "unknown"

// SemVer is a parsed semantic version: "0.2.0" for a release, or
// "0.2.0-beta" / "0.2.0-beta.1" for a beta.
type SemVer struct {
	Major      int
	Minor      int
	Patch      int
	Prerelease string // identifiers after "-", empty for a stable release
}

// String renders the version in its canonical form.
func (v SemVer) String() string {
	s := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if v.Prerelease != "" {
		s += "-" + v.Prerelease
	}
	return s
}

// IsPrerelease reports whether the version carries a prerelease suffix.
func (v SemVer) IsPrerelease() bool { return v.Prerelease != "" }

// Channel returns the build channel of the version: ChannelBeta for a
// prerelease, ChannelRelease otherwise.
func (v SemVer) Channel() string {
	if v.IsPrerelease() {
		return ChannelBeta
	}
	return ChannelRelease
}

// Parse parses "x.y.z" or "x.y.z-<prerelease>", e.g. "0.1.15", "0.2.0-beta"
// or "0.2.0-beta.1". Prerelease identifiers are accepted as-is; the release
// pipeline only stamps "beta" and "beta.<n>".
func Parse(s string) (SemVer, error) {
	core, prerelease := s, ""
	if i := strings.IndexByte(s, '-'); i >= 0 {
		core, prerelease = s[:i], s[i+1:]
		if prerelease == "" {
			return SemVer{}, fmt.Errorf("version %q has an empty prerelease", s)
		}
	}

	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return SemVer{}, fmt.Errorf("version %q is not <major>.<minor>.<patch>[-<prerelease>]", s)
	}
	var nums [3]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return SemVer{}, fmt.Errorf("version %q has an invalid numeric component %q", s, p)
		}
		nums[i] = n
	}

	if prerelease != "" {
		for _, id := range strings.Split(prerelease, ".") {
			if id == "" || strings.Trim(id, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-") != "" {
				return SemVer{}, fmt.Errorf("version %q has an invalid prerelease %q", s, prerelease)
			}
		}
	}

	return SemVer{Major: nums[0], Minor: nums[1], Patch: nums[2], Prerelease: prerelease}, nil
}

// ChannelOf classifies a version string: ChannelRelease for a stable version,
// ChannelBeta for a prerelease and ChannelDev for anything unparsable
// (including the "dev" fallback of local builds).
func ChannelOf(v string) string {
	parsed, err := Parse(v)
	if err != nil {
		return ChannelDev
	}
	return parsed.Channel()
}

// BuildInfo is the build metadata shown on the About page, returned as one
// payload instead of several separate calls.
type BuildInfo struct {
	Version   string `json:"version"`
	Channel   string `json:"channel"`
	Commit    string `json:"commit"`
	BuildTime string `json:"buildTime"`
}

// Info assembles the current build metadata. The build time is normalized to
// UTC so one build reads the same wherever it is shown.
func Info() BuildInfo {
	return BuildInfo{
		Version:   Version,
		Channel:   ChannelOf(Version),
		Commit:    Commit,
		BuildTime: normalizeBuildTime(BuildTime),
	}
}

// normalizeBuildTime renders raw as RFC 3339 in UTC. The release workflow
// already stamps UTC ("date -u"); normalizing keeps that contract for
// hand-stamped or offset-bearing values. Unparsable values pass through.
func normalizeBuildTime(raw string) string {
	if raw == "" || raw == "unknown" {
		return "unknown"
	}
	t, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return raw
	}
	return t.UTC().Format(time.RFC3339)
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
