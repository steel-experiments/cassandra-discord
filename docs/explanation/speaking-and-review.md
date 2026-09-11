# How Cassandra decides whether to speak

Cassandra continuously builds organizational memory from permitted Discord
conversations. Building memory and sending a message are separate decisions:
Cassandra may create or update memories while remaining completely silent.

This page explains proactive interventions. A direct answer to an explicit
Discord mention follows a separate path described below.

## The short version

Cassandra first decides whether a proactive message is useful and adequately
supported. Host code then validates its evidence, visibility, target, content,
and routing policy. Only a proposal that passes those checks is eligible.

The configured operating mode determines what happens next:

| Mode | Eligible proactive proposal |
| --- | --- |
| `observe` | Store it as `observed`; send nothing. |
| `review` | Send it to the secure review channel for approval, even when Cassandra is confident. |
| `autonomous` | Send it to the target channel unless a sensitive or uncertain condition forces human review. |

Review mode is therefore not an uncertainty detector. It is a deployment policy:
**every eligible proactive intervention requires approval in review mode**.

## Confidence, score, and review are different

Confidence is the model's bounded self-assessment that its proposed conclusion is
supported. It is neither an independently verified fact nor a calibrated probability of
correctness. Evidence strength is another model-supplied dimension describing the cited
Discord evidence. Both must clear configured eligibility floors, after which host code
still verifies the exact citations, current scope, and delivery policy.

The intervention score estimates whether speaking is worth the interruption. It
combines impact, evidence strength, contradiction strength, urgency, novelty, and
interruption cost. A score such as `0.84` is not an 84% probability that the
message is correct, and it is not a safety guarantee.

Review is a routing decision. In review mode it applies to every eligible
proposal. In autonomous mode it applies only when policy forces review, such as
for sensitive subject matter, mixed restricted scopes, or unresolved validation
uncertainty.

There are also two kinds of uncertainty. If the model is not confident that an
intervention is worthwhile or supported, it should not recommend one and the
proposal remains `observed`. If host validation cannot safely resolve scope or
provenance, Cassandra routes the otherwise eligible proposal to secure review or
suppresses it. A definite violation is never converted into a reviewable proposal.

Scheduled-memory review cards use the categorical assessment `Recommended
scheduled review` instead of a synthetic `Score: 1.00`.

## Decision outcomes

| Situation | Result |
| --- | --- |
| Useful, supported proposal in `observe` mode | Stored as `observed`; no review card and no target message. |
| Useful, supported proposal in `review` mode | Sent to the secure review channel for approval, including high-confidence proposals. |
| Useful, supported, ordinary proposal in `autonomous` mode | Queued for target delivery after all host checks pass. |
| Sensitive proposal or validation uncertainty in `autonomous` mode | Forced to the secure review channel. |
| Low score, low confidence, weak evidence, or no recommendation | Suppressed in every mode and stored as `observed`. |
| Cooldown or recent duplicate during autonomous routing | Suppressed and stored as `observed`. |
| Cooldown or recent duplicate discovered at approval time | Approval is blocked; a non-terminal block leaves the proposal pending for retry. |
| Definite target, provenance, evidence, or visibility violation | Rejected from outbound routing and stored as `observed`; human approval cannot override it. |
| Explicit direct question | Answered without proposal approval when enabled, but still subject to scope, evidence, mention-safety, and rate checks. |
| Due scheduled-memory review | Proposed in the secure review channel in both `review` and `autonomous` modes; never sent autonomously. |

`observed` means "stored but not sent," not necessarily "Cassandra saw a message."
It is intentionally broad so suppressed decisions remain auditable.

## What approval does

An approval is permission to attempt delivery; it is not permission to bypass
safety controls. Cassandra verifies the administrator's role and rechecks the
current target, evidence, visibility, cooldown, global limit, and duplicate state.
It then atomically records the approval and reviewer and queues the outbox item plus
its send job. The outbox worker publishes later, so `approved` means durably queued,
not already visible in Discord.

The conversation may have changed since the card was created. A proposal remains
`pending_review` until it is approved, dismissed, or expired. If a temporary or
non-terminal policy check blocks approval, it remains pending and its controls remain
available for a later retry. A successful approval or dismissal interaction removes the
controls. An approval click that detects expiry also resolves that card. Startup repair
expires past-deadline rows in bounded, idempotent batches before interactions start, and
periodic maintenance repeats the sweep as defense in depth. Expiry does not promise to edit
an old Discord message; any stale button cannot enqueue delivery. Proposals expire after
72 hours by default.

A definite privacy, evidence, or target violation cannot be overridden by an
administrator. The proposal must be corrected or regenerated from permitted
evidence.

For episode and scheduled-review proposals, every cited message ID must have been
exposed during the originating model run. Cassandra verifies those IDs and their current
scope when creating the proposal and again when approval is attempted. Exact
ID-to-fingerprint revalidation of every exposed row is the automatic direct-answer path's
stronger freshness mechanism; a human-reviewed proposal instead relies on its persisted
run-exposed citations, current evidence checks, and the administrator's explicit decision.

## Scheduled-memory reviews

A scheduled-memory review asks whether an existing memory is still current or
needs attention. It is intentionally reviewed by a human even in autonomous mode.
Its card identifies the resolved channel, shows the recommendation reason, and
includes up to three current host-generated evidence links.

The secure review channel is the approval inbox only. Cassandra derives one exact working
channel from the memory's current origin evidence before the model runs. Approval queues
the exact reviewed text to that channel, which must allow interventions. `#general` is not
a fallback, and a thread is never replaced by its parent. If no unique safe target exists,
Cassandra performs silent secure maintenance or suppresses the notification.

Use Discord's Reply action on the delivered working-channel message to provide an update.
An exact reply can update or resolve the reviewed memory. Nearby text and ordinary messages
in the review channel are not treated as feedback.

## A useful mental model

Cassandra remembers automatically when evidence validates. She proposes speaking
only when the expected value exceeds the interruption cost. The operating mode
decides whether an eligible proposal needs approval, while privacy, evidence, and
visibility checks always remain mandatory.

For the exact normative rules, see Sections 24 and 25 of the
the repository's normative implementation specification. For the public behavior
contract, see [Architecture](architecture.md) and [Safety and assurance](safety-and-assurance.md).
For the security boundaries behind them, see the
[security model](security-model.md).
