---
name: sync-gacha-schedules
description: "Use the local Gtask MCP to read checklists and safely refresh verified public schedules or map catalogs for enabled games. Trigger when the user asks to refresh, research, verify, or synchronize public events, recurring modes, version times, exploration regions, or other public data in Gtask."
---

# Sync Gacha Schedules

Use only the `gacha_task_manager` MCP tools for application data. Do not run shell commands, edit SQLite directly, or read browser cookies.

## Public-data jobs

1. Register with `register_gacha_schedule_agent` using a stable Agent ID, `webSearch: true`, and `protocolVersion: "2026-07-31.1"`. If the application reports an incompatible protocol, stop and ask the user to update the Gtask plugin instead of continuing with partial fields.
2. Claim one job with `claim_gacha_schedule_job`. If the result is `null`, stop successfully; authenticated personal progress is handled locally by Gtask adapters and is not an Agent task.
3. Read `job.contract` before searching. It is the authoritative machine-readable description of:
   - the requested section and inventory scope;
   - the requested output locale and user timezone;
   - required, conditional, and forbidden fields;
   - field meanings and completion criteria.
   Do not recreate those requirements from this skill or from title heuristics.
4. Follow `job.contract.workflow`: establish the requested inventory, research every required field, verify the result, match it against `matchCandidates`, then submit it. When an exploration contract declares `matchCandidates` to be the complete verified baseline, audit only additions, official renames, or parent corrections and do not resubmit unchanged map nodes; an empty `items` submission is valid when the audit finds no change. Use `activityTagTargets` as an additional bounded update list when present.
5. Use Codex native web search autonomously. Choose queries, source order, parallelism, and follow-up searches from the evidence returned. Prefer official localized sources matching `job.contract.requestContext.outputLocale` when they answer the question, but freely broaden to publisher communities, official APIs/maps, established game wikis, guide communities, and other useful sources when official pages are incomplete. Cross-check uncertain community-only facts.
6. Confirm official localized in-game names for `job.contract.requestContext.outputLocale`; do not translate names yourself. Convert source times into absolute ISO-8601 instants using the source server's timezone and DST rules. Use `requestContext.userTimeZone` only for the user's requested display/interpretation context.
7. Decide semantic identity yourself. When a result is the same item as a `matchCandidates` entry, submit that exact `itemId` as `matchItemId`; omit it only for a genuinely new item. Use `archiveItems` only for a supplied synchronized candidate that is positively verified as wrong, duplicated, or obsolete—never merely because one source omitted it.
8. Keep user-visible progress truthful with `update_gacha_schedule_job_progress` at every material phase. Include real `current` and `total` values when known.
9. Submit through `apply_gacha_public_schedule`, setting `contentLocale` exactly to `job.contract.requestContext.outputLocale`. Treat its schema as the transport field superset and `job.contract` as the target-specific requirement source. Inspect `job.status` and `remainingTargets`; continue the same job until it completes. Submit verified sections as they become ready so one incomplete section does not discard other results.
10. Use `fail_gacha_schedule_job` only after useful searches and cross-checks for the remaining contract scope are genuinely exhausted. Never leave a claimed job unfinished.

## Safety

- Public-data jobs must not submit completion state or exploration progress.
- Event jobs must only submit the categories allowed by the current contract; Gtask's activity section accepts limited-time events only.
- Use dedicated synchronization tools instead of generic checklist writes.
- Never attempt to merge public jobs with authenticated `personal_sync` rows. Public-job candidates contain only `public_schedule` rows.
- Preserve manual items, fixed tasks, fixed weekly items, and custom checklists.
- Codex owns business decisions; MCP tools only enforce field types, record identity, transaction integrity, authorization scope, and protected manual-data boundaries.
