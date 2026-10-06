package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strings"
)

// The Map tab's next map and map vote (AMX Mod X), on top of changelevel:
//
//	{"action":"set_nextmap","map":"de_aztec"}  amx_cvar amx_nextmap de_aztec;
//	                                           amxx pause mapchooser.amxx
//	{"action":"nextmap"}                       -> {"output", "nextMap"}
//	{"action":"votemap","maps":["a","b"]}      amx_votemap a b (1 to 4 maps)
//
// amx_nextmap is FCVAR_SPONLY, which Xash3D refuses to set from the console
// in multiplayer, so it goes through AMX Mod X's amx_cvar. nextmap.amxx
// changes to it when the map ends (time limit or max rounds) and sets it
// back to the next mapcycle.txt entry on every map load. mapchooser.amxx
// holds the players' own vote about two minutes before the end and would
// overwrite the admin's choice if anyone voted, so set_nextmap pauses it;
// AMX Mod X loads every plugin again on the next map, so the players' vote
// is back there. amx_votemap (adminvote.amxx) shows players a menu for
// amx_vote_time + 2 seconds and, if one map gets amx_votemap_ratio of the
// votes, runs changelevel 2 seconds later. Its result only shows in the
// AMX Mod X log, so the page waits for the map to change.

// mapNameMaxAMXX is the longest map name AMX Mod X keeps: amx_votemap and
// nextmap.amxx read names into 32-cell buffers.
const mapNameMaxAMXX = 31

// voteMapsMax is how many maps amx_votemap takes (adminvote.sma ignores the
// rest).
const voteMapsMax = 4

// Lines amx_votemap prints (adminvote.txt, English).
const (
	voteStarted    = "Voting has started"
	voteRunning    = "There is already one voting"
	voteNotAllowed = "Voting not allowed at this time"
)

// What the engine prints for a cvar: "amx_nextmap" is "de_aztec".
var nextMapPattern = regexp.MustCompile(`"amx_nextmap" is "([^"]*)"`)

var mapActions = map[string]actionSpec{
	"set_nextmap": {fields: []string{"map"}, build: func(f actionFields, env actionEnv) ([]string, error) {
		name, err := f.string("map")
		if err != nil {
			return nil, err
		}
		if err := checkMapName(name, mapNameMaxAMXX, env); err != nil {
			return nil, fmt.Errorf("map: %w", err)
		}
		return []string{"amx_cvar amx_nextmap " + name, "amxx pause mapchooser.amxx"}, nil
	}},
	"nextmap": {prepare: func(actionFields, actionEnv) (actionRunner, error) {
		return func(ctx context.Context, a *adminAPI, _ string) (actionResult, error) {
			name, output, err := readNextMap(ctx, a.console)
			if err != nil {
				return actionResult{Output: output}, err
			}
			return actionResult{Output: output, NextMap: name}, nil
		}, nil
	}},
	"votemap": {fields: []string{"maps"}, prepare: func(f actionFields, env actionEnv) (actionRunner, error) {
		maps, err := f.mapNames("maps", voteMapsMax, env)
		if err != nil {
			return nil, err
		}
		command := "amx_votemap " + strings.Join(maps, " ")
		if !safeCommandPattern.MatchString(command) {
			return nil, fmt.Errorf("refusing unsafe command %q", command)
		}
		return func(ctx context.Context, a *adminAPI, client string) (actionResult, error) {
			a.logf("%s: votemap: %s", client, command)
			output, err := a.console.Run(ctx, command)
			if err != nil {
				return actionResult{Output: output}, err
			}
			switch {
			case strings.Contains(output, voteStarted):
				return actionResult{Output: output}, nil
			case strings.Contains(output, voteRunning):
				return actionResult{Output: output}, refuse(http.StatusConflict, "a vote is already running")
			case strings.Contains(output, voteNotAllowed):
				return actionResult{Output: output}, refuse(http.StatusConflict, "the last vote ended less than amx_vote_delay seconds ago; try again in a few seconds")
			default:
				// AMX Mod X not loaded, or it refused the maps.
				return actionResult{Output: output}, refuse(http.StatusBadGateway, "the vote didn't start: %s", firstLine(output))
			}
		}, nil
	}},
}

// readNextMap asks the engine for amx_nextmap. An empty name with a nil
// error means the cvar doesn't exist (AMX Mod X isn't loaded).
func readNextMap(ctx context.Context, console consoleRunner) (name, output string, err error) {
	output, err = console.Run(ctx, "amx_nextmap")
	if err != nil {
		return "", output, err
	}
	if m := nextMapPattern.FindStringSubmatch(output); m != nil {
		return m[1], output, nil
	}
	return "", output, nil
}

// mapNames reads a JSON array of 1 to max different map names, each
// checked like changelevel's and short enough for AMX Mod X.
func (f actionFields) mapNames(name string, max int, env actionEnv) ([]string, error) {
	var names []string
	raw := bytes.TrimSpace(f[name])
	if !bytes.HasPrefix(raw, []byte("[")) || json.Unmarshal(raw, &names) != nil {
		return nil, fmt.Errorf("%s: must be a list of map names", name)
	}
	if len(names) < 1 || len(names) > max {
		return nil, fmt.Errorf("%s: pick 1 to %d maps", name, max)
	}
	seen := map[string]bool{}
	for _, m := range names {
		if err := checkMapName(m, mapNameMaxAMXX, env); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if seen[m] {
			return nil, fmt.Errorf("%s: %s is listed twice", name, m)
		}
		seen[m] = true
	}
	return names, nil
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if s == "" {
		return "no answer"
	}
	return s
}
