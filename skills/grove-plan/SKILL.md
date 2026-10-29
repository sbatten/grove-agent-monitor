---
name: grove-plan
description: 'Plan a change before making it: investigate, then write a plan another engineer could follow (steps, files, risks, acceptance criteria and how it will be verified). Use for the plan step of a Grove task, or whenever asked to plan a change without making it yet.'
---

# Planning a change

The goal of this step is a plan that someone else could carry out without guessing, and that reviewers can approve or challenge.

## Investigate first

- Read the code and anything else the change touches. Follow the real call paths, and check how similar things are already done.
- Don't change the project yet. Inspect freely: read code, run read-only commands and existing scripts with no side effects, search the web, and use any other tools that help.
- Note what you're unsure of. A question you can answer now by reading or running something is cheaper than a wrong plan.

## Write the plan

In Markdown, with these parts:
1. **Overview:** what changes and why, in a few sentences.
2. **Steps:** the work, in order.
3. **What changes:** the files, components, systems and data or API changes.
4. **Risks and mitigations:** what could break, and how you'll avoid or detect it.
5. **Acceptance criteria:** refine the ones you were given so each can be checked.
6. **Verification:** how the result will be proved. For anything a human should see, say which screenshots or recordings will prove each criterion.

Keep it as small as the task allows. Don't plan work nobody asked for.

## Revising

If reviewers ask for changes, address every objection by name: change the plan where they're right, and argue where you disagree. End with a section `## Response to reviewers`. The revised plan must actually change; resubmitting the same text sends the step to the human.

## In Grove

Submit the plan with `grove_submit` (the whole plan is the output). If the step has reviewers, make the hires it returns and end your turn.
