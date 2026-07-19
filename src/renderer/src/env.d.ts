import type { GachaApi } from '../../shared/contracts'

declare global {
  interface Window {
    gacha: GachaApi
  }
}

export {}
