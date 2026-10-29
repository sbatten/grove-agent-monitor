---
name: grove-research
description: 'Find something out and report checkable findings: data and telemetry, issues and pull requests, code, docs, the web. Use for the research step of a Grove task, or whenever asked to investigate and answer a question with evidence.'
---

# Researching a question

The goal of this step is an answer the human can trust and a reviewer can check.

- **Use whatever sources fit:** the codebase, issues and pull requests, telemetry and data tools (for example Kusto), docs and the web.
- **Don't modify anything** while researching: no code, issues, labels or data. (Saving evidence files, below, is fine.)
- **Make the answer checkable.** Cite file paths, line numbers, issue numbers and URLs. Include the exact queries you ran, with their time windows and filters.
- **Separate verified facts from inference.** Say what you assumed and what is uncertain.
- **Answer the question first,** then show how you got there.
- **Be complete.** Lists (issues, files, people) should cover everything that meets the criteria. If you had to cut a list short, say how and why.
- **Show it when it helps.** A chart, or a screenshot of the query and its results, often says more than a table. If you have an evidence folder, save it there with an `evidence.json` (see the `grove-verify` skill for the format); it leads the human's report.

## Revising

If reviewers ask for changes, address every point, and re-check anything they doubted rather than defending it from memory.

## In Grove

Submit your report with `grove_submit`: the answer first, then how you got it (queries, sources, file paths, links), then what's uncertain or assumed.
