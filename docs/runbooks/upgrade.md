# Upgrade

Releases are images tagged by version (`ghcr.io/hungga1711/workspace:1.0.0`); read the release notes
(`CHANGELOG.md`) for anything to do by hand before upgrading.

## With upgrade.sh (recommended)

In `infra/production/`:

```bash
./upgrade.sh 1.0.0
```

A bare tag keeps the repository of `WORKSPACE_IMAGE` in `.env` (`ghcr.io/hungga1711/workspace` after `install.sh`);
pass a full reference (`ghcr.io/hungga1711/workspace:1.0.0`) when `.env` points at a locally built `workspace:local`.

1. `backup.sh` into `./backups` (skip with `--no-backup`).
2. Pulls the new image. If that fails, nothing has changed.
3. Writes `WORKSPACE_IMAGE` in `.env`.
4. Runs the migrations (`docker compose run --rm --no-deps app migrate`).
5. Restarts the app on the new image (`docker compose up -d`).
6. Waits up to 5 minutes for `app` to report healthy.

When step 4, 5 or 6 fails it writes the previous image back into `.env` and starts it again, and prints what to do
next. The previous tag is kept in `.upgrade-previous` after a successful upgrade.

## Rolling back

Migrations are forward-only (`NNN_name.sql`, never edited once released) and are written so the previous release
still runs on the migrated database (new columns have defaults, nothing the previous release reads is dropped in
the same release). So the usual roll-back is:

```bash
./upgrade.sh "$(cat .upgrade-previous)" --no-backup
```

When a release says it is not backward compatible, or the previous image fails on the new schema, restore the
backup taken in step 1:

```bash
docker compose down -v                          # deletes the volumes of this installation
./restore.sh backups/workspace-<date> --yes     # the backup upgrade.sh just made
```

## Built from source

Installations that build the image (`WORKSPACE_IMAGE=workspace:local`):

```bash
./backup.sh
git pull && docker compose build
docker compose up -d       # the app restarts on the new image, migrating before it serves
```

Tag the old image first (`docker tag workspace:local workspace:previous`) to keep a roll-back target:
`./upgrade.sh workspace:previous`.

## Schedule

There is no automatic upgrade. To follow releases, watch the repository's releases. Upgrades take the app down
for about a minute while it restarts (the migrations of a release usually take seconds).
