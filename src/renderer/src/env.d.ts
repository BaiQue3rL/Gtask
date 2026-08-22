import type { GtaskApi } from '../../shared/contracts'

declare global {
  interface Window {
    gtask: GtaskApi
  }
}

export {}
