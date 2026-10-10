package main

import (
	"context"
	"strings"
	"testing"
	"time"
)

// fakeEngine answers rcon packets the way SV_RemoteCommand does: one print
// packet per finished line, then one with what is left.
type fakeEngine struct {
	console *engineConsole
	// answers maps a command to the lines it prints; a missing command
	// prints nothing. "" as the last line ends the output without a newline.
	answers map[string][]string
	// silent commands get no answer at all (the engine is stuck).
	silent map[string]bool
	sent   []string
}

func (e *fakeEngine) send(_ context.Context, data []byte) error {
	text := string(data)
	e.sent = append(e.sent, text)
	command := strings.TrimSuffix(strings.SplitN(text, `" `, 2)[1], "\n")
	if e.silent[command] {
		return nil
	}
	go func() {
		print := func(s string) { e.console.deliver([]byte(printPrefix + s + "\x00")) }
		if marker, ok := strings.CutPrefix(command, "echo "); ok {
			print(marker + "\n")
		}
		for _, line := range e.answers[command] {
			print(line)
		}
		print("")
	}()
	return nil
}

func newFakeEngine(password string) *fakeEngine {
	e := &fakeEngine{answers: map[string][]string{}, silent: map[string]bool{}}
	e.console = newEngineConsole(password, e.send)
	return e
}

func runConsole(t *testing.T, c *engineConsole, command string, timeout time.Duration) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return c.Run(ctx, command)
}

func TestRconPacket(t *testing.T) {
	got := string(rconPacket("pa,ss", "kick #3"))
	if want := "\xff\xff\xff\xffrcon \"pa,ss\" kick #3\n"; got != want {
		t.Fatalf("rconPacket = %q, want %q", got, want)
	}
}

func TestEngineConsoleRun(t *testing.T) {
	e := newFakeEngine("secret")
	e.answers["status"] = []string{"map: de_dust2\n", "^3players: 2\n", "\n"}

	out, err := runConsole(t, e.console, "status", time.Second)
	if err != nil || out != "map: de_dust2\nplayers: 2\n\n" {
		t.Fatalf("Run = %q, %v", out, err)
	}
	if e.sent[0] != "\xff\xff\xff\xffrcon \"secret\" status\n" {
		t.Fatalf("sent %q", e.sent[0])
	}

	out, err = runConsole(t, e.console, "mp_startmoney 800", time.Second)
	if err != nil || out != "" {
		t.Fatalf("silent command = %q, %v", out, err)
	}
}

func TestEngineConsoleIgnoresOtherPackets(t *testing.T) {
	e := newFakeEngine("secret")
	e.console.deliver([]byte("\xff\xff\xff\xffinfo stuff"))
	e.console.deliver([]byte("game data"))
	out, err := runConsole(t, e.console, "sv_restart 1", time.Second)
	if err != nil || out != "" {
		t.Fatalf("Run = %q, %v", out, err)
	}
}

func TestEngineConsoleTimeoutResync(t *testing.T) {
	e := newFakeEngine("secret")
	e.silent["changelevel de_slow"] = true
	if _, err := runConsole(t, e.console, "changelevel de_slow", 50*time.Millisecond); err != errConsoleTimeout {
		t.Fatalf("stuck command err = %v", err)
	}
	// The stuck command's replies turn up late.
	e.console.deliver([]byte(printPrefix + "late line\n"))
	e.console.deliver([]byte(printPrefix))

	e.answers["kick #2"] = []string{"Kicked player\n"}
	out, err := runConsole(t, e.console, "kick #2", time.Second)
	if err != nil || out != "Kicked player\n" {
		t.Fatalf("after resync = %q, %v", out, err)
	}
	if len(e.sent) != 3 || !strings.Contains(e.sent[1], "echo web_admin_sync_1") {
		t.Fatalf("sent %q", e.sent)
	}
	// Back in sync: no more echo.
	if _, err := runConsole(t, e.console, "kick #2", time.Second); err != nil || len(e.sent) != 4 {
		t.Fatalf("next run err = %v, sent %q", err, e.sent)
	}
}

func TestIsRconPacket(t *testing.T) {
	for data, want := range map[string]bool{
		"\xff\xff\xff\xffrcon pw status":       true,
		"\xff\xff\xff\xff  rcon pw status":     true,
		"\xff\xff\xff\xff\x01\trcon pw status": true,
		"\xff\xff\xff\xff\"rcon\" pw status":   true,
		"\xff\xff\xff\xffRCON pw status":       true,
		"\xff\xff\xff\xffrcon":                 true,
		"\xff\xff\xff\xffgetchallenge steam":   false,
		"\xff\xff\xff\xffconnect 48 1":         false,
		"\xff\xff\xff\xffinfo\nrcon pw status": false,
		"\xff\xff\xff\xffrco":                  false,
		"\xff\xff\xff\xff":                     false,
		"rcon pw status":                       false,
		"\x01\x00\x00\x00rcon pw status":       false,
	} {
		if got := isRconPacket([]byte(data)); got != want {
			t.Errorf("isRconPacket(%q) = %v, want %v", data, got, want)
		}
	}
}
