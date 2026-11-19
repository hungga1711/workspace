# frontend/desktop

The workspace desktop app (macOS, Windows, Linux), built with [Tauri 2](https://tauri.app).

It is a window onto the company's own workspace server: it loads the same web app a browser does
([../web](../web/)), so every screen, fix and feature reaches the desktop with the server's next deploy. There is no
second UI and no build of the web app inside the desktop app. The only page of its own is
[connect/index.html](connect/index.html), shown until a server address is saved.

What the desktop adds to the web app:

- **Server address**, kept in the app's config directory (`server.json`). Nobody types it:
  - The person who set up the server builds the app with its address built in (see *Build for your company*).
  - *Profile › Desktop app › Open in app* in the web app opens `workspace://open?server=<this server>&path=/app`; the
    app saves that address (if it has none) and opens the page. A link to a different server than the saved one shows
    the connect page with it filled in, so a stray link cannot switch servers silently.
  - A managed install (MDM, Intune) can set `WORKSPACE_URL` in the environment.
  - Only a copy built without an address and opened directly shows the connect page; *Go › Change server…* asks again.
- **Notifications**: the web app's `new Notification(...)` (an incoming call while the window is hidden) shows a system
  notification, through the notification plugin. Only the saved server's pages get that permission, nothing else.
- **Links and windows**: a link to another site opens in the default browser; a new window of the app itself (a
  meeting, a call) opens as another app window.
- **Downloads** go to the Downloads folder (never over an existing file) and are shown when done.
- One instance at a time, window size and position remembered, *Go* menu (Back `⌘[`, Forward `⌘]`, Reload `⌘R`).

Web push (the service worker) is not available inside the system webview, so notifications for new messages and tasks
arrive while the app runs only if the web app shows them; the app's own notification list works as in a browser.

## Build for your company

There are no prebuilt downloads: each company builds its own app, with its server's address built in.

```bash
pnpm install
pnpm desktop:build https://work.company.com   # the address staff open workspace at
```

Run it on each kind of computer staff use: a Mac builds the macOS app, Windows the Windows installers, Linux the Linux
packages. It needs Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/). The installers land in
`dist/`. Put them where staff can download them (a shared drive, an intranet page) and paste that link in
*Admin › Settings › Desktop app*; Profile then shows *Download* and *Open in app* (on computers, not phones).

## Develop

Needs Rust (stable) and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) of your OS.

```bash
pnpm install
pnpm --filter @workspace/desktop dev      # opens the app; connect to http://localhost:3000 for a local web app
pnpm --filter @workspace/desktop build    # installers in src-tauri/target/release/bundle/
pnpm --filter @workspace/desktop icons    # after changing icon.svg (the brand mark, lib/brand-mark.ts in the web app)
```

`src-tauri/src/lib.rs` is the whole app. Change the web app, not this package, for anything a person sees after
connecting.

## Not yet

- Windows the app opens itself (a meeting, a call) cannot show system notifications: WebKit's linked popups do not
  get the app's IPC. The main window, where an incoming call rings, can.
- Tray unread count, global shortcut, push for new messages while the window is closed.

## Release

Unsigned builds run after the OS's "unknown developer" prompt (macOS: right-click › Open the first time). Signing (Apple Developer ID and notarisation, a Windows
code-signing certificate) and auto-update (the Tauri updater with its own key pair) are not set up yet.
