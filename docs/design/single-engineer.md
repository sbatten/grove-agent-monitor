# Design: one engineer per task

Status: **implemented** in 0.17.0. Decisions from review are recorded in [Decisions](#decisions); where the build differs from the proposal, see [Changes during implementation](#changes-during-implementation).

## Summary

Today every task gets a **task lead** that does no work itself and hires a
separate session for each phase: planner, researcher, implementer and
verifier, plus the reviewers. This proposal replaces the lead and the four
author personas with **one engineer session per task**. The engineer plans,
researches, implements and verifies, loading a **skill** for each phase. It
hires **reviewers as nested sessions**, which keep their chat (and so their
earlier points) for the whole task.

Most of what Grove already does stays the same:
- the Chief of Staff, the inbox and attaching tasks to chat;
- task stages and the human's decisions;
- steps, review forums, unanimous approval and the round caps;
- shipping (draft PR, publish, watch, merge);
- the task report.

The grove still shows the engineer walking between workstations. The
workstation now follows the engineer's current step, not which session is
running.

## Why

The work itself isn't what goes wrong in the current workflow. Coordinating
the sessions is.

| Task | Tickets | Member sessions | Notes |
| --- | --- | --- | --- |
| T3 | 114 | 10 (plus re-creations; about 55 sessions in the logs) | 13 review rounds, 64 "no response" errors from a stop-hook loop, 24 failed hires at the host's limit of 100 messages per session per hour |
| T10 | 36 | 8 | |
| T2, T5 | 39, 41 | 7 each | cancelled |

Each hand-off between personas costs a session and a few messages. It also
means writing a brief that copies results from earlier steps, and the new
session re-reading the same code. Newer models can carry one thread from the
plan through verification. The one thing a separate session really adds is an
**independent opinion**, so this design keeps reviewers as sessions and
nothing else.

## Roles and sessions

| Role | Session | Agent file | Model |
| --- | --- | --- | --- |
| Chief of Staff | the human's chat | `chief-of-staff` (unchanged) | Opus 5.5 |
| Engineer | one per task, **top-level** (`independent`), started by the Chief | `grove-engineer` (new) | Opus 5.5 for code, Sol 6.1 otherwise ([Models](#models)) |
| Reviewer | one per specialty per task, **nested** under the engineer (`currentSession`) | `grove-reviewer-*` (kept) | unchanged rotation (Sol, Opus, Grok 4.7, Gemini 4) |

```
Chief of Staff ──create_session (independent)──► T7 Engineer ──create_session (currentSession)──► Security reviewer
                                                     │                                        ├─► Code reviewer
                                                     │                                        └─► Tests reviewer
                                                     └── loads skills: grove-plan → grove-execute → grove-verify
```

In VS Code, each task appears once in the session list (its engineer), with
its reviewers grouped under it. Each sprite is still one session you can open.

T3 would have had 1 engineer and 4 reviewer sessions instead of about 55.

## How a task runs

The steps don't change: `plan`, `research`, `execute` and `verify`, each with
optional reviewers. The templates stay the same, and the engineer can still
write its own route. What changes is who does each step and how its output
reaches Grove.

1. **Hand-off:** the Chief creates the task and starts the engineer with
   `grove_handoff`. On every turn, Grove adds the engineer's context: the task,
   the current step, the skill to load, the acceptance criteria and any open
   review points.
2. **Route:** the engineer picks the steps with `grove_plan_steps`, as leads do
   today.
3. **Each step:**
   1. `grove_next` names the step and its skill ("Step S2 · Execute. Load the
      `grove-execute` skill.").
   2. The engineer loads the skill and does the work in its own chat.
   3. It submits the output with **`grove_submit`** (new): the step's output
      text, plus the evidence folder for research, execute and verify.
   4. Grove checks the output **inside the tool call**, using the same checks
      that today run when a member's turn ends: a verify report ends in
      `RESULT:` and `evidence.json` is valid; a draft PR step gives
      `PR: <url>` or `NO PR: <why>`. If a check fails, the tool returns an
      error saying what to fix. This replaces the stop-hook pushback that
      looped on T3.
   5. **If the step has reviewers,** `grove_submit` returns the hires
      (`create_session` the first time, `send_message` after that). The
      engineer makes them and ends its turn.
   6. Each reviewer ends its turn with a verdict, which Grove's stop hook in
      the reviewer's session checks, as today. The reviewer reports to the
      engineer with `send_message`. When every verdict is in, Grove wakes the
      engineer with the outcome.
   7. **Changes requested:** the engineer revises in the same chat and calls
      `grove_submit` again; that's the next round. The 6-round cap per step
      still applies, and so does escalation when a revision comes back
      unchanged.
4. **Deliver:** the engineer calls `grove_deliver` with a summary, the key
   decisions and the `ask`. For a code change, Grove first sends the engineer
   the draft-PR brief, and the engineer opens the draft PR itself.
5. **Ship:** after the human approves, the engineer does the publish and merge
   steps itself. Grove still watches the PR and wakes the engineer only when
   it needs work.

### Tools

| Tool | Change |
| --- | --- |
| `grove_handoff` | Starts an engineer instead of a lead. |
| `grove_plan_steps` | Unchanged. |
| `grove_next` | Returns the engineer's next move: the step to work on and its skill, the reviewer hires to make, or "wait". It no longer lists persona hires. |
| `grove_submit` | **New.** `{ step, output }`. Records the step's output, validates it, and opens the review round. |
| `grove_deliver`, `grove_update`, `grove_blocked`, `grove_answer` | Unchanged; the engineer calls them. |
| `grove_support` | **Removed.** No task ever used it (see [Decisions](#decisions)). |
| `grove_create_task`, `grove_record_decision`, `grove_status`, `grove_cancel_task` | Unchanged (Chief). |

### Hooks

- **Engineer tools:** the engineer gets all tools, since it does the work. It
  may use subagents for quick lookups, but they never count as reviews.
  Reviewers can only be hired through `grove_next`/`grove_submit` hires.
- **Stop hook (engineer):** pushes back only when a step is active, nothing
  has been submitted, and no reviewers, human or PR are pending. It keeps
  v0.14.1's rule of not pushing back a turn that did nothing, and
  `MAX_STOP_BLOCKS`.
- **Reviewers:** unchanged. Their verdict is checked at the end of their turn,
  they can't message the Chief, and they report to the engineer.
- **Chief:** unchanged, including `CHIEF_TOOLS`.

## Reviewers keep their memory

A reviewer is a nested session the engineer creates the first time that
specialty is needed. After that it gets `send_message` in the same chat, so it
remembers its earlier points the way a person would. Its brief for each round
also includes the forum's open points, so it checks those first and then looks
for anything new the revision introduced.

Grove already keeps one reviewer per specialty per task (`memberKey`), and the
host's rate-limit backoff and "chat lost" handling apply unchanged. A
reviewer's chat is only replaced when the host says it's gone.

**Verifying its own work:** the engineer verifies its own change, so the
`code-change` template adds the **tests** reviewer to the `verify` step. It
checks the evidence against each acceptance criterion. It's the same tests
reviewer session that reviewed the plan, so it already knows the criteria.

```
code-change: plan [security, tests, architecture] → execute [security, tests, code, architecture] → verify [tests]
research:    research [accuracy]
```

## Phases become skills

The four author personas become plugin skills. Reviewers stay custom agents.

| Skill | Replaces | Contents |
| --- | --- | --- |
| `grove-plan` | `grove-planner.agent.md` | what a plan covers, the plan template, acceptance criteria |
| `grove-research` | `grove-researcher.agent.md` | sources, making answers checkable, optional evidence |
| `grove-execute` | `grove-implementer.agent.md` | following the plan, scope, tests, optional evidence |
| `grove-verify` | `grove-verifier.agent.md` | capturing screenshots and recordings, `evidence.json`; **scripts**: an `evidence.json` checker and recording helpers |
| `grove-review` | shared part of the reviewer agents | verdict format, checking earlier points first, what counts as blocking |

### Why skills for the phases, and agents for reviewers

- **Engineer, phase skills:** one session means one model, so the reasons for
  separate agents (a model per role and tool limits per role) no longer
  apply. Skills load only when needed, can include scripts, and work outside
  Grove ("verify this with evidence" in any chat).
- **Reviewers stay custom agents:** each one is its own session with its own
  model and persona. Grove puts the `grove-review` skill into every reviewer's
  brief, so the shared rules are always present (see
  [Changes during implementation](#changes-during-implementation)).

### What the host does (confirmed)

- **Skill loads are visible to Grove.** The runtime emits a `skill.invoked`
  session event with `name`, `pluginName`, `path` and `trigger`
  (`agent-invoked`, `user-invoked` or `context-load`)
  (`copilot-sdk/generated/session-events.d.ts`, `SkillInvokedData`). Grove
  already listens to session events (`onEvent` in
  [integration.mjs](../../extensions/grove-agent-monitor/lib/process/integration.mjs)).
- **The same in VS Code:** the agent host passes plugin skills to the runtime
  as `skillDirectories` (`copilotSessionLauncher.ts`,
  `toSdkSkillDirectories` in `copilotPluginConverters.ts`). It also hides the
  raw `skill` tool call and builds its display from `skill.invoked`
  (`copilotToolDisplay.ts`, `HIDDEN_TOOL_NAMES`), so the event is what
  reliably reaches the session.
- **Agent files can preload skills, but only for sessions started as that
  agent:** `toSdkCustomAgents` forwards an agent file's `skills:` list, and the
  SDK injects "the full content of each listed skill … into the agent's
  context at startup" (`types.d.ts`, `CustomAgentConfig.skills`). Grove's
  sessions come from `create_session`, which can't pick an agent, so this
  doesn't apply to them.

### When a skill isn't loaded

A skill is only loaded if the engineer chooses to load it. To make up for
that:
- `grove_next` and the engineer's context name the skill to load for the
  current step.
- Grove notes the `skill.invoked` events for each step. If `grove_submit` is
  called without the step's skill, the result reminds the engineer and it's
  logged. Submissions **aren't refused**: after an extension reload Grove
  loses its in-memory record, and refusing would cause false failures.
- The engineer's instructions say to reload the phase's skill at the start of
  each step. This also covers skills dropped by context compaction.

## In the grove

| What's happening | Where the engineer is |
| --- | --- |
| Step is plan / research / execute / verify | at the planning table / research nook / forge / testing station |
| Loads another phase's skill mid-step (for example research during execute) | detours to that station until the next step or skill |
| Reviewers deliberating | joins its reviewers at the review station (plan review or code review) |
| Draft PR, publish, merge | the forge |
| Waiting on the human, on hold, or watching the PR | rests in the tent; the Chief shows the ask |
| Blocked | at the **Needs you** lantern |
| Session error | shows the error, as today |

**Tents** hold the engineer and its reviewers. Reviewers rest
there between rounds and come out to meet the engineer at the review station.
The tent's hover lists everyone with their last verdict, plus the progress
board and PR as today.

**Sprites:**
- **Engineer:** a new sprite in the task colour. It replaces the lead sprite,
  so the council station becomes the Chief's alone.
- **Planner, researcher, implementer and tester:** these sprites are retired.

## Models

One engineer means one model per task, chosen by the task's kind:
- `grove_create_task` takes `kind: code | research | other` (default `code`
  when the goal names a change to a repository, `other` otherwise).
- Grove passes the model at hand-off, and the hook enforces it, as it does
  for leads today: **Opus 5.5** (`claude-opus-5.5`) for `code`, **Sol 6.1**
  (`gpt-6.1-sol`) for `research` and `other`.
- `grove-engineer.agent.md` sets `model: claude-opus-5.5` as the default when
  no model is passed.

The reviewer mapping in
[models.mjs](../../extensions/grove-agent-monitor/lib/process/models.mjs)
doesn't change.

## Recovery

- **Engineer error or stall:** shown on its sprite. Grove wakes it in the same
  chat, using the existing lead logic (`continueLead`, `MAX_LEAD_WAKES`, the
  rate-limit backoff).
- **Engineer chat lost:** the Chief re-hands the task to a new engineer. The
  new engineer picks up from the board: step outputs, open review points, the
  PR, evidence on disk, and the branch or worktree. That's possible because
  everything a step produces is recorded by `grove_submit`, not just held in
  the engineer's context.
- **Reviewer chat lost:** recreated, and given the forum's history in its
  brief.

## No migration

No code carries old tasks over. The board's format version goes from 1 to 2,
and Grove already leaves a board with another version untouched and reports
it (`readJson` in
[board.mjs](../../extensions/grove-agent-monitor/lib/process/board.mjs)).
After upgrading:
- the old Chief of Staff chat's board stops loading, and the human starts a
  new Chief chat with a fresh board;
- the old task files, evidence and HTML reports stay on disk;
- work in flight (T12) is dropped. Its branch or worktree is still there to
  pick up by hand or in a new task.

## What gets removed

- **Agents:** `grove-lead`, `grove-planner`, `grove-researcher`,
  `grove-implementer`, `grove-verifier`.
- **Support helpers:** `grove_support`, `issueSupport`, the `support` role and
  its sprite mapping.
- **engine.mjs:**
  - `KIND_ROLE` collapses to the engineer;
  - author-convened reviews (`author`, the author parts of `issueWork` and
    `route`) go;
  - author tickets go: Grove now records output from `grove_submit` instead of
    reading it from a member's final message.
- **integration.mjs:**
  - the member role for authors (`authorTickets`, `authorDuties`,
    `gateAuthorHire`, the author stop-hook contract and the revive rules);
  - `LEAD_TOOLS` and the lead's "never does the work" denial;
  - persona hires in `next()`.
- **prompts.mjs:**
  - the author briefs (`briefFor` for the planner, researcher, implementer and
    verifier) move into the skills;
  - `authorConvene` goes;
  - `leadHandoff` becomes `engineerHandoff`.
- **Tests:** much of
  [process.test.mjs](../../tests/process.test.mjs) is rewritten for the
  engineer flow, and engine tests are added for `grove_submit`.

This is a net reduction: roughly a third of `integration.mjs` and the author
paths in `engine.mjs` and `prompts.mjs` go away.

## Validation

1. **Unit tests:**
   - `grove_submit` validation per step kind;
   - review rounds driven by submissions;
   - re-hand-off resuming from the board;
   - the skill-loaded reminder;
   - a version 1 board is left untouched.
2. **Grove canvas test page:** check the engineer's stations, the skill
   detour, joining the review huddle, and the tent roster with verdicts.
3. **A real side-by-side task:** run a code change about the size of T3 on
   the new flow, and compare sessions, messages, review rounds, wall time and
   errors from the host logs.

## Decisions

1. **Engineer model:** chosen by task kind: Opus 5.5 for code, Sol 6.1 for
   research and other work.
2. **Verify reviewer:** yes, the tests reviewer reviews `verify` by default.
3. **Skill detours:** yes, loading another phase's skill mid-step moves the
   sprite to that station.
4. **Helpers:** `grove_support` is removed; it can come back if a real task
   needs it. It existed because leads weren't allowed to do any work, so the
   only way to look something up was to hire a helper. No task ever used it. The engineer can
   look things up itself, or use ordinary subagents for side lookups.
5. **In-flight work:** no migration. The board format version goes up, and
   in-flight work is dropped.

## Changes during implementation

- **No `skills:` preloading for reviewers.** `create_session` has no `agent`
  parameter (`createSessionWithSharedWorkspaceInputSchema` in VS Code's
  `sessionServerTools.ts`), so neither the engineer nor its reviewers are
  started *as* custom agents, and an agent file's `skills:` list never
  applies. Grove already puts each agent file's text into the session's brief,
  so it does the same with the `grove-review` skill: every reviewer brief
  includes it. That guarantees it just as well.
- **The engineer's brief comes from the marker.** The Chief's hand-off prompt
  is a short marker; Grove expands it in the engineer's session into the full
  brief (the agent file's standing instructions, the goal, criteria, steps and
  skills), as it already did for reviewers.
- **Catching up.** An engineer that takes a task over gets the finished steps'
  results in `grove_next` until it submits something.
- **Engineer sprite.** The engineer uses the existing mage class (the old lead
  sprite) in a dusk robe with its task's pennant, rather than a new class.
- **Report.** Each step in "How it was done" is drawn with its workstation
  (star table, bookshelf, forge, training dummy) rather than an author sprite.
- **Old boards.** Version 1 boards fail with a message saying to start a new
  Chief of Staff chat.
