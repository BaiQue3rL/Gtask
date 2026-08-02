# AI-only guide: maintaining the canonical map catalog

This guide is written for a future AI task. The user should be able to say, for example, “校准星铁的基准地图清单” without explaining the repository layout again.

## Goal and authority boundary

The bundled catalog is the canonical public map inventory used to create an immediate, deterministic checklist. It contains **names and hierarchy only**. It must never contain or overwrite a user's exploration percentage, completion state, account ID, provider ID, Cookie, Token, or other personal data.

Personal synchronization binds official provider IDs and progress to canonical rows later. Codex is used only for uncertain increments, renames, or parent corrections; application code executes validated changes.

## Files to inspect and edit

Primary source:

- `src/main/sync/map-catalog.ts`
  - `MAP_CATALOGS`: canonical names and parent/child hierarchy.
  - `MAP_CATALOG_VERIFIED_AT`: last evidence-backed verification time for each game.
  - `stableKey()`: stable machine identities.

Relevant behavior and contracts:

- `src/main/sync/map-catalog-freshness.ts`: decides when a future Codex incremental audit is needed.
- `src/main/sync/interface-contract.ts`: tells Codex that existing `matchCandidates` are the verified baseline and that only increments/corrections should be submitted.
- `tests/map-catalog.test.ts`: hierarchy, uniqueness, representative parents, and stable-key regression tests.
- `tests/map-catalog-freshness.test.ts`: version-boundary and age-based audit behavior.

Do not edit SQLite directly to maintain the baseline. Database rows are runtime state, not the source of truth for a shipped baseline.

## Game identifiers

| Game | `GameId` |
| --- | --- |
| 原神 | `genshin` |
| 崩坏：星穹铁道 | `star-rail` |
| 绝区零 | `zenless` |
| 鸣潮 | `wuthering-waves` |

## Required hierarchy

The catalog has exactly two levels:

1. `region`: a first-level main region with no parent.
2. `subregion`: a second-level location belonging to exactly one `region`.

There is no third level and no special “independent map” type. Underground areas, isolated spaces, special entrances, and instance-like explorable maps still appear as `subregion` under their verified first-level main region.

Examples:

- 原神：`璃月` is a `region`; `沉玉谷` and `层岩巨渊·地下矿区` are its `subregion` entries.
- 星铁：`匹诺康尼` is a `region`; its concrete explorable locations are `subregion` entries.
- 鸣潮：`瑝珑` is a `region`; `今州城` and `云陵谷` are its `subregion` entries.

If reliable sources do not establish whether a place is a first-level main region or which parent it belongs to, do not guess. Continue cross-checking or report the unresolved item to the user without writing it.

## Data format

Edit only the affected entry inside `MAP_CATALOGS`:

```ts
const MAP_CATALOGS: Record<GameId, readonly MapRegionDefinition[]> = {
  'star-rail': [
    {
      title: '匹诺康尼',
      subregions: [
        '黄金的时刻',
        '筑梦边境'
      ]
    }
  ]
}
```

Rules:

- Use the official localized name for the application's current output language; the bundled Chinese catalog uses official Simplified Chinese names. Do not translate an English source yourself.
- Preserve a deliberate, user-readable region and subregion order. New version content normally belongs near the newest related region, not at an arbitrary hash/alphabetical position.
- Do not duplicate a place under multiple parents.
- Do not add placeholder, “未知”, progress, completion, time-window, or personal-ID fields to `MapRegionDefinition`.

## Evidence and research workflow

1. Read the current game entry in `MAP_CATALOGS` before searching.
2. Prefer official localized map navigation, official community battle-record/map pages, official version pages, or user-provided screenshots of those official interfaces.
3. When an official source is incomplete, cross-check established wikis or guide communities. A single search snippet is not sufficient evidence for a parent relationship.
4. Compare the verified inventory with the current baseline and make the smallest additive or corrective edit. Do not rebuild unchanged games.
5. Update only the affected game's `MAP_CATALOG_VERIFIED_AT` after the whole affected catalog has been checked, using an ISO-8601 timestamp with `Z` or an explicit UTC offset.

## Stable identity after the first public release

`stableKey()` hashes the game, node kind, parent identity, and title. A simple rename would otherwise create a new machine identity and could detach existing provider bindings or progress.

Gtask 1.0 的首发基准尚未对外发布，因此当前目录不保留封闭测试版本的拼写别名。首个公开版本发布后，如果修正一个已经发布的标题，需要在 `stableKey()` 中增加别名，把**新 identity 映射到旧发布 identity**后再改显示名称。对于二级地区：

```ts
['game-id\0subregion\0Parent\0Corrected Name', 'Parent\0Old Shipped Name']
```

Then add or extend a regression assertion in `tests/map-catalog.test.ts` proving that the corrected display name still hashes to the old key. For a new, never-shipped entry, no legacy alias is needed.

Never change a parent merely to retain a key. If the verified parent was wrong, correct the hierarchy and explicitly assess whether existing bindings need a migration or legacy mapping.

## Required validation

Run, in order:

1. `pnpm exec vitest run tests/map-catalog.test.ts tests/map-catalog-freshness.test.ts`
2. `pnpm typecheck`
3. `pnpm test`

Run `pnpm build` as well when preparing a new trial/release package. Do not clear the user's database just to test a baseline edit unless the user explicitly requests a clean-state test.

## Completion report

Tell the user:

- which game and regions changed;
- whether any shipped stable key needed preservation;
- which evidence types were used;
- which checks passed;
- whether a new application/plugin package was produced.

Do not expose internal chain-of-thought, credentials, account identifiers, or unrelated project files.
