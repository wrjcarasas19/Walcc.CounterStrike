package main

import "regexp"

// The rcon password comes from the RCON_PASSWORD environment variable, not
// from server.cfg, so it never lands in the repository or the image. It is
// handed to the engine as a start argument (+rcon_password <value>); with no
// password set, the engine refuses every rcon command.
//
// The engine joins its + arguments into one command line, so the value must
// stay a single plain token: it can't start with + or - (that starts a new
// argument), and quotes, spaces, ; and // would end or split the command.
var rconPasswordPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.~!@#%^*=+,:?-]{0,63}$`)

// rconStatus says why engineArgs did or didn't add the rcon password.
type rconStatus int

const (
	rconEnabled rconStatus = iota
	rconUnset
	rconInvalid
)

// engineArgs returns the engine's start arguments: args (os.Args, program
// name first) with +rcon_password added right after the program name, so a
// +rcon_password given on the command line still wins. The password is only
// added when it matches rconPasswordPattern.
func engineArgs(args []string, password string) ([]string, rconStatus) {
	if password == "" {
		return args, rconUnset
	}
	if !rconPasswordPattern.MatchString(password) {
		return args, rconInvalid
	}
	out := make([]string, 0, len(args)+2)
	out = append(out, args[:1]...)
	out = append(out, "+rcon_password", password)
	return append(out, args[1:]...), rconEnabled
}
