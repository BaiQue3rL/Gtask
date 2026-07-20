import { createElectronNetFetcher, type ChromiumNetFetch } from './electron-net-fetcher'
import {
  PublicScheduleDocumentAdapter,
  type PublicScheduleDocumentAdapterOptions
} from './public-schedule-document'
import {
  createPublicScheduleHttpLoader,
  type PublicScheduleHttpOptions
} from './public-schedule-http'

export interface ElectronPublicScheduleAdapterOptions
  extends Omit<PublicScheduleHttpOptions, 'fetcher'> {
  document?: PublicScheduleDocumentAdapterOptions
}

export function createElectronPublicScheduleAdapter(
  netFetch: ChromiumNetFetch,
  options: ElectronPublicScheduleAdapterOptions
): PublicScheduleDocumentAdapter {
  const loadDocument = createPublicScheduleHttpLoader({
    ...options,
    fetcher: createElectronNetFetcher(netFetch)
  })
  return new PublicScheduleDocumentAdapter(loadDocument, options.document)
}
