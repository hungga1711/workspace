# frontend/

Every client of workspace. They all talk to the same backend through the gateway (`/api/*`).

| App | Status | Stack | Guide |
|---|---|---|---|
| [web](web/) | Production | Next.js 15, React 19, Tailwind CSS v4; also the BFF and the PWA | [web/AGENTS.md](web/AGENTS.md) |
| [desktop](desktop/) | New | Tauri 2: a window onto the server's web app, plus notifications and downloads | [desktop/README.md](desktop/README.md) |
| [browser-extension](browser-extension/) | Production | Chrome/Edge MV3, plain JS | [browser-extension/README.md](browser-extension/README.md) |

Shared rule: clients hold no business logic the backend doesn't enforce. Authorization and
validation live in the backend; clients render and call.
