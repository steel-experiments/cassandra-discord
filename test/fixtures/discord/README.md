# Synthetic Discord fixtures

Controllable stand-ins for the Discord surface, used by the Section 46.2
integration suite. Nothing here touches the network. Every seam is
deterministic and scriptable.

## Why a shared adapter

The production code is built around small dependency-injection seams
(`BackfillMessageFetcher`, `ThreadArchiveSource`, `OutboxSender`,
`RecentSentMessageLookup`), so tests can fake Discord without a live connection.
Previously each test re-implemented its own inline fake. `synthetic-adapter.ts`
consolidates them into one controllable object so reliability scenarios share a
single, scriptable surface.

## `createSyntheticDiscord(opts?)`

Returns an object exposing every seam plus the controls a test needs:

| Field | Kind | Purpose |
| --- | --- | --- |
| `clock` | `ControllableClock` | Deterministic `now()` with `set`/`advance`. |
| `backfillFetcher` | `BackfillMessageFetcher` | Paginates seeded channel history newest-first, honoring `before`. |
| `seedChannelMessages(channel, raws)` | control | Append raw (snake_case) message payloads to a channel. |
| `scriptFetchError(channel, err, onCall)` | control | Throw a scripted error on the Nth fetch for a channel. |
| `fetchCalls` | record | Every fetch call: `{ channelId, before, limit }`. |
| `archiveSource` | `ThreadArchiveSource` | Public/private archived-thread pagination per parent. |
| `seedArchivedThreads(parent, threads, opts)` | control | Seed archived threads and `hasMore` flags. |
| `sender` | `OutboxSender` | Records sends; scripts errors per send attempt. |
| `scriptSendError(err, onCall)` | control | Throw a scripted error on the Nth send attempt (counting failures). |
| `sentMessages` | record | Successful sends, in order. |
| `recentSentLookup` | `RecentSentMessageLookup` | For outbox `sending`-state crash recovery. |
| `seedRecentSent(channel, msgs)` | control | Seed recent sent messages for recovery. |
| `recordEvent(type, payload)` / `events` | record | Recorded Gateway events to feed `handleGatewayEvent`. |

### Scripting errors

`ScriptedError` carries an optional numeric `status` and `code`, mirroring how
discord.js surfaces REST errors. The jobs error classifier duck-types these, so a
`{ status: 429 }` error is classified as transient without importing discord.js:

```ts
discord.scriptSendError({ status: 429, message: 'You are being rate limited.' }, 0);
// call 0 throws → row returns to queued → call 1 (the retry) succeeds
```

Send and fetch error indices count attempts, not successes, so a scripted
failure on call 0 does not also fail its own retry.

## Where it is used

- `test/integration/ingestion-reliability.test.ts`: rate-limit retry (429) on
  outbox delivery and on backfill fetch, and forum-post thread backfill.

The other Section 46.2 scenarios have dedicated tests that still use their own
inline fakes; see `test/integration/section-46.2-coverage.test.ts` for the full
scenario-to-test registry.
