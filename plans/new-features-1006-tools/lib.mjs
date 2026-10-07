// Helpers for driving the web page in headless Chromium (see README.md).
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

export const BASE = process.env.BASE ?? 'http://127.0.0.1:27016';
export const OUT = process.env.OUT ?? 'out';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'headless-admin';

/**
 * Chromium with WebGL through SwiftShader (software GL; there is no GPU in
 * the container) and autoplay allowed, so the game can start without a
 * real click on a media element.
 */
export async function launch() {
  return chromium.launch({
    headless: true,
    // The full Chromium build in its new headless mode (not the headless
    // shell) unless CHANNEL says otherwise.
    channel: process.env.CHANNEL ?? 'chromium',
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

/** A page that logs console errors and page errors, prefixed with tag. */
// `touch`: a phone (isMobile, hasTouch), so the page shows touch controls.
export async function newPage(
  browser,
  { tag = 'page', width = 1280, height = 800, touch = false } = {}
) {
  const context = await browser.newContext({
    viewport: { width, height },
    ...(touch ? { isMobile: true, hasTouch: true } : {}),
  });
  await routeGameFiles(context);
  await context.addInitScript(exposeEngine);
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error' || process.env.VERBOSE) {
      console.log(`[${tag} console.${msg.type()}] ${msg.text()}`);
    }
  });
  page.on('pageerror', (error) => console.log(`[${tag} pageerror] ${error.message}`));
  return page;
}

// The game files zip (src/client/src/gamefiles.ts). Its blob store only
// allows CORS from the real site, so the page's download is redirected to
// a small server here that sends cache/<zip> (fetch it once: see README.md)
// with a CORS header. (route.fulfill can't carry 400 MB.)
const GAMEFILES = /^https:\/\/sgwalcc\.blob\.core\.windows\.net\/public\/(gamezip_[^/?]+\.zip)/;
const ZIP_PORT = Number(process.env.ZIP_PORT ?? 27090);
let zipServer;

function startZipServer() {
  if (zipServer) return;
  zipServer = createServer((req, res) => {
    const name = /^\/(gamezip_[\w.-]+\.zip)$/.exec(req.url ?? '')?.[1];
    const file = name && `cache/${name}`;
    const cors = { 'Access-Control-Allow-Origin': '*' };
    if (!file || !existsSync(file)) {
      console.log(`${file ?? req.url} missing: see README.md`);
      res.writeHead(404, cors).end();
      return;
    }
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'application/zip',
      'Content-Length': statSync(file).size,
    });
    createReadStream(file).pipe(res);
  }).listen(ZIP_PORT, '127.0.0.1');
  zipServer.unref();
}

async function routeGameFiles(context) {
  startZipServer();
  await context.route(GAMEFILES, (route) =>
    route.fulfill({
      status: 302,
      headers: {
        Location: `http://127.0.0.1:${ZIP_PORT}/${GAMEFILES.exec(route.request().url())[1]}`,
        'Access-Control-Allow-Origin': '*',
      },
    })
  );
}

export async function shot(page, name) {
  const path = `${OUT}/${name}.png`;
  await page.screenshot({ path });
  console.log(`screenshot ${path}`);
}

/** Text of the WebGL renderer, or why there is none. */
export async function webglInfo(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2') ??
      document.createElement('canvas').getContext('webgl');
    if (!gl) return 'no WebGL';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

/**
 * Loads the page, types a nickname, downloads the game files and connects.
 * Resolves once the HUD is shown (the game is in), or throws after
 * timeoutMs with the page's status texts.
 */
export async function joinGame(page, { name = 'Headless', timeoutMs = 480_000 } = {}) {
  await page.goto(BASE);
  await page.fill('#nickname-input', name);
  await page.click('#action-button');
  const deadline = Date.now() + timeoutMs;
  let clickedConnect = false;
  while (Date.now() < deadline) {
    const phase = await page.getAttribute('#desktop', 'data-phase').catch(() => null);
    if (phase === 'ready' && !clickedConnect) {
      clickedConnect = true;
      await page.click('#action-button');
    }
    if (phase === 'error') break;
    const hudShown = await page.evaluate(() => {
      const hud = document.getElementById('hud');
      return !!hud && !hud.hidden && !document.getElementById('desktop');
    });
    if (hudShown) return;
    await page.waitForTimeout(1000);
  }
  const status = await page.evaluate(() =>
    ['#download-status', '#load-status', '#connect-status']
      .map((s) => `${s}: ${document.querySelector(s)?.textContent?.trim() ?? '(gone)'}`)
      .join(' | ')
  );
  throw new Error(`didn't get into the game: ${status}`);
}

/**
 * Runs in the page before its scripts: keeps the engine object (the
 * Xash3DWebRTC instance in src/client/src/main.ts, not global) as
 * window.__engine, caught when its constructor sets _running, so tests can
 * run console commands. Also counts data channel packets (window.__dc).
 */
function exposeEngine() {
  Object.defineProperty(Object.prototype, '_running', {
    configurable: true,
    set(value) {
      if (typeof this.Cmd_ExecuteString === 'function') window.__engine = this;
      Object.defineProperty(this, '_running', {
        value,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    },
  });
  window.__dc = { sent: 0, received: 0 };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    window.__dc.sent++;
    return send.call(this, data);
  };
  const Peer = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const peer = new Peer(...args);
    peer.addEventListener('datachannel', (e) =>
      e.channel.addEventListener('message', () => window.__dc.received++)
    );
    return peer;
  };
  window.RTCPeerConnection.prototype = Peer.prototype;
}

/** Runs a console command in the game (after joinGame). */
export async function engineCommand(page, command) {
  await page.evaluate((c) => window.__engine.Cmd_ExecuteString(c), command);
}

/** Waits until the server lists `name` as a human player (status.json). */
export async function waitForPlayer(name, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await (await fetch(`${BASE}/status.json`)).json();
    if (status.players.some((p) => !p.bot && p.name === name)) return status;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${name} never showed up in status.json`);
}

/** Opens the F4 admin menu and logs in with ADMIN_PASSWORD. */
export async function openAdmin(page) {
  await pressKey(page, 'F4');
  if (await page.isVisible('#admin-login')) {
    await page.fill('#admin-password', ADMIN_PASSWORD);
    await page.click('#admin-login');
    await page.waitForTimeout(1000);
  }
}

/** Opens a menu drawn over the game by its key (F3 settings, F4 admin). */
export async function pressKey(page, key) {
  await page.keyboard.press(key);
  await page.waitForTimeout(500);
}

/** Sends one admin action from Node (same API as the F4 menu). */
export async function adminAction(action) {
  const login = await fetch(`${BASE}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: ADMIN_PASSWORD }),
  });
  if (!login.ok) throw new Error(`admin login: ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0] ?? '';
  const res = await fetch(`${BASE}/admin/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(action),
  });
  return { status: res.status, body: await res.text() };
}
