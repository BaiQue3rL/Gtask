---
name: sync-gacha-schedules
description: "Use the local Gtask MCP to safely refresh verified public schedules or map catalogs and to enrich missing labels or time windows on authenticated personal checklists. Trigger when Gtask queues public-data research or bounded personal-metadata research."
---

# Sync Gacha Schedules

Use only the `gacha_task_manager` MCP tools for application data. Do not run shell commands, edit SQLite directly, or read browser cookies.

## Job routing

1. Register with `register_gacha_schedule_agent` using a stable Agent ID, `webSearch: true`, and `protocolVersion: "2026-08-01.1"`. If the application reports an incompatible protocol, stop and ask the user to update the Gtask plugin instead of continuing with partial fields.
2. Claim one job with `claim_gacha_schedule_job`. If the result is `null`, stop successfully.
3. Read `job.contract` before searching. It is the authoritative machine-readable description of:
   - the requested section and inventory scope;
   - the requested output locale and user timezone;
   - required, conditional, and forbidden fields;
   - field meanings and completion criteria.
   Do not recreate those requirements from this skill or from title heuristics.
4. Route by `job.jobKind`:
   - `public_catalog`: follow `job.contract.workflow`, establish the requested inventory, research every required field, verify, match against `matchCandidates`, and submit with `apply_gacha_public_schedule`. When an exploration contract declares a complete verified baseline, audit only additions, official renames, or parent corrections. Use `activityTagTargets` when present.
   - `personal_metadata`: inspect only `metadataTargets`, research every listed `missingFields`, and submit every target once with `apply_gacha_personal_metadata`. Do not establish an inventory, add, archive, rename, reclassify, or change completion/progress. If a requested time remains unknowable after useful cross-checks, include it in `unresolvedFields` with a reason; an unknowable activity tag must be the requested locale's “未知” equivalent instead.
5. Use Codex native web search autonomously. Choose queries, source order, parallelism, and follow-up searches from the evidence returned. Prefer official localized sources matching `job.contract.requestContext.outputLocale` when they answer the question, but freely broaden to publisher communities, official APIs/maps, established game wikis, guide communities, and other useful sources when official pages are incomplete. Cross-check uncertain community-only facts.
6. Confirm official localized in-game names for `job.contract.requestContext.outputLocale`; do not translate names yourself. Convert source times into absolute ISO-8601 instants using the source server's timezone and DST rules. Use `requestContext.userTimeZone` only for the user's requested display/interpretation context.
7. Decide semantic identity yourself. When a result is the same item as a `matchCandidates` entry, submit that exact `itemId` as `matchItemId`; omit it only for a genuinely new item. Use `archiveItems` only for a supplied synchronized candidate that is positively verified as wrong, duplicated, or obsolete—never merely because one source omitted it.
8. Keep user-visible progress truthful with `update_gacha_schedule_job_progress` at every material phase. Include real `current` and `total` values when known.
9. Submit through the tool selected by `job.jobKind`, setting `contentLocale` exactly to `job.contract.requestContext.outputLocale`. Treat the tool schema as transport and `job.contract` as the requirement source. For public jobs inspect `remainingTargets` and continue until completion.
10. Use `fail_gacha_schedule_job` only after useful searches and cross-checks for the remaining contract scope are genuinely exhausted. Never leave a claimed job unfinished.

## Safety

- Public-data jobs and personal-metadata jobs must not submit completion state or exploration progress.
- Event jobs must only submit the categories allowed by the current contract; Gtask's activity section accepts limited-time events only.
- Use dedicated synchronization tools instead of generic checklist writes.
- Never attempt to merge public jobs with authenticated `personal_sync` rows. Public-job candidates contain only `public_schedule` rows.
- Personal-metadata jobs may update only the exact existing `personal_sync` item IDs and fields named by `metadataTargets.missingFields`.
- Preserve manual items, fixed tasks, fixed weekly items, and custom checklists.
- Codex owns business decisions; MCP tools only enforce field types, record identity, transaction integrity, authorization scope, and protected manual-data boundaries.
