# Installing the extension for a whole company

People can install workspace AI Insights from the Chrome Web Store or Edge Add-ons themselves, but a company usually
pushes it with browser policy so everyone has it without developer mode or a store visit. The extension still
records nothing until each person pastes their own connection code from workspace › Me › My AI, and every AI page
shows its notice.

Replace `<EXTENSION_ID>` with the store ID (Chrome Web Store and Edge Add-ons give different IDs; use each
browser's own). The update URLs below are the stores' standard ones.

| Browser | Update URL |
|---|---|
| Chrome | `https://clients2.google.com/service/update2/crx` |
| Edge | `https://edge.microsoft.com/extensionwebstorebase/v1/crx` |

## Chrome

### Google Admin console (Chrome Enterprise or Workspace-managed browsers)

Devices › Chrome › Apps & extensions › Users & browsers › pick the org unit › **+** › Add from Chrome Web Store ›
search "workspace AI Insights" › Installation policy: **Force install**. Optionally pin it to the toolbar.

### Windows (Group Policy or registry)

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist]
"1"="<EXTENSION_ID>;https://clients2.google.com/service/update2/crx"
```

Group Policy: Computer Configuration › Administrative Templates › Google › Google Chrome › Extensions ›
"Configure the list of force-installed apps and extensions" › add `<EXTENSION_ID>;https://clients2.google.com/service/update2/crx`.

### macOS (configuration profile)

Deploy with Jamf, Kandji, Intune or any MDM as a custom settings payload for the domain `com.google.Chrome`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>ExtensionInstallForcelist</key>
  <array>
    <string><EXTENSION_ID>;https://clients2.google.com/service/update2/crx</string>
  </array>
</dict>
</plist>
```

### Linux

`/etc/opt/chrome/policies/managed/workspace-ai.json`:

```json
{ "ExtensionInstallForcelist": ["<EXTENSION_ID>;https://clients2.google.com/service/update2/crx"] }
```

## Microsoft Edge

### Intune

Devices › Configuration › Create › Settings catalog › Microsoft Edge › Extensions › "Control which extensions are
installed silently" › Enabled › add `<EXTENSION_ID>;https://edge.microsoft.com/extensionwebstorebase/v1/crx`.

### Windows registry

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist]
"1"="<EXTENSION_ID>;https://edge.microsoft.com/extensionwebstorebase/v1/crx"
```

### macOS

The same profile as Chrome with the payload domain `com.microsoft.Edge` and the Edge update URL.

## Before the store listing is live

For a pilot, self-host the package: build `workspace-ai.zip` (`pnpm --filter @workspace/web ext:zip`), pack it as a
`.crx` with Chrome's "Pack extension", serve it with an update manifest from your own HTTPS server, and use that
manifest URL in `ExtensionInstallForcelist` instead of the store URL. Chrome on Windows and macOS only accepts
self-hosted extensions on managed (enrolled) devices.

## Checking it worked

`chrome://policy` (or `edge://policy`) lists `ExtensionInstallForcelist` with status OK, and `chrome://extensions`
shows the extension as "Installed by your administrator". The person then opens it once and pastes their connection
code.
