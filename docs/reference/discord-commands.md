# Discord command reference

Cassandra registers one guild-scoped `/cassandra` command. Every subcommand is
admin-only and replies ephemerally. A caller is authorized only when one of
their Discord roles appears in `CASSANDRA_ADMIN_ROLE_IDS`. If that setting is
empty, nobody is authorized.

## Operations

| Command | Behavior |
| --- | --- |
| `/cassandra status` | Shows a compact, sectioned dashboard with package version and safe build/deployment identity, mode, Gateway and model health, spend and usage, due/deferred work, eligible sync coverage, proposal/outbox state, rolling direct-reply outcomes and latency, storage, backups, and policy coverage. |
| `/cassandra mode value:<configured|observe|review|autonomous> [confirmation]` | Changes the effective mode immediately. `configured` clears the durable override and returns control to `CASSANDRA_MODE`; autonomous requires the exact confirmation `AUTONOMOUS`. |
| `/cassandra channels` | Lists up to 25 current channels with visibility, ingestion, intervention, thread, archive, sync, history, and access-warning flags. |
| `/cassandra sync [channel]` | Queues reconciliation for one channel or every non-excluded channel. Duplicate active work is collapsed. |
| `/cassandra pause` | Pauses review and outbound jobs. Ingestion and backfill continue. |
| `/cassandra resume` | Resumes paused work. |
| `/cassandra historical status` | Shows the bounded campaign window, order, model, status, and budget. |
| `/cassandra historical pause` | Pauses only historical construction and review; live work continues. |
| `/cassandra historical resume` | Resumes a paused or newly funded campaign when cumulative budget remains. |
| `/cassandra recap start [days] [topic] [channel] [budget-usd]` | Queues a durable, adaptively time-partitioned recap in the invocation channel. Defaults to 14 days and a $5 ceiling; configuration limits the maximum window and budget. The ceiling is not an estimate: a request may make up to 30 analysis calls plus synthesis before that spend gate stops new calls. |
| `/cassandra recap status` | Shows the five most recent recap states, actual analyzed-message progress, adaptive partitions, omitted counts and limiting caps, authoritative retry-lineage spend, and durable worker ownership. A nonterminal request without exactly one queued or running owner is shown as `recovery needed`, never as active synthesis. |
| `/cassandra recap retry id:<id>` | Creates a new synthesis-only attempt from the latest failed leaf of a recap lineage whose planned chunks all completed and whose shared budget has room. It reuses the stored summaries, citations, fingerprints, and lineage spend without re-analyzing message history. |
| `/cassandra recap cancel id:<id>` | Cancels a queued or running recap by full ID or unique prefix. |
| `/cassandra reload-policy` | File mode only. Validates and atomically reloads policy and prompt files, then queues memory re-scoping when needed. In basic mode the command is refused with a restart notice: the basic policy comes from the environment lists, and changes to those lists take effect after a restart. |
| `/cassandra backup` | Queues an online SQLite backup, returns a short job ID, and sends a best-effort private completion DM that identifies the inbox as non-conversational. Track retries or failures with `/cassandra status`. |
| `/cassandra integrity-check` | Runs SQLite integrity and foreign-key checks. |

The registered `sync` command performs overlap reconciliation. A full historical
backfill is scheduled at startup when `FULL_HISTORY=true`.

Status distinguishes work that is due now from queued work deferred until a
future `run_after` time. Its failed-job count is retained history, not a claim
that every failure is current. Sync progress is based on channels currently
eligible for history ingestion; Cassandra-named control/test channels and other
policy-excluded surfaces are reported separately instead of making eligible sync
look incomplete. Build, source revision, and deployment identifiers are bounded,
sanitized, and shortened to 12 characters in Discord.

Normal mention-based catch-ups are intentionally one bounded snapshot. When the
footer says `Coverage: partial`, the answer is a deterministic, channel-balanced
and time-balanced sample—not a claim that only those messages exist. Narrow the
topic/channel/window, or use `/cassandra recap start` for durable partitioned analysis.
Host-generated links are placed inline beside supported claims when the model supplies
valid citation markers; remaining valid citations appear in one descriptive `Sources:` line.
Deep recaps also post a fixed, content-free notice if bounded processing retries are
exhausted, so an expected report does not disappear silently. A synthesis retry gets a
new request and delivery identity; this prevents its report from colliding with the
original request's failure notice. Source scope and fingerprints are revalidated before
the retried report can be queued. Failures caused by changed sources, invalid targets,
unfinished chunks, or exhausted request budget are not retryable from stored summaries.
Every retry retains its immediate parent and immutable root request. Cassandra charges
all chunk and synthesis attempts—including failed or aborted billable calls—in that family
against the root request's original cap. Per-call timestamps determine daily spend, and
copied retry summaries create no new charge,
so retrying an older ancestor cannot reset the remaining budget. Each failed request can
have at most one retry child: once a newer attempt exists, only that latest failed leaf can
be retried. A completed or partial report closes the entire lineage to further retries.

Status counters have the following scopes:

| Field | Meaning |
| --- | --- |
| `Gateway: ... reconnects` | Reconnect events since the current process started. The count is diagnostic; `ready` is the current state. |
| `Usage` and `Spend` | Model input/output tokens and estimated provider cost for the current organization day and across retained run history. Input combines uncached input, cache reads, and cache writes. Inspector shows the post-migration-034 cache/reasoning breakdown; the command keeps its existing aggregate shape. Input and output are separate totals and need not be similar. |
| `Jobs: due` | Queued jobs whose `run_after` time has arrived. |
| `Jobs: deferred` | Queued jobs intentionally waiting for a future `run_after`, including retries and budget-deferred work. |
| `Jobs: failed retained` | Terminal failed-job records kept for diagnosis, within the `JOBS_RETENTION_DAYS` window (default 30 days); the daily maintenance job removes older ones, so this count falls over time. They are historical until a current due/running job indicates active work. When nonzero, `Failure types` shows the four largest job-type groups and aggregates the remainder as `other`. |
| `Historical: analyses pending` | Historical episodes currently queued or being reviewed. |
| `Proposals: review` | Actionable `pending_review` rows, using the same captured-clock deadline rule as `/cassandra proposals`: null, future, and exactly-current deadlines count; strictly past deadlines do not. A rare pre-sweep mismatch is shown separately as `stale awaiting expiry`. Startup repair expires stale rows before interactions start, and periodic maintenance repeats the sweep. |
| `Proposals: observed` | Durable proposals that were stored but not sent. This includes observe-mode proposals and proposals suppressed by recommendation, threshold, evidence, scope, rate, or duplicate checks. |
| Other proposal states | All-time counts of proposal rows in their current durable state, not today's activity. |
| `Delivery` | All-time counts of outbox rows in their current durable state. This can include direct answers and other deliveries, so it does not have to match proposal counts. |
| `Campaign progress: waiting` | Episodes from the named campaign currently queued or being reviewed. |
| `Deep recaps` | Durable admin-requested reports by owned-active, recovery-needed, and terminal state, plus their recorded spend. |

For the relationship between confidence, review, suppression, and approval, see
[How Cassandra decides whether to speak](../explanation/speaking-and-review.md).

## Proposal review

| Command | Behavior |
| --- | --- |
| `/cassandra proposals` | Lists up to 10 unexpired pending proposals without message content. |
| `/cassandra approve id:<id>` | Rechecks current evidence, visibility, cooldown, limit, and duplicate policy, then atomically records approval and queues the outbox delivery. It does not publish synchronously. |
| `/cassandra dismiss id:<id>` | Dismisses the proposal and creates no outbox item. |

Proposal IDs may be full IDs or unique eight-character prefixes. If a prefix is
ambiguous, use the full ID. Review-channel buttons use the same approval and
dismissal workflow as the slash commands. A non-terminal policy block leaves the
proposal `pending_review` and keeps its buttons available for a later retry. Successful
approval or dismissal interactions remove the controls; an approval click that detects
expiry also resolves its card. Startup repair performs the idempotent expiry sweep in
bounded update batches before interactions start, and periodic maintenance repeats it as
defense in depth. Expiry changes database state but does not promise to edit an old Discord
message, so a stale button may remain visible but cannot enqueue delivery.
Scheduled-memory cards live in the exact secure review channel, but approval queues the
notification to the separately shown source/working channel. That target must set
`allow_interventions: true`; `#general` is not a fallback, and threads remain exact targets.
Use Discord Reply on the delivered notification to update the reviewed memory. Ordinary
review-channel messages do not alter memory. Cards show a categorical recommendation and
up to three current evidence links rather than a synthetic intervention score.

## Memory and deletion

| Command | Behavior |
| --- | --- |
| `/cassandra memory-search query:<text>` | Runs a literal full-text memory search visible from the invocation context. Use `query:*` (surrounding whitespace is ignored) for the bounded inventory compatibility form. The exact secure review channel has broader review access. |
| `/cassandra memory-get id:<memory-id>` | Returns one complete permitted memory with host-built Discord source links. Use the full ID returned by `memory-search`. |
| `/cassandra forget-message id:<message-id>` | Immediately purges normalized content and attachment references, removes evidence links, and re-scopes or invalidates affected memories. |
| `/cassandra forget-user id:<user-id>` | Queues bounded, restart-safe deletion of the user's message content and evidence links. |

These commands do not echo message content in their replies. Deletion actions
are audited.

## MCP token management

| Command | Behavior |
| --- | --- |
| `/cassandra mcp-token create name:<name> [channels:<refs>] [expires-days:<1-365>]` | Creates a bearer token and displays it once. Channel refs are comma-separated IDs or names. |
| `/cassandra mcp-token list` | Lists token metadata, scope, expiry, last use, and revocation state. |
| `/cassandra mcp-token revoke id:<id>` | Revokes a token immediately. |

With no channel list, a token receives org scope. A channel list adds only valid
restricted channels. A restricted thread ref is stored as its canonical parent scope
anchor so the token can use the same thread boundary as Discord retrieval. Review-only
and excluded channels cannot be granted. The
plaintext token cannot be recovered because Cassandra stores only its SHA-256
hash. A token expires 90 days after creation unless `expires-days` sets a
different lifetime (1 to 365 days); the command cannot create a token that
never expires.

## Inspector token management

| Command | Behavior |
| --- | --- |
| `/cassandra inspector-token create name:<name> [expires-days:<1-365>]` | Creates an inspector bearer token and displays it once. |
| `/cassandra inspector-token list` | Lists token metadata, expiry, last use, and revocation state. |
| `/cassandra inspector-token revoke id:<id>` | Revokes a token immediately. |

An inspector token authenticates the read-only admin web surface
(`INSPECTOR_ENABLED=true`). It carries no scope: every page runs under the
secure review grant. A token expires 30 days after creation unless
`expires-days` sets a different lifetime (1 to 365 days). In a browser, paste
the token as the password in the login dialog; from a command-line client, send
it as `Authorization: Bearer`. An inspector token never authenticates the MCP
endpoint, and an MCP token never authenticates the inspector.

## Auditing

Authorization successes and failures are written to `admin_events`. Audit rows
contain actor IDs, action names, targets, timestamps, and bounded metadata. They
do not contain Discord message bodies or secret token values.
