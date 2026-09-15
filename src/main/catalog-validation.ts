import { AppDatabase } from './database'
import { parseRemoteCatalogFeed } from './remote-catalog-update'

/** Uses the actual consumer against an isolated database, never the player's data. */
export function validateCatalogPublication(input: unknown, options: { inventory?: boolean } = {}) {
  const feed = parseRemoteCatalogFeed(input)
  const database = new AppDatabase(':memory:')
  try {
    const applied = database.applyRemoteCatalogFeed(feed)
    return {
      revision: feed.revision,
      schemaVersion: feed.schemaVersion,
      games: feed.games.map((game) => ({ gameId: game.gameId,
        upserts: game.upserts.length, archives: game.archives.length,
        versionException: Boolean(game.versionWindow), scheduleUpdates: game.scheduleUpdates?.length ?? 0,
        deadlineReviews: database.listDeadlineReviews(game.gameId) })),
      ...(options.inventory ? { inventory: database.listGames().map((game) => ({ gameId: game.id,
        items: database.listChecklistItems(game.id, { source: 'public_schedule' }).map((item) => ({
          remoteKey: item.remoteKey, title: item.title, category: item.category, activityTags: item.activityTags,
          startsAt: item.startsAt, endsAt: item.endsAt, periodKey: item.periodKey, modeKey: item.modeKey,
          mapNodeKind: item.mapNodeKind, parentRemoteKey: item.parentRemoteKey, parentTitle: item.parentTitle, sourceUrl: item.sourceUrl
        })), schedules: database.listPublishedSchedules(game.id) })) } : {}),
      applied,
      receipt: database.getRemoteCatalogReceipt()
    }
  } finally { database.close() }
}
