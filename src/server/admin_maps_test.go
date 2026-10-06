package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func newMapTestAdmin(t *testing.T, outputs map[string]string) (*adminAPI, *scriptConsole, *http.Cookie) {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"de_dust2", "de_aztec", "cs_office", "de_nuke", "de_inferno"} {
		if err := os.WriteFile(filepath.Join(dir, name+".bsp"), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	console := &scriptConsole{outputs: outputs, errs: map[string]error{}}
	a := newAdminAPI(testAdminPassword, console, actionEnv{mapsDir: dir})
	a.logf = func(string, ...any) {}
	c := sessionCookie(t, login(t, a, testAdminPassword, testAdminAddress))
	return a, console, c
}

type mapResponse struct {
	Output  string `json:"output"`
	Error   string `json:"error"`
	NextMap string `json:"nextMap"`
}

func mapCommand(t *testing.T, a *adminAPI, c *http.Cookie, body string) (int, mapResponse) {
	t.Helper()
	rec := a.do(adminRequest{path: "/admin/command", body: body, cookie: c, remote: testAdminAddress})
	var resp mapResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("%s: %v (%s)", body, err, rec.Body)
	}
	return rec.Code, resp
}

func TestAdminSetNextMap(t *testing.T) {
	a, console, c := newMapTestAdmin(t, map[string]string{
		"amx_cvar amx_nextmap de_aztec": "[AMXX] Cvar \"amx_nextmap\" changed to \"de_aztec\"\n",
		"amxx pause mapchooser.amxx":    "Paused plugin \"mapchooser.amxx\"\n",
		// The engine's cvar line, as the image prints it.
		"amx_nextmap": "\"amx_nextmap\" is \"de_aztec\"\n",
	})
	code, resp := mapCommand(t, a, c, `{"action":"set_nextmap","map":"de_aztec"}`)
	if code != http.StatusOK || !strings.Contains(resp.Output, "changed to") {
		t.Fatalf("set_nextmap = %d %+v", code, resp)
	}
	code, resp = mapCommand(t, a, c, `{"action":"nextmap"}`)
	if code != http.StatusOK || resp.NextMap != "de_aztec" {
		t.Fatalf("nextmap = %d %+v", code, resp)
	}
	want := []string{"amx_cvar amx_nextmap de_aztec", "amxx pause mapchooser.amxx", "amx_nextmap"}
	if !reflect.DeepEqual(console.commands, want) {
		t.Fatalf("commands = %q, want %q", console.commands, want)
	}
}

func TestAdminNextMapWithoutAMXX(t *testing.T) {
	a, _, c := newMapTestAdmin(t, map[string]string{"amx_nextmap": "Unknown command \"amx_nextmap\"\n"})
	code, resp := mapCommand(t, a, c, `{"action":"nextmap"}`)
	if code != http.StatusOK || resp.NextMap != "" {
		t.Fatalf("nextmap = %d %+v", code, resp)
	}
	rec := a.do(adminRequest{path: "/admin/command", body: `{"action":"nextmap"}`, cookie: c, remote: testAdminAddress})
	if strings.Contains(rec.Body.String(), "nextMap") {
		t.Fatalf("empty nextMap sent: %s", rec.Body)
	}
}

func TestAdminVoteMap(t *testing.T) {
	const command = "amx_votemap de_aztec cs_office de_nuke de_inferno"
	for _, tc := range []struct {
		name, output string
		err          error
		code         int
		message      string
	}{
		{"started", "Voting has started...\n", nil, http.StatusOK, ""},
		{"running", "There is already one voting...\n", nil, http.StatusConflict, "a vote is already running"},
		{"too soon", "Voting not allowed at this time\n", nil, http.StatusConflict, "amx_vote_delay"},
		{"no amxx", "Unknown command \"amx_votemap\"\n", nil, http.StatusBadGateway, `the vote didn't start: Unknown command "amx_votemap"`},
		{"silent", "", nil, http.StatusBadGateway, "the vote didn't start: no answer"},
		{"timeout", "", errors.New("timeout"), http.StatusGatewayTimeout, "didn't answer"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, console, c := newMapTestAdmin(t, map[string]string{command: tc.output})
			console.errs[command] = tc.err
			code, resp := mapCommand(t, a, c, `{"action":"votemap","maps":["de_aztec","cs_office","de_nuke","de_inferno"]}`)
			if code != tc.code || !strings.Contains(resp.Error, tc.message) {
				t.Fatalf("votemap = %d %+v, want %d %q", code, resp, tc.code, tc.message)
			}
			if !reflect.DeepEqual(console.commands, []string{command}) {
				t.Fatalf("commands = %q", console.commands)
			}
		})
	}
}

func TestAdminVoteMapRefused(t *testing.T) {
	a, console, c := newMapTestAdmin(t, map[string]string{})
	for _, body := range []string{
		`{"action":"votemap","maps":["de_aztec","cs_office","de_nuke","de_inferno","de_dust2"]}`,
		`{"action":"votemap","maps":["de_aztec","de_train"]}`,
		`{"action":"votemap","maps":["de_aztec","DE_AZTEC;quit"]}`,
	} {
		if code, resp := mapCommand(t, a, c, body); code != http.StatusBadRequest {
			t.Errorf("%s = %d %+v", body, code, resp)
		}
	}
	if len(console.commands) != 0 {
		t.Fatalf("commands = %q", console.commands)
	}
	code, _ := mapCommand(t, a, c, `{"action":"votemap","maps":["de_aztec"]}`)
	if code != http.StatusBadGateway || !reflect.DeepEqual(console.commands, []string{"amx_votemap de_aztec"}) {
		t.Fatalf("one map = %d, commands %q", code, console.commands)
	}
}

func TestMapActionsNeedSession(t *testing.T) {
	a, console, _ := newMapTestAdmin(t, map[string]string{})
	for _, body := range []string{`{"action":"nextmap"}`, `{"action":"votemap","maps":["de_aztec"]}`, `{"action":"set_nextmap","map":"de_aztec"}`} {
		rec := a.do(adminRequest{path: "/admin/command", body: body, remote: testAdminAddress})
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s without session = %d", body, rec.Code)
		}
	}
	if len(console.commands) != 0 {
		t.Fatalf("commands = %q", console.commands)
	}
}
