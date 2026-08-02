---
name: sync-gacha-schedules
description: "Use the local Gtask MCP to safely refresh verified public schedules or map catalogs, resolve bounded exceptions in staged authenticated snapshots, and enrich missing personal metadata. Trigger when Gtask queues public-data research or bounded personal-data research."
---

# Sync Gacha Schedules

Use only the `gacha_task_manager` MCP tools for application data. Do not run shell commands, edit SQLite directly, or read browser cookies.

## Job routing

1. Register with `register_gacha_schedule_agent` using a stable Agent ID, `webSearch: true`, and `protocolVersion: "2026-08-02.2"`. If the application reports an incompatible protocol, stop and ask the user to update the Gtask plugin instead of continuing with partial fields.
2. Claim exactly the job ID supplied by the background prompt with `claim_gacha_schedule_job`, and echo the supplied model and reasoning effort. Never claim a different queued job. If the result is `null`, stop successfully. The model and reasoning effort are fixed by the user's Gtask setting for the entire job and must not be changed by the Agent.
3. Read `job.contract` before searching. It is the authoritative machine-readable description of:
   - the requested section and inventory scope;
   - the requested output locale and user timezone;
   - required, conditional, and forbidden fields;
   - field meanings and completion criteria.
   Do not recreate those requirements from this skill or from title heuristics.
4. Route by `job.jobKind`:
   - `public_catalog`: follow `job.contract.workflow`, establish the requested inventory, research every required field, verify, match against `matchCandidates`, and submit with `apply_gacha_public_schedule`. When an exploration contract declares a complete verified baseline, audit only additions, official renames, or parent corrections. Use `activityTagTargets` when present.
   - `personal_review`: inspect only `reviewTargets`. Treat facts declared by `factAuthority` as authenticated mechanical facts, research only the listed semantic exceptions, resolve every candidate exactly once, and submit the whole batch with `apply_gacha_personal_review`. Authenticated event rows are already visible as a provisional personal snapshot; this review may refine or exclude them by stable official ID and must not delay initial table creation. Structurally invalid map batches remain staged. Every event resolution must set `eventScope`; only `limited` can be included, while `permanent` and `unknown` must be excluded. Do not classify gameplay tags in this step: omit `activityTags` and let the follow-up `personal_metadata` job research them. Never read or match the public checklist.
   - `personal_metadata`: inspect only `metadataTargets`, research every listed `missingFields`, and submit every target once with `apply_gacha_personal_metadata`. Do not establish an inventory, add, archive, rename, reclassify, or change completion/progress. Research the activity's real gameplay before submitting tags and use optional `activityTagEvidence` only when it adds useful audit context. If useful research still cannot support an accurate tag, mark `activityTags` unresolved with a reason instead of guessing. Activity times that remain unknowable after useful cross-checks may also use `unresolvedFields` with a reason. For cycle targets, follow each target's `timeWindowPolicy`: `full_cycle` requires the complete active cycle window, while `current_playable_phase` requires the exact currently open stage window. Do not submit unresolved, expired, future, reward-claim, previous-stage, or guessed cycle windows.
5. Activity tags are stable IDs from `job.contract.activityTagCatalog`, not free-form labels. The catalog is a vocabulary, not a checklist: do not search for somewhere to apply every listed tag, and do not force a tag merely because it is available. When evidence is clear, submit 1–5 accurate tags from the activity's actual gameplay; no fixed dimension or minimum variety is required. When evidence is insufficient, leave public-item tags empty or mark personal metadata unresolved. Reuse the most specific existing IDs. If a genuinely new mechanic cannot be represented, call `register_gacha_activity_tag` once with a reusable `custom.*` ID, localized labels, a precise definition, aliases, and evidence; then reference that ID. Do not register container/source phrases such as “活动玩法”, “版本活动”, or “个人数据”, and never use `unknown` as a guessed substitute.
6. Use Codex native web search autonomously. Choose queries, source order, parallelism, and follow-up searches from the evidence returned. Prefer official localized sources matching `job.contract.requestContext.outputLocale` when they answer the question, but freely broaden to publisher communities, official APIs/maps, established game wikis, guide communities, and other useful sources when official pages are incomplete. Cross-check uncertain community-only facts.
7. Confirm official localized in-game names for `job.contract.requestContext.outputLocale`; do not translate names yourself. Convert source times into absolute ISO-8601 instants using the source server's timezone and DST rules. Use `requestContext.userTimeZone` only for the user's requested display/interpretation context.
8. Decide semantic identity yourself. When a result is the same item as a `matchCandidates` entry, submit that exact `itemId` as `matchItemId`; omit it only for a genuinely new item. Use `archiveItems` only for a supplied synchronized candidate that is positively verified as wrong, duplicated, or obsolete—never merely because one source omitted it.
9. Report every material phase with `update_gacha_schedule_job_progress`. Use `searching` for gathering sources, `verifying` for checking facts or personal semantics, `structuring` for organizing results, and `writing` for submission. Include real `current` and `total` values when known. `message` is an internal diagnostic and is not product copy; keep it concise and never rely on it to communicate with the user.
10. Submit through the tool selected by `job.jobKind`, setting `contentLocale` exactly to `job.contract.requestContext.outputLocale`. Treat the tool schema as transport and `job.contract` as the requirement source. For public jobs inspect `remainingTargets` and continue until completion.
11. Use `fail_gacha_schedule_job` only after useful searches and cross-checks for the remaining contract scope are genuinely exhausted. Never leave a claimed job unfinished and never change the configured model or reasoning strength during a job.

## Safety

- Public-data jobs and personal-metadata jobs must not submit completion state or exploration progress. Personal-review jobs may submit an activity completion value only together with a mechanically reproducible `completionRule`; map progress and cycle challenge records remain immutable official facts.
- Event jobs must only submit the categories allowed by the current contract; Gtask's activity section accepts limited-time events only.
- Use dedicated synchronization tools instead of generic checklist writes.
- Never attempt to merge public jobs with authenticated `personal_sync` rows. Public-job candidates contain only `public_schedule` rows.
- Personal-metadata jobs may update only the exact existing `personal_sync` item IDs and fields named by `metadataTargets.missingFields`.
- Personal-review jobs may resolve only their exact `reviewTargets`; they cannot inspect, match, copy, archive, or update `public_schedule` or `manual` rows.
- Preserve manual items, fixed tasks, fixed weekly items, and custom checklists.
- Codex owns business decisions; MCP tools only enforce field types, record identity, transaction integrity, authorization scope, and protected manual-data boundaries.
