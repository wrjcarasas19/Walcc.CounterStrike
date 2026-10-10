import filesystemURL from 'xash3d-fwgs/filesystem_stdio.wasm?url';
import xashURL from 'xash3d-fwgs/xash.wasm?url';
import menuURL from 'cs16-client/cl_dll/menu_emscripten_wasm32.wasm?url';
import clientURL from 'cs16-client/cl_dll/client_emscripten_wasm32.wasm?url';
import serverURL from 'cs16-client/dlls/cs_emscripten_wasm32.so?url';
import gles3URL from 'xash3d-fwgs/libref_gles3compat.wasm?url';
import { Xash3DWebRTC } from './webrtc';

export function createEngine(): Xash3DWebRTC {
  blockMicrophone();
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  redirectFullscreen(canvas, document.getElementById('game')!);
  return new Xash3DWebRTC({
    canvas,
    module: {
      // No voice chat: the game's config.cfg turns the engine's voice on and
      // binds K to +voicerecord, which opens the microphone as the engine
      // starts. Set here, before the engine starts, so it never asks for it.
      arguments: ['-windowed', '-game', 'cstrike', '+voice_enable', '0'],
    },
    libraries: {
      filesystem: filesystemURL,
      xash: xashURL,
      menu: menuURL,
      server: serverURL,
      client: clientURL,
      render: {
        gles3compat: gles3URL,
      },
    },
    filesMap: {
      'dlls/cs_emscripten_wasm32.so': serverURL,
      '/rwdir/filesystem_stdio.so': filesystemURL,
    },
  });
}

// SDL's fullscreen toggle calls requestFullscreen on the canvas itself
// (emscripten_request_fullscreen_strategy("#canvas")), which would leave the
// HTML HUD outside the fullscreen element. Fullscreen the wrapper instead.
// No voice chat: even if a player turns voice_enable back on in the console,
// the engine can't open the microphone. Nothing else on the page uses it.
function blockMicrophone() {
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  devices.getUserMedia = () =>
    Promise.reject(new DOMException('Voice chat is disabled', 'NotAllowedError'));
}

function redirectFullscreen(canvas: HTMLCanvasElement, game: HTMLElement) {
  if (!game.requestFullscreen) return;
  canvas.requestFullscreen = (options) => game.requestFullscreen(options);
}
