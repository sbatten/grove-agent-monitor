# Grove Agent Monitor

A Copilot plugin that pairs a **Chief of Staff orchestration workflow** with a
**hi-detail pixel-art canvas** (480×320, crisp at any panel size) that shows it happening. The canvas is
a calm, bioluminescent forest clearing.

## The workflow

You talk to one agent, the **Chief of Staff**. It never does work itself, and
it never waits on agents. Grove holds it to that: it can only use Grove's
tools, the session tools and the canvas (no shell, files, git or GitHub), so
anything to do or find out goes to a task.

When you ask for something, the Chief:
1. turns the request into tasks, each marked `code`, `research` or `other`;
2. hands each task to a new, independent **engineer session** with
   `create_session`;
3. replies and ends its turn, so it's always free for your next message.

Each **engineer** does its task from start to finish in its own chat: it plans,
researches, implements and verifies, loading a **skill** for each kind of step.
For an independent opinion it hires **reviewers**, each its own session (chat)
that it keeps for the whole task, so a reviewer remembers what it said in
earlier rounds. **One session = one sprite** in the grove.

In VS Code's session list, **each task is grouped under its engineer**:
- **Engineers:** the Chief starts each engineer as an independent top-level
  session at its structured task destination (`relationship: "independent"`).
- **Reviewers:** nested chats inside their engineer's session
  (`relationship: "currentSession"`), so a task's whole team sits together.
- **Enforcement:** Grove's `preToolUse` hook sets this placement (and the
  model) on every `create_session` call, so it doesn't depend on the model
  passing the right arguments. Destination is authoritative, not the Chief's
  cwd or a path mentioned in the goal.

### Workspace routing

Every new `grove_create_task` requires `destination`:

| Mode | Workspace | Creation intent |
| --- | --- | --- |
| `new-worktree` | Absolute target repo | `worktree: true` |
| `existing-worktree` | Exact authorized continuation checkout | Direct folder; verify actual attachment |
| `read-only` | Absolute Git checkout folder | Direct folder; no new worktree needed |
| `scratch` | Omitted | Omit workspace/worktree; independent host scratch |

Actual directory, Git identity, branch and HEAD are recorded separately.
Unknown or mismatched attachment blocks work and review acceptance. Resume a
correctly attached engineer for same-PR work; recovery carries its verified
checkout, never defaults to main. Some hosts redirect independent
`worktree: false` from a linked checkout to the primary root. That is a repair
prerequisite, not successful reuse. Legacy boards retain reports/votes and active
attachments; legacy recovery needs an explicit `grove_handoff` destination.
`read-only` requires Git identity; non-repository work uses `scratch`.
Ordinary branch changes or detached HEAD inside the verified engineer checkout
remain allowed. Identity is refreshed at submission/dispatch and on directory
changes, not reprobed or rewritten for every ordinary tool call.

Reviewers share the engineer folder by default. A reviewer object
`{ name: "code", worktree: true }` opts into a separate nested worktree on
supporting hosts. Code review requires committed content and a pinned SHA.
The host may start on the default branch: Grove selects the pinned commit only
in the clean separate checkout (detached, hooks disabled), then checks actual
HEAD and cleanliness before work and again before accepting the review.
Preparation failures survive reviewer restart until a fresh assignment.
Dirty content or unsupported placement is
reported, never auto-committed or silently converted to sharing.

Only a Chief-recorded explicit human `workspaceRepair: true` decision (`retry` or
`note`) permits attachment-repair confirmation. Target/isolation derive from
recorded routing, not free text. The affirmative form must immediately precede
matching `set_workspace`, as the turn's final tool. Host confirmation/approval
still applies. A placement failure does not authorize repair; ordinary questions
and other attachment/move tools remain denied. Correct attachments and read-only
diagnosis need no form.
Restart invalidates both repair authority and consent: a fresh Chief-recorded
human decision is required, including when the session identity is unchanged.

### Steps: the engineer shapes the work

Not every task is a code change, so the engineer decides what each task needs.
It builds a **route** out of four kinds of step, and can attach reviewers to
any of them:

| Step | Skill the engineer loads | For |
| --- | --- | --- |
| `plan` | `grove-plan` | designing a change before making it |
| `research` | `grove-research` | finding things out: data, issues, code, docs, the web |
| `execute` | `grove-execute` | making a change: code, or other actions |
| `verify` | `grove-verify` | proving it works with **visual evidence** (screenshots, screen recordings, rendered output) saved to session data |
| *reviewers* | | checking a step's output in a shared forum; approval must be **unanimous** |

**Reviewers:**
- **Built-in:** `security`, `tests`, `code` and `architecture` have their own
  personas. `accuracy` re-derives numbers and facts independently.
- **Your own:** any other name needs a focus, for example
  `{ "name": "privacy", "focus": "no user-identifying data" }`.
- **How they review:** Grove adds the `grove-review` skill to every reviewer's
  brief: check the work yourself, label findings blocking or non-blocking,
  re-check your own earlier points first in later rounds, and end with a
  verdict.

**Templates** cover the common shapes:
- `code-change`:
  1. **plan**, reviewed by security, tests and architecture;
  2. **execute**, reviewed by security, tests, code and architecture;
  3. **verify**, reviewed by tests. The engineer verifies its own work, so the
     tests reviewer opens the evidence and checks it against each criterion.
- `research`: one **research** step, reviewed by accuracy.

Some examples:
- "What are the weekly and monthly active users of the agents window?" gets
  one research step with an accuracy reviewer.
- "Collect easy issues assigned to me" gets one research step, reviewed if it
  matters.
- A feature request gets the `code-change` template.

**How a route runs:**
1. **Each step:** `grove_next` gives the engineer the step's assignment (the
   skill to load, the brief, feedback to address, the evidence folder). It
   does the work in its own chat and submits the output with `grove_submit`.
   Grove checks it right away and says what to fix if it falls short.
2. **Reviews:** if the step has reviewers, `grove_submit` returns their hires
   and the engineer ends its turn. Each reviewer reports back to the
   engineer's chat. If the review isn't unanimous, the engineer revises in its
   own chat and resubmits, and the same reviewer chats review it again.
   - **Review limits:** after 3 rounds without agreement the step is escalated
     to you, and no step gets more than 6 rounds however often you send it
     back.
   - **No repeat reviews:** if the engineer resubmits the same output after the
     reviewers asked for changes, it is escalated rather than reviewed again.
3. **Choosing again:** when the steps are done, Grove shows the engineer their
   results, and it chooses what's next:
   - add more steps, replace planned ones, or **redo** a finished step (and
     everything after it) with feedback;
   - or **deliver** a short summary, the key decisions it made, and an `ask`:
     the one thing it needs from you (a decision, a question to answer, or
     just "approve").
4. **Failed verification:** this also comes back to the engineer, which
   usually redoes from the execute step.
5. **Draft PR:** a code change (one with an `execute` step, unless the engineer
   said `ship: false`) isn't brought to you yet. Grove adds a step for the
   engineer to commit it and open a **draft pull request**, so you can review
   the change itself. If the work can't go in a PR (no repository, no remote,
   nothing changed in files), it says `NO PR: <why>` instead.
6. **Sign-off:** a delivered result goes to the Chief, which brings it to you.
   - **The report:** a link to the task's report comes first (see below),
     then the draft PR's link.
   - **The engineer's ask** and **the result:** the answer or outcome, with
     links to the evidence.
   - **Approve** when you're satisfied. A code change then ships (see below).
   - **Ask for more**, and the same engineer plans the follow-up, usually
     redoing a step. This works on a finished task too: it reopens it.

If a review can't agree, the task is **escalated to you**. The Chief links the
report and lays out each reviewer's position.

### Shipping an approved code change

When you approve a code change (the engineer delivered it with an `execute`
step, and didn't say `ship: false`), the engineer carries on without being
asked:

1. **Publish:** Grove adds a step for the engineer:
   - push anything new to the draft PR and mark it **ready for review** (or,
     if there was no draft, commit, push and open the PR), with
     `Closes #<n>` for the issue it fixes;
   - do anything else you asked for when approving, such as closing a
     superseded PR;
   - start any GitHub comment with 🤖;
   - submit the PR link (Grove checks for it).
2. **Watch:** Grove itself polls the PR with `gh pr view` every 2 minutes. The
   engineer isn't woken and isn't pushed while checks run.
   - **Checks fail, a reviewer requests changes, or the branch conflicts:**
     Grove wakes the engineer with the details. It plans the fix (usually one
     execute step), and Grove goes back to watching. The same problem on the
     same commit isn't raised twice.
   - **Ready to merge** (checks done and passing, review approved, mergeable):
     the Chief asks you, and the inbox shows a **Merge** button.
   - **Merged** (by the engineer or anyone else): the task is done, and the Chief
     tells you.
   - **Closed without merging:** escalated to you.
3. **Merge:** when you say so, the engineer merges it the way the repository
   expects, never bypassing checks or reviews.

If you don't want a PR, the Chief approves with `ship: false`. If the draft
step said `NO PR`, approving simply finishes the task. If `gh` can't
read the PR, the engineer's sprite shows the error until it can.

### Blocked, on hold, and questions

Everything you say about a task goes through the Chief, who records it
(`grove_record_decision`) and messages the engineer:

| You… | Decision | What happens |
| --- | --- | --- |
| want everyone to stop for now | `hold` | Open reviews are cancelled (chats keep their transcripts). Nothing new starts, and the engineer isn't woken or pushed. |
| want them to continue | `resume` | The engineer carries on with its step, or the missing reviewers get their work again, in the same chats. |
| ask something about the work | `question` | The engineer finds out what it needs, answers with `grove_answer`, and the Chief brings you the answer. |
| want to steer a running task | `note` | The engineer (and its reviewers) see your words; nothing stops. |
| aren't ready to act on something waiting on you | `shelve` | It goes on the **shelf** (see below). |
| want a shelved task back in your inbox | `unshelve` | It's back exactly where it was. |

Status questions ("where are we?") aren't recorded: the Chief answers them
from `grove_status`.

**The shelf:** anything waiting on you (a sign-off, an escalation, a blocker, a
PR ready to merge) can be set aside for later with **Shelve** in the inbox, or
by telling the Chief.
- It leaves your inbox, and the Chief leaves the **Needs you** lantern if
  nothing else waits, so the lantern always means something needs you now.
- The engineer rests in its tent, which goes dark with a "z" drifting up. Its
  chat, its reviewers' chats, the draft PR and the report are all kept, and
  Grove doesn't wake or push it.
- Grove keeps watching a shelved task's PR. If the PR needs work (failing
  checks, requested changes, conflicts), the task comes off the shelf and goes
  back to the engineer.
- **To pick it up:** **Bring back** in the inbox's shelf puts it back in your
  inbox exactly where it was. Or attach it to chat and say what you want: any
  answer (approve, "run it again with this week's data", cancel) takes it off
  the shelf, and the same engineer, which remembers everything, does it.
- There's no timer: it waits until you bring it back.

**Blocked on you:** when something only you can do stands in the way (signing
in, access), the engineer calls `grove_blocked`, or a reviewer ends its review
with `BLOCKED: <what you must do>`.
- Everyone stops, and the Chief tells you exactly what to do. The task shows in
  your inbox, and whoever is blocked waits at the **Needs you** lantern.
- When you've done it, tell the Chief (or attach the task and say so). It
  records `retry`, and work continues in the same chats.
- There's deliberately no "retry" button: unblocking goes through the Chief.

**Status board:** engineers post progress with `grove_update`. It shows on the
tent's hover, in the inbox, in the task view and in the report, and
`grove_status` returns it.
- **The Chief's chat stays clear:** an engineer can't message the Chief except
  with Grove's notices (results, escalations, blockers, answers, a PR ready to
  merge), and reviewers can't message the Chief at all.

**Host message limits:** a hire that hits the host's limit on messages per
session isn't counted as a failure. It waits 15 minutes and retries in the
same chat. A reviewer's chat is only replaced when the host says it's gone, so
each reviewer keeps one chat for the whole task.

You can answer in the Chief's chat or from its **inbox** in the grove (see
[The canvas](#the-canvas)).

### The task report

Whenever a task comes back to you, for sign-off or for your input, Grove writes
a self-contained HTML page beside its evidence, at
`files/grove/<T>/report.html` in the Chief's session data. It's rewritten
when you decide. The canvas also serves it at `report/<T>/`.

It's styled as a higher-resolution version of the grove: the night sky and
treeline, parchment scrolls with gilded corners, rune tags, the team's real
sprites, and each step's workstation. The content changes with the task, but the order doesn't:
1. **Your move** (the summons scroll at the top): what's needed from you in
   one line, the engineer's `ask`, how to answer from the chat or the inbox, a
   brief summary, and a row of facts (the PR, how many pieces of evidence,
   criteria shown, verification and reviews).
2. **Pull request:** always shown for a code change, with its state, or why
   there isn't one.
3. **Evidence:** screenshots and screen recordings first, as a gallery.
   Click an image to enlarge it; recordings play in place. The verify step's
   evidence comes first, then anything saved during research or execute
   steps.
4. **Acceptance criteria:** each one with the evidence that proves it (matched
   by the criterion's text or number in `evidence.json`).
5. **Decisions:** the key decisions the engineer listed, each review's outcome,
   and what you asked for along the way.
6. **What the team did:** the result (the last research, execute or plan
   output), progress updates and questions.
7. **How it was done:** the team (the engineer and its reviewers), then every
   step with its output, each reviewer's verdict and the full review
   discussion, then the task's log.

The page has no scripts. Every value is escaped, and the step outputs'
Markdown is rendered as a safe subset. It also works on a phone and prints
cleanly.

Tasks run in parallel, one engineer session each.

### Models

| Session | Model | Set in |
| --- | --- | --- |
| Chief of Staff | Claude Opus 5.5 | `chief-of-staff.agent.md` |
| Engineer, `code` task | Claude Opus 5.5 | `ENGINEER_MODELS` in `lib/process/models.mjs` (`grove-engineer.agent.md` names the code model) |
| Engineer, `research` or `other` task | GPT-6.1 Sol | `ENGINEER_MODELS` |
| Security reviewer | Claude Opus 5.5 | `grove-reviewer-security.agent.md` |
| Code reviewer | Claude Opus 5.5 | `grove-reviewer-code.agent.md` |
| Architecture reviewer | GPT-6.1 Sol | `grove-reviewer-architecture.agent.md` |
| Tests reviewer | GPT-6.1 Sol | `grove-reviewer-tests.agent.md` |
| Custom-focus reviewers (accuracy, privacy…) | rotation: Grok 4.7, Gemini 4, GPT-6.1 Sol, Claude Opus 5.5 | `grove-reviewer.agent.md` |

- **How it applies:** VS Code uses the Chief's `model:` when you pick the
  agent. Engineers and reviewers aren't started *as* custom agents
  (`create_session` can't choose one), so Grove passes the model to
  `create_session` on every hand-off and hire, and puts each agent file's
  instructions in the session's brief. The `preToolUse` hook also sets the
  model, overriding a missing or different one, so no session inherits a
  lighter model from the chat that started it.
- **Rotation:** for the generic reviewer, the list is a rotation, not a
  fallback order: the first custom focus on a step gets Grok 4.7, the second
  Gemini 4, and so on.
- **To change a model,** edit the agent file (or `ENGINEER_MODELS`) and
  reinstall the plugin. `tests/agents.test.mjs` requires every agent to name
  one.
- **Reasoning effort and context size** can't be set per session:
  `create_session` only takes a model, so these follow the host's defaults.

### How work flows between sessions

```
you ──► Chief of Staff ──► T1 engineer ── plan · execute · verify (in its own chat, one skill per step)
            ▲   │               │
            │   │               ├──► T1 · Security / Tests / Architecture reviewers   (plan)
            │   │               ├──► T1 · Security / Tests / Code / Architecture      (execute; same chats)
            │   │               └──► T1 · Tests reviewer                               (verify; same chat)
            │   │                         └─ each reviews, then reports back to the engineer's chat
            │   └─ grove_record_decision ─► board ──► engineer wakes up and continues
            ├──── "[Grove → Chief of Staff] T1 is ready" + report ◄── board ◄── submissions and reviews
            │
   grove inbox (Complete / Dismiss) ─► board ──► engineer applies it (and wakes if work continues)
```

- **Down:** `grove_create_task` names the task and returns a hand-off (title, a short prompt with
  a one-time marker, and the model for the task's kind). The Chief starts the
  engineer with it. In the new session Grove turns the marker into the
  engineer's full brief: its standing instructions (`grove-engineer.agent.md`),
  the goal, the criteria, and the steps with their skills.
- **Work:** the engineer works each step in its own chat and submits it with
  `grove_submit`. Grove checks the output against the step's contract, records
  it on the board, and opens the review or starts the next step.
- **Reviews:** `grove_submit` (or `grove_next`) gives `create_session` the
  first time a specialty is needed, and `send_message` to that reviewer's chat
  after that. The engineer only passes a short hire marker; Grove, inside the
  reviewer's chat, expands it into the brief: the reviewer's persona, the
  `grove-review` skill, the task, the output under review, the results of
  earlier steps and the review discussion. When the reviewer's turn ends,
  Grove checks its verdict, writes it to the board, and has the reviewer
  **report to the engineer with `send_message`**, which starts the engineer's
  next turn. The engineer's Grove applies it (the engineer's session is the
  only writer of task state).
- **Up:** when a task needs you (a delivered result, an escalation, a
  blocker), the engineer **messages the Chief** (`grove_next` lists the
  message). Grove attaches the full details to that turn, and the Chief relays
  them to you.
- **Back down:** your answer goes to the Chief, which records it with
  `grove_record_decision` and **messages the engineer** with the result. The
  engineer's turn applies it and carries on.
- **Every hand-off is visible.** Each one is a `send_message` from one model
  to another, so it shows up as a turn in that chat in VS Code.
  - **Why not wake sessions directly?** Turns an extension starts itself (the
    SDK's `session.send`) don't appear in VS Code, and host tools such as tool
    search don't work inside them.
  - **Fallback:** Grove uses those direct wake-ups only if an expected message
    hasn't arrived within 45 seconds, or the engineer stopped in the middle of
    a step.

### How Grove enforces it

- **Roles:** each session runs its own copy of the extension, and Grove gives it
  a role.
  - **The Chief** can't hire agents or open `ask_user` forms, so it never
    blocks. It can only use `grove_*` tools, the session tools, the canvas and
    tool search: Grove refuses the shell, files, git and GitHub.
  - **An engineer** has the full toolset, including subagents for side
    lookups (they never count as reviews). It can't open `ask_user` forms
    (the human talks to the Chief), and it can only start sessions for its
    reviewers' tickets.
  - **The stop hook** sends an engineer back to work, at most 3 times, when it
    stops in the middle of a step without submitting, or while hires,
    messages or a decision (next steps or delivery) are waiting. It never
    does when the turn said and did nothing: the engineer is declining, for
    example because the Chief told it to hold, and every reply-less turn shows
    as an error in its chat. Grove's wake-ups try again later.
  - **Reviewers** have the full toolset too, but can't start sessions or
    message the Chief. Not modifying the project is in their instructions.
  - **Other sessions** are unaffected.
- **Tickets:** every reviewer session needs a ticket. Tickets carry a token,
  so an engineer can only hire for its own task, and a reviewer can only
  report on its own ticket.
- **Output checks:** `grove_submit` checks the engineer's output before
  recording it:
  - a plan must be complete;
  - research and execute outputs must say what was found or done (with valid
    `evidence.json` if they left evidence);
  - a verification must end with `RESULT: PASS` or `RESULT: FAIL` and leave a
    valid `evidence.json` with real image or video files;
  - Grove's PR steps must give the PR's link (`PR: <url>`), or `NO PR: <why>`
    for the draft.

  When a reviewer's turn ends (`agentStop` hook), Grove checks it ends with
  `VERDICT: APPROVE` or `VERDICT: CHANGES` (or `BLOCKED: <what the human must
  do>`) and sends it back for another turn if not.
- **Skills:** Grove watches the `skill.invoked` events in the engineer's
  session. Loading another kind of step's skill moves its sprite to that
  workstation, and submitting a step without its skill gets a reminder (not a
  refusal).
- **Recovery:** sessions keep their transcripts, so failures resume work
  instead of starting over.
  - **Engineer stops mid-step:** the stop hook sends it back; if its session
    goes idle anyway, Grove wakes it in the same chat, up to 3 times, then
    tells the Chief the task stalled.
  - **Reviewer turn ends without a verdict** (an error, for example): Grove
    nudges it to continue in the same chat, up to 2 times. If you stop it
    yourself, Grove leaves it alone until you message it.
  - **Reviewer gives up:** the engineer retries in the **same chat** (attempt
    2, 3), or in a new chat only if the host says the old one is gone. After 3
    failed attempts the task is escalated. Hitting the host's message limit
    isn't an attempt: the hire waits 15 minutes and goes to the same chat.
  - **Lost reviewer session:** if a hire isn't picked up within 5 minutes, or a
    working reviewer stops sending heartbeats for 4 minutes, it's retried.
  - **Lost engineer:** `grove_handoff` issues a new hand-off. The new engineer
    takes the task over and catches up from the board (`grove_next` shows the
    finished steps' results); the old one steps aside.

Process state is a **board** in the Chief's session data, at `files/grove/`:
- `board.json` holds task numbering, hand-offs and notices sent.
- `tasks/<T>.json` holds one task, including its reviewers' chat links. It's
  written only by that task's owner (its engineer).
- `results/<ticket>.json` holds one reviewer's progress heartbeats and final
  review. Only the reviewer session working that ticket writes it.
- `decisions/<T>.json` holds your decisions, from chat or the grove inbox.
  Only the Chief writes it.
- Evidence goes in `<T>/evidence/attempt-<n>/`, and the report in
  `<T>/report.html`.

Engineers and reviewers find the board through
`<COPILOT_HOME or ~/.copilot>/extension-data/grove-agent-monitor/boards/<board-id>.json`.

**Board format:** version 2 is the one-engineer process. A board from the
earlier process (version 1: a task lead with a persona session per step)
isn't migrated. Grove leaves it untouched and says so: start a new Chief of
Staff chat for a fresh board. The old reports and evidence stay on disk.

## The canvas

The canvas shows the team at work. Your **inbox** lives on the Chief of Staff:

- **Books over the Chief:** while tasks wait on you, books in their task
  colours float over the Chief at the **Needs you** lantern (three at most,
  then a count).
- **Click the Chief** (or the books), or use the **Inbox** button in the
  toolbar (which also shows the count), to open the inbox. It opens like a
  game's menu: a near full-screen panel over the dimmed grove. Press **Esc**,
  click **Close**, or click outside the panel to return to the grove.
- **One row per task**, in three sections: **Needs you**, **In progress** and
  **On the shelf**. Each row has the task's report book on the left, what it
  needs and a short summary in the middle, and its actions on the right, with
  the main one (Approve, Merge, Accept or Bring back) first and highlighted.
  On a narrow screen the actions wrap under the text. Each ask shows:
  - the task, what it needs (**Ready for sign-off** or **Needs your input**),
    how long it has waited, the engineer's ask and a short summary;
  - a **book** that opens the task's report in a new tab;
  - **Attach to chat:** your next message in the Chief's chat is about this
    task, so you can write "approve, but rename the flag" without naming it.
    The Chief records it as your answer, or as a note to the team if the task
    is still running. Attach several tasks to cover them in one message, and
    click again to remove one. Attached tasks show in the inbox and on the
    **Inbox** button.
    - **How it works:** VS Code doesn't show pills that extensions push into
      the chat input, so Grove doesn't use them. Grove keeps the attached tasks
      and adds them as context to your next message to the Chief, once. Its
      own relay messages don't use them up. The Chief names the task at the
      start of its reply, since the context isn't visible in chat. Only the
      Grove opened from the Chief's chat can attach.
  - **Complete** (sign off, or **Approve** for a code change, which then opens
    a PR; **Accept** for a stuck review, which puts the team back to work),
    **Merge** for a PR that's ready, **Shelve** (set it aside for later; see
    [the shelf](#blocked-on-hold-and-questions)), and **Dismiss** (cancel the
    task, after a second click to confirm).
  - **Blocked** tasks show what the team needs from you, with Attach, Shelve
    and Dismiss only: tell the Chief when it's done.
- **In progress:** tasks still running (including on hold, or watching a PR)
  are listed below the asks with the engineer's latest update, plus Attach and
  Dismiss.
- **On the shelf:** shelved tasks are listed last, with what they were waiting
  for, their report, and **Bring back**, Attach and Dismiss.
- **How inbox decisions travel:** Grove writes them to the board, where the
  task's engineer picks them up within a second, and wakes itself if work
  continues (shelving never wakes it). The inbox and the lantern change at
  once, without waiting for the engineer. The Chief hears what you decided at the start of its next turn.
  If the engineer's session isn't running, the Chief is asked to message it after
  45 seconds. Only the Grove opened from the Chief of Staff's chat can decide.

- **Sessions become sprites:** every session in the workflow is one character
  for the whole task. Its role picks its class:

  | Role | Class |
  | --- | --- |
  | Chief of Staff | archmage |
  | engineer | mage (dusk robe, with its task's pennant), a **shapeshifter** |
  | reviewer | seer (robe colour by specialty) |

- **Activities become places:** the engineer walks to the workstation for the
  step it's on:

  | The engineer is… | Where |
  | --- | --- |
  | planning, or choosing the next steps | the PLANNING star table |
  | researching | the RESEARCH bookshelf under the ancient tree |
  | executing (and opening, publishing or merging a PR) | the IMPLEMENTING forge |
  | verifying | the TESTING dummies |
  | with its reviewers | in their huddle at the REVIEW lectern (plans and research) or the CODE REVIEW mirror (changes and verification) |
  | waiting on you, on hold, or watching a PR | resting in its tent |
  | blocked on you | at the **Needs you** lantern next to the Chief |

  - **Shapeshifting:** the engineer is a mage on the move, but when it
    arrives at a station it transforms into the class that works there: a
    scribe at the star table, a scout at the bookshelf, an artificer at the
    forge, a warden at the dummies. A ring of light rises from its feet as it
    changes, and it changes back to a mage when it sets off again. Its robe
    stays the same colour, and its tooltip says which form it has taken.
  - **Detours:** the station follows the skills it loads. If it loads
    `grove-research` in the middle of an execute step, it walks to the
    bookshelf, and back to the forge when it loads `grove-execute` again.
  - Each review stands in its own **huddle** under a banner such as `T3 R2`
    (task and round). The speaker rotates while they discuss.
  - **Reviewers** walk to the huddle while they review, and rest in their
    team's **tent** between rounds (their chat stays open for the next
    round). A blocked reviewer waits at the **Needs you** lantern. The team
    leaves when the task is done.
- **Team tents:** when a task's team forms, it pitches a tent at camp in the
  task's colour, beside the fire.
  - Idle members walk into the tent and aren't drawn while inside, so a busy
    camp stays readable. The doorway glows while anyone is in.
  - **Hover** a tent to see the task, its stage, what it's blocked on, its PR,
    the engineer's latest update, who's resting inside (each reviewer with its
    last verdict: approved or changes) and who's out working. **Click** it to
    open the task view.
  - The tent comes down once the team has left.
  - There's no limit on tents. Ten pitch with room to spare on either side of
    the fire; further tents pack into the gaps between them, always clear of
    the fire's seats.
  - The **Chief** waits at the **Needs you** lantern whenever a decision is
    waiting for you, with its inbox books overhead. It sits at camp otherwise:
    always available.
- **Errors:** an agent with a problem shows a red **!** bubble and flickers.
  Click it for the reason. Agents with an error stay out by the fire rather
  than going into their tent. Errors come from:
  - **Session errors:** any session (the Chief, an engineer, or a reviewer)
    that hits an error in its chat, such as "No response was returned" or a
    failed model request. It shows until a turn goes through again, with a
    count when it repeats. Reviewers report it in their heartbeats, and an
    engineer's is stored on its task, so the Chief's grove sees both.
  - **Failed hires:** a hire that failed, for example because the host's
    message limit was hit or the session never started. The reason shows until
    the retry starts, even if the reviewer never got a chat.
  - **Stalled tasks:** an engineer that stopped responding.

  `grove_status` lists the same errors for the Chief.
- **Task names:** every task gets a mystical name, such as **Moonfern**, as
  well as its id (`T3`), so you can tell the Chief "ask Moonfern to…". Every
  Grove tool takes either. The name sits in a small line above the task's
  title in the inbox, the task strip, the task view, tent and agent tooltips,
  and the report, so the title keeps its room. Session titles use it too
  (`Moonfern · Add dark mode`).
  - Names come from `lib/process/names.mjs`. Each board starts at a different
    place in the list and takes the next name for each new task, so names
    never repeat on a board; after a full lap they gain a numeral
    (`Moonfern II`). Tasks made before names existed get theirs the same way
    when the board loads.
- **Many tasks at once:** every task gets a colour.
  - Each agent wears a **pennant** in its task's colour.
  - Review huddles fly a banner in it, and the team's tent is made of it.
  - The **task strip** under the scene shows one chip per task with its stage,
    or "Waiting for its engineer" until the engineer session picks the task up.
- **Task view:** click a task chip to see the task's steps. Above them: whether
  it's on hold or blocked, its PR, your open question and the engineer's updates. Pick a step to read
  its output, its review (round votes and every post) and, once delivered, the
  engineer's summary. **Report ↗** opens the task's report. It's read-only. Press
  **Escape** or **◀ Grove** to return.

## Using it

1. Install the plugin, then start a **new** chat with the **Chief of Staff**
   agent selected. The host must provide the session tools `create_session`
   and friends (the VS Code agent host does).
2. Ask for what you want. The Chief opens the Grove canvas, starts an
   engineer session per task, and is free again right away.
3. Keep talking to the Chief to start work. When a task needs you, the Chief
   links its report in chat, and the task appears in the Chief's inbox in the
   grove. Answer from either. Watch the team in the canvas, or open an
   engineer's session to follow it in detail.

The plugin also includes the engineer's phase skills (`grove-plan`,
`grove-research`, `grove-execute`, `grove-verify`) and the reviewers'
`grove-review`. They work outside Grove too: for example, ask any chat to
"verify this change with evidence" and it can use `grove-verify`.

And it includes the **`grove-sprites` skill**. It documents the
painted hi-detail sprite system (procedural painter, hue-shifted ramps, soft glow), character classes, workstation layout and art
direction, plus the workflow for validating sprites, viewing them, and
capturing snapshots.

## Contents

```
.plugin/plugin.json
agents/                  # chief-of-staff, grove-engineer, grove-reviewer (+ -security/-tests/-code/-architecture)
extensions/grove-agent-monitor/
  extension.mjs          # SDK wiring: canvas, grove_* tools, hooks
  lib/process/           # engine (stages, steps, reviews), shared board, roles/relay/hooks/tools, briefs, evidence, report
  lib/                   # HTTP/SSE runtime, schemas, scene ops, atomic storage
  web/                   # Canvas page: model, engine/, sprites/, scene/, tasks.mjs (strip + forum view), inbox.mjs
tests/process.test.mjs   # end-to-end process tests (simulated Chief, engineer and reviewer sessions)
tests/report.test.mjs    # task report rendering and the canvas's report/inbox routes
tests/engine.test.mjs    # engine alone: submissions, reviews, hold, blockers, questions, shipping a PR, limits
tests/agents.test.mjs    # agent and skill front matter
skills/grove-plan/, grove-research/, grove-execute/, grove-verify/   # the engineer's phase skills
  grove-verify/scripts/check-evidence.mjs                            # checks evidence.json the way Grove does
skills/grove-review/     # how reviewers review (Grove adds it to every reviewer's brief)
skills/grove-sprites/
  SKILL.md               # Sprite system + art direction
  scripts/validate-sprites.mjs
```

## Canvas reference

### Grove tools

| Tool | Who | Description |
| --- | --- | --- |
| `grove_create_task` | Chief | Open a task `{ title, goal, kind, destination, criteria? }`. Pass the exact returned handoff to `create_session`; workspace/worktree are omitted for scratch. |
| `grove_handoff` | Chief | Get a fresh hand-off for a task whose engineer never started, stalled or was lost. The new engineer picks the task up from the board. |
| `grove_record_decision` | Chief | Record what the human decided, asked or said: `approve` (`ship: false` to skip the PR), `changes`, `note`, `question`, `hold`, `resume`, `retry`, `merge` or `cancel`, with their words as `note`. Grove checks it applies to the task's stage. It returns the message to send the engineer. |
| `grove_cancel_task` | Chief | Cancel a task. |
| `grove_status` | anyone | Show each task's stage, kind, engineer and reviewers (with chat links), steps and their review votes, recent history, and what's waiting on the human. |
| `grove_plan_steps` | engineer | Choose or change the route: `{ template?, steps?: [{ kind, title?, brief?, reviewers? }], replace?, redoFrom?, note? }`. Returns what to do next, like `grove_next`. |
| `grove_next` | engineer | What to do now: the assignment for the step in progress (`work`: skill, brief, review feedback, evidence folder), reviewer hires to make (`create_session` with `title`, `prompt`, `relationship: "currentSession"`, `model` for a new reviewer, or `send_message` with `session`, `message` for one who has a chat), messages to send the Chief, and, when no step is running, the results and what to decide. |
| `grove_submit` | engineer | Submit the step in progress: `{ step, output }`. Grove checks it against the step's contract and records it; if the step has reviewers, it returns their hires. |
| `grove_deliver` | engineer | Hand the result to the human: `{ summary, ask?, decisions?, ship? }`, where `ask` is the one thing the engineer needs from the human (shown at the top of the report and in the inbox), `decisions` are the key decisions made, each with its reason, and `ship: false` means there's no PR. For a code change, Grove first adds a step for the engineer to open a draft PR, then brings it for sign-off. Grove writes the task report. Returns the report's path and the message to send the Chief. While a PR is under watch, it hands back to watching instead. |
| `grove_update` | engineer | Post progress on the task's status board: `{ text }`. |
| `grove_blocked` | engineer | Stop the task until the human does something only they can: `{ need, reason? }`. Returns the message to send the Chief. |
| `grove_answer` | engineer | Answer the human's open question: `{ text }`. Returns the message to send the Chief. |

### Canvas actions

These are mostly used for manual scenes and demos. Process agents appear automatically.

- **Canvas id:** `grove-agent-monitor`
- **Open input:** `{ "scene"?: string }`. The scene name is the durable
  identity and defaults to `"default"`.
- **Actions:**

| Action | Description |
| --- | --- |
| `getState` | Return agents, the council, the theme, station visibility and the viewer count. |
| `hireAgent` | Hire an agent: `{ id, role, name?, palette?, activity?, task? }`. It walks in from the road. |
| `updateAgent` | Change an agent: `{ id, activity?, task?, error?, name?, role?, palette? }`. On an activity change, the agent walks to that station. |
| `dismissAgent` | Dismiss an agent: `{ id }`. It walks out of the grove. |
| `convene` | Gather agents at the council ring: `{ topic, members[] }`. |
| `resolveCouncil` | End the council: `{ decision?, next? }`. The decision is announced, and members return to their prior activities (or `next`). |
| `configureScene` | Change the scene: `{ theme?: night\|dusk\|dawn, stations?: { <station>: boolean } }`. |
| `clearAgents` | Dismiss everyone. |
| `summonDemo` | Hire a demo party: `{ cycle?: boolean }`. By default the party keeps moving. |
| `setView` | Switch views: `{ view: "scene" \| "gallery" }`. |
| `snapshot` | Return a PNG of the visible canvas so an agent can see it: `{ scale?: 1–4 }`. |

Field values:

- **Roles:** `orchestrator`, `engineer`, `planner`, `implementer`, `reviewer`, `tester`, `researcher`, `generalist`.
- **Activities:** `idle`, `planning`, `plan-review`, `implementing`, `code-review`, `testing`, `research`, `waiting`, `done`.
  - To send agents to council, use `convene` instead of setting an activity.

In the canvas, click an agent to see its name, class, station and task (click
again, elsewhere, or press Escape to hide it). Hovering only highlights it, so
details don't flicker past as agents walk.

State is stored privately under
`<COPILOT_HOME or ~/.copilot>/extension-data/grove-agent-monitor/scenes/<scene>.json`.
Writes are atomic, and each file includes a format marker and version.

## Development

```sh
node tests/process.test.mjs                              # process engine, roles, relays (simulated sessions)
node tests/engine.test.mjs                               # engine alone: hold, blockers, questions, shipping, limits
node tests/placement.test.mjs                            # routing, Git identity, reviewer revisions, consent (temporary fixtures)
node tests/agents.test.mjs                               # agent front matter is valid
node tests/scene.test.mjs                                # team tents: pitch, rest inside, strike
node tests/report.test.mjs                               # task report, report/evidence/inbox routes
node skills/grove-sprites/scripts/validate-sprites.mjs   # lint sprites
node --check extensions/grove-agent-monitor/extension.mjs
```

After you edit files in `web/`, reload the canvas page. After you edit
`extension.mjs` or `lib/`, reload extensions.

Member sessions may run in a sandbox. Session data, which holds Grove
evidence, is writable, but locations such as `/tmp` may not be. Plans should target the
workspace or session data.
