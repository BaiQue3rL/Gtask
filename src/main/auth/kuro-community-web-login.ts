import { randomUUID } from 'node:crypto'
import { BrowserWindow, screen } from 'electron'

const LOGIN_URL = 'https://www.kurobbs.com/mc/'
const TOKEN_POLL_INTERVAL_MS = 1_500
const TOKEN_BRIDGE_TIMEOUT_MS = 1_000

export async function requestKuroCommunityWebToken(
  parent: BrowserWindow | null
): Promise<string | null> {
  const loginWindow = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    title: '库街区官网登录',
    parent: parent ?? undefined,
    modal: Boolean(parent),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#f4f6f8',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      partition: `kuro-community-login-${randomUUID()}`
    }
  })

  loginWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  loginWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedKuroUrl(url)) event.preventDefault()
  })

  return await new Promise<string | null>((resolve, reject) => {
    let settled = false
    let polling = false
    let timer: ReturnType<typeof setInterval> | null = null

    const finish = (result: string | null): void => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      timer = null
      resolve(result)
      if (!loginWindow.isDestroyed()) loginWindow.close()
    }

    const poll = async (): Promise<void> => {
      if (settled || polling || loginWindow.isDestroyed()) return
      if (!isAllowedKuroUrl(loginWindow.webContents.getURL())) return
      polling = true
      try {
        const token = await loginWindow.webContents.executeJavaScript(
          buildTokenBridgeScript(),
          false
        ) as unknown
        if (typeof token === 'string' && token.trim()) finish(token.trim())
      } catch {
        // The official page may be navigating or rebuilding its login dialog.
      } finally {
        polling = false
      }
    }

    loginWindow.on('closed', () => finish(null))
    loginWindow.webContents.on('did-navigate', () => void poll())
    loginWindow.webContents.on('did-finish-load', () => void poll())
    loginWindow.webContents.on(
      'did-fail-load',
      (_event, code, description, url, isMainFrame) => {
        if (!isMainFrame || settled || code === -3) return
        settled = true
        if (timer) clearInterval(timer)
        reject(new Error(`库街区官网登录页加载失败（${code}：${description}，${url}）`))
        loginWindow.close()
      }
    )
    loginWindow.once('ready-to-show', () => {
      centerWindow(loginWindow, parent)
      loginWindow.show()
    })

    timer = setInterval(() => void poll(), TOKEN_POLL_INTERVAL_MS)
    void loginWindow.loadURL(LOGIN_URL).catch((error) => {
      if (settled) return
      settled = true
      if (timer) clearInterval(timer)
      reject(error)
      loginWindow.close()
    })
  })
}

function buildTokenBridgeScript(): string {
  return `(() => new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', receive);
      window.clearTimeout(timeout);
      resolve(value);
    };
    const receive = (event) => {
      if (event.origin !== window.location.origin || event.data?.code !== 20000) return;
      const token = event.data?.data?.accessToken;
      finish(typeof token === 'string' && token.trim() ? token.trim() : null);
    };
    window.addEventListener('message', receive);
    const timeout = window.setTimeout(() => finish(null), ${TOKEN_BRIDGE_TIMEOUT_MS});
    window.postMessage({ code: 10000 }, window.location.origin);
  }))()`
}

function isAllowedKuroUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && (
      url.hostname === 'kurobbs.com' ||
      url.hostname.endsWith('.kurobbs.com') ||
      url.hostname === 'kurogame.com' ||
      url.hostname.endsWith('.kurogame.com') ||
      url.hostname === 'kurogame.net' ||
      url.hostname.endsWith('.kurogame.net')
    )
  } catch {
    return false
  }
}

function centerWindow(window: BrowserWindow, parent: BrowserWindow | null): void {
  const windowBounds = window.getBounds()
  const anchorBounds = parent && !parent.isDestroyed()
    ? parent.getBounds()
    : screen.getPrimaryDisplay().workArea
  const workArea = screen.getDisplayMatching(anchorBounds).workArea
  window.setPosition(
    Math.min(
      Math.max(
        Math.round(anchorBounds.x + (anchorBounds.width - windowBounds.width) / 2),
        workArea.x
      ),
      workArea.x + workArea.width - windowBounds.width
    ),
    Math.min(
      Math.max(
        Math.round(anchorBounds.y + (anchorBounds.height - windowBounds.height) / 2),
        workArea.y
      ),
      workArea.y + workArea.height - windowBounds.height
    )
  )
}
