---
description: Claim the oldest ready-for-agent issue and dispatch a worktree agent to implement it (one issue per run; drive with /loop)
allowed-tools: Bash, Read, Task, Agent
---

# Dispatch ready-for-agent issues

Pick up **one** fully-specified issue and hand it to an isolated agent. Designed to
be driven on a recurring interval: `/loop 10m /dispatch-ready-issues`. Each run
claims at most one issue, so successive loop ticks drain the queue without ever
double-claiming.

Follow the conventions in `CLAUDE.md` → **Issue-driven workflow**. The `/triage`
skill owns the label vocabulary; this command only consumes the `ready-for-agent`
shelf it produces.

## Steps

1. **Find the next issue.** Query the oldest open issue that is `ready-for-agent`
   and NOT already `in-progress` or assigned:

   ```bash
   gh issue list --state open --label ready-for-agent --json number,title,labels,assignees,createdAt \
     --jq '[.[] | select((.labels | map(.name) | index("in-progress") | not) and (.assignees | length == 0))] | sort_by(.createdAt) | .[0]'
   ```

   If the result is empty, report **"ready-for-agent queue is empty"** and stop.
   Do not fabricate work.

2. **Claim it first (single-writer guard).** Before reading the brief or writing
   any code, atomically mark the issue as taken so a concurrent loop tick can't
   grab it:

   ```bash
   gh issue edit <n> --add-label in-progress --remove-label ready-for-agent --add-assignee @me
   ```

   Re-run the step-1 query afterward and confirm the issue is no longer returned —
   if another tick claimed it in the gap, abandon and restart at step 1.

3. **Read the contract.** Fetch the issue and its **agent brief** comment
   (`gh issue view <n> --comments`). The brief is authoritative; the body and
   discussion are only context. If no agent brief comment exists, this issue was
   mislabeled — revert the claim (`--remove-label in-progress --add-label
needs-triage --remove-assignee @me`), comment that it reached the shelf without
   a brief, and stop.

4. **Dispatch an isolated agent.** Launch a subagent with `isolation: "worktree"`
   so parallel dispatches never collide. Instruct it to:
   - Create branch `issue-<n>-<short-slug>` off `main`.
   - Implement exactly what the agent brief specifies — no scope creep.
   - Run `/verify` and `/code-review` on the branch; fix what they surface.
   - Push and open a PR whose body **opens with `Closes #<n>`** and summarizes the
     change against the brief's acceptance criteria.
   - Report back the PR number and a one-line status.

5. **Reconcile on completion.**
   - Success → comment the PR link on the issue and swap the issue label
     `in-progress` → keep until merge (the `Closes #<n>` auto-closes on squash
     merge). Move the **PR** to `ready-for-human`.
   - Failure / blocked → revert the issue to `needs-triage` (or `needs-info` if the
     blocker is a missing decision), remove `in-progress`, unassign, and comment
     what blocked it so the next triage pass can act.

## Notes

- **One issue per run.** Depth over breadth — a clean single dispatch beats a
  half-claimed batch. `/loop` provides the cadence.
- **Never merge automatically.** This command stops at `ready-for-human`; a human
  merges with `gh pr merge --squash --delete-branch`.
- The queue is only as good as triage. If it's persistently empty, groom more
  issues to `ready-for-agent` (or put `/triage` on its own loop) rather than
  loosening the brief requirement here.
