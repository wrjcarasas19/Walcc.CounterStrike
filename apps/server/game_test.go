package main

import "testing"

func TestGameDir(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"entrypoint", []string{"./xash", "+ip", "0.0.0.0", "-port", "27015", "-game", "cstrike", "+map de_dust2"}, "cstrike"},
		{"half-life", []string{"./xash", "-game", "valve", "+map crossfire"}, "valve"},
		{"first wins", []string{"./xash", "-game", "valve", "-game", "cstrike"}, "valve"},
		{"missing", []string{"./xash", "+map de_dust2"}, "cstrike"},
		{"no value", []string{"./xash", "-game"}, "cstrike"},
		{"program name only", []string{"-game"}, "cstrike"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := gameDir(tt.args); got != tt.want {
				t.Errorf("gameDir(%q) = %q, want %q", tt.args, got, tt.want)
			}
		})
	}
}
