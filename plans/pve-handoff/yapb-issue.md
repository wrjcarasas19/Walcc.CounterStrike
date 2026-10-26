# Draft issue for yapb/yapb (not posted)

**Title:** Server hangs for good while the vistable is being rebuilt (4.4.957, Linux i386)

**Environment:** YaPB 4.4.957 (release `yapb-4.4.957-linux.tar.xz`), Metamod-R 1.3.0.149, ReGameDLL_CS 5.30.0.814, Xash3D FWGS dedicated server (i386). Reproduced with the engine running under qemu-i386, which makes it slow; I haven't measured it on native hardware.

**What happens:** on a map with no `train/<map>.vis`, YaPB starts `Rebuilding vistable... N% done.` While that runs, the server sometimes stops running frames. One core stays at 100%, nothing is logged after the last vistable line, and the server never recovers (left for 30 minutes). Sometimes the same stall lasts a few seconds and then recovers.

**When:** 9 hangs in 33 runs (1 human, 4 bots, de_dust2, `sv_restart 1` every 15 s), and every one of them happened while the rebuild was running (between 39% and 83%). No run hung after `Rebuilding vistable... 99%`. With a prebuilt `de_dust2.vis` in `train/`, 75 restarts never hung. The hangs came at a round restart, at the end of freeze time, and 7 s into a round, so the restart itself isn't the trigger.

**Where:** I signalled the engine thread during the hang and backtraced it each time. Every sample is inside `pfnStartFrame` (`GetEntityAPI` lambda #9, offsets `+0xc6101`, `+0xc6149`, `+0xc61f9`, `+0xc624a` in `yapb.so`), calling `pfnTraceLine` → `SV_Move` → `SV_ClipMoveToEntity` → `PM_RecursiveHullCheck`. So something in the frame calls `TraceLine` in a loop that doesn't end. `GraphVistable::rebuild ()` itself is bounded (one source node and 250–400 targets per call), so I suspect bot code that runs with the incomplete table. One loop that can't end if `dest == source` (zero `dir`) while traces start in solid is `Bot::isPenetrableObstacle3` (`for (;;)` in `src/combat.cpp`); I haven't confirmed that's the one.

**Workaround:** ship prebuilt `.vis` files so the rebuild never runs during play.
