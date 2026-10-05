import { attachAdmin, detachAdmin } from './admin';
import { createEngine } from './engine';
import { GameFilesError, getGameFiles } from './gamefiles';
import {
  getPhase,
  onAction,
  removeDesktop,
  setConnectStatus,
  setPhase,
  showConnectionLost,
  showError,
  type Stage,
  updateProgress,
} from './desktop';
import { attachHud, detachHud } from './hud';
import { syncServerMaps } from './maps';
import { cachePlayerName, getPlayerName } from './player';
import { ConnectError, type Xash3DWebRTC } from './webrtc';

const GENERIC_ERROR = 'Failed to load game. Please try again later.';

let engine: Xash3DWebRTC | undefined;
let failedStage: Stage | undefined;

onAction(() => {
  switch (getPhase()) {
    case 'idle':
      cachePlayerName();
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
  removeDesktop();
  const playerName = getPlayerName();

  const confirmLeave = (event: BeforeUnloadEvent) => {
    event.preventDefault();
    event.returnValue = '';
    return '';
  };
  engine.onDisconnect = () => {
    detachAdmin();
    detachHud();
    showConnectionLost(() => {
      window.removeEventListener('beforeunload', confirmLeave);
      window.location.reload();
    });
  };

  engine.main();
  attachHud(engine);
  attachAdmin(engine);
  engine.Cmd_ExecuteString('_vgui_menus 0');
  if (!window.matchMedia('(hover: hover)').matches) {
    engine.Cmd_ExecuteString('touch_enable 1');
  }
  engine.Cmd_ExecuteString(`name "${playerName}"`);
  // Large cl_dlmax makes this dedicated server crash in Netchan_TransmitBits.
  engine.Cmd_ExecuteString('cl_dlmax 1400');
  engine.Cmd_ExecuteString('rate 25000');
  engine.Cmd_ExecuteString('cl_updaterate 60');
  engine.Cmd_ExecuteString('cl_cmdrate 60');
  engine.Cmd_ExecuteString('cl_allowdownload 0');
  engine.Cmd_ExecuteString('cl_allowupload 0');
  engine.Cmd_ExecuteString('connect 127.0.0.1:8080');

  window.addEventListener('beforeunload', confirmLeave);
}
