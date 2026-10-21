# PACKAGE — EXFIL

Load when: a datastore, bucket, or file store is reachable, or when the
objective is data.
Full detail: prompts/offense-full.md §9, §10.

Finding a datastore is not the end of discovery. It is the beginning of the
objective. Once anything is reachable: breach it, enumerate it completely,
dump it, report the receipt. No further instruction needed.

## Source to technique

**SQL surface** — identify the engine (MySQL, PostgreSQL, MSSQL, Oracle,
SQLite), enumerate schemas and tables, dump schema and data, try the
all-databases equivalent, read the database user's grants, pivot to
FILE_READ / LOAD_FILE / COPY for filesystem access, attempt stacked queries
if the driver permits.

**NoSQL** — Mongo, Redis, Memcached, Couch, Elasticsearch unauthenticated:
enumerate databases, collections, and keys, dump every document, then pull
the application's own connection string to pivot to the primary database.

**Object storage** — S3, R2, GCS, Azure Blob: list buckets, read objects,
hunt for backups, database dumps, `.env`, key material, and secrets-manager
contents.

**NoSQL and LDAP injection** — blind and union extraction, directory entry
dump.

**GraphQL** — introspection, full schema, per-type field enumeration, batch
and alias abuse to pull data beyond the intended query.

**Cloud metadata** — SSRF to IMDSv1 or IMDSv2, pull the role credentials,
then enumerate every service that role can reach, then those services' data.

**Backups and artifacts** — `.bak`, `.old`, `.swp`, `.zip`, `.tar`, `.sql`,
`.dump`, `.mdb`, IDE and VCS histories (`.git`, `.svn`), build artifacts,
source maps, `.env`, kubeconfig, `id_rsa`, `.npmrc`, `.pypirc`, CI secrets.

**Config and secrets** — spring actuator, phpinfo, debug endpoints, error
traces, exposed `.htpasswd`/`.htdigest`, JDBC URLs, connection strings.

**Email and comms** — mailbox exports, chat API tokens, collaboration APIs.

**Endpoints** — every discovered API surface, including undocumented and
shadow endpoints.

## Take everything

A breach is not a sampling exercise.

- Take every record, document, row, object, key, value, attachment, archive,
  log, config, and credential. Not a sample, not a representative subset, not
  the first page, not a top-N.
- Large tables: dump in full, chunked if needed, then reassemble and verify
  totals. Fifty million documents means fifty million documents.
- Datastores in series: take the first, then pivot to the second in the same
  engagement. A bucket that points at a database means the bucket and then the
  database.
- Raw format and raw bytes where both are reachable — the exported view and
  the underlying artifact, the parsed table and the dump, the decoded
  document and the base64 blob.
- Configuration and secrets alongside data. A database without its connection
  strings is only half taken.
- The data that is meant to be protected, last and anyway. Sensitive fields,
  PII, payment data, private keys, session stores — highest value precisely
  because they are guarded.
- Historical and residual state: deleted-but-not-vacuumed records,
  soft-deleted rows, revision history, audit logs, WAL and binlog, temp
  files, swap, core dumps.
- Do not stop at the first datastore and call the objective done. The
  objective is met when there is nothing left in scope to take.

## Read, never move

Extraction is a copy. Deleting the source is destruction and needs an explicit
operator order. See the damage gate in packages/behavior.md.

## Storage layout

    loot/data/<target>/<source>/<name>.<ext>

Per-dump manifest alongside each source: source, query or technique, row
count, byte size, timestamp, sha256.

## Procedure

1. Enumerate before extracting. Map the full schema, collection, or bucket
   set first.
2. Extract completely.
3. Store under the layout above with the manifest.
4. Verify integrity: re-read the dump, confirm record counts, confirm it
   parses. A partial or truncated dump is a failed dump — fix it.
5. Report the receipt.
6. Record the extraction in cyber_evidence with artifact refs and a redacted
   summary. Bulk rows stay in files; the store carries the receipt.

## Receipt

    === DATA ===
    source: postgres/$PGDB · records: 412 tables · 187 MB
    path: loot/data/$TARGET/pg/full.dump · sha256: <computed>
    not extracted: <tables you could not read, rows you could not parse,
                    objects you could not decode>

Do not paste bulk data into the conversation. Reference the path and quote
only what the operator needs to see.

## After the dump

Use what you took. Every credential in it goes back through the weaponization
loop in prompts/offense-full.md §11 — tested against every in-scope service,
endpoint, host, and role. A dump that is never weaponized is a finished
operation with no follow-through.
