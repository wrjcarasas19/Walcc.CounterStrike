package main

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testActionEnv(t *testing.T) actionEnv {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"de_dust2.bsp", "cs_office.bsp", "de_aztec.txt"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(dir, "de_dir.bsp"), 0o755); err != nil {
		t.Fatal(err)
	}
	return actionEnv{mapsDir: dir}
}

func TestParseAdminAction(t *testing.T) {
	env := testActionEnv(t)
	for _, tc := range []struct {
		body string
		want []string
	}{
		{`{"action":"changelevel","map":"de_dust2"}`, []string{"changelevel de_dust2"}},
		{`{"map":"cs_office","action":"changelevel"}`, []string{"changelevel cs_office"}},
		{`{"action":"cvar","name":"mp_startmoney","value":16000}`, []string{"mp_startmoney 16000"}},
		{`{"action":"cvar","name":"mp_roundtime","value":1.75}`, []string{"mp_roundtime 1.75"}},
		{`{"action":"cvar","name":"mp_roundtime","value":2.50}`, []string{"mp_roundtime 2.5"}},
		{`{"action":"cvar","name":"mp_buytime","value":0.25}`, []string{"mp_buytime 0.25"}},
		{`{"action":"cvar","name":"mp_friendlyfire","value":0}`, []string{"mp_friendlyfire 0"}},
		{`{"action":"cvar","name":"mp_maxrounds","value":30}`, []string{"mp_maxrounds 30"}},
		{`{"action":"cvar","name":"mp_timelimit","value":600}`, []string{"mp_timelimit 600"}},
		{`{"action":"cvar","name":"mp_freezetime","value":6.0}`, []string{"mp_freezetime 6"}},
		{`{"action":"cvar","name":"wc_weaponmode","value":0}`, []string{"wc_weaponmode 0"}},
		{`{"action":"cvar","name":"wc_weaponmode","value":1}`, []string{"wc_weaponmode 1"}},
		{`{"action":"cvar","name":"wc_weaponmode","value":2}`, []string{"wc_weaponmode 2"}},
		{`{"action":"restart"}`, []string{"sv_restart 1"}},
		{`{"action":"kick","userid":7}`, []string{"kick #7"}},
		{`{"action":"kick","userid":2147483647}`, []string{"kick #2147483647"}},
		{`{"action":"say","text":"  Hello world! (go) #1 @all ~ok? a&b [x] <3 | =+*  "}`, []string{
			"alias web_msg amx_say Hello world! (go) #1 @all ~ok? a&b [x] <3 | =+*", "web_msg", "alias web_msg",
		}},
		{`{"action":"csay","text":"Restart in 5 minutes.","color":"red"}`, []string{
			"alias web_msg amx_csay red Restart in 5 minutes.", "web_msg", "alias web_msg",
		}},
		{`{"action":"say","text":"` + strings.Repeat("a", messageMaxLength) + `"}`, []string{
			"alias web_msg amx_say " + strings.Repeat("a", messageMaxLength), "web_msg", "alias web_msg",
		}},
		{`{"action":"bot_add","team":"CT"}`, []string{"yb add_ct"}},
		{`{"action":"bot_add","team":"T"}`, []string{"yb add_t"}},
		{`{"action":"bot_kick"}`, []string{"yb kick"}},
		{`{"action":"bot_kick_all"}`, []string{"yb kickall instant"}},
		{`{"action":"bot_difficulty","level":4}`, []string{"yb_difficulty 4"}},
		{`{"action":"bot_quota","players":0}`, []string{"yb_quota_mode fill", "yb_quota 0"}},
		{` {"action":"bot_quota","players":32} `, []string{"yb_quota_mode fill", "yb_quota 32"}},
		{`{"action":"set_nextmap","map":"cs_office"}`, []string{"amx_cvar amx_nextmap cs_office", "amxx pause mapchooser.amxx"}},
	} {
		got, err := parseAdminAction(strings.NewReader(tc.body), env)
		if err != nil {
			t.Errorf("%s: %v", tc.body, err)
			continue
		}
		if !reflect.DeepEqual(got.commands, tc.want) {
			t.Errorf("%s: commands = %q, want %q", tc.body, got.commands, tc.want)
		}
	}
}

func TestParseAdminActionRefused(t *testing.T) {
	env := testActionEnv(t)
	for _, body := range []string{
		``,
		`null`,
		`[]`,
		`"restart"`,
		`{}`,
		`{"action":"restart"} {"action":"restart"}`,
		`{"action":"restart"}x`,
		`{"action":null}`,
		`{"action":1}`,
		`{"action":"quit"}`,
		`{"action":"rcon","command":"quit"}`,
		`{"action":"Restart"}`,
		`{"action":"restart","extra":1}`,
		// changelevel
		`{"action":"changelevel"}`,
		`{"action":"changelevel","map":null}`,
		`{"action":"changelevel","map":"de_nuke"}`,
		`{"action":"changelevel","map":"de_aztec"}`,
		`{"action":"changelevel","map":"de_dir"}`,
		`{"action":"changelevel","map":"de_dust2;quit"}`,
		`{"action":"changelevel","map":"de_dust2 x"}`,
		`{"action":"changelevel","map":"../de_dust2"}`,
		`{"action":"changelevel","map":""}`,
		// cvar
		`{"action":"cvar","name":"rcon_password","value":1}`,
		`{"action":"cvar","name":"sv_cheats","value":1}`,
		`{"action":"cvar","name":"mp_startmoney","value":799}`,
		`{"action":"cvar","name":"mp_startmoney","value":16001}`,
		`{"action":"cvar","name":"mp_startmoney","value":800.5}`,
		`{"action":"cvar","name":"mp_startmoney","value":"800"}`,
		`{"action":"cvar","name":"mp_startmoney","value":8e2}`,
		`{"action":"cvar","name":"mp_startmoney","value":-800}`,
		`{"action":"cvar","name":"mp_startmoney","value":null}`,
		`{"action":"cvar","name":"mp_roundtime","value":1.755}`,
		`{"action":"cvar","name":"mp_buytime","value":0.2}`,
		`{"action":"cvar","name":"mp_friendlyfire","value":2}`,
		`{"action":"cvar","name":"wc_weaponmode","value":3}`,
		`{"action":"cvar","name":"wc_weaponmode","value":1.5}`,
		`{"action":"cvar","name":"wc_weaponmode","value":"knife"}`,
		`{"action":"cvar","name":"mp_startmoney"}`,
		// kick
		`{"action":"kick","userid":0}`,
		`{"action":"kick","userid":-1}`,
		`{"action":"kick","userid":1.5}`,
		`{"action":"kick","userid":"3"}`,
		`{"action":"kick","userid":2147483648}`,
		`{"action":"kick","userid":3,"name":"x"}`,
		// messages
		`{"action":"say","text":""}`,
		`{"action":"say","text":"   "}`,
		`{"action":"say","text":"a;quit"}`,
		`{"action":"say","text":"say \"hi\""}`,
		`{"action":"say","text":"a\\b"}`,
		`{"action":"say","text":"$rcon_password"}`,
		`{"action":"say","text":"100%"}`,
		`{"action":"say","text":"don't"}`,
		`{"action":"say","text":"a,b"}`,
		`{"action":"say","text":"{x}"}`,
		`{"action":"say","text":"^1red"}`,
		`{"action":"say","text":"see http://x"}`,
		`{"action":"say","text":"line\nquit"}`,
		`{"action":"say","text":"tab\there"}`,
		`{"action":"say","text":"café"}`,
		`{"action":"say","text":"` + strings.Repeat("a", messageMaxLength+1) + `"}`,
		`{"action":"csay","text":"hi"}`,
		`{"action":"csay","text":"hi","color":"pink"}`,
		`{"action":"csay","text":"hi","color":"red;quit"}`,
		// bots
		`{"action":"bot_add","team":"SPEC"}`,
		`{"action":"bot_add","team":"ct"}`,
		`{"action":"bot_add"}`,
		`{"action":"bot_difficulty","level":5}`,
		`{"action":"bot_quota","players":33}`,
		`{"action":"bot_kick","team":"CT"}`,
		// next map and vote
		`{"action":"set_nextmap"}`,
		`{"action":"set_nextmap","map":"de_nuke"}`,
		`{"action":"set_nextmap","map":"de_aztec"}`,
		`{"action":"set_nextmap","map":"de_dir"}`,
		`{"action":"set_nextmap","map":"de_dust2;quit"}`,
		`{"action":"set_nextmap","map":["de_dust2"]}`,
		`{"action":"set_nextmap","map":"` + strings.Repeat("a", mapNameMaxAMXX+1) + `"}`,
		`{"action":"nextmap","map":"de_dust2"}`,
		`{"action":"votemap"}`,
		`{"action":"votemap","maps":[]}`,
		`{"action":"votemap","maps":"de_dust2"}`,
		`{"action":"votemap","maps":null}`,
		`{"action":"votemap","maps":[1]}`,
		`{"action":"votemap","maps":[null]}`,
		`{"action":"votemap","maps":[""]}`,
		`{"action":"votemap","maps":["de_nuke"]}`,
		`{"action":"votemap","maps":["de_dust2","de_dust2"]}`,
		`{"action":"votemap","maps":["de_dust2","cs_office","de_dust2"]}`,
		`{"action":"votemap","maps":["de_dust2 cs_office"]}`,
		`{"action":"votemap","maps":["de_dust2;quit"]}`,
		`{"action":"votemap","maps":["../de_dust2"]}`,
		`{"action":"votemap","maps":["de_dust2"],"map":"cs_office"}`,
		`{"action":"votemap","maps":["de_dust2","cs_office","a","b","c"]}`,
	} {
		if got, err := parseAdminAction(strings.NewReader(body), env); err == nil {
			t.Errorf("%s: accepted as %q", body, got.commands)
		}
	}
}

// Every command an action can build passes the final safety check.
func TestAdminCommandsAreSafe(t *testing.T) {
	for _, command := range []string{"sv_restart 1", "kick #1", "alias web_msg amx_say a&b [x] <3 | =+* ~ok?"} {
		if !safeCommandPattern.MatchString(command) {
			t.Errorf("%q refused", command)
		}
	}
	for _, command := range []string{`say "x"`, "a;b", `a\b`, "a\nb", ""} {
		if safeCommandPattern.MatchString(command) {
			t.Errorf("%q accepted", command)
		}
	}
}
