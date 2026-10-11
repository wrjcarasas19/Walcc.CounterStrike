// Turns Emscripten's engine glue (dist/raw.js) into the ES module the wrapper
// imports (lib/generated/xash.js, typed by lib/generated/xash.d.ts).
// Upstream's scripts/patch-emscripten-js.mts at the commit pinned in
// apps/server/Dockerfile (WEBXASH3D_COMMIT), as plain JavaScript so the
// xash3d-fwgs stage needs Node only, not ts-node. Every replacement must
// match: a silent no-op would ship an engine that never starts.
import { promises as fs } from 'fs';

let data = await fs.readFile('./dist/raw.js', 'utf8');

function replaceAll(find, replace) {
  if (!data.includes(find)) {
    throw new Error(`patch-emscripten-js: not found in raw.js: ${find}`);
  }
  data = data.split(find).join(replace);
}

// fix CJS export to EJS
replaceAll(
  `if(typeof exports==="object"&&typeof module==="object"){module.exports=Xash3D;module.exports.default=Xash3D}else if(typeof define==="function"&&define["amd"])define([],()=>Xash3D);`,
  'export default Xash3D;',
);

// add on start async FS callback
replaceAll('preInit();', '');
replaceAll('run();', '');

// hack to call dynamic function inside precompiled function
// (the engine's emscripten net code logs these placeholders; the wrapper's
// Net class in lib/net.ts supplies the real sendto/recvfrom)
replaceAll(
  'console.log("sendto")',
  'return moduleArg.sendto?.(sockfd, packets, sizes, packet_count, seq_num, to, to_len)',
);
replaceAll(
  'console.log("recvfrom")',
  'return moduleArg.recvfrom?.(sockfd, buf, len, flags, src_addr, addrlen)',
);

// return engine funcs instead of runtime promise
replaceAll(
  'return moduleRtn',
  `
        return {
            Module,
            FS,
            HEAP32,
            HEAP16,
            HEAP8,
            HEAPU8,
            getValue,
            addFunction,
            removeFunction,
            start: () => {
                preInit();
                run();
            },
        };
    `,
);

await fs.writeFile('./lib/generated/xash.js', data);
