import filesystemURL from 'xash3d-fwgs/filesystem_stdio.wasm?url';
import xashURL from 'xash3d-fwgs/xash.wasm?url';
import menuURL from 'cs16-client/cl_dll/menu_emscripten_wasm32.wasm?url';
import clientURL from 'cs16-client/cl_dll/client_emscripten_wasm32.wasm?url';
import serverURL from 'cs16-client/dlls/cs_emscripten_wasm32.so?url';
import gles3URL from 'xash3d-fwgs/libref_gles3compat.wasm?url';
import { Xash3DWebRTC } from './webrtc';

export function createEngine(): Xash3DWebRTC {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  redirectFullscreen(canvas, document.getElementById('game')!);
  return new Xash3DWebRTC({
    canvas,
    module: {
      // The engine's own voice chat stays off (the game's config.cfg turns it
      // on and binds K to +voicerecord): with it on, the engine opens the
      // microphone as it starts and sends voice over the game connection.
      // Voice goes over WebRTC instead (voice.ts). Set here, before the
      // engine starts, so it never calls getUserMedia.
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
function redirectFullscreen(canvas: HTMLCanvasElement, game: HTMLElement) {
  if (!game.requestFullscreen) return;
  canvas.requestFullscreen = (options) => game.requestFullscreen(options);
}
