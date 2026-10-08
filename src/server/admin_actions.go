package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Typed admin actions: the only things POST /admin/command accepts. Each
// one is a JSON object with an "action" name and exactly the fields listed
// for it, and turns into fixed engine commands. Every value is checked
// again here with the same rules as the F4 menu (src/client/src/admin/*),
// so nothing but these commands can reach the engine.
//
// To add an action: add an entry to adminActions (its fields and a build
// function using the field readers below), mirror it in AdminAction in
// src/client/src/admin/actions.ts, and add a case to the tests. Actions
// that need more than fixed commands (the bans in admin_bans.go) have a
// prepare function instead, which checks the fields and returns a runner.

// adminAction is a checked action, ready to run: either commands, or run.
type adminAction struct {
	name     string
	commands []string
	run      actionRunner
}

type actionFields map[string]json.RawMessage

type actionSpec struct {
	fields  []string
	build   func(f actionFields, env actionEnv) ([]string, error)
	prepare func(f actionFields, env actionEnv) (actionRunner, error)
}

// actionEnv is what building and running an action may look at.
type actionEnv struct {
	// mapsDir holds the maps the server can load (cstrike/maps).
	mapsDir string
	// bans is the ban list and peers the connected players' real
	// addresses, for the ban actions.
	bans  *banList
	peers peerDirectory
	// claims is the leaderboard database, for the claimed-names actions
	// (admin_names.go); nil when it isn't open.
	claims *statsDB
}

// adminCvar mirrors CVARS in src/client/src/admin/cvars.ts: the range and
// decimal places the Match tab allows. Keep both in sync.
type adminCvar struct {
	min, max float64
	decimals int
}

var adminCvars = map[string]adminCvar{
	"mp_friendlyfire": {0, 1, 0},
	"mp_timelimit":    {0, 600, 0},
	"mp_roundtime":    {1, 9, 2},
	"mp_startmoney":   {800, 16000, 0},
	"mp_freezetime":   {0, 60, 0},
	"mp_buytime":      {0.25, 9, 2},
	"mp_maxrounds":    {0, 100, 0},
	// Voice chat: everyone hears everyone (voice_roster.go).
	"sv_alltalk": {0, 1, 0},
	// 0 off, 1 knife only, 2 pistols only (src/amxx/wc_weaponmode.sma).
	"wc_weaponmode": {0, 2, 0},
	// 0 classic, 1 Gun Game, 2 Deathmatch (src/amxx/wc_gamemode.sma).
	"wc_gamemode": {0, 2, 0},
	// Deathmatch frag limit, 0 off (src/amxx/wc_gamemode.sma).
	"wc_dm_fraglimit": {0, 500, 0},
	// Gun Game (src/amxx/wc_gamemode.sma): kills per level, a level lost on
	// suicide (0/1), late joiners at the lowest level (0/1).
	"wc_gg_kills_per_level": {1, 10, 0},
	"wc_gg_suicide_penalty": {0, 1, 0},
	"wc_gg_join_lowest":     {0, 1, 0},
}

// Same as message-text.ts: printable ASCII without " ; \ $ { } ' , ^ %.
var messagePattern = regexp.MustCompile("^[ !#&()*+\\-./0-9:<=>?@A-Z[\\]_`a-z|~]+$")

const messageMaxLength = 120

// The colours amx_csay knows (MESSAGE_COLORS in message-text.ts).
var messageColors = map[string]bool{
	"white": true, "red": true, "green": true, "blue": true, "yellow": true,
	"magenta": true, "cyan": true, "orange": true, "ocean": true, "maroon": true,
}

// messageAlias is the server-side alias a message goes through, so AMX Mod
// X reads the words without quotes (see message-text.ts).
const messageAlias = "web_msg"

var addBotCommands = map[string]string{"CT": "yb add_ct", "T": "yb add_t"}

// safeCommandPattern is the last check on every command: printable ASCII
// without the characters that end a command or escape (" ; \). Like
// COMMAND_PATTERN in core.ts, it only catches a mistake in a build function.
var safeCommandPattern = regexp.MustCompile(`^[ !#-:<-\[\]-~]+$`)

var adminActions = map[string]actionSpec{
	// Map tab.
	"changelevel": {fields: []string{"map"}, build: func(f actionFields, env actionEnv) ([]string, error) {
		name, err := f.string("map")
		if err != nil {
			return nil, err
		}
		if err := checkMapName(name, 64, env); err != nil {
			return nil, fmt.Errorf("map: %w", err)
		}
		return []string{"changelevel " + name}, nil
	}},
	// Match tab: one cvar (presets send several of these, then restart).
	"cvar": {fields: []string{"name", "value"}, build: func(f actionFields, _ actionEnv) ([]string, error) {
		name, err := f.string("name")
		if err != nil {
			return nil, err
		}
		def, ok := adminCvars[name]
		if !ok {
			return nil, errors.New("name: not a cvar the menu sets")
		}
		value, err := f.number("value", def)
		if err != nil {
			return nil, err
		}
		return []string{name + " " + value}, nil
	}},
	"restart": {build: fixed("sv_restart 1")},
	// Players tab.
	"kick": {fields: []string{"userid"}, build: func(f actionFields, _ actionEnv) ([]string, error) {
		userid, err := f.integer("userid", 1, math.MaxInt32)
		if err != nil {
			return nil, err
		}
		return []string{"kick #" + strconv.Itoa(userid)}, nil
	}},
	// Message tab.
	"say": {fields: []string{"text"}, build: func(f actionFields, _ actionEnv) ([]string, error) {
		text, err := f.message("text")
		if err != nil {
			return nil, err
		}
		return aliasCommands("amx_say " + text), nil
	}},
	"csay": {fields: []string{"text", "color"}, build: func(f actionFields, _ actionEnv) ([]string, error) {
		text, err := f.message("text")
		if err != nil {
			return nil, err
		}
		color, err := f.string("color")
		if err != nil {
			return nil, err
		}
		if !messageColors[color] {
			return nil, errors.New("color: not an amx_csay colour")
		}
		return aliasCommands("amx_csay " + color + " " + text), nil
	}},
	// Bots tab.
	"bot_add": {fields: []string{"team"}, build: func(f actionFields, _ actionEnv) ([]string, error) {
		team, err := f.string("team")
		if err != nil {
			return nil, err
		}
		command, ok := addBotCommands[team]
		if !ok {
			return nil, errors.New("team: must be CT or T")
		}
		return []string{command}, nil
	}},
	"bot_kick":     {build: fixed("yb kick")},
	"bot_kick_all": {build: fixed("yb kickall instant")},
	"bot_difficulty": {fields: []string{"level"}, build: func(f actionFields, _ actionEnv) ([]string, error) {
		level, err := f.integer("level", 0, 4)
		if err != nil {
			return nil, err
		}
		return []string{"yb_difficulty " + strconv.Itoa(level)}, nil
	}},
	"bot_quota": {fields: []string{"players"}, build: func(f actionFields, _ actionEnv) ([]string, error) {
		players, err := f.integer("players", 0, botQuotaMax)
		if err != nil {
			return nil, err
		}
		return []string{"yb_quota_mode fill", "yb_quota " + strconv.Itoa(players)}, nil
	}},
}

func init() {
	for _, actions := range []map[string]actionSpec{banActions, mapActions, nameActions} {
		for name, spec := range actions {
			adminActions[name] = spec
		}
	}
}

// checkMapName checks a map name from the page: allowlisted characters, at
// most maxLength long, and <name>.bsp is a file in the maps directory.
func checkMapName(name string, maxLength int, env actionEnv) error {
	if len(name) > maxLength || !mapNamePattern.MatchString(name) {
		return errors.New("not a map name")
	}
	if info, err := os.Stat(filepath.Join(env.mapsDir, name+".bsp")); err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("%s isn't on the server", name)
	}
	return nil
}

func fixed(commands ...string) func(actionFields, actionEnv) ([]string, error) {
	return func(actionFields, actionEnv) ([]string, error) { return commands, nil }
}

// aliasCommands runs command through messageAlias: define, run, clear.
func aliasCommands(command string) []string {
	return []string{"alias " + messageAlias + " " + command, messageAlias, "alias " + messageAlias}
}

// parseAdminAction reads one action from body and builds its commands. The
// error says what is wrong, for a 400 response.
func parseAdminAction(body io.Reader, env actionEnv) (adminAction, error) {
	dec := json.NewDecoder(body)
	var fields actionFields
	if err := dec.Decode(&fields); err != nil {
		return adminAction{}, fmt.Errorf("the body must be one JSON object: %w", err)
	}
	if fields == nil {
		return adminAction{}, errors.New("the body must be one JSON object")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return adminAction{}, errors.New("the body must be one JSON object")
	}
	name, err := fields.string("action")
	if err != nil {
		return adminAction{}, err
	}
	spec, ok := adminActions[name]
	if !ok {
		return adminAction{}, fmt.Errorf("unknown action %q", name)
	}
	if err := fields.only(append([]string{"action"}, spec.fields...)); err != nil {
		return adminAction{}, err
	}
	if spec.prepare != nil {
		run, err := spec.prepare(fields, env)
		if err != nil {
			return adminAction{}, err
		}
		return adminAction{name: name, run: run}, nil
	}
	commands, err := spec.build(fields, env)
	if err != nil {
		return adminAction{}, err
	}
	for _, command := range commands {
		if !safeCommandPattern.MatchString(command) {
			return adminAction{}, fmt.Errorf("refusing unsafe command %q", command)
		}
	}
	return adminAction{name: name, commands: commands}, nil
}

// only checks that the object has exactly the given fields.
func (f actionFields) only(names []string) error {
	want := map[string]bool{}
	for _, name := range names {
		want[name] = true
		if _, ok := f[name]; !ok {
			return fmt.Errorf("%s: missing", name)
		}
	}
	var extra []string
	for name := range f {
		if !want[name] {
			extra = append(extra, name)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		return fmt.Errorf("unexpected fields: %s", strings.Join(extra, ", "))
	}
	return nil
}

func (f actionFields) string(name string) (string, error) {
	var value string
	raw := bytes.TrimSpace(f[name])
	if !bytes.HasPrefix(raw, []byte(`"`)) || json.Unmarshal(raw, &value) != nil {
		return "", fmt.Errorf("%s: must be a string", name)
	}
	return value, nil
}

// JSON numbers as the menu sends them: digits with an optional fraction,
// no sign or exponent.
var (
	integerPattern = regexp.MustCompile(`^[0-9]{1,10}$`)
	decimalPattern = regexp.MustCompile(`^[0-9]{1,6}(\.[0-9]{1,6})?$`)
)

func (f actionFields) integer(name string, min, max int) (int, error) {
	raw := string(bytes.TrimSpace(f[name]))
	value, err := strconv.Atoi(raw)
	if !integerPattern.MatchString(raw) || err != nil || value < min || value > max {
		return 0, fmt.Errorf("%s: must be a whole number from %d to %d", name, min, max)
	}
	return value, nil
}

// number checks a cvar value like checkCvarValue in cvars.ts and formats
// it like formatCvarValue (no exponent, no trailing zeros).
func (f actionFields) number(name string, def adminCvar) (string, error) {
	raw := string(bytes.TrimSpace(f[name]))
	value, err := strconv.ParseFloat(raw, 64)
	if !decimalPattern.MatchString(raw) || err != nil || value < def.min || value > def.max {
		return "", fmt.Errorf("%s: must be a number from %g to %g", name, def.min, def.max)
	}
	scale := math.Pow(10, float64(def.decimals))
	if math.Abs(math.Round(value*scale)-value*scale) > 1e-9 {
		return "", fmt.Errorf("%s: at most %d decimal places", name, def.decimals)
	}
	return strconv.FormatFloat(math.Round(value*scale)/scale, 'f', -1, 64), nil
}

// message checks a message like checkMessage in message-text.ts: trimmed,
// not empty, allowlisted characters, no //, at most messageMaxLength.
func (f actionFields) message(name string) (string, error) {
	text, err := f.string(name)
	if err != nil {
		return "", err
	}
	text = strings.Trim(text, " ")
	switch {
	case text == "":
		return "", fmt.Errorf("%s: empty", name)
	case !messagePattern.MatchString(text):
		return "", fmt.Errorf("%s: contains characters that can't be sent", name)
	case strings.Contains(text, "//"):
		return "", fmt.Errorf("%s: can't contain //", name)
	case len(text) > messageMaxLength:
		return "", fmt.Errorf("%s: longer than %d characters", name, messageMaxLength)
	}
	return text, nil
}
