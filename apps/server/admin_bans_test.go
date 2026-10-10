package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Real `status` output from the image (one bot), plus a WebRTC player in
// slot 2 and one still connecting, as FWGS SV_Status_f prints them.
const testStatus = "map: de_dust2\n" +
	"# score ping dev  lastmsg qport useragent\t\tname\t\taddress\n" +
	" 0     0 Bot       n/a 80.79663     0 n/a (n/a-n/a 0)\t   Tator\t 0.0.0.0\n" +
	" 2    -1       45    m 0.01000 27005 0.21 (emscripten-wasm32 4529)\tA \"long\" name\t3.10.20.30\n" +
	"10     0 Connect     n/a 0.20000 27005 0.21 (emscripten-wasm32 4529)\t      ab\t9.1.2.3\n" +
	"\n"

func TestParseStatus(t *testing.T) {
	got := parseStatus(testStatus)
	want := map[int]statusRow{
		0:  {name: "Tator", address: "0.0.0.0", bot: true},
		2:  {name: `A "long" name`, address: "3.10.20.30"},
		10: {name: "ab", address: "9.1.2.3"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseStatus = %+v, want %+v", got, want)
	}
	if rows := parseStatus("^3no server running.\n"); len(rows) != 0 {
		t.Fatalf("no server = %+v", rows)
	}
}

// scriptConsole answers each command with a fixed output.
type scriptConsole struct {
	outputs  map[string]string
	errs     map[string]error
	commands []string
}

func (c *scriptConsole) Run(_ context.Context, command string) (string, error) {
	c.commands = append(c.commands, command)
	return c.outputs[command], c.errs[command]
}

type fakePeers struct {
	keys   map[[4]byte]string
	closed []string
}

func (p *fakePeers) keyOf(ip [4]byte) (string, bool) {
	key, ok := p.keys[ip]
	return key, ok
}

func (p *fakePeers) closeFrom(key string) int {
	p.closed = append(p.closed, key)
	return 1
}

const testAdminAddress = "203.0.113.7:4000"

func newBanTestAdmin(t *testing.T) (*adminAPI, *scriptConsole, *fakePeers, *http.Cookie) {
	t.Helper()
	list, err := loadBanList(filepath.Join(t.TempDir(), bansFile))
	if err != nil {
		t.Fatal(err)
	}
	console := &scriptConsole{outputs: map[string]string{
		"status":  testStatus,
		"kick #7": "",
	}, errs: map[string]error{}}
	peers := &fakePeers{keys: map[[4]byte]string{
		{3, 10, 20, 30}: "198.51.100.9",
		{9, 1, 2, 3}:    "2001:db8:1:2::/64",
	}}
	a := newAdminAPI(testAdminPassword, console, actionEnv{mapsDir: t.TempDir(), bans: list, peers: peers})
	now := time.Date(2026, 10, 6, 12, 0, 0, 0, time.UTC)
	a.now = func() time.Time { return now }
	a.logf = func(string, ...any) {}
	c := sessionCookie(t, login(t, a, testAdminPassword, testAdminAddress))
	return a, console, peers, c
}

type banResponse struct {
	Output string     `json:"output"`
	Error  string     `json:"error"`
	Bans   []banEntry `json:"bans"`
}

func banCommand(t *testing.T, a *adminAPI, c *http.Cookie, body string) (int, banResponse) {
	t.Helper()
	rec := a.do(adminRequest{path: "/admin/command", body: body, cookie: c, remote: testAdminAddress})
	var resp banResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%s: %v (%s)", body, err, rec.Body)
	}
	return rec.Code, resp
}

func TestAdminBan(t *testing.T) {
	a, console, peers, c := newBanTestAdmin(t)

	code, resp := banCommand(t, a, c, `{"action":"ban","userid":7,"slot":3}`)
	if code != http.StatusOK {
		t.Fatalf("ban = %d %+v", code, resp)
	}
	if want := []string{"status", "kick #7"}; !reflect.DeepEqual(console.commands, want) {
		t.Fatalf("commands = %q, want %q", console.commands, want)
	}
	want := []banEntry{{Address: "198.51.100.9", Name: `A "long" name`, BannedAt: a.now()}}
	if !reflect.DeepEqual(resp.Bans, want) || !strings.Contains(resp.Output, "Banned 198.51.100.9") {
		t.Fatalf("response = %+v", resp)
	}
	if !a.env.bans.banned("198.51.100.9") {
		t.Fatal("not banned")
	}
	if !reflect.DeepEqual(peers.closed, []string{"198.51.100.9"}) {
		t.Fatalf("closed = %q", peers.closed)
	}

	code, resp = banCommand(t, a, c, `{"action":"bans"}`)
	if code != http.StatusOK || !reflect.DeepEqual(resp.Bans, want) {
		t.Fatalf("bans = %d %+v", code, resp)
	}

	code, resp = banCommand(t, a, c, `{"action":"unban","address":"198.51.100.9"}`)
	if code != http.StatusOK || len(resp.Bans) != 0 || a.env.bans.banned("198.51.100.9") {
		t.Fatalf("unban = %d %+v", code, resp)
	}
	code, resp = banCommand(t, a, c, `{"action":"unban","address":"198.51.100.9"}`)
	if code != http.StatusOK || !strings.Contains(resp.Output, "wasn't banned") {
		t.Fatalf("second unban = %d %+v", code, resp)
	}

	// IPv6 players are banned by /64; unban takes any address in it.
	console.outputs["kick #8"] = ""
	if code, resp := banCommand(t, a, c, `{"action":"ban","userid":8,"slot":11}`); code != http.StatusOK {
		t.Fatalf("IPv6 ban = %d %+v", code, resp)
	}
	if !a.env.bans.banned(addressKey("2001:db8:1:2::99")) {
		t.Fatal("IPv6 /64 not banned")
	}
	if code, resp := banCommand(t, a, c, `{"action":"unban","address":"2001:db8:1:2::1/64"}`); code != http.StatusOK || len(resp.Bans) != 0 {
		t.Fatalf("IPv6 unban = %d %+v", code, resp)
	}
}

func TestAdminBanRefused(t *testing.T) {
	for _, tc := range []struct {
		name  string
		body  string
		setup func(*scriptConsole, *fakePeers)
		want  int
		ran   []string
	}{
		{name: "bot", body: `{"action":"ban","userid":7,"slot":1}`, want: http.StatusBadRequest, ran: []string{"status"}},
		{name: "empty slot", body: `{"action":"ban","userid":7,"slot":2}`, want: http.StatusConflict, ran: []string{"status"}},
		{name: "no peer", body: `{"action":"ban","userid":7,"slot":3}`, want: http.StatusConflict, ran: []string{"status"},
			setup: func(_ *scriptConsole, p *fakePeers) { delete(p.keys, [4]byte{3, 10, 20, 30}) }},
		{name: "own address", body: `{"action":"ban","userid":7,"slot":3}`, want: http.StatusBadRequest, ran: []string{"status"},
			setup: func(_ *scriptConsole, p *fakePeers) { p.keys[[4]byte{3, 10, 20, 30}] = "203.0.113.7" }},
		{name: "player left", body: `{"action":"ban","userid":7,"slot":3}`, want: http.StatusConflict, ran: []string{"status", "kick #7"},
			setup: func(c *scriptConsole, _ *fakePeers) { c.outputs["kick #7"] = clientNotOnServer + "\n" }},
		{name: "kick timeout", body: `{"action":"ban","userid":7,"slot":3}`, want: http.StatusGatewayTimeout, ran: []string{"status", "kick #7"},
			setup: func(c *scriptConsole, _ *fakePeers) { c.errs["kick #7"] = errors.New("timeout") }},
		{name: "status timeout", body: `{"action":"ban","userid":7,"slot":3}`, want: http.StatusGatewayTimeout, ran: []string{"status"},
			setup: func(c *scriptConsole, _ *fakePeers) { c.errs["status"] = errors.New("timeout") }},
		{name: "unban bad address", body: `{"action":"unban","address":"203.0.113.0/24"}`, want: http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, console, peers, c := newBanTestAdmin(t)
			if tc.setup != nil {
				tc.setup(console, peers)
			}
			code, resp := banCommand(t, a, c, tc.body)
			if code != tc.want || resp.Error == "" {
				t.Fatalf("= %d %+v, want %d", code, resp, tc.want)
			}
			if !reflect.DeepEqual(console.commands, tc.ran) {
				t.Fatalf("commands = %q, want %q", console.commands, tc.ran)
			}
			if len(a.env.bans.list()) != 0 || len(peers.closed) != 0 {
				t.Fatalf("bans %+v, closed %q", a.env.bans.list(), peers.closed)
			}
		})
	}
}

func TestParseBanActions(t *testing.T) {
	env := testActionEnv(t)
	for _, body := range []string{
		`{"action":"bans"}`,
		`{"action":"ban","userid":1,"slot":1}`,
		`{"action":"ban","userid":2147483647,"slot":64}`,
		`{"action":"unban","address":"203.0.113.7"}`,
		`{"action":"unban","address":"2001:db8::/64"}`,
	} {
		got, err := parseAdminAction(strings.NewReader(body), env)
		if err != nil || got.run == nil || got.commands != nil {
			t.Errorf("%s: %+v, %v", body, got, err)
		}
	}
	for _, body := range []string{
		`{"action":"bans","all":true}`,
		`{"action":"ban","userid":7}`,
		`{"action":"ban","slot":3}`,
		`{"action":"ban","userid":0,"slot":3}`,
		`{"action":"ban","userid":7,"slot":0}`,
		`{"action":"ban","userid":7,"slot":65}`,
		`{"action":"ban","userid":7,"slot":"3"}`,
		`{"action":"ban","userid":7,"slot":3,"name":"x"}`,
		`{"action":"ban","address":"203.0.113.7"}`,
		`{"action":"unban"}`,
		`{"action":"unban","address":7}`,
		`{"action":"unban","address":"203.0.113.7;quit"}`,
		`{"action":"unban","address":"2001:db8::1"}`,
		`{"action":"unban","address":"all"}`,
	} {
		if got, err := parseAdminAction(strings.NewReader(body), env); err == nil {
			t.Errorf("%s: accepted as %+v", body, got)
		}
	}
}

func TestAdminBanNeedsSession(t *testing.T) {
	a, console, _, _ := newBanTestAdmin(t)
	for _, body := range []string{`{"action":"bans"}`, `{"action":"ban","userid":7,"slot":3}`, `{"action":"unban","address":"198.51.100.9"}`} {
		if rec := a.do(adminRequest{path: "/admin/command", body: body}); rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without a session = %d", body, rec.Code)
		}
	}
	if len(console.commands) != 0 {
		t.Fatalf("ran %q", console.commands)
	}
}
