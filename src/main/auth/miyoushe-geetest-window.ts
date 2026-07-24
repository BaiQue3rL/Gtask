import { randomBytes } from 'node:crypto'
import { BrowserWindow, screen } from 'electron'
import type {
  MiyousheGeetestChallenge,
  MiyousheGeetestResult
} from '../sync/miyoushe-chronicle-client'

const COMPLETION_URL = 'gacha-verification://complete/'

export interface GeetestWindowCopy {
  title: string
  heading: string
  description: string
  apiServers?: string[]
  includeSessionUserInfo?: boolean
  showMethod?: 'showCaptcha' | 'showBox'
}

const MIYOUSHE_COPY: GeetestWindowCopy = {
  title: '米游社安全验证',
  heading: '米游社安全验证',
  description: '请手动完成官方滑块。应用只接收本次验证票据，不保存滑块内容。',
  apiServers: ['gcaptcha4.captchami.com'],
  includeSessionUserInfo: true,
  showMethod: 'showCaptcha'
}

export async function solveMiyousheGeetest(
  parent: BrowserWindow | null,
  challenge: MiyousheGeetestChallenge,
  copy: GeetestWindowCopy = MIYOUSHE_COPY
): Promise<MiyousheGeetestResult | null> {
  const verificationWindow = new BrowserWindow({
    width: 480,
    height: 620,
    minWidth: 420,
    minHeight: 540,
    title: copy.title,
    parent: parent ?? undefined,
    modal: Boolean(parent),
    autoHideMenuBar: true,
    show: false,
    backgroundColor: '#07152d',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  verificationWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  return await new Promise<MiyousheGeetestResult | null>((resolve, reject) => {
    let settled = false
    const finish = (result: MiyousheGeetestResult | null): void => {
      if (settled) return
      settled = true
      resolve(result)
      if (!verificationWindow.isDestroyed()) verificationWindow.close()
    }

    verificationWindow.on('closed', () => finish(null))
    verificationWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith(COMPLETION_URL)) {
        if (!url.startsWith('data:text/html')) event.preventDefault()
        return
      }
      event.preventDefault()
      try {
        const encoded = new URL(url).hash.slice(1)
        finish(parseResult(JSON.parse(decodeURIComponent(encoded))))
      } catch {
        finish(null)
      }
    })
    verificationWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || settled) return
      reject(new Error(`米游社验证窗口加载失败（${code}：${description}）`))
      settled = true
      verificationWindow.close()
    })
    verificationWindow.once('ready-to-show', () => {
      const windowBounds = verificationWindow.getBounds()
      const anchorBounds = parent && !parent.isDestroyed()
        ? parent.getBounds()
        : screen.getPrimaryDisplay().workArea
      const workArea = screen.getDisplayMatching(anchorBounds).workArea
      const unclampedX = Math.round(anchorBounds.x + (anchorBounds.width - windowBounds.width) / 2)
      const unclampedY = Math.round(anchorBounds.y + (anchorBounds.height - windowBounds.height) / 2)
      verificationWindow.setPosition(
        Math.min(Math.max(unclampedX, workArea.x), workArea.x + workArea.width - windowBounds.width),
        Math.min(Math.max(unclampedY, workArea.y), workArea.y + workArea.height - windowBounds.height)
      )
      verificationWindow.show()
    })

    const html = buildVerificationPage(challenge, copy)
    void verificationWindow.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`).catch((error) => {
      if (settled) return
      settled = true
      reject(error)
      verificationWindow.close()
    })
  })
}

function buildVerificationPage(
  challenge: MiyousheGeetestChallenge,
  copy: GeetestWindowCopy
): string {
  const nonce = randomBytes(16).toString('base64')
  const challengeJson = JSON.stringify(challenge).replaceAll('<', '\\u003c')
  const copyJson = JSON.stringify(copy).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' https://*.geetest.com https://*.geevisit.com https://*.gsensebot.com; connect-src https://*.geetest.com https://*.geevisit.com https://*.gsensebot.com https://*.captchami.com; img-src data: https://*.geetest.com https://*.geevisit.com https://*.gsensebot.com https://*.captchami.com; style-src 'unsafe-inline' https://*.geetest.com https://*.geevisit.com https://*.gsensebot.com; frame-src https://*.geetest.com https://*.geevisit.com https://*.gsensebot.com https://*.captchami.com">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(copy.title)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:28px;color:#dce9f8;background:linear-gradient(145deg,#0c213d,#07172e);font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif}.card{width:min(390px,100%);padding:24px;border:1px solid #36577d;border-radius:14px;background:rgba(7,23,46,.9);box-shadow:0 20px 60px rgba(0,0,0,.35)}h1{margin:0 0 8px;font-size:20px}p{margin:0 0 18px;color:#8da4bf}.status{margin-top:16px;color:#78acd9;font-size:12px}#captcha{min-height:44px}
  </style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(copy.heading)}</h1>
    <p>${escapeHtml(copy.description)}</p>
    <div id="captcha"></div>
    <div id="status" class="status">正在加载官方验证组件…</div>
  </main>
  <script nonce="${nonce}">
    const challenge = ${challengeJson};
    const copy = ${copyJson};
    const status = document.getElementById('status');
    const isV4 = challenge.version === 4;
    const scriptSources = isV4
      ? ['https://static.geetest.com/v4/gt4.js', 'https://static.geevisit.com/v4/gt4.js']
      : ['https://static.geetest.com/static/js/gt.0.5.0.js'];
    const loadInitializer = () => new Promise((resolve, reject) => {
      let index = 0;
      const next = () => {
        const current = isV4 ? window.initGeetest4 : window.initGeetest;
        if (typeof current === 'function') return resolve(current);
        if (index >= scriptSources.length) return reject(new Error('all sources failed'));
        const script = document.createElement('script');
        let finished = false;
        const finishAttempt = (loaded) => {
          if (finished) return;
          finished = true;
          window.clearTimeout(timeout);
          if (loaded) {
            const initializer = isV4 ? window.initGeetest4 : window.initGeetest;
            if (typeof initializer === 'function') return resolve(initializer);
          }
          script.remove();
          next();
        };
        script.src = scriptSources[index++];
        script.async = true;
        script.onload = () => finishAttempt(true);
        script.onerror = () => finishAttempt(false);
        const timeout = window.setTimeout(() => finishAttempt(false), 4000);
        document.head.appendChild(script);
      };
      next();
    });
    loadInitializer().then((initializer) => {
      const options = isV4 ? {
        captchaId: challenge.gt,
        riskType: challenge.riskType,
        ...(copy.includeSessionUserInfo
          ? { userInfo: JSON.stringify({ mmt_key: challenge.sessionId }) }
          : {}),
        ...(Array.isArray(copy.apiServers) && copy.apiServers.length
          ? { apiServers: copy.apiServers }
          : {}),
        product: 'bind',
        language: 'zh-cn'
      } : {
        gt: challenge.gt,
        challenge: challenge.challenge,
        new_captcha: Boolean(challenge.newCaptcha),
        offline: !Boolean(challenge.success),
        api_server: 'api.geetest.com',
        https: true,
        product: 'bind',
        lang: 'zh-cn'
      };
      initializer(options, (captcha) => {
        if (!isV4) captcha.appendTo('#captcha');
        captcha.onReady(() => {
          status.textContent = '请完成上方验证';
          if (!isV4) {
            captcha.verify();
          } else if (copy.showMethod === 'showBox' && typeof captcha.showBox === 'function') {
            captcha.showBox();
          } else if (typeof captcha.showCaptcha === 'function') {
            captcha.showCaptcha();
          } else if (typeof captcha.showBox === 'function') {
            captcha.showBox();
          } else {
            status.textContent = '官方验证组件没有提供可用的显示方法，请重试。';
          }
        });
        captcha.onSuccess(() => {
          const result = captcha.getValidate();
          if (!result) {
            status.textContent = '未取得验证结果，请重试。';
            return;
          }
          status.textContent = '验证成功，正在继续同步…';
          window.location.href = '${COMPLETION_URL}#' + encodeURIComponent(JSON.stringify({
            ...result,
            ...(isV4 && { version: 4 })
          }));
        });
        captcha.onError(() => { status.textContent = '验证加载失败，请关闭窗口后重试。'; });
      });
    }).catch(() => {
      status.textContent = '官方验证组件加载失败，请检查网络或代理后重试。';
    });
  </script>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function parseResult(value: unknown): MiyousheGeetestResult {
  if (typeof value !== 'object' || value === null) throw new Error('验证结果格式不正确')
  const record = value as Record<string, unknown>
  if (record.version === 4) {
    const result = {
      captcha_id: record.captcha_id,
      lot_number: record.lot_number,
      pass_token: record.pass_token,
      gen_time: record.gen_time,
      captcha_output: record.captcha_output
    }
    if (Object.values(result).some((item) => typeof item !== 'string' || !item.trim())) {
      throw new Error('Geetest V4 验证结果不完整')
    }
    return { ...result, version: 4 } as MiyousheGeetestResult
  }
  const result = {
    geetest_challenge: record.geetest_challenge,
    geetest_validate: record.geetest_validate,
    geetest_seccode: record.geetest_seccode
  }
  if (Object.values(result).some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('验证结果不完整')
  }
  return result as MiyousheGeetestResult
}
