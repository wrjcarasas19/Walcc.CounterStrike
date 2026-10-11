export type FS = {
    mkdir(path: string): void
    mkdirTree(path: string): void
    writeFile(path: string, data: Uint8Array): void
    chdir(path: string): void
}

export type Module = {
    ccall: (
        ident: string,
        returnType: 'number' | 'string' | null,
        argTypes: Array<'number' | 'string'>,
        args: Array<number | string>
    ) => number | string | void
    arguments?: string[]
    canvas: HTMLCanvasElement
    ctx: WebGL2RenderingContext | CanvasRenderingContext2D | null
    dynamicLibraries?: string[]
    onRuntimeInitialized?: () => void
    recvfrom?: (sockfd: number, buf: number, len: number, flags: number, src_addr: number, addrlen: number) => number
    sendto?: (sockfd: number, packets: number, sizes: number, packet_count: number, seq_num: number, to: number, to_len: number) => number
    locateFile?: (path: string) => string
    [key: string]: unknown
}

export type Em = {
    Module: Module
    FS: FS
    start: () => void
    HEAP32: Int8Array
    HEAP16: Int8Array
    HEAP8: Int8Array
    HEAPU8: Int8Array
    addFunction: (func: (...params: any[]) => unknown, args: string) => number
    removeFunction: (ptr: number) => void
    getValue: (
        ptr: number,
        type: 'i8' | 'u8' | 'i16' | 'u16' | 'i32' | 'u32' | 'i64' | 'u64' | 'float' | 'double' | '*'
    ) => number
}

const Xash: (moduleArg?: Partial<Module>) => Promise<Em>
export default Xash
