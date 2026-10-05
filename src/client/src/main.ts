import { createEngine } from './engine';
import { getGameFiles } from './gamefiles';
import {
  getPhase,
  onAction,
  removeDesktop,
  setPhase,
  showError,
  updateProgress,
} from './desktop';
import { cachePlayerName, getPlayerName } from './player';
import type { Xash3DWebRTC } from './webrtc';

let engine: Xash3DWebRTC | undefined;

onAction(() => {
  switch (getPhase()) {
    case 'idle':
      cachePlayerName();
      void prepare();
      break;
    case 'ready':
      start(engine!);
      break;
    case 'error':
      // The engine may be half-initialized; start over from a clean page.
      window.location.reload();
      break;
  }
});

setPhase('idle');

async function prepare() {
  setPhase('downloading');
  let stage: 'download' | 'load' = 'download';
  try {
    engine = createEngine();
    const [gamefiles] = await Promise.all([getGameFiles(), engine.init()]);
    stage = 'load';
    setPhase('loading');
    await loadGameFiles(engine, gamefiles.files);
    setPhase('ready');
  } catch (error) {
    console.error('Failed to load game:', error);
    showError(stage, 'Failed to load game. Please try again later.');
  }
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

  engine.main();
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

  window.addEventListener('beforeunload', (event) => {
    event.preventDefault();
    event.returnValue = '';
    return '';
  });
}
