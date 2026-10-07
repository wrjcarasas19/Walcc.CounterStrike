#!/bin/bash
# Makes the announcer sounds. Runs inside the local/cs16-sounds image (see
# generate.sh, which builds the image and calls this): /out is
# src/client/public/sounds. Needs piper, ffmpeg and sox.
set -euo pipefail

OUT=${OUT:-/out}
VOICE=/voice/en_US-john-medium.onnx
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Loudness of every file (EBU R128 integrated) and the true peak the
# limiter aims for before encoding; the encoded files are checked against
# -1 dBTP at the end.
TARGET_I=-16
TARGET_TP=-2.5
RATE=48000

# --- Voice -------------------------------------------------------------------

# say <name> <text> [length scale]: Piper TTS, then an "arena announcer"
# chain: a bit lower and slower, bass and presence lift, compression, and a
# short slap-back echo plus a small room tail.
say() {
	local name=$1 text=$2 length=${3:-1.05}
	# noise 0: no random variation, so the same text gives the same audio.
	echo "$text" | piper -m "$VOICE" --length-scale "$length" \
		--noise-scale 0 --noise-w-scale 0 --sentence-silence 0 \
		-f "$TMP/$name.tts.wav" 2>/dev/null
	ffmpeg -hide_banner -loglevel error -y -i "$TMP/$name.tts.wav" -af "\
silenceremove=start_periods=1:start_threshold=-50dB,\
areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,\
aresample=$RATE,asetrate=$RATE*0.9,aresample=$RATE,atempo=1.05,\
highpass=f=80,bass=g=5:f=140,equalizer=f=3000:t=q:w=1:g=3,\
acompressor=threshold=-24dB:ratio=5:attack=3:release=120:makeup=4,\
apad=pad_dur=0.45,\
aecho=0.85:0.7:70|140|230:0.28|0.16|0.08" \
		-ac 1 -ar $RATE -c:a pcm_s16le "$TMP/$name.voice.wav"
}

# --- Synth stingers (sox) ---------------------------------------------------

# -R: fixed random seed (dither, white noise), so every run gives the same
# files.
sox() { command sox -R "$@"; }

# note <file> <seconds> <freq>: a short square+triangle blip with a fast
# attack and decay.
note() {
	sox -n -r $RATE -c 1 -b 16 "$1" synth "$2" square "$3" synth "$2" triangle mix "$3" \
		fade q 0.004 "$2" 0.04 vol 0.35
}

# chord <file> <seconds> <freq...>: notes held together with a slow decay.
chord() {
	local file=$1 len=$2
	shift 2
	local parts=() i=0
	for f in "$@"; do
		sox -n -r $RATE -c 1 -b 16 "$TMP/chord$i.wav" synth "$len" square "$f" synth "$len" sine mix "$f" \
			fade q 0.006 "$len" "$(awk -v l="$len" 'BEGIN { print l * 0.8 }')" vol 0.2
		parts+=("$TMP/chord$i.wav")
		i=$((i + 1))
	done
	sox -m "${parts[@]}" "$file"
}

# Notes (Hz): C5 E5 G5 C6 E6 G6, and G4.
C5=523.25 E5=659.26 G5=783.99 C6=1046.5 E6=1318.51 G6=1567.98 G4=392.0

# Rising arpeggio, the level-up jingle.
stinger_levelup() {
	note "$TMP/n1.wav" 0.07 $C5
	note "$TMP/n2.wav" 0.07 $E5
	note "$TMP/n3.wav" 0.07 $G5
	chord "$TMP/n4.wav" 0.35 $C6 $G5
	sox "$TMP/n1.wav" "$TMP/n2.wav" "$TMP/n3.wav" "$TMP/n4.wav" "$1"
}

# The same arpeggio an octave up, played twice: "last weapon" alarm.
stinger_final() {
	note "$TMP/f1.wav" 0.06 $C6
	note "$TMP/f2.wav" 0.06 $E6
	note "$TMP/f3.wav" 0.06 $G6
	sox "$TMP/f1.wav" "$TMP/f2.wav" "$TMP/f3.wav" "$TMP/f1.wav" "$TMP/f2.wav" "$TMP/f3.wav" "$TMP/fa.wav"
	chord "$TMP/f4.wav" 0.4 $C6 $E6 $G6
	sox "$TMP/fa.wav" "$TMP/f4.wav" "$1"
}

# Fanfare: G4 C5 E5, then a held C major chord.
stinger_winner() {
	note "$TMP/w1.wav" 0.11 $G4
	note "$TMP/w2.wav" 0.11 $C5
	note "$TMP/w3.wav" 0.11 $E5
	chord "$TMP/w4.wav" 1.4 $C5 $E5 $G5 $C6
	sox "$TMP/w1.wav" "$TMP/w2.wav" "$TMP/w3.wav" "$TMP/w4.wav" "$1"
}

# "You were knifed": short and not a voice. A metallic swipe (filtered
# noise) and a falling "bwomp".
stinger_knifed() {
	sox -n -r $RATE -c 1 -b 16 "$TMP/k1.wav" synth 0.09 whitenoise \
		vol 0.3 highpass 4000 fade q 0.002 0.09 0.07
	sox -n -r $RATE -c 1 -b 16 "$TMP/k2.wav" synth 0.45 square 330-70 synth 0.45 sine mix 330-70 \
		vol 0.4 lowpass 1800 fade q 0.005 0.45 0.25
	sox "$TMP/k1.wav" "$TMP/k2.wav" "$1"
}

# overlay <out> <bed> <voice> <delay ms>: the voice starts <delay> ms into
# the bed.
overlay() {
	ffmpeg -hide_banner -loglevel error -y -i "$2" -i "$3" -filter_complex \
		"[1:a]adelay=$4[v];[0:a][v]amix=inputs=2:duration=longest:normalize=0" \
		-ac 1 -ar $RATE -c:a pcm_s16le "$1"
}

# --- Loudness and encoding --------------------------------------------------

# loudness <wav>: integrated loudness (LUFS) and true peak (dBTP).
loudness() {
	ffmpeg -hide_banner -nostats -i "$1" -af ebur128=peak=true -f null - 2>&1 |
		sed -n '/Summary/,$p' | awk '/ I: /{i=$2} /Peak:/{p=$2} END{print i, p}'
}

# finish <name> <wav>: gain to TARGET_I, then a limiter at TARGET_TP run at
# 4x the sample rate (so it catches inter-sample peaks), three times (the limiter
# takes a little loudness off); then Opus in WebM and MP3, both mono,
# metadata stripped. Opus at 64 kb/s: at 40 kb/s and below libopus came out
# about 1.5 LU quieter than its input.
finish() {
	local name=$1 src=$2 gain=0 i tp
	read -r i tp < <(loudness "$src")
	gain=$(awk -v t=$TARGET_I -v i="$i" 'BEGIN { print t - i }')
	local limit
	limit=$(awk -v tp=$TARGET_TP 'BEGIN { print 10 ^ (tp / 20) }')
	for _ in 1 2 3; do
		ffmpeg -hide_banner -loglevel error -y -i "$src" -af "\
volume=${gain}dB,aresample=$((RATE * 4)),\
alimiter=limit=$limit:attack=2:release=60:level=false,aresample=$RATE" \
			-ac 1 -ar $RATE -c:a pcm_s16le "$TMP/$name.norm.wav"
		read -r i tp < <(loudness "$TMP/$name.norm.wav")
		gain=$(awk -v g="$gain" -v t=$TARGET_I -v i="$i" 'BEGIN { print g + t - i }')
	done
	echo "$name: $i LUFS, $tp dBTP before encoding" >&2
	ffmpeg -hide_banner -loglevel error -y -i "$TMP/$name.norm.wav" -map_metadata -1 \
		-fflags +bitexact -flags:a +bitexact \
		-c:a libopus -b:a 64k -application audio -f webm "$OUT/$name.webm"
	ffmpeg -hide_banner -loglevel error -y -i "$TMP/$name.norm.wav" -map_metadata -1 \
		-fflags +bitexact -flags:a +bitexact -id3v2_version 0 \
		-ar 44100 -c:a libmp3lame -b:a 64k "$OUT/$name.mp3"
}

# --- The files ---------------------------------------------------------------

# Spellings chosen by transcribing the output with Whisper: "Quad kill"
# comes out as "quad to kill", "First blood!" with a gap between the words,
# "Godlike!" (after the echo) as "god like it".

voice_line() { # <name> <text> [length scale]
	say "$1" "$2" "${3:-}"
	finish "$1" "$TMP/$1.voice.wav"
}

voice_line first-blood "First blood."
voice_line headshot "Headshot!"
voice_line double-kill "Double kill!"
voice_line triple-kill "Triple kill!"
voice_line quad-kill "Quad-kill!"
voice_line rampage "Rampage!"
voice_line killing-spree "Killing spree!"
voice_line dominating "Dominating!"
voice_line unstoppable "Unstoppable!"
voice_line godlike "God like!"
voice_line humiliation "Humiliation!"
voice_line last-man "Last man standing!"

say level-up "Level up!"
stinger_levelup "$TMP/levelup.wav"
overlay "$TMP/level-up.mix.wav" "$TMP/levelup.wav" "$TMP/level-up.voice.wav" 330
finish level-up "$TMP/level-up.mix.wav"

say final-level "Final level!"
stinger_final "$TMP/final.wav"
overlay "$TMP/final-level.mix.wav" "$TMP/final.wav" "$TMP/final-level.voice.wav" 420
finish final-level "$TMP/final-level.mix.wav"

say winner "Winner!" 1.2
stinger_winner "$TMP/winner.wav"
overlay "$TMP/winner.mix.wav" "$TMP/winner.wav" "$TMP/winner.voice.wav" 450
finish winner "$TMP/winner.mix.wav"

stinger_knifed "$TMP/knifed.wav"
finish knifed "$TMP/knifed.wav"

# --- Check -------------------------------------------------------------------

# Decode each encoded file and measure it: integrated loudness, true peak,
# size. Fails if a file is over 30 KB or above -1 dBTP, or its loudness is
# more than 1 LU from the target.
fail=0
printf '%-16s %-5s %8s %8s %8s %7s\n' file fmt bytes LUFS dBTP seconds
for f in "$OUT"/*.webm "$OUT"/*.mp3; do
	r=$(ffmpeg -hide_banner -nostats -i "$f" -af ebur128=peak=true -f null - 2>&1)
	i=$(echo "$r" | sed -n '/Summary/,$p' | sed -n 's/^ *I: *\(-\?[0-9.]*\) LUFS/\1/p')
	tp=$(echo "$r" | sed -n '/Summary/,$p' | sed -n 's/^ *Peak: *\(-\?[0-9.inf]*\) dBFS/\1/p')
	d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$f")
	b=$(stat -c %s "$f")
	n=$(basename "$f")
	printf '%-16s %-5s %8d %8s %8s %7.2f\n' "${n%.*}" "${n##*.}" "$b" "$i" "$tp" "$d"
	if [ "$b" -ge 30720 ] || awk -v tp="$tp" -v i="$i" -v t=$TARGET_I \
		'BEGIN { d = i - t; exit !(tp > -1 || d > 1 || d < -1) }'; then
		echo "  FAIL: $n" >&2
		fail=1
	fi
done
exit $fail
