package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Bans are kept in Go, by the address the player's WebSocket came from: the
// engine only sees the fake address sfu.go gives each WebRTC peer (new on
// every connect), so its own addip/banid can't work.
//
// A ban's address is an addressKey: an IPv4 address as is, an IPv6 address
// as its /64 (one host usually gets a whole /64, so a single address would
// be easy to step around), the same key the admin login lockout uses. Like
// that lockout it is the TCP peer address: X-Forwarded-For isn't trusted,
// so behind a reverse proxy every player has the proxy's address and a ban
// would ban everybody (the admin API refuses to ban the admin's own
// address, which catches that case).
//
// The list is saved as JSON in bansFile under DATA_DIR (default "data" in
// the working directory, /xashds/data in the image), so it survives a
// restart when that directory is a volume.

const bansFile = "bans.json"

// banEntry is one banned address. Name is the player's name when they were
// banned, for the list only.
type banEntry struct {
	Address  string    `json:"address"`
	Name     string    `json:"name"`
	BannedAt time.Time `json:"bannedAt"`
}

type banFileData struct {
	Bans []banEntry `json:"bans"`
}

// banList is safe for concurrent use. A nil *banList bans nobody.
type banList struct {
	mu   sync.Mutex
	path string
	bans map[string]banEntry
	// broken is set when the file exists but can't be read: the list is
	// then never saved, so the file isn't overwritten with an empty list.
	broken error
}

var errBanFileBroken = errors.New("the ban file couldn't be read when the server started; fix or remove it and restart")

// loadBanList reads the list from path. A missing file is an empty list.
// Any other error is returned with an empty, read-only list.
func loadBanList(path string) (*banList, error) {
	l := &banList{path: path, bans: map[string]banEntry{}}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return l, nil
	}
	if err == nil {
		var file banFileData
		if err = json.Unmarshal(data, &file); err == nil {
			for _, ban := range file.Bans {
				key, ok := normalizeBanAddress(ban.Address)
				if !ok {
					err = fmt.Errorf("%q is not an address", ban.Address)
					break
				}
				ban.Address = key
				l.bans[key] = ban
			}
		}
	}
	if err != nil {
		l.bans = map[string]banEntry{}
		l.broken = err
		return l, fmt.Errorf("%s: %w", path, err)
	}
	return l, nil
}

// addressKey is the key a remote host is banned (and locked out) under: an
// IPv4 address, an IPv6 /64 written as "<prefix>/64", or host unchanged if
// it isn't an IP address.
func addressKey(host string) string {
	ip := net.ParseIP(host)
	if ip == nil {
		return host
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// normalizeBanAddress checks an address from the ban file or the API: an
// IPv4 address or an IPv6 /64, in any spelling.
func normalizeBanAddress(address string) (string, bool) {
	if ip := net.ParseIP(address); ip != nil && ip.To4() != nil {
		return ip.To4().String(), true
	}
	ip, prefix, err := net.ParseCIDR(address)
	if err != nil || ip.To4() != nil {
		return "", false
	}
	if ones, bits := prefix.Mask.Size(); ones != 64 || bits != 128 {
		return "", false
	}
	return addressKey(ip.String()), true
}

// banned reports whether key (an addressKey) is banned.
func (l *banList) banned(key string) bool {
	if l == nil {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	_, ok := l.bans[key]
	return ok
}

// list returns the bans, newest first.
func (l *banList) list() []banEntry {
	if l == nil {
		return []banEntry{}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.sorted()
}

func (l *banList) sorted() []banEntry {
	bans := make([]banEntry, 0, len(l.bans))
	for _, ban := range l.bans {
		bans = append(bans, ban)
	}
	sort.Slice(bans, func(i, j int) bool {
		if !bans[i].BannedAt.Equal(bans[j].BannedAt) {
			return bans[i].BannedAt.After(bans[j].BannedAt)
		}
		return bans[i].Address < bans[j].Address
	})
	return bans
}

// add bans ban.Address and saves the list. It reports whether the address
// is new (an existing ban is kept as it was).
func (l *banList) add(ban banEntry) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.broken != nil {
		return false, errBanFileBroken
	}
	if _, ok := l.bans[ban.Address]; ok {
		return false, nil
	}
	l.bans[ban.Address] = ban
	if err := l.save(); err != nil {
		delete(l.bans, ban.Address)
		return false, err
	}
	return true, nil
}

// remove lifts the ban on key and saves the list. It reports whether key
// was banned.
func (l *banList) remove(key string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.broken != nil {
		return false, errBanFileBroken
	}
	ban, ok := l.bans[key]
	if !ok {
		return false, nil
	}
	delete(l.bans, key)
	if err := l.save(); err != nil {
		l.bans[key] = ban
		return false, err
	}
	return true, nil
}

// save writes the list to a temporary file and renames it over the old
// one, so a crash never leaves half a file. The caller holds l.mu.
func (l *banList) save() error {
	data, err := json.MarshalIndent(banFileData{Bans: l.sorted()}, "", "  ")
	if err != nil {
		return err
	}
	dir := filepath.Dir(l.path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, bansFile+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), l.path)
}
