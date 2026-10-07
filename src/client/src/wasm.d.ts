declare module '*.wasm?url' {
  const url: string;
  export default url;
}

declare module '*.so?url' {
  const url: string;
  export default url;
}

/** The cs16-client package version, from vite.config.ts. */
declare const __CS16_CLIENT_VERSION__: string;
