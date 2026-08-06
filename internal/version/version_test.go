package version

import "testing"

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
