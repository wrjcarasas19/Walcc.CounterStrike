package main

import (
	"slices"
	"testing"
)

func TestEngineArgsAddsPassword(t *testing.T) {
	args := []string{"./xash", "+ip", "0.0.0.0", "-game", "cstrike", "+map de_dust2"}
	got, status := engineArgs(args, "s3cret-Pass_1")
	if status != rconEnabled {
		t.Fatalf("status = %v, want rconEnabled", status)
	}
	want := []string{"./xash", "+rcon_password", "s3cret-Pass_1", "+ip", "0.0.0.0", "-game", "cstrike", "+map de_dust2"}
	if !slices.Equal(got, want) {
		t.Fatalf("engineArgs() = %q, want %q", got, want)
	}
	if !slices.Equal(args, []string{"./xash", "+ip", "0.0.0.0", "-game", "cstrike", "+map de_dust2"}) {
		t.Fatalf("engineArgs changed its input: %q", args)
	}
}

func TestEngineArgsWithoutPassword(t *testing.T) {
	args := []string{"./xash", "+map de_dust2"}
	got, status := engineArgs(args, "")
	if status != rconUnset {
		t.Fatalf("status = %v, want rconUnset", status)
	}
	if !slices.Equal(got, args) {
		t.Fatalf("engineArgs() = %q, want %q", got, args)
	}
}

func TestEngineArgsRejectsUnsafePasswords(t *testing.T) {
	args := []string{"./xash", "+map de_dust2"}
	for _, password := range []string{
		"two words",
		`quo"te`,
		"semi;quit",
		"line\nquit",
		"-dev",
		"+quit",
		"back\\slash",
		"slash//comment",
		"ünïcode",
		"a234567890123456789012345678901234567890123456789012345678901234x",
	} {
		got, status := engineArgs(args, password)
		if status != rconInvalid {
			t.Errorf("engineArgs(%q) status = %v, want rconInvalid", password, status)
		}
		if !slices.Equal(got, args) {
			t.Errorf("engineArgs(%q) = %q, want %q", password, got, args)
		}
	}
}

func TestRconPasswordPatternAcceptsTokens(t *testing.T) {
	for _, password := range []string{"a", "7", "Admin_2026", "x.y~z!@#%^*=+,:?-"} {
		if !rconPasswordPattern.MatchString(password) {
			t.Errorf("%q should be accepted", password)
		}
	}
}
