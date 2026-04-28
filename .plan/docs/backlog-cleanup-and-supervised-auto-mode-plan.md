# Backlog Cleanup And Supervised Auto Mode

## Shipped In This Pass

- A project-scoped `Clean up backlog` action now routes through the existing sidebar board agent instead of adding a separate automation path.
- Task cards and terminal panels now distinguish `needs approval`, `needs input`, `needs review`, and `ready for review`.
- Browser notifications can now fire when an agent is blocked on the user, with an optional sound toggle.
- Runtime settings now describe the current autonomous flag honestly as unsafe full bypass rather than a supervised approval flow.

## Next Phase

- Replace the prompt-driven cleanup action with a backend cleanup service that can:
  - inspect the backlog in one run
  - produce structured recommendations
  - apply only high-confidence task mutations
  - persist an audit trail
- Extend board/task metadata with review confidence, last-reviewed timestamps, and cleanup run identifiers.
- Add a dry-run review UI before auto-trashing or rewriting backlog items.

## Supervised Auto Mode

The current `Full auto permissions bypass` setting is a raw CLI bypass. It is not a safe approver loop.

To support a Claude Code style supervised mode cleanly, the runtime needs:

- an approval policy model instead of a single bypass boolean
- a dedicated review/approval agent or policy engine that can inspect proposed tool calls
- a queue for pending approval requests with structured context
- allow/deny logging tied to the task session timeline
- per-agent capability handling because Codex and Claude expose different approval surfaces

## Constraint

Do not implement supervised auto mode by layering more UI on top of the current bypass flag. The missing piece is server/runtime orchestration, not another checkbox.
