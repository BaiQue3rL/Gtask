export type ChromiumNetFetch = (
  input: string | Request,
  init?: RequestInit & { bypassCustomProtocolHandlers?: boolean }
) => Promise<Response>

/**
 * Adapts Electron net.fetch to the standard fetch signature expected by sync loaders.
 * The caller supplies net.fetch after app.whenReady(), keeping this module unit-testable.
 */
export function createElectronNetFetcher(netFetch: ChromiumNetFetch): typeof fetch {
  return async (input, init) => {
    const normalizedInput = input instanceof URL ? input.toString() : input
    return netFetch(normalizedInput, {
      ...init,
      // Schedule sources must always use Chromium's built-in HTTPS handling.
      bypassCustomProtocolHandlers: true
    })
  }
}
