#!/usr/bin/env node
/**
 * Event operations tool (docs/runbooks/operations.md#events).
 *
 *   dlq list                        dead letters per schema and consumer group: waiting, total
 *   dlq show [<group>] [--all]      what is waiting (or everything with --all): group, event, reason
 *   dlq replay <group> [--dry-run]  replay that group's waiting dead letters, to it only
 *   dlq outbox-replay <schema> <group> [--type <t>]... [--since <iso>] [--until <iso>] [--dry-run]
 *                                   re-send events kept in a module's outbox to one group
 *
 * Replays are requests written to the database: the running server delivers them within seconds (events are
 * delivered inside its process, ops/dlq.ts). MIGRATE_DATABASE_URL (owner role on the workspace database; default
 * local dev). Exits 1 from `list` when anything is waiting, so it can gate a health check.
 */
import { listDlq, readDlq, replayDlq, replayFromOutbox } from "../ops/dlq.js";

const [cmd, ...args] = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--") && !["--type", "--since", "--until"].includes(a)));
const valuesOf = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]!] : []));
const positional = args.filter((a, i) => !a.startsWith("--") && !["--type", "--since", "--until"].includes(args[i - 1] ?? ""));

async function main(): Promise<number> {
  switch (cmd) {
    case "list": {
      const rows = await listDlq();
      if (!rows.length) console.log("No dead letters.");
      for (const r of rows)
        console.log(
          `${r.waiting > 0 ? "!" : " "} ${r.schema.padEnd(9)} ${r.consumer.padEnd(22)} ${r.stream.padEnd(34)} waiting ${String(r.waiting).padStart(5)}   total ${String(r.total).padStart(5)}`,
        );
      return rows.some((r) => r.waiting > 0) ? 1 : 0;
    }
    case "show": {
      const rows = await readDlq({ ...(positional[0] ? { consumer: positional[0] } : {}), onlyWaiting: !flags.has("--all"), limit: 200 });
      if (!rows.length) console.log("Nothing waiting.");
      for (const m of rows)
        console.log(
          `${m.schema}#${m.id}  ${m.failedAt}  ${m.consumer}  ${m.eventType ?? "(malformed)"} ${m.eventId ?? ""}${m.replayedAt ? `  replayed ${m.replayedAt}` : ""}\n    ${m.reason}`,
        );
      return 0;
    }
    case "replay": {
      const group = positional[0];
      if (!group) break;
      const dryRun = flags.has("--dry-run");
      const n = await replayDlq(group, { dryRun });
      console.log(
        dryRun ? `${n} dead letter(s) of ${group} would be replayed.` : `Requested a replay of ${n} dead letter(s) to ${group}; the running server delivers them within seconds.`,
      );
      return 0;
    }
    case "outbox-replay": {
      const [schema, group] = positional;
      if (!schema || !group) break;
      const dryRun = flags.has("--dry-run");
      const since = valuesOf("--since")[0];
      const until = valuesOf("--until")[0];
      const date = (flag: string, v: string) => {
        const d = new Date(v);
        if (Number.isNaN(d.getTime())) throw new Error(`${flag} expects an ISO date, got ${v}`);
        return d;
      };
      const n = await replayFromOutbox({
        schema,
        group,
        types: valuesOf("--type"),
        ...(since ? { since: date("--since", since) } : {}),
        ...(until ? { until: date("--until", until) } : {}),
        dryRun,
      });
      console.log(
        dryRun ? `${n} event(s) from ${schema} would be sent to ${group}.` : `Queued ${n} event(s) from ${schema} for ${group}; the running server delivers them within seconds.`,
      );
      return 0;
    }
  }
  console.error(
    "usage: dlq list | dlq show [<group>] [--all] | dlq replay <group> [--dry-run] |\n       dlq outbox-replay <schema> <group> [--type <t>]... [--since <iso>] [--until <iso>] [--dry-run]",
  );
  return 2;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
