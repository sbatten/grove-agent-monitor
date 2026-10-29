---
name: grove-verify
description: 'Prove a change works with visual evidence (screenshots, screen recordings, rendered output) a human can check just by looking, and write evidence.json. Use for the verify step of a Grove task, or whenever asked to verify a change with evidence.'
---

# Verifying with visual evidence

The goal is to let a human confirm the change **just by looking**, without running or clicking anything themselves. Evidence goes in the evidence folder you were given. It's in session data, not the workspace.

## 1. Exercise every acceptance criterion for real

Run the app or command, drive the UI, and trigger the edge cases the plan lists. Never fabricate output. If something fails, still capture evidence of the failure.

## 2. Capture images or recordings

Before/after pairs are best.
- **Web UI:** use the browser tools (`openBrowserPage`, `screenshotPage`, `runPlaywrightCode`…; find them with tool search if they aren't loaded). Save screenshots to files, for example with `runPlaywrightCode` and `await page.screenshot({ path: '<evidence folder>/after.png', fullPage: true })`, or `npx playwright screenshot <url> <file>`.
- **Interactions** (animation, drag, multi-step UI): a short screen recording shows them best. Playwright records `.webm` with `browser.newContext({ recordVideo: { dir: '<evidence folder>' } })`; rename the file it writes to something meaningful.
- **macOS desktop:** `screencapture -x <file>.png`. A recording from `screencapture -v` is a `.mov`, which isn't accepted: convert it with `ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p out.mp4` if ffmpeg is available, or record with Playwright instead.
- **CLI, tests or logs:** render the real output into an image, for example an `.svg` with monospaced `<text>` lines of the actual output, or an HTML page that you screenshot.
- **Data and behaviour:** charts or diagrams generated from real runs.

Allowed files: `.png .jpg .jpeg .gif .webp .svg .mp4 .webm`, 25 MB each at most, with plain file names directly in the evidence folder.

## 3. Write evidence.json

In the same folder:

```json
{
  "summary": "One paragraph: what was verified and the outcome.",
  "items": [
    { "file": "after.png", "caption": "What this shows", "criterion": "Which acceptance criterion it proves" }
  ]
}
```

Check it with the script in this skill's folder: `node <this skill's folder>/scripts/check-evidence.mjs <evidence folder>`. It applies the same rules Grove does.

## 4. Leave the project alone

Don't change the project's source while verifying. Only write in the evidence folder and temporary locations. If verification shows something needs fixing, report it; the fix is a separate step.

## In Grove

Submit the verification report with `grove_submit`: each criterion → its evidence files → the result. The last line must be exactly `RESULT: PASS` or `RESULT: FAIL`. Grove won't accept it until `evidence.json` and its files are valid. A reviewer then opens your evidence and checks it against the criteria.
