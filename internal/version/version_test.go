package version

import (
	"reflect"
	"testing"
)

func TestStringFallback(t *testing.T) {
	// Defaults: local / non-release builds.
	Version = "dev"
	Commit = "unknown"
	if got := String(); got != "dev" {
		t.Fatalf("String() with defaults = %q, want %q", got, "dev")
	}
}

func TestStringWithCommit(t *testing.T) {
	Version = "0.2.0"
	Commit = "deadbeefcafef00d"
	if got := String(); got != "0.2.0 (deadbee)" {
		t.Fatalf("String() = %q, want %q", got, "0.2.0 (deadbee)")
	}
}

func TestStringShortCommit(t *testing.T) {
	Version = "0.2.0"
	Commit = "abc"
	if got := String(); got != "0.2.0 (abc)" {
		t.Fatalf("String() = %q, want %q", got, "0.2.0 (abc)")
	}
}

func TestInfo(t *testing.T) {
	Version = "0.2.0"
	Commit = "a1b2c3d"
	BuildTime = "2026-06-18T12:34:56Z"
	want := BuildInfo{
		Version:   "0.2.0",
		Channel:   ChannelRelease,
		Commit:    "a1b2c3d",
		BuildTime: "2026-06-18T12:34:56Z",
	}
	if got := Info(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Info() = %+v, want %+v", got, want)
	}
}

func TestInfoBetaChannel(t *testing.T) {
	for _, v := range []string{"0.2.0-beta", "0.2.0-beta.1"} {
		Version = v
		Commit = "a1b2c3d"
		BuildTime = "2026-06-18T12:34:56Z"
		got := Info()
		if got.Channel != ChannelBeta {
			t.Fatalf("Info() for %q: Channel = %q, want %q", v, got.Channel, ChannelBeta)
		}
		if got.Version != v {
			t.Fatalf("Info().Version = %q, want %q", got.Version, v)
		}
	}
}

func TestInfoDevChannel(t *testing.T) {
	Version = "dev"
	Commit = "unknown"
	BuildTime = "unknown"
	if got := Info().Channel; got != ChannelDev {
		t.Fatalf("Info().Channel = %q, want %q", got, ChannelDev)
	}
}

func TestInfoNormalizesBuildTimeToUTC(t *testing.T) {
	Version = "0.2.0"
	Commit = "a1b2c3d"
	// A build stamped with a local offset must surface as the same instant in
	// UTC, so the About page reads identically everywhere.
	BuildTime = "2026-06-18T15:34:56+03:00"
	if got := Info().BuildTime; got != "2026-06-18T12:34:56Z" {
		t.Fatalf("Info().BuildTime = %q, want %q", got, "2026-06-18T12:34:56Z")
	}
}

func TestInfoKeepsUnstampedBuildTime(t *testing.T) {
	for _, raw := range []string{"", "unknown", "not-a-timestamp"} {
		BuildTime = raw
		want := raw
		if raw == "" {
			want = "unknown"
		}
		if got := Info().BuildTime; got != want {
			t.Fatalf("Info().BuildTime for %q = %q, want %q", raw, got, want)
		}
	}
}

func TestParse(t *testing.T) {
	tests := []struct {
		in      string
		want    SemVer
		wantErr bool
	}{
		{in: "0.2.0", want: SemVer{Major: 0, Minor: 2, Patch: 0}},
		{in: "0.2.0-beta", want: SemVer{Major: 0, Minor: 2, Patch: 0, Prerelease: "beta"}},
		{in: "0.2.0-beta.1", want: SemVer{Major: 0, Minor: 2, Patch: 0, Prerelease: "beta.1"}},
		{in: "12.34.56-beta.10", want: SemVer{Major: 12, Minor: 34, Patch: 56, Prerelease: "beta.10"}},
		{in: "1.0.0-rc-2", want: SemVer{Major: 1, Minor: 0, Patch: 0, Prerelease: "rc-2"}},
		{in: "dev", wantErr: true},
		{in: "", wantErr: true},
		{in: "1.2", wantErr: true},
		{in: "1.2.3.4", wantErr: true},
		{in: "1.2.x", wantErr: true},
		{in: "1.2.-3", wantErr: true},
		{in: "0.2.0-", wantErr: true},
		{in: "0.2.0-beta..1", wantErr: true},
		{in: "0.2.0-beta 1", wantErr: true},
		{in: "v0.2.0", wantErr: true},
	}
	for _, tc := range tests {
		got, err := Parse(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("Parse(%q) = %+v, want an error", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("Parse(%q) returned an unexpected error: %v", tc.in, err)
			continue
		}
		if got != tc.want {
			t.Errorf("Parse(%q) = %+v, want %+v", tc.in, got, tc.want)
		}
		if got.String() != tc.in {
			t.Errorf("Parse(%q).String() = %q, want the input back", tc.in, got.String())
		}
	}
}

func TestChannelOf(t *testing.T) {
	tests := map[string]string{
		"0.1.15":       ChannelRelease,
		"0.2.0":        ChannelRelease,
		"0.2.0-beta":   ChannelBeta,
		"0.1.14-beta":  ChannelBeta,
		"0.2.0-beta.1": ChannelBeta,
		"0.2.0-beta.7": ChannelBeta,
		"dev":          ChannelDev,
		"":             ChannelDev,
		"v0.2.0":       ChannelDev,
		"0.2.0-beta.":  ChannelDev,
	}
	for in, want := range tests {
		if got := ChannelOf(in); got != want {
			t.Errorf("ChannelOf(%q) = %q, want %q", in, got, want)
		}
	}
}
