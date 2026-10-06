package main

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
)

// BOT_QUOTA sets how many players (humans plus YaPB bots) the server keeps
// in the game, so a near-empty server has bots to play against. 0 (or unset)
// means no bots until an admin adds them from the F4 menu.
//
// It can't be passed as start arguments (+yb_quota_mode fill +yb_quota N):
// YaPB runs addons/yapb/conf/yapb.cfg when the first map loads, after the
// start arguments, and that puts both cvars back to the file's values. So
// the server writes the two lines into yapb.cfg before the engine starts.
// yapb.cfg also runs on every map change, but yb_ignore_cvars_on_changelevel
// (set in the Dockerfile) keeps a quota the admin changed at runtime.
const (
	botQuotaMax  = 32
	yapbConfPath = "cstrike/addons/yapb/conf/yapb.cfg"
)

var botQuotaPattern = regexp.MustCompile(`^[0-9]{1,2}$`)

// parseBotQuota reads BOT_QUOTA: empty is 0; anything that isn't a whole
// number from 0 to botQuotaMax returns ok = false.
func parseBotQuota(raw string) (quota int, ok bool) {
	if raw == "" {
		return 0, true
	}
	if !botQuotaPattern.MatchString(raw) {
		return 0, false
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n > botQuotaMax {
		return 0, false
	}
	return n, true
}

var (
	yapbQuotaLine     = regexp.MustCompile(`(?m)^yb_quota[ \t].*$`)
	yapbQuotaModeLine = regexp.MustCompile(`(?m)^yb_quota_mode[ \t].*$`)
)

// setBotQuota returns yapb.cfg with yb_quota set to quota and yb_quota_mode
// set to "fill" (or "normal" for 0, so the Bots tab's add/kick buttons work
// as plain bot counts). A missing line is added at the end.
func setBotQuota(cfg []byte, quota int) []byte {
	mode := "fill"
	if quota == 0 {
		mode = "normal"
	}
	cfg = setCvarLine(cfg, yapbQuotaLine, fmt.Sprintf(`yb_quota "%d"`, quota))
	return setCvarLine(cfg, yapbQuotaModeLine, fmt.Sprintf(`yb_quota_mode "%s"`, mode))
}

func setCvarLine(cfg []byte, line *regexp.Regexp, value string) []byte {
	if line.Match(cfg) {
		return line.ReplaceAllLiteral(cfg, []byte(value))
	}
	if len(cfg) > 0 && !bytes.HasSuffix(cfg, []byte("\n")) {
		cfg = append(cfg, '\n')
	}
	return append(cfg, value+"\n"...)
}

// writeBotQuota sets the quota in the yapb.cfg under baseDir.
func writeBotQuota(baseDir string, quota int) error {
	path := filepath.Join(baseDir, yapbConfPath)
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	cfg, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	updated := setBotQuota(cfg, quota)
	if bytes.Equal(updated, cfg) {
		return nil
	}
	return os.WriteFile(path, updated, info.Mode().Perm())
}
