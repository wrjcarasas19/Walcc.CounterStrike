// Lets node resolve the client's extensionless relative imports ("./cvars")
// to .ts files, for smoke tests of modules that import other modules:
// node --experimental-strip-types --import <this file> smoke-x.mts
import { register } from 'node:module';
register(
  'data:text/javascript,export async function resolve(s, c, next) { try { return await next(s, c); } catch (e) { if (s.startsWith(".") && !s.endsWith(".ts")) return next(s + ".ts", c); throw e; } }'
);
