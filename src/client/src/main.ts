import { attachAdmin, detachAdmin } from './admin';
// Before ./wheel: its key listeners must run before the wheel's (chat.ts).
import { attachChat, detachChat } from './chat';
import { createEngine } from './engine';
import { GameFilesError, getGameFiles } from './gamefiles';
import {
  getPhase,
  hideConnectionLost,
  onAction,
  removeDesktop,
  setConnectStatus,
  setPhase,
  showConnectionLost,
  showError,
  showReconnecting,
  type Stage,
  updateProgress,
} from './desktop';
import { attachHud, detachHud, setLocalPlayerName } from './hud';
import { hasJoinParam, joinAction, withoutJoinParam } from './invite/link';
import { startLeaderboard, stopLeaderboard } from './leaderboard';
import { startLobby, stopLobby } from './lobby';
import { startMapResync, stopMapResync, syncServerMaps } from './maps';
import { setInGame } from './modal';
import { cachePlayerName, getPlayerName, savedPlayerName } from './player';
import { attachSettings, detachSettings } from './settings';
import { attachWheel, detachWheel } from './wheel';
import { ConnectError, type Xash3DWebRTC } from './webrtc';

const GENERIC_ERROR = 'Failed to load game. Please try again later.';
// The engine talks to the server through Xash3DWebRTC, which stands in for
// this address.
const SERVER_ADDRESS = '127.0.0.1:8080';
// Waits before each attempt to re-open a lost connection; after the last
// one fails, the player is offered a reload.
const RECONNECT_DELAYS_MS = [1_000, 3_000, 5_000];

let engine: Xash3DWebRTC | undefined;
let failedStage: Stage | undefined;
// Opened from an invite link (?join=1): connect as soon as the game files
// are loaded, without waiting for a click on Connect.
let joinWhenReady = false;

onAction(() => {
  switch (getPhase()) {
    case 'idle':
      cachePlayerName();
      if (joinWhenReady) {
        setConnectStatus(`Invite link: joining as ${getPlayerName()}.`);
      }
      void prepare();
      break;
    case 'ready':
      void connect(engine!);
      break;
    case 'error':
      // Game files are already loaded, so a failed connect is retried in
      // place; earlier failures start over.
      if (failedStage === 'connect' && engine) {
        void connect(engine);
      } else {
        window.location.reload();
      }
      break;
  }
});

setPhase('idle');
startLobby();
startLeaderboard();
handleInviteLink();

/**
 * Invite links (?join=1): with a saved nickname the download starts at once
 * and the game connects when it's loaded (through connect() and start(), so
 * the lobby and leaderboard polling stop as usual); without one the
 * nickname field gets focus and the next Download goes on to connect.
 * The parameter is removed from the address bar at once, so reloading the
 * page later (e.g. after "Connection lost") doesn't join by itself.
 *
 * No click is needed: the download and the connection don't ask for a user
 * gesture. Sound starts on the first key, click or tap (the engine resumes
 * its AudioContext then), and the mouse is captured on the first click on
 * the game, as after a normal Connect.
 */
function handleInviteLink(): void {
  const action = joinAction(hasJoinParam(location.search), savedPlayerName());
  const cleaned = withoutJoinParam(location.href);
  if (cleaned !== undefined) history.replaceState(history.state, '', cleaned);
  if (action === 'none') return;
  joinWhenReady = true;
  if (action === 'connect') {
    cachePlayerName();
    setConnectStatus(`Invite link: joining as ${getPlayerName()}.`);
    void prepare();
  } else {
    setConnectStatus('Invite link: enter a nickname, then press Download.');
    document.getElementById('nickname-input')?.focus();
  }
}

async function prepare() {
  setPhase('downloading');
  let stage: Stage = 'download';
  try {
    engine = createEngine();
    // Only the wasm engine starts here; the server connection waits for
    // Connect so idle launchers don't hold server slots.
    const [gamefiles] = await Promise.all([getGameFiles(), engine.init()]);
    stage = 'load';
    setPhase('loading');
    await loadGameFiles(engine, gamefiles.files);
    await syncServerMaps(engine);
    setPhase('ready');
  } catch (error) {
    fail(stage, error);
    return;
  }
  if (joinWhenReady && engine) {
    joinWhenReady = false;
    await connect(engine);
  }
}

async function connect(engine: Xash3DWebRTC) {
  setPhase('connecting');
  setConnectStatus('Connecting to the game server...');
  try {
    await engine.connect();
  } catch (error) {
    fail('connect', error);
    return;
  }
  start(engine);
}

function fail(stage: Stage, error: unknown): void {
  console.error(`Failed at the ${stage} stage:`, error);
  failedStage = stage;
  showError(stage, describeError(error));
}

function describeError(error: unknown): string {
  if (error instanceof GameFilesError) {
    return error.status === undefined
      ? "Couldn't download the game files. Check your internet connection and try again."
      : `Couldn't download the game files (HTTP ${error.status}). Please try again later.`;
  }
  if (error instanceof ConnectError) {
    switch (error.kind) {
      case 'unreachable':
        return "Couldn't reach the game server. It may be offline or busy; please try again shortly.";
      case 'closed':
        return 'The game server closed the connection. Please try again.';
      case 'timeout':
      case 'webrtc':
        return "Couldn't open a game connection. Port 27018 may be blocked by your network.";
    }
  }
  return GENERIC_ERROR;
}

async function loadGameFiles(
  engine: Xash3DWebRTC,
  files: Awaited<ReturnType<typeof getGameFiles>>['files']
): Promise<void> {
  const fileEntries = Object.entries(files).filter(([, file]) => !file.dir);
  const totalFiles = fileEntries.length;
  let filesLoaded = 0;
  updateProgress('load', 0, 'Initializing engine...');

  await Promise.all(
    fileEntries.map(async ([filename, file]) => {
      const path = '/rodir/' + filename;
      const dir = path.split('/').slice(0, -1).join('/');

      engine.em.FS.mkdirTree(dir);
      engine.em.FS.writeFile(path, await file.async('uint8array'));

      filesLoaded += 1;
      updateProgress('load', filesLoaded / totalFiles, filename);
    })
  );

  engine.em.FS.chdir('/rodir');

  updateProgress('load', 1, 'Done');
}

function start(engine: Xash3DWebRTC): void {
  stopLobby();
  stopLeaderboard();
  removeDesktop();
  const playerName = getPlayerName();

  const confirmLeave = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
    return '';
  };
  engine.onDisconnect = () => {
    void reconnect(engine).then((reconnected) => {
      if (reconnected) return;
      stopMapResync();
      detachAdmin();
      detachSettings();
      detachWheel();
      setInGame(false);
      detachChat();
      detachHud();
      showConnectionLost(() => {
        window.removeEventListener('beforeunload', confirmLeave);
        window.location.reload();
      });
    });
  };

  engine.main();
  setInGame(true);
  const touch = !window.matchMedia('(hover: hover)').matches;
  attachHud(engine);
  attachChat(engine, { touch });
  attachAdmin(engine);
  engine.Cmd_ExecuteString('_vgui_menus 0');
  if (touch) engine.Cmd_ExecuteString('touch_enable 1');
  // Saved settings (sensitivity, crosshair, volume) before connecting.
  attachSettings(engine, touch);
  attachWheel(engine, touch);
  engine.Cmd_ExecuteString(`name "${playerName}"`);
  setLocalPlayerName(playerName);
  // Large cl_dlmax makes this dedicated server crash in Netchan_TransmitBits.
  engine.Cmd_ExecuteString('cl_dlmax 1400');
  engine.Cmd_ExecuteString('rate 25000');
  engine.Cmd_ExecuteString('cl_updaterate 60');
  engine.Cmd_ExecuteString('cl_cmdrate 60');
  engine.Cmd_ExecuteString('cl_allowdownload 0');
  engine.Cmd_ExecuteString('cl_allowupload 0');
  engine.Cmd_ExecuteString(`connect ${SERVER_ADDRESS}`);
  startMapResync(engine);

  window.addEventListener('beforeunload', confirmLeave);
}

/**
 * Re-opens a lost connection while the engine keeps running, so the game
 * files and engine don't have to load again. The server sees the new
 * connection as a new player, so the engine joins again.
 */
async function reconnect(engine: Xash3DWebRTC): Promise<boolean> {
  showReconnecting();
  for (const delay of RECONNECT_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await engine.connect();
    } catch (error) {
      console.warn('Reconnect attempt failed:', error);
      continue;
    }
    hideConnectionLost();
    // Maps added while the player was away (e.g. after a server restart).
    await syncServerMaps(engine);
    engine.Cmd_ExecuteString(`connect ${SERVER_ADDRESS}`);
    return true;
  }
  return false;
}
