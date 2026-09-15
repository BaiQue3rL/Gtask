# Canonical map catalog maintenance

The current workflow is defined in `docs/catalog-maintenance.md`. This guide adds the map-specific requirements. It applies to the audited workspace; installed clients may have older protocol capabilities.

## Public ownership and source

Maps contain official names, stable identities, and hierarchy only. Personal interfaces may update progress on uniquely matched public rows; they cannot create or rename nodes, change parents, or override the catalog. Region groups display completed/open-catalog child counts, not an averaged exploration percentage. Personal region percentages remain separate reference data; they never override the group's child-based completion or filtering. Missing progress blocks completion, and newly published open children reopen the group without resetting previous child progress.

New map additions, corrections, and retirements go through verified deltas compiled into `updates/catalog.json`. The application embeds that exact publication, and remote updates consume it too. Do not edit a player's SQLite database or duplicate every change in TypeScript.

`src/main/sync/map-catalog.ts` is the frozen initial inventory and compatibility seed. `stableKey()` and its historical aliases explain existing identities, but a new publication supplies explicit remoteKey values. Preserve each published remoteKey on a rename or parent correction; no new hash or alias is needed merely to rename a published JSON row. Do not rewrite the legacy seed verification timestamp to claim a new complete audit.

## Games and hierarchy

| Game | gameId |
| --- | --- |
| 原神 | genshin |
| 崩坏：星穹铁道 | star-rail |
| 绝区零 | zenless |
| 鸣潮 | wuthering-waves |

There are exactly two levels:

- `region`: first-level region, without a parent.
- `subregion`: exactly one verified region parent, specified by parentRemoteKey.

There is no third level or independent-map node type. A scene, dungeon, chest, achievement, or repeatable entrance does not by itself prove independent exploration progress. 鸣潮“玄元境” has no independent exploration percentage and must stay out (user clarification, 2026-09-05).

For a region with no catalog children, the renderer shows a same-name second-level self row, backed by the original region's progress and completion action. This is a view projection, not an additional public map: never publish a duplicate row merely to reproduce it. The region shows `0/1` or `1/1`; a later publication of real children replaces the self row. This applies to every game, including 原神“空之神殿”.

Examples: 璃月 → 沉玉谷/层岩巨渊·地下矿区; 匹诺康尼 → 黄金的时刻/筑梦边境; 瑝珑 → 今州城/云陵谷. If reliable sources do not establish the parent or independent progress eligibility, retain the candidate in research records without guessing.

## Verified delta workflow

1. Read the current public inventory with `pnpm catalog:check --inventory` after building. Existing MCP jobs also provide matchCandidates and sanitized observations. Inspect the full requested game's map scope, not only names already present.
2. Prefer official localized map navigation, community map/battle-record structure, version pages, or user-provided images of official interfaces. Cross-check incomplete sources; a search snippet alone cannot establish a parent relationship. Keep official Simplified Chinese names for the Chinese catalog.
3. Prepare only actual additions, corrections, or explicit retirements. Preserve stable keys and verify each parent dependency; include a newly added parent with its children in the same batch. No progress, completion, account IDs, credentials, placeholders, or inferred third level.
4. Compile the delta against `updates/catalog.json`, review the resulting diff, and preserve all prior retirement decisions. Missing rows in a delta do not mean deletion. Record the affected game's full-scope verification time and sources in the maintenance report; publication time describes the actual changed facts.
5. Validate using the real consumer. The same batch must remain legal on top of the existing catalog; an orphan, duplicate identity, or retired parent must fail without partial writes.

A public subregion row has `remoteKey`, `category: exploration`, `mapNodeKind: subregion`, `title`, `parentRemoteKey`, and `sourceUrl`; parentTitle is optional display metadata. A region uses mapNodeKind: region and has no parentRemoteKey. Keep deliberate display order where an explicit order exists; never change an identity just to move or rename a row.

## Required verification and report

Run `pnpm exec vitest run tests/map-catalog.test.ts tests/map-catalog-freshness.test.ts`, `pnpm typecheck`, `pnpm test`, and, for publication preparation, `pnpm build` followed by `pnpm catalog:check`. Add a consumer regression for a changed published identity or hierarchy when it exercises a new case. Use temporary databases; never clear a user's data for verification.

Report the game and concrete changes, stable identity preservation, evidence types and unresolved coverage, checks actually completed, and whether a publication or package was actually delivered. Do not present a commit, online feed, mirror, or client receipt as interchangeable evidence.
