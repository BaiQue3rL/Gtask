---
name: sync-gtask-schedules
description: "Maintain Gtask public baselines when a baseline job is queued or the user asks to audit or update activities, recurring modes, version timing, or maps. Use the scoped local MCP contract; ordinary personal progress and explicitly authorized software maintenance are outside this skill."
---

# Maintain Gtask public baselines

## Responsibility

Codex verifies public facts; programs validate and apply a batch; Gtask reads the published catalog and synchronizes personal progress itself. Normal application use never waits for Codex.

This workflow applies to **baseline maintenance**. Explicit requests to repair software, data handling, deployment, or UI authorize software maintenance under the user's scope; do not silently expand a baseline job into that mode.

- Maintain only public item identity, names, tags, hierarchy, official times, and published rules. Never submit completion, scores, exploration percentages, account identifiers, credentials, or custom items.
- Personal adapters update only uniquely matched existing items. Missing or ambiguous evidence preserves progress; manual completion locks remain protected. Automatic inheritance, quick pass, generated teams, and skipped stages do not prove manual challenge participation.
- Runtime lifecycle changes execute an already-published boundary or rule. Never infer a new catalog, time, or cadence from personal progress. Opening cadence and open duration are separate; preserve gaps. Routine periods do not need new rows or research.
- Use the dedicated MCP tools for application data. Do not inspect credentials, raw authenticated responses, or edit a player's SQLite database. Authorized repository publication and isolated validation may use repository tools.

## Workflow

For an authorized repository maintenance request, follow `docs/catalog-maintenance.md`: export the public inventory, verify the requested scope, compile one delta with `pnpm catalog:check --base ... --delta ... --output ...`, and validate the result. This route does not require a running player application or its database. For an already queued MCP job, use the exact-job workflow below; never silently abandon it in favor of an unrelated task.

1. Register a stable agent ID with `webSearch: true`. The live tool schema and returned `job.contract` define supported fields; cached plugin version metadata is diagnostic.
2. For an existing background job, claim the **exact supplied job ID**. For a direct application-data request, pass your registered `agentId` to `queue_gtask_baseline_maintenance` so creation and claiming happen atomically. Retain the returned ID; do not queue and then race the background worker to claim it. If the live schema does not yet support atomic claiming, use the exact-ID fallback and inspect its outcome.
3. Check `isError` before reading `structuredContent`; never parse error text as JSON. Only `claimOutcome=claimed/resumed` permits progress or writes. Another owner means stop writing that job; use `get_gtask_schedule_job` for a compact read-only status/result when supported, rather than claiming again to poll. A terminal job or missing ID is not a successful audit this run. Never silently queue substitute work.
4. Read the current `job.contract.maintenancePolicy`, saved `researchDecisions`, candidates, observations, and coverage requirements. The live contract governs supported capabilities even if a cached skill is older. Audit the complete target inventory, then research only new, changed, conflicting, or unsupported facts. Reuse reliable evidence across items and batch independent source checks.
5. Sanitized `sourceObservations` can support an unambiguous time-only correction. Cite its `observationId` in both the item and evidence; no duplicate web lookup is required for that field. Missing names, membership, hierarchy, or gameplay facts still require sources, preferably official localized sources.
6. Compare verified facts with the baseline. Reuse `matchItemId` and stable keys for the same item; preserve map IDs on renames. Submit one validated delta per active target with `apply_gtask_public_schedule`, not one call per row. Unchanged rows stay out of `items`.
7. A fully checked target with no changes uses `verifiedUnchangedTargets`; `verifiedEmptyTargets` means the events catalog is actually empty. Failed fetching or incomplete inventory proves neither. Keep tasks `items` empty; submit `versionWindow` only for a verified exception or change the published cadence cannot express.
8. Report material phases through the progress tool; its default compact result avoids repeating the inventory. Save conflict decisions in `researchDecisions`: target, stable key, resolved/pending/excluded status, old/adopted value, timeBasis, reason, and sources containing publication time and the actual statement. Resume saved decisions. Reopening needs new evidence, or `correctionReason` identifying an interpretation/structuring mistake or a user correction; never lock a proven error in place. For `all`, read each apply result's new contract and remaining targets through exploration.
9. Check the main announcement/rules and one independent targeted source for an unresolved field. If no new evidence results, record a concrete pending gap and continue other confirmed differences, rather than searching the same question indefinitely. Pending is not proof of eligibility; do not falsely mark that target unchanged or fully audited. Report the read-only summary's `auditComplete` and unresolved count separately from job termination. When no useful verified submission is possible, explicitly fail the scoped job. Do not claim unrelated jobs.

## Inclusion and time

- Activities must have verified independent identity and limited-time participation. Permanent content, long-term one-off tasks, banners, shops, reward tiers, and internal stages stay out.
- Lack of a deadline does **not** prove permanence. When the consumer supports protocol v2, a verified limited and currently open activity may use `deadlineReview` with both evidence sources, checked sources, checkedAt, reviewAt, and the missing-time reason. Keep endsAt empty. Prioritize these reviews in every covered game and at version boundaries; the review date is not an expiry. Otherwise retain the candidate in research records. Never invent time or assume an older installed client has new capabilities.
- For the same item, version and server, later applicable official corrections/current detailed rules override only the fields they revise in old announcements or stale calendars. Compare publication/update order and content, not retrieval/repost timestamps. Resolve this before considering timestamp precision; do not omit eligible items because a superseded date conflicts.
- Preserve source timezone, wording and precision. For a confirmed open event beginning after the update, an explicit official maintenance start plus expected duration may provide a nominal schedule start; record the derivation and `timeBasis=nominal_maintenance`, never claim it is a measured opening. Do not invent unsupported hours or substitute banner/reward-claim windows. Use the contract's missing-deadline exception only when its conditions hold; otherwise record the precise remaining gap.
- Cycles are stable mode definitions. Same-period calibration preserves progress; a new period resets it. Protocol v2 can stage future windows and publish supported typed rules through `scheduleUpdates`; preserve nominal period identity and use `scheduleArchives` for explicit withdrawal. Never overwrite an active period with a future window. New algorithm types still require software maintenance; data updates use the existing validated algorithms.
- Maps have exactly two levels, region and subregion. In the repository, read `docs/ai-map-catalog-maintenance.md` before changing a map baseline.
- Use the job's tag vocabulary; add a reusable custom tag with evidence only when necessary.

## Repository publication

When repository publication is authorized, compile the cumulative public delta into `updates/catalog.json`, preserving prior retirements. Build and run `pnpm catalog:check`; `--inventory` emits only public fields from an isolated consumer. The application embeds the same file used for remote distribution. Do not duplicate new facts in historical TypeScript seeds. Source accuracy and scope coverage still require the evidence review above.

A passed local check, a repository commit, an online catalog, a mirror, and a client receipt are distinct results. Report only observed stages. Finalize the delta before the required checks; reuse validation for unchanged inputs, and repeat affected checks only after content changes, failures or new evidence. Keep the worktree until local application and authorized publication are complete. Version changes and publication follow the user's existing authorization; baseline-only edits do not require an application version bump.
