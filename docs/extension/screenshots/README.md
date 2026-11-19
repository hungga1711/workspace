# Store screenshots

1280×800 PNGs for the Chrome Web Store, Firefox Add-ons and Edge listings, taken headless on a neutral fake chat
page (no AI vendor's branding) with the extension loaded unpacked and connected to a fake workspace:

| File | Shows |
|---|---|
| `1-notice.png` | The notice pill in the corner, expanded: what is recorded and the link to Me › My AI |
| `2-redact.png` | The sensitive-data filter in redact mode: the text that will be sent, with `[KEYWORD]`, `[EMAIL]`, `[PHONE]`, `[CCCD]` |
| `3-feedback.png` | The one-tap "Did AI help?" chip after an answer |
| `4-block.png` | Block mode: the message with a card number was not sent |
| `5-options.png` | The options page: connection status and the task-hint option |
| `6-link.png` | After a prompt that names a task (`Summarise T-157 …`): the "Link this chat to T-157 in workspace?" chip |

Regenerate (English UI; Chromium takes the `_locales/en` texts from `--lang=en-US`):

```bash
cd frontend/web && EXT_SHOTS=1 pnpm test:ext
```

The capture is `frontend/web/e2e-extension/screenshots.spec.ts`, skipped unless `EXT_SHOTS=1`, so the normal
`pnpm test:ext` run does not write files. For the 640×400 variant Chrome also accepts, downscale with
`sips -z 400 640 <file>` on macOS or any image tool.
