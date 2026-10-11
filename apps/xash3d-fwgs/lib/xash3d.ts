import Xash, { Em, Module } from './generated/xash'
import { Net } from "./net";
import {
    DEFAULT_CLIENT_LIBRARY,
    DEFAULT_SOFT_LIBRARY,
    DEFAULT_FILESYSTEM_LIBRARY,
    DEFAULT_MENU_LIBRARY,
    DEFAULT_SERVER_LIBRARY,
    DEFAULT_GLES3COMPAT_LIBRARY,
    DEFAULT_XASH_LIBRARY
} from './constants'

/**
 * Rendering library options.
 */
export type RenderLibrariesOptions = {
    soft?: string
    gles3compat?: string
}

/**
 * Configuration paths for libraries used by the engine.
 */
export type LibrariesOptions = {
    filesystem?: string
    server?: string
    menu?: string
    client?: string
    xash?: string
    render?: RenderLibrariesOptions
}

/**
 * Renderer types supported by Xash3D.
 */
export type Xash3DRenderer = 'gles3compat' | 'soft'

/**
 * Configuration options for the Xash3D instance.
 */
export type Xash3DOptions = {
    canvas?: HTMLCanvasElement
    renderer?: Xash3DRenderer
    filesMap?: Record<string, string>
    libraries?: LibrariesOptions
    dynamicLibraries?: string[]
    module?: Partial<Module>
}

/**
 * Xash3D WebAssembly engine wrapper for running and controlling the game engine.
 */
export class Xash3D {
    /** User-defined configuration options */
    opts: Xash3DOptions

    /** Optional networking interface */
    net?: Net

    private _exited = false

    /** Indicates whether the engine has exited */
    public get exited() {
        return this._exited;
    }

    private set exited(value: boolean) {
        this._exited = value;
    }

    private _running = false

    /** Indicates whether the engine is currently running */
    public get running() {
        return this._running;
    }

    private set running(value: boolean) {
        this._running = value;
    }

    /** Internal Emscripten interface */
    em?: Em

    /** Promise used to track module initialization */
    private emPromise?: Promise<void>

    /**
     * Creates a new instance of the Xash3D engine.
     * @param opts - Engine configuration options
     */
    constructor(opts: Xash3DOptions = {}) {
        this.opts = opts;
    }

    /**
     * Executes a command string within the engine.
     * @param cmd - The command string to execute
     */
    Cmd_ExecuteString(cmd: string) {
        this.em?.Module?.ccall(
            'Cmd_ExecuteString',
            null,
            ['string'],
            [cmd]
        )
    }

    /**
     * Quits the engine by executing the `quit` command.
     */
    Sys_Quit() {
        this.Cmd_ExecuteString('quit')
    }

    /**
     * Initializes the engine asynchronously.
     * Awaits module setup and exits immediately if flagged.
     */
    async init() {
        if (!this.emPromise) {
            this.emPromise = this.runEm()
        }
        await this.emPromise
        if (this.exited) {
            this.Sys_Quit()
            return
        }
    }

    /**
     * Starts the main engine loop, if not already running or exited.
     */
    main() {
        if (!this.em || this.running || this.exited) return
        this.running = true
        this.em.start()
    }

    /**
     * Gracefully quits the engine, if running.
     */
    quit() {
        if (this.exited || !this.running) return
        this.exited = true;
        this.running = false;
        this.Sys_Quit()
    }

    /**
     * Maps a given file path using the configured `filesMap`.
     * @param path - The original path
     * @returns Mapped path or original
     */
    private locateFile(path: string) {
        return this.opts.filesMap![path] ?? path
    }

    /**
     * Initializes rendering context and injects render-specific dynamic libraries.
     * @param canvas - HTMLCanvasElement used for rendering
     * @param render - Renderer type to initialize
     * @returns WebGL2RenderingContext or `null` for software rendering
     */
    private initRender(canvas?: HTMLCanvasElement, render: Xash3DOptions['renderer'] = 'gles3compat') {
        switch (render) {
            case 'gles3compat':
                if (this.opts?.libraries?.render?.gles3compat) {
                    this.opts.filesMap![DEFAULT_GLES3COMPAT_LIBRARY] = this.opts.libraries.render.gles3compat
                }
                this.opts.dynamicLibraries!.push(DEFAULT_GLES3COMPAT_LIBRARY)
                return canvas?.getContext('webgl2', {
                    alpha: false,
                    depth: true,
                    stencil: true,
                    antialias: true,
                }) ?? null
            default:
                if (this.opts?.libraries?.render?.soft) {
                    this.opts.filesMap![DEFAULT_SOFT_LIBRARY] = this.opts.libraries.render.soft
                }
                this.opts.dynamicLibraries!.push(DEFAULT_SOFT_LIBRARY)
                return null
        }
    }

    /**
     * Sets the path for a specific core engine library, if provided.
     * @param library - The name of the library to initialize
     * @param defaultPath - The default path to use if not overridden
     */
    initLibrary(library: keyof Omit<LibrariesOptions, 'render'>, defaultPath: string) {
        if (this.opts.libraries?.[library]) {
            this.opts.filesMap![defaultPath] = this.opts.libraries[library]
        }
    }

    /**
     * Internal method to initialize and run the WebAssembly module.
     * Loads dynamic libraries, sets up canvas and rendering, and connects networking.
     */
    private async runEm() {
        if (!this.opts.filesMap) {
            this.opts.filesMap = {}
        }
        if (!this.opts.dynamicLibraries) {
            this.opts.dynamicLibraries = []
        }

        this.initLibrary('filesystem', DEFAULT_FILESYSTEM_LIBRARY)
        this.initLibrary('client', DEFAULT_CLIENT_LIBRARY)
        this.initLibrary('server', DEFAULT_SERVER_LIBRARY)
        this.initLibrary('menu', DEFAULT_MENU_LIBRARY)
        if (this.opts.libraries?.xash) {
            this.opts.filesMap[DEFAULT_XASH_LIBRARY] = this.opts.libraries.xash
        }

        const canvas = this.opts?.canvas;
        const ctx = this.initRender(canvas, this.opts.renderer)
        const dynamicLibraries = [
            DEFAULT_FILESYSTEM_LIBRARY,
            DEFAULT_MENU_LIBRARY,
            DEFAULT_SERVER_LIBRARY,
            DEFAULT_CLIENT_LIBRARY,
            ...this.opts.dynamicLibraries,
        ]
        this.em = await Xash({
            canvas,
            ctx,
            dynamicLibraries,
            sendto: this.net?.sendto,
            recvfrom: this.net?.recvfrom,
            locateFile: path => this.locateFile(path),
            ...(this.opts.module ?? {}),
        })
        if (this.net) {
            this.net.init(this.em)
        }
    }
}
