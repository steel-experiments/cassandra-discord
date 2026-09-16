# Back up and restore

Cassandra keeps all mutable state in `DATA_DIR`. With the container defaults,
the database is `/app/data/cassandra.sqlite` and backups are written to
`/app/data/backups`.

The export and restore commands below cover the two supported install kinds:
Docker Compose (including the released image) and Railway. Run every restore
against a disposable volume first. A backup that was never restored is an
untested backup.

## Create an online backup

From Discord:

```text
/cassandra backup
```

The command queues a durable backup job, replies immediately with a short job
ID, and sends the requesting admin a best-effort DM after the backup passes
integrity verification. The notification states that the DM inbox is not a
conversational surface and directs questions to an explicit `@Cassandra`
mention in the server. `/cassandra status` shows the latest backup age and the
durable job's queued, retrying, running, succeeded, or failed state. Railway
and Coolify logs also contain structured `backup.started`,
`backup.succeeded`, and `backup.failed` events.

From a built source checkout:

```bash
npm run backup
```

The CLI needs `DATABASE_PATH`, `DATA_DIR`, and optionally `BACKUP_DIR`. It
does not need Discord or model credentials.

Each successful backup creates:

- `cassandra-YYYYMMDD-HHMMSS.sqlite`
- `cassandra-YYYYMMDD-HHMMSS.sqlite.manifest.json`

The manifest records the application version, schema version, source path,
timestamp, SHA-256 digest, file size, and integrity result.

Cassandra uses SQLite's online backup API. Do not copy only the live
`.sqlite` file while WAL mode is active; committed pages may still be in the
WAL.

## Export a backup off the host

A backup file under `/app/data/backups` is still on the application volume.
Copy both the `.sqlite` file and its matching `.manifest.json` to separate
storage, then verify the copy with the recorded digest.

### From Docker Compose

List the completed backups and copy one out with the service name from your
Compose file (`cassandra` in the repository files):

```bash
docker compose exec cassandra ls -1 /app/data/backups

docker compose cp \
  cassandra:/app/data/backups/cassandra-YYYYMMDD-HHMMSS.sqlite .
docker compose cp \
  cassandra:/app/data/backups/cassandra-YYYYMMDD-HHMMSS.sqlite.manifest.json .
```

Verify the copy against the manifest:

```bash
jq -r .sha256 cassandra-YYYYMMDD-HHMMSS.sqlite.manifest.json
shasum -a 256 cassandra-YYYYMMDD-HHMMSS.sqlite
```

The two values must match character for character. When they differ, delete
the copy and export again.

### From Railway

> The export drill ran against a live Railway service on 2026-09-16: the
> online backup, the manifest checksum, the off-platform copy, and the decoded
> file all matched. Run it on a disposable service when you rehearse a
> restore.

Install the Railway CLI and log in. Run the checksum and the copy through
`railway ssh` against your service. The `railway ssh -- <command>` form may
mangle quotes and pipes. Prefer to open the session with
`railway ssh --service <service-name>` and run each command interactively
inside it, or wrap the command in `sh -c '...'`:

```bash
# Digest of the backup on the volume.
railway ssh --service <service-name> -- \
  "sha256sum /app/data/backups/cassandra-YYYYMMDD-HHMMSS.sqlite"

# Copy the file out as base64, decode it locally.
railway ssh --service <service-name> -- \
  "base64 /app/data/backups/cassandra-YYYYMMDD-HHMMSS.sqlite" \
  | tr -d '\r' | base64 -d > cassandra-YYYYMMDD-HHMMSS.sqlite
```

Then verify the export:

```bash
shasum -a 256 cassandra-YYYYMMDD-HHMMSS.sqlite
jq -r .sha256 cassandra-YYYYMMDD-HHMMSS.sqlite.manifest.json
```

The `railway ssh` session prints session text around the command output. The
digest comparison is the authority: when the local digest does not match the
manifest, the transfer was damaged. Delete the file and export again. Fetch
the manifest with the same `base64` method when you do not have it locally.

Keep the exported pairs in your off-host backup system. `BACKUP_RETENTION_DAYS`
controls local rotation on the volume only. It does not remove off-host
copies. Set off-host retention separately and document it in the member
privacy notice.

Reasonable starting objectives are a 24-hour recovery point and a two-hour
manual recovery time. Adjust `BACKUP_INTERVAL_HOURS` and off-host copy
frequency if those targets are too loose.

## Test a backup

Run restore drills on another machine or an isolated volume. At minimum:

1. verify the manifest digest
2. open the database with Node.js 24
3. run `npm run integrity-check` against the restored path
4. start Cassandra in observe mode
5. confirm schema migration and scoped search behavior

Record the date and result of each restore drill. A successful backup job
does not prove that the full restore procedure works.

## Restore a backup

Use this sequence on every install kind:

1. Set `CASSANDRA_MODE=observe` in the deployment environment.
2. Stop Cassandra and confirm no process holds the database open.
3. Preserve the entire damaged data directory. Do not overwrite your only copy.
4. Copy the chosen standalone backup to the configured `DATABASE_PATH`.
5. Make sure stale `-wal` and `-shm` files from the damaged database are not
   placed beside the restored file.
6. Verify the digest before the first start (see below).
7. Start Cassandra. Startup applies any migrations newer than the backup.
8. Wait for reconciliation and durable jobs to settle.
9. Compare `/cassandra channels` with the current policy.
10. Recheck deletion requests made after the backup timestamp.
11. Move to review or autonomous mode only after the restored state is
    checked.

### Restore on Docker Compose

Stop the service first, then move the file into the volume:

```bash
docker compose stop cassandra

# Remove stale write-ahead files from the damaged database, if any remain.
docker run --rm -v <project>_cassandra_data:/data alpine \
  sh -c 'rm -f /data/cassandra.sqlite-wal /data/cassandra.sqlite-shm'

docker compose cp ./cassandra-YYYYMMDD-HHMMSS.sqlite \
  cassandra:/app/data/cassandra.sqlite

docker compose start cassandra
```

Find the exact volume name with `docker volume ls`. The default Compose
project prefix is the directory name of your Compose file.

### Restore on Railway

> Rehearse a restore on a disposable service before you depend on it. The
> `railway ssh -- <command>` form may mangle quotes and pipes; run the
> commands interactively inside the ssh session, or wrap them in `sh -c
> '...'`.

The service must be stopped, but the volume must stay mounted. Point the
service start command at a long sleep, so the container runs without
Cassandra:

1. In the Railway service settings, set the start command to
   `sleep infinity` and deploy.
2. Copy the backup in as base64, decode it on the volume, and verify:

   ```bash
   base64 cassandra-YYYYMMDD-HHMMSS.sqlite | \
     railway ssh --service <service-name> -- \
       "base64 -d > /app/data/cassandra.sqlite && \
        rm -f /app/data/cassandra.sqlite-wal /app/data/cassandra.sqlite-shm && \
        sha256sum /app/data/cassandra.sqlite"
   ```

   Compare the printed digest with the manifest. When they differ, stop and
   export again; do not start Cassandra on a damaged restore.
3. Remove the start-command override in the service settings.
4. Deploy again. Cassandra starts against the restored file.

### Verify the restore

After the first start from a restored database:

```bash
curl --fail http://cassandra.example.internal/readyz
```

Then, inside the container or a built checkout:

```bash
node dist/cli/commands.js integrity-check
```

Finish with `/cassandra status` and `/cassandra channels` in Discord, and one
scoped search question in the test console. Only then move out of observe
mode.

## Handle deletion requests after restore

A backup contains the deletion state that existed when it was created. It
cannot contain a request made later. Restoring an older backup can therefore
bring back content that was deleted after that backup.

Keep a deletion-request ledger outside the Cassandra database if your
retention or legal requirements demand reliable replay. After a restore,
reissue every `forget-message` and `forget-user` request newer than the
backup timestamp. If the preserved damaged database is readable, its admin
audit records can help reconstruct those requests, but it should not be your
only deletion ledger.

Older backups may retain content until both local and off-host retention
remove them. State that delay plainly in the privacy notice.
