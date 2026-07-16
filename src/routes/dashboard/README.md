# Dashboard

Authenticated UI to observe and control the sync worker. All routes are gated by
better-auth in [`+layout.server.ts`](+layout.server.ts) (redirects to the login
page when there's no session). See the
[architecture doc](../../../docs/ARCHITECTURE.md) for the full picture.

## Routes

| Route                  | File(s)                            | Shows                                                                                                            |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/dashboard`           | `+page.svelte` / `+page.server.ts` | Overview: **live** run status + progress, run controls, stat tiles, storage-by-type, errors, recent-changes feed |
| `/dashboard/stream`    | `stream/+server.ts`                | SSE endpoint — streams the active run's progress (auth-gated)                                                    |
| `/dashboard/runs`      | `runs/+page.*`                     | Run history table (click a row → detail)                                                                         |
| `/dashboard/runs/[id]` | `runs/[id]/+page.*`                | Per-run stats, timing, worker id, and full event log                                                             |
| `/dashboard/content`   | `content/+page.*`                  | Searchable/filterable resource explorer (by URL/title, kind, state) with pagination                              |

## Control plane

The dashboard never talks to the worker directly — it writes rows and the worker
reacts (see [`$lib/server/sync.ts`](../../lib/server/sync.ts)):

- **Enqueue a run** — `?/enqueue` action → `enqueueRun(mode, { maxPages })` inserts
  `sync_run(status='queued')`. The worker claims it.
- **Steer the active run** — `?/control` action → `setControl(runId, action)` sets
  `sync_run.control` to `pause` / `resume` / `cancel`. The worker polls it between
  requests and updates its status.

Enqueue options: **mode**, **max requests**, and **max file size (MB)** — the last
maps to `params.maxDocBytes` so a run can archive HTML but skip large PDFs
(0 = pages-only). See [architecture §4](../../../docs/ARCHITECTURE.md).

**Live updates.** The overview opens an `EventSource` to `/dashboard/stream`; the
status card (progress, counts, current URL, heartbeat, controls) updates without a
reload, with a green "live" pulse when connected. When a run ends it calls
`invalidateAll()` to refresh the aggregates. A **worker-health banner** appears when
a run is queued/running but nothing has claimed it or its heartbeat has gone stale
(i.e. `bun run worker` isn't running). Read models (`getOverview`, `getActiveRun`,
`getChangeFeed`, `listResources`, …) are in `sync.ts`.

## UI

Built with the in-repo shadcn-svelte kit (`$lib/components/ui/*`) — card, badge,
button, table — plus Tailwind. Formatting helpers (bytes, relative time,
duration) are in [`$lib/format.ts`](../../lib/format.ts), safe on client + server.

## Notes / TODO

- Add a "view stored copy" link that presigns an R2 URL (or serves a local blob).
- Live-refresh could be added via polling/SSE; today it refreshes on action/nav.
