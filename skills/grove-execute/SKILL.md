---
name: grove-execute
description: 'Carry out a change: usually code in the workspace following an approved plan, sometimes another action such as filing or labelling issues. Use for the execute step of a Grove task, including fixing a pull request after checks fail or reviewers ask for changes.'
---

# Carrying out the work

- **Follow the approved plan,** with small, focused changes that match the codebase's conventions. If the plan is wrong in a detail, make the smallest sound correction and say so. Never silently expand the scope.
- **Build and run the relevant tests,** and report the real results, including failures.
- **Don't commit or push** unless the step asks you to. Grove has you open a draft pull request when the work is delivered.
- **When the work is in a pull request,** push further changes to its branch (the same worktree or folder), so it stays up to date. When fixing a PR, reply on it to say what you changed. Start any comment you write on GitHub with 🤖.
- **Show the change when it helps:** before and after screenshots, or a short screen recording, in your evidence folder with an `evidence.json` (see the `grove-verify` skill). It leads the human's report.

## Revising

If reviewers ask for changes, resolve every blocking point and every piece of feedback, and say how you addressed each one. End with a section `## Response to reviewers`.

## In Grove

Submit a summary with `grove_submit`:
- what you changed or did (files, systems) and why;
- the behaviour change;
- how reviewers can inspect it, such as which `git diff` paths to read;
- build and test results;
- anything not done.
