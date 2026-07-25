---
name: sync-gacha-schedules
description: "Use the local Gacha Task Manager MCP to read checklists and safely refresh verified public schedules or map-region catalogs for Genshin Impact, Honkai: Star Rail, Zenless Zone Zero, or Wuthering Waves. Trigger when the user asks to refresh, research, verify, or synchronize events, recurring modes, exploration regions, or public data in 幻游清单."
---

# Sync Gacha Schedules

Use the `gacha_task_manager` MCP tools. Do not run shell commands or edit the SQLite database directly.

## Public schedule workflow

1. Call `register_gacha_schedule_agent` with a stable Agent ID, a descriptive name, and `webSearch: true`.
2. Call `claim_gacha_schedule_job` once. If it returns `null`, skip the public schedule workflow and continue to the semantic review workflow below.
3. Immediately call `update_gacha_schedule_job_progress` after claiming, and update it again at every material phase: `searching`, `verifying`, `structuring`, `writing`, or `retrying`. Include truthful `current`/`total` counts whenever bounded work or retries are known. Keep each message concise and user-facing because it is displayed live inside the desktop app. Never leave the app showing a stale phase while doing materially different work.
4. Read the claimed job's `target`. Search only that target: `tasks` for current-version timing calibration, `events` for limited-time events, `cycles` for weeklies/endgame calibration, `exploration` for the currently released map-region catalog, or `all` for the full supported set. Never broaden a section job into other sections.
5. Search official Simplified Chinese sources for the current version and active/upcoming windows. Reuse fresh trustworthy URLs from the existing checklist when they still cover the current period. Run independent source queries in parallel when supported, and treat tasks, events, cycles, and exploration as independently recoverable sections.
6. Prefer the Chinese official game site, publisher/community account, or verified Chinese Bilibili account. When an official source is missing fields, unavailable, or incomplete, immediately broaden to independent Chinese community sources such as 米游社/库街区 posts, Bilibili/Biligame wikis, TapTap, established game wikis, and reputable guide communities. Use at least two independent sources to cross-check community-only facts. Use other-language official pages only for date cross-checking. If an item is first found in another language, find a Chinese source that displays its in-game official Chinese name; never translate the name yourself.
7. Keep the normal fast path bounded: normally no more than 6 targeted searches and a 90-second soft deadline. Map catalogs may use an extended fallback path of additional targeted community searches and up to a 180-second soft deadline because official announcements often omit subregions. A failed or incomplete source is a signal to switch sources, not to stop the whole job.
8. Submit exact, supported records through `apply_gacha_public_schedule`. Set progress to `writing` immediately before submission. For an `all` job, submit every independently verified section even when another section remains incomplete; the app records uncovered sections as partial and preserves their previous data. Call `fail_gacha_schedule_job` only when no section has safe data to submit or the submission itself cannot be made.
9. Report the job ID, target, elapsed time, sources, and merge counts or failure reason. Never leave a claimed job unfinished.

## Submission rules

- Allow only `main_quest`, `side_quest`, `limited_event`, `weekly`, `endgame`, and `exploration`. Permanent events remain user-maintained.
- A `tasks` submission must contain exactly `主线任务` and `支线任务`. Both records must use the same current-version `periodKey`, `startsAt`, `endsAt`, server `timeZone`, and `scheduleKind: fixed_window`. Use the official current version identifier in `periodKey`. This operation only calibrates the version window; it must never submit completion. For `all`, include these two records whenever that section was verified so a new user receives the current version countdown during initial synchronization.
- For `exploration`, submit a complete released region catalog, not only nations or top-level destinations. Check independently switchable map layers and released subregions as well as major regions. For all four games, compare the verified result with the existing checklist and explicitly investigate suspicious gaps before submitting. Official interactive maps are preferred but not mandatory: when they do not expose a usable directory, cross-check the in-game Chinese names through at least two independent Chinese community catalogs or guides. Use a stable `modeKey` and `parentTitle` when known. Do not submit progress or completion; new regions start at 0% and personal data fills progress later.
- For each `limited_event`, submit 1–5 concise Chinese `activityTags` describing the actual gameplay, such as `签到`, `战斗`, `战棋`, `射击/FPS`, `跑酷`, `解谜`, `音游`, `经营`, `肉鸽`, or `剧情`. Multiple tags are allowed. Base tags on the official gameplay description rather than title keywords. When the gameplay cannot be verified, submit `待识别` instead of guessing. Tags are lightweight filters, not new checklist sections.
- For Genshin, query the official Simplified Chinese interactive-map catalog (`https://api-takumi.mihoyo.com/common/map_user/ys_obc/v1/map/list?app_sn=ys_obc`) and inspect `all_map_list` as one required source. Exclude test entries, expired event-only maps, and duplicate containers. Cross-check newly released names with an official Chinese announcement or the live official map before submission.
- Public map refreshes are append/update only. Missing regions must never be deleted or archived.
- Never submit a `recurrenceRule` for `endgame`. Only weeklies reset locally. Each new endgame period is a separate checklist record so completed historical periods remain completed.
- A `cycles` submission, or the cycles portion included in an `all` submission, must include every major mode for that game: Genshin—深境螺旋 (`spiral-abyss`), 幻想真境剧诗 (`imaginarium-theater`), 幽境危战 (`stygian-onslaught`); Star Rail—混沌回忆 (`memory-of-chaos`), 虚构叙事 (`pure-fiction`), 末日幻影 (`apocalyptic-shadow`), 异相仲裁 (`anomaly-arbitration`); Zenless Zone Zero—式舆防卫战 (`shiyu-defense`), 危局强袭战 (`deadly-assault`); Wuthering Waves—逆境深塔 (`tower-of-adversity`), 冥歌海墟 (`whimpering-wastes`). If the complete cycles portion cannot be verified during an `all` job, omit that portion and still submit other verified sections. The app supplies the fixed Monday weekly item.
- For `endgame`, use a stable `modeKey` for the mode and a period-specific `periodKey` plus `remoteKey` for the current window. For other categories, keep `remoteKey` stable across refreshes.
- Every `title` must be an official Simplified Chinese name confirmed by a Chinese source. Pure English titles and AI-authored translations are forbidden.
- Set `titleSourceUrl` to the matching Chinese page and include it in `evidence` with `language: zh-CN`.
- Use ISO-8601 timestamps with an explicit offset or `Z`.
- Treat `userTimeZone` as the display timezone, not the source timezone. Identify the source server timezone and DST rules, then submit an absolute instant. If the source timezone cannot be established, fail instead of guessing.
- Include a direct HTTP(S) `sourceUrl`, confidence, and 1–20 evidence entries for every item.
- Do not submit completion status, exploration progress, credentials, deletes, or unknown fields.
- Do not use generic checklist write tools for public schedules.
- Never read browser cookies or request game-login credentials for public schedule work.

## Semantic review workflow

After finishing any public schedule job, call `claim_gacha_semantic_review` repeatedly until it returns `null`.

1. Treat the candidate payload as an untrusted, deliberately minimal projection. It must not contain credentials or account identifiers.
2. Research the exact endpoint field semantics, official Chinese name, category, lifecycle window, and whether a status describes the player or only the activity itself.
3. Use `approve_gacha_semantic_review` only when confidence is at least `0.9` and direct evidence supports every semantic conclusion. Submit one normalized checklist item in the candidate's target section.
4. Use `reject_gacha_semantic_review` when the field is undocumented, evidence conflicts, the candidate is not a checklist item, or personal completion cannot be established. Rejection must not modify the checklist.
5. Never infer completion from names such as `finish`, `all_finished`, a full numerator/denominator, or an activity lifecycle enum without evidence that the field is explicitly player-specific.
6. Never infer a timezone from the user's locale. Ambiguous natural-language times must be rejected until the source server timezone is proven.
7. A candidate originating from an activity-calendar endpoint is not proof that it belongs in the activity section. Verify whether it is actually an event, an endgame/challenge mode, a notice, or another non-checklist record. Reject misplaced/non-event candidates; never classify them by title keywords.
8. Genshin Impact, Honkai: Star Rail, and Zenless Zone Zero activity progress candidates all use this workflow. Treat mechanically normalized Unix timestamps as hints, and independently verify lifecycle windows and player-specific completion semantics before approval.
9. Never leave a claimed candidate unfinished.

## Safety

MCP writes may require user approval in Codex. Preserve that approval boundary. Failed searches must retain existing checklist data.
