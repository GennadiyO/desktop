import { BrowserWindow, ipcMain, app } from 'electron'
import { Emitter, Disposable } from 'event-kit'
import { logDebug, logError } from '../lib/logging/main'
import { ICrashDetails, ErrorType } from '../crash/shared'
import { registerWindowStateChangedEvents } from '../lib/window-state'

const minWidth = 600
const minHeight = 500

export class CrashWindow {
  private readonly window: Electron.BrowserWindow
  private readonly emitter = new Emitter()
  private readonly errorType: ErrorType
  private readonly error: Error

  private hasFinishedLoading = false
  private hasSentReadyEvent = false

  public constructor(errorType: ErrorType, error: Error) {
    const windowOptions: Electron.BrowserWindowOptions = {
      width: minWidth,
      height: minHeight,
      minWidth: minWidth,
      minHeight: minHeight,
      show: false,
      // This fixes subpixel aliasing on Windows
      // See https://github.com/atom/atom/commit/683bef5b9d133cb194b476938c77cc07fd05b972
      backgroundColor: '#fff',
      webPreferences: {
        // Disable auxclick event
        // See https://developers.google.com/web/updates/2016/10/auxclick
        disableBlinkFeatures: 'Auxclick',
        // Explicitly disable experimental features for the crash process
        // since, theoretically it might be these features that caused the
        // the crash in the first place. As of writing we don't use any
        // components that relies on experimental features in the crash
        // process but our components which relies on ResizeObserver should
        // be able to degrade gracefully.
        experimentalFeatures: false,
      },
    }

    if (__DARWIN__) {
      windowOptions.titleBarStyle = 'hidden'
    } else if (__WIN32__) {
      windowOptions.frame = false
    }

    this.window = new BrowserWindow(windowOptions)
    this.error = error
    this.errorType = errorType
  }

  public load() {
    logDebug('Starting crash process')

    // We only listen for the first of the loading events to avoid a bug in
    // Electron/Chromium where they can sometimes fire more than once. See
    // See
    // https://github.com/desktop/desktop/pull/513#issuecomment-253028277. This
    // shouldn't really matter as in production builds loading _should_ only
    // happen once.
    this.window.webContents.once('did-start-loading', () => {
      logDebug('Crash process in startup')
    })

    this.window.webContents.once('did-finish-load', () => {
      logDebug('Crash process started')
      if (process.env.NODE_ENV === 'development') {
        this.window.webContents.openDevTools()
      }

      this.hasFinishedLoading = true
      this.maybeEmitDidLoad()
    })

    this.window.webContents.on('did-finish-load', () => {
      this.window.webContents.setVisualZoomLevelLimits(1, 1)
    })

    this.window.webContents.on('did-fail-load', () => {
      logError('Crash process failed to load')
      if (__DEV__) {
        this.window.webContents.openDevTools()
        this.window.show()
      } else {
        this.emitter.emit('did-fail-load', null)
      }
    })

    ipcMain.on('crash-ready', (event: Electron.IpcMainEvent) => {
      logDebug(`Crash process is ready`)

      this.hasSentReadyEvent = true

      this.sendError()
      this.maybeEmitDidLoad()
    })

    ipcMain.on('crash-quit', (event: Electron.IpcMainEvent) => {
      logDebug('Got quit signal from crash process')

      if (!__DEV__) {
        app.relaunch()
      }

      app.quit()
    })

    registerWindowStateChangedEvents(this.window)

    this.window.loadURL(`file://${__dirname}/crash.html`)
  }

  /**
   * Emit the `onDidLoad` event if the page has loaded and the renderer has
   * signalled that it's ready.
   */
  private maybeEmitDidLoad() {
    if (this.hasFinishedLoading && this.hasSentReadyEvent) {
      this.emitter.emit('did-load', null)
    }
  }

  public onClose(fn: () => void) {
    this.window.on('closed', fn)
  }

  public onFailedToLoad(fn: () => void) {
    this.emitter.on('did-fail-load', fn)
  }

  /**
   * Register a function to call when the window is done loading. At that point
   * the page has loaded and the renderer has signalled that it is ready.
   */
  public onDidLoad(fn: () => void): Disposable {
    return this.emitter.on('did-load', fn)
  }

  public focus() {
    this.window.focus()
  }

  /** Show the window. */
  public show() {
    logDebug('Showing crash process window')
    this.window.show()
  }

  /** Report the error to the renderer. */
  private sendError() {
    // `Error` can't be JSONified so it doesn't transport nicely over IPC. So
    // we'll just manually copy the properties we care about.
    const friendlyError = {
      stack: this.error.stack,
      message: this.error.message,
      name: this.error.name,
    }

    const details: ICrashDetails = {
      type: this.errorType,
      error: friendlyError,
    }

    this.window.webContents.send('error', details)
  }

  public destroy() {
    this.window.destroy()
  }
}
