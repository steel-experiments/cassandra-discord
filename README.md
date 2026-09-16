# Cassandra for Discord

Cassandra for Discord is a quiet organizational-memory agent for one Discord
server. It ingests the channels you permit into SQLite, groups conversation
into episodes, and extracts durable memories: decisions, assumptions,
predictions, risks, open questions, and commitments. It is not the Apache
Cassandra database.

Most of the time Cassandra says nothing. Mention it and it answers with
citations. Point it at a review channel and it brings forgotten decisions and
contradictions to a human first. Autonomous posting exists, but it is bounded
by channel policy, evidence checks, cooldowns, and daily limits. In `observe`
mode, the default, it never posts on its own.

> **@Cassandra** what did we decide about the API rate limit?
>
> On 2026-08-14 the team decided to keep the limit at 100 requests per minute
> for partners and 10 for everyone else (source: `#api-design`, two messages
> linked). On 2026-08-20 a lower limit was proposed. I found no later
> decision.

Cassandra was inspired by Sunil Pai's essay
[Every company needs a Cassandra](https://sunilpai.dev/posts/every-company-needs-a-cassandra/).

Full documentation: <https://steel-experiments.github.io/cassandra-discord/>

This file is written so that a person or a coding agent can install Cassandra
by following the steps in order. Every step ends with a check. An agent must
ask the human for every value in the table in Step 2 and must never invent a
Discord ID or paste a token anywhere except `.env` or the hosting platform's
variable store.

Cassandra for Discord 1.0.0 is released. The container image is published
at `ghcr.io/steel-experiments/cassandra-discord` (each release records its
digest), and the Railway template is live.

## Quick path

If you know Docker and already have a Discord application:

```bash
cp .env.example .env          # fill in the values from Step 2
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build -d
curl --fail http://127.0.0.1:3000/readyz
```

Then run `/cassandra status` in Discord as a member with the admin role. The
steps below explain each value and each check.

## Before you install

You run everything, and you own the data:

- One Discord server per instance. One process, one SQLite database. Never
  attach one database volume to two active replicas.
- Your own Discord application with a bot token and the Message Content
  Intent.
- Your own model-provider account and API key. The default model is
  `openai/gpt-5.6-terra`. Anthropic and Google are also supported.
- Persistent storage for the database: one volume at `/app/data` in
  containers, or `./data` for a native run.
- **Message content flows to your chosen cloud model provider.** Self-hosting
  keeps storage and access control on your machine, not model processing.
  See [Privacy](docs/privacy-notice.md).
- A starter spend control of 2 USD per day. It is an admission control, not a
  provider billing ceiling, and hosting charges are separate.

## Step 1: Discord setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   create an application and copy its Application ID.
2. On the Bot page, create a token and store it in a secret manager.
3. Enable **Message Content Intent** on the Bot page.
4. Create an install URL with the `bot` and `applications.commands` scopes,
   open it, and add the bot to your server.
5. Give the bot a role with View Channel, Read Message History, Send
   Messages, Send Messages in Threads, Embed Links, and Use Application
   Commands. Do not grant Administrator. Deny the role on categories that
   must never be read.
6. Pick or create an admin role for the humans who may run `/cassandra`
   commands.
7. Create a text channel named `cassandra-test`. Any channel whose name
   contains `cassandra` is a safe console: nothing posted there becomes a
   memory.

Check: the bot appears in the member list, offline for now. The exact gateway
intents and permission reasoning are in
[Install Cassandra](docs/tutorials/getting-started.md).

## Step 2: Configuration

Copy the short template and fill it in:

```bash
cp .env.example .env
```

| Variable | Value | Where the human finds it |
| --- | --- | --- |
| `DISCORD_TOKEN` | the bot token | Developer Portal, Bot page |
| `DISCORD_APPLICATION_ID` | the application ID | Developer Portal, General Information |
| `DISCORD_GUILD_ID` | the server ID | right-click the server name, Copy Server ID |
| `OPENAI_API_KEY` | the provider key | the provider console; for another provider set `LLM_PROVIDER` and its key instead |
| `CASSANDRA_ADMIN_ROLE_IDS` | admin role ID, comma-separated for several | Server Settings, Roles, right-click, Copy Role ID |
| `ORG_VISIBLE_CHANNEL_IDS` | channel or category IDs whose content the whole server may see in answers | right-click the channel or category, Copy Channel ID |
| `RESTRICTED_CHANNEL_IDS` | channel or category IDs whose content stays inside that channel | same |
| `FULL_HISTORY` | `true` imports all reachable history on first start, `false` starts from now | ask the human; there is no default |
| `ORG_NAME`, `ORG_TIMEZONE` | recommended; defaults are `Your Company` and `UTC` | |

Discord shows the Copy ID entries only when Developer Mode is on (User
Settings, Advanced). A Discord ID is a 17 to 20 digit number.

Rules the process enforces at startup:

- At least one ID must be present across the two channel lists. Both empty is
  a startup error. Channels in neither list are not read at all, and threads
  follow their parent channel. Leave `cassandra-test` out of both lists.
- An ID must not appear in both lists.
- `LLM_DAILY_BUDGET_USD` defaults to `2`. The word `unlimited` removes the
  cap. Any other value must be a number.
- Keep `CASSANDRA_MODE=observe` for the first installation. A human decides
  later whether to enable `review` or `autonomous`.

A native run reads `./.env`; values already in the real environment win. For
per-channel control beyond two lists, set `CHANNEL_POLICY_SOURCE=file` and
edit `config/channel-policy.yml`, a synthetic sample. Every supported setting
is listed with its default in `config/advanced.env.example` and the
[Configuration reference](docs/reference/configuration.md).

Check: no required value is empty, and no ID appears twice.

## Step 3: Run Cassandra

All options run the same code: one process, one database, HTTP on port 3000
for health checks only.

**Option A: released image with Docker Compose.** Available after the first
release. Set the `image:` line in `docker-compose.image.example.yml` to a
released version tag, or to the digest recorded in the release notes, then:

```bash
docker compose -f docker-compose.image.example.yml up -d
```

Never point it at `latest`. Migrations are forward-only, so an upgrade must be
a deliberate action. See [Deploy with Docker](docs/how-to/deploy.md).

**Option B: build from source with Docker Compose.** The override publishes
port 3000 on `127.0.0.1` only.

```bash
cp docker-compose.override.example.yml docker-compose.override.yml
docker compose up --build -d
```

**Option C: Node.js 24 without Docker.** Data lands in `./data`; set
`DATA_DIR` in `.env` to move it.

```bash
npm ci --ignore-scripts
npm run verify:sqlite
npm run build
npm start
```

**Option D: Railway.** The template provisions one always-running service
from the released image, one volume at `/app/data`, one replica, a `/readyz`
health check, and a 45-second shutdown drain. Set the Step 2 variables as
service variables; Railway rejects an empty value, so leave an empty list
unset. See [Deploy on Railway](docs/how-to/railway.md).

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/cassandra-for-discord)

Check: the log shows `cassandra starting`, then the process becomes ready.
Use `docker compose logs -f cassandra` or the terminal of a native run.

## Step 4: Verify the first start

1. Health check, expected HTTP 200:

   ```bash
   curl --fail http://127.0.0.1:3000/readyz
   ```

2. In Discord, as a member with the admin role, run `/cassandra status`. The
   gateway is ready, the model is healthy, and the build revision is the one
   you deployed.
3. Run `/cassandra channels`. Only the channels from your lists show as
   ingesting. A missing permission shows as an access warning.
4. In `#cassandra-test`, send these one at a time:

   ```text
   @Cassandra hi
   @Cassandra bring me up to speed on the last two days
   @Cassandra what do you remember?
   ```

   `hi` gets a direct reply from the console. In basic mode, ask the two
   content questions from an org channel such as `#general` instead: the
   console is in neither list, so its scope is restricted, and answers there
   report the memory count without repeating content. From the org channel
   you get a bounded catch-up with inline source links and an inventory of
   permitted memories. "No matching permitted activity" is a correct answer
   while nothing has been ingested yet.
5. With `FULL_HISTORY=true`, let the backfill drain before you judge memory
   coverage. `/cassandra status` shows the progress.
6. Post a member notice before you treat the installation as live. A template
   is in [Publish the member privacy notice](docs/how-to/publish-privacy-notice.md).

If a check fails, see [Troubleshooting](#troubleshooting).

## Use Cassandra

Any member can ask. Mention the bot in a channel it can read, and make each
question self-contained:

```text
@Cassandra what did we decide about the launch sequence?
@Cassandra what risks have we recorded for the migration?
@Cassandra bring me up to speed on this channel since Monday
```

Cassandra answers from the intersection of what the bot can read, the channel
policy, and the visibility of the channel you asked in. Restricted evidence
never appears in an org-visible answer. DMs are not answered, and DM content is
not stored or sent to the model.

The three modes:

- `observe`, the default: ingests, extracts memories, answers mentions, never
  posts on its own. Model calls still happen.
- `review`: proposes interventions as cards in a secure review channel for a
  human to approve. Needs `CASSANDRA_REVIEW_CHANNEL_ID` and
  `CASSANDRA_REVIEW_CHANNEL_SECURE=true`, set only after you verified who can
  read that channel.
- `autonomous`: posts approved kinds of interventions itself, within
  cooldowns and daily limits.

Admin commands are ephemeral and role-gated. The ones you need first:

| Command | Purpose |
| --- | --- |
| `/cassandra status` | Health, spend, sync coverage, backups, policy coverage |
| `/cassandra channels` | Per-channel visibility, ingestion, and access flags |
| `/cassandra mode value:<observe\|review\|autonomous>` | Change the mode; `autonomous` needs the confirmation `AUTONOMOUS` |
| `/cassandra recap start [days] [topic] [channel] [budget-usd]` | Durable multi-day report, default 14 days and 5 USD |
| `/cassandra memory-search query:<text>` | Full-text search over permitted memories |
| `/cassandra backup` | Online SQLite backup into the data volume |

The full list is in [Discord commands](docs/reference/discord-commands.md).
Member guidance is in [Use Cassandra](docs/how-to/use-cassandra.md). Other
agents connect read-only through MCP, see
[Connect MCP clients](docs/how-to/connect-mcp-clients.md).

## Operate Cassandra

- **Configuration changes.** Edit `.env` or the platform variables and
  restart. In file mode `/cassandra reload-policy` reloads the policy without
  a restart; basic mode needs the restart.
- **Upgrades.** Pull the next version tag or digest, stop the old container,
  start the new one. Migrations run at startup and are forward-only, so never
  run two versions against one volume. See
  [Upgrade](docs/how-to/deploy.md#do-not-run-unattended-latest-upgrades).
- **Backups.** `/cassandra backup` writes into the data volume. Copy the file
  off the host and record its checksum. Restore procedures are in
  [Back up and restore](docs/how-to/backup-and-restore.md).
- **Stopping.** `docker compose stop` sends SIGTERM. Cassandra drains work for
  up to 30 seconds; the Compose grace period is 45 seconds.
- **Spend.** `/cassandra status` shows the day's spend against the budget.
  When it is exhausted, paid work waits for the next day in `ORG_TIMEZONE`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Startup error `CHANNEL_POLICY_SOURCE=basic needs at least one id` | Both channel lists are empty. Add channels, or set `CHANNEL_POLICY_SOURCE=file` if you have a policy file. |
| Startup error mentioning `FULL_HISTORY` | The variable is unset. Choose `true` or `false`. |
| `An invalid token was provided` | Wrong or reset bot token. |
| `/cassandra` commands answer with a permission notice | The caller lacks a role from `CASSANDRA_ADMIN_ROLE_IDS`, or the list is empty. |
| Answers say nothing was found | Channel not selected, not synced yet, restricted to another audience, or outside the time window. |

The full symptom map, including model and budget errors, is in
[Troubleshooting](docs/how-to/troubleshooting.md).

## Contribute

```bash
npm ci --ignore-scripts
npm run verify
```

`npm run verify` is the CI gate: SQLite capability probe, lint, type checks,
tests, and build. `CASSANDRA_IMPLEMENTATION_SPEC.md` is the normative design;
when code and spec disagree, the spec wins or the spec is amended. Migrations
are immutable. Read [CONTRIBUTING.md](CONTRIBUTING.md),
[SECURITY.md](SECURITY.md) for private vulnerability reports, and
[the architecture map](contributor-docs/architecture.md).

## License

Apache License 2.0. See [LICENSE](LICENSE).
