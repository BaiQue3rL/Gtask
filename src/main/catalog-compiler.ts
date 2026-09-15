import { parseRemoteCatalogFeed, type RemoteCatalogFeed, type RemoteCatalogGameUpdate } from './remote-catalog-update'
import { validateCatalogPublication } from './catalog-validation'

/** Compose verified facts by stable identity; never infer deletions from absence. */
export function compileCatalogDelta(baseInput: unknown, deltaInput: unknown) {
  const base = parseRemoteCatalogFeed(baseInput)
  const delta = parseRemoteCatalogFeed(deltaInput)
  const games = new Map(base.games.map((game) => [game.gameId, structuredClone(game)]))
  let changed = false
  for (const incoming of delta.games) {
    const previous = games.get(incoming.gameId)
    const game: RemoteCatalogGameUpdate = previous ?? { gameId: incoming.gameId, upserts: [], archives: [] }
    const before = JSON.stringify(game)
    const items = new Map(game.upserts.map((item) => [item.remoteKey, item]))
    const archives = new Set(game.archives)
    for (const item of incoming.upserts) { items.set(item.remoteKey, item); archives.delete(item.remoteKey) }
    for (const key of incoming.archives) { items.delete(key); archives.add(key) }
    game.upserts = [...items.values()]
    game.archives = [...archives]
    if (incoming.versionWindow) game.versionWindow = incoming.versionWindow
    const scheduleId = (record: { kind: string; key: string }) => `${record.kind}:${record.key}`
    const schedules = new Map((game.scheduleUpdates ?? []).map((record) => [scheduleId(record), record]))
    const retired = new Map((game.scheduleArchives ?? []).map((record) => [scheduleId(record), record]))
    for (const record of incoming.scheduleUpdates ?? []) { schedules.set(scheduleId(record), record); retired.delete(scheduleId(record)) }
    for (const record of incoming.scheduleArchives ?? []) { schedules.delete(scheduleId(record)); retired.set(scheduleId(record), record) }
    if (schedules.size || game.scheduleUpdates) game.scheduleUpdates = [...schedules.values()]
    if (retired.size || game.scheduleArchives) game.scheduleArchives = [...retired.values()]
    if (JSON.stringify(game) !== before) changed = true
    games.set(game.gameId, game)
  }
  if (changed && Date.parse(delta.publishedAt) <= Date.parse(base.publishedAt)) throw new Error('有事实变化时必须使用更新的发布时间')
  if (changed && delta.revision === base.revision) throw new Error('有事实变化时必须使用新的清单修订')
  const feed: RemoteCatalogFeed = changed ? parseRemoteCatalogFeed({
    schemaVersion: Math.max(base.schemaVersion, delta.schemaVersion), revision: delta.revision,
    publishedAt: delta.publishedAt, games: [...games.values()]
  }) : base
  return { changed, feed, validation: validateCatalogPublication(feed) }
}
