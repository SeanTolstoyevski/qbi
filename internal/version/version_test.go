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
	want := BuildInfo{Version: "0.2.0", Commit: "a1b2c3d", BuildTime: "2026-06-18T12:34:56Z"}
	if got := Info(); !reflect.DeepEqual(got, want) {
		t.Fatalf("Info() = %+v, want %+v", got, want)
	}
}
