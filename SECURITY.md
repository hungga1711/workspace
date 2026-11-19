# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Report them privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability** (GitHub private vulnerability reporting / security advisories).
Include what you found, how to reproduce it, the affected version or commit, and the impact you expect.

We aim to acknowledge a report within a few working days, keep you updated while we work on a fix,
and credit you in the advisory unless you prefer otherwise. Please give us a reasonable time to
release a fix before disclosing the issue publicly.

## Supported versions

Security fixes land on the `main` branch and ship in the next release. Only the latest release is supported;
upgrade with `upgrade.sh` ([docs/runbooks/upgrade.md](docs/runbooks/upgrade.md)).

## Scope

In scope: the code in this repository (web app, backend server and its modules, packages, the browser extension,
and the deployment configuration under `infra/`). Out of scope: vulnerabilities in third-party components
(Postgres, Caddy, SeaweedFS, LiveKit, …) that should be reported upstream, and issues that need a
misconfigured installation (for example the development-only variable `WEBHOOK_ALLOW_PRIVATE` set in
production).

## Verifying the image

Images published to GHCR from `main` and from releases are signed keylessly with
[cosign](https://docs.sigstore.dev/) by `.github/workflows/image.yml` (called by the CI and release workflows), and
carry an SPDX SBOM attestation (the SBOM is also attached to each GitHub Release):

```bash
cosign verify ghcr.io/hungga1711/workspace:<version> \
  --certificate-identity-regexp '^https://github.com/hungga1711/workspace/\.github/workflows/image\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
