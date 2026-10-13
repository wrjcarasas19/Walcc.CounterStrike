package main

// counterStrike is the game folder the image's ENTRYPOINT runs. The
// hl-web-server compose service (docker-compose.yml) runs "valve" instead;
// the leaderboard, bots, community maps and the admin API are written for
// Counter-Strike and stay off for any other game.
const counterStrike = "cstrike"

// gameDir returns the engine's game folder: the value after the first -game
// in args (program name first), as the engine reads it, or "cstrike".
func gameDir(args []string) string {
	for i := 1; i+1 < len(args); i++ {
		if args[i] == "-game" {
			return args[i+1]
		}
	}
	return counterStrike
}
