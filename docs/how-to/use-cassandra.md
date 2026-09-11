# Use Cassandra in Discord

This is the everyday guide for members of a Discord server where Cassandra is already
installed. You do not need an administrator role to ask Cassandra a question.

## Ask a question

Mention Cassandra in a server channel she can access:

~~~text
@Cassandra what did we decide about the launch sequence?
@Cassandra what risks have we recorded for the migration?
@Cassandra bring me up to speed on this channel since Monday
~~~

Make follow-up questions self-contained when possible. Cassandra can use permitted
conversation and memories, but she does not treat every earlier chat message as an
unbounded conversation history.

## Choose the right kind of answer

| Need | Ask for |
| --- | --- |
| Recent activity across a bounded window | A catch-up, such as “last two days” |
| A decision, risk, prediction, or commitment retained over time | A memory question |
| A focused subject | A topical memory question with the key term |
| A large, durable report over many days | Ask an admin to run `/cassandra recap start` |

A normal catch-up is intentionally bounded. A deep recap is an admin-started background
job that splits a larger window into smaller analyses and posts a durable report later.
Neither operation silently expands what the requester is allowed to see.

## Read citations and coverage

Cassandra places host-built Discord source links beside supported claims. A link points
to a message you are permitted to open; Cassandra does not let the model author source
URLs.

A catch-up footer says whether coverage was complete or partial. Partial coverage means
the requested window exceeded a retrieval bound and Cassandra used a deterministic
channel- and time-balanced sample. It does not mean the omitted messages do not exist.
Narrow the channel, topic, or time window when completeness matters.

No matching result can also be correct: the relevant channel may be excluded, restricted
to another audience, not synchronized yet, deleted, outside the time window, or simply
absent.

## Understand visibility

Cassandra answers from the intersection of:

- Discord channels the bot may read;
- the configured channel policy; and
- the visibility grant of the destination or MCP token.

Organization-visible evidence can be used in organization-visible answers. Restricted
evidence stays within its channel family. Review-only evidence stays in the secure review
context. Excluded content is not available. Cassandra fails closed when a channel is
unknown or permissions become insufficient.

## DMs are not a conversation surface

Cassandra does not read or answer questions in direct messages. A DM receives a fixed,
rate-limited notice directing the sender back to a server mention. DM content is not
ingested, stored, logged, or sent to the model.

## Report a wrong or unsafe answer

Preserve the answer and its source links, then contact a Cassandra administrator. Say
which claim is wrong, which source contradicts it, and whether the problem appears to be
missing context, stale memory, or visibility.

Administrators can inspect a memory with `/cassandra memory-get`, find related memories
with `/cassandra memory-search`, pause review/outbound work, and use the deletion
commands when content must be removed. Do not paste restricted evidence into a broader
channel while reporting the issue.

## Connect another agent

For read-only access from ChatGPT/Codex, Claude, or another MCP client, ask an
administrator to issue a dedicated least-privilege token, then follow
[Connect MCP clients](connect-mcp-clients.md). Each client should have its own token so
access can be audited and revoked independently.
