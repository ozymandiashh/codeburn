# The Codex reset forecast

OpenAI resets Codex usage limits for paid users every so often, as a goodwill
gesture, on no published schedule and with no advance notice. CodeBurn cannot
tell you when the next one lands. What it can do is say how often they have
landed before, and what that implies about the next few hours — with the range
around that implication printed every single time.

This page explains the model, where the data comes from, and, in some detail,
what the forecast is not.

## The short version

`codeburn quota` prints a Codex section like this:

```
Codex reset forecast
  Reset forecast: 24% chance in the next 24h (10 to 51%), 4% in 6h (1 to 14%). 12h since the last global reset; typical wait 2.2d. Working hours in SF: yes.
  Estimated from 44 past resets in the public record; low confidence.
  Source: https://codex-reset.com/api/timeline — refreshed in this repo by a scheduled workflow, never fetched by this client.
```

The same two lines appear in the macOS menubar's Codex quota hover card and in
the Plan tab, beside the pace captions. `codeburn quota --format json` carries
the same numbers structurally, under `providers[].resetForecast`, so nothing has
to parse the English.

## Where the data comes from

The record is a file in this repository: `src/data/codex-reset-history.json`,
with a byte-identical copy at
`mac/Sources/CodeBurnMenubar/Resources/CodexResetHistory/codex-reset-history.json`
(SwiftPM resources have to live inside the target directory, so it exists
twice; a test pins the two together).

It is derived from [codex-reset.com](https://codex-reset.com)'s public
`/api/timeline`, **a community tracker that is not operated by or endorsed by
OpenAI, and that nobody has audited**. Please read the numbers with that in
mind. The file itself carries the attribution in its header.

Four fields per event survive into the repository:

| Field | Meaning |
| --- | --- |
| `id` | The tracker's own event id |
| `announced_at` | ISO-8601 UTC instant |
| `type` | `reset` or `credits` |
| `reset_kind` | e.g. `global`, on resets only |

Every text field the upstream carries — post bodies, titles, author names, links
— is dropped by `scripts/refresh-codex-reset-history.mjs` and never written. The
file is a table of times, not a copy of anyone's posts.

### How it is refreshed

`.github/workflows/refresh-codex-reset-history.yml` runs every six hours, fetches
the timeline, normalizes it, validates the shape and the ordering, and opens or
updates a pull request when the file changes. It never pushes to `main`.

**`codeburn` itself never fetches this.** Issue #725 rules out new network
polling in the client, and the maintainer's exception to that non-goal is
exactly, and only:

> the dataset is refreshed by a GitHub Action in the repo, never by the client
> at runtime.

The forecast is arithmetic over a file that ships with the build. There is no new
request, no new timer, no new credential, and no new endpoint on any surface.

## The model

All of it lives in `src/reset-forecast.ts`, mirrored in
`mac/Sources/CodeBurnMenubar/Data/CodexResetForecast.swift`. Both are pure: a
history and a `now` go in, numbers come out. The menubar needs its own copy
because `codeburn status --format menubar-json` carries no quota block — the
menubar's quota comes from its own native adapters — so unlike pricing, this
cannot ride the CLI payload.

### 1. Conditional survival

The record gives 44 resets, so 43 inter-reset waits. Given that *e* hours have
already passed since the last reset, the chance of one landing in the next *h*
hours is the share of waits that ended between *e* and *e + h*, out of the waits
that lasted longer than *e*. For a fully observed record this is what
Kaplan-Meier reduces to, so the simpler form is used directly.

Waits that ended in the last 120 days count three times as much as older ones.
Both public trackers note that the cadence sped up over 2026, and the record
agrees: the mean wait across the whole record is 201 hours, against 116 hours
across the last 120 days.

Deep in the tail the at-risk set thins to one or two waits, where a raw share is
0 or 1 and reads as certainty. The estimate is pulled toward a memoryless rate
(from the weighted mean wait) in proportion to how thin the set is — at 20
at-risk waits the pull is under a fifth, at 2 it is most of the answer.

### 2. The range

A Wilson score interval on the *unweighted* at-risk counts. Unweighted on
purpose: recency weighting and shrinkage are judgements about the data, not
extra observations, and neither is allowed to narrow the range. Wilson rather
than a normal approximation because these counts are small and often sit at 0
or n, where a normal interval collapses to a point and reads as certainty.

The range is then widened, never narrowed, to contain the point estimate, and it
is printed every time. There is no rendering path in CodeBurn that prints one of
these probabilities without its range.

### 3. The hour-of-day prior

Resets are announced by people, in San Francisco, during their day. In the
record CodeBurn ships:

- **no reset at all lands between 02:00 and 07:00 Pacific**, and only one each
  in the 01:00 and 07:00 hours;
- **42 of 44, about 95%, land between 07:00 and 23:00 Pacific**;
- the weekday spread is close to flat — Saturday carries as many as Tuesday — so
  the model does not treat weekends differently, and "working hours" here means
  that 07:00-to-23:00 Pacific band, not Monday to Friday.

The observed hourly density, relative to a uniform day, becomes a multiplier on
the hazard, averaged hour by hour across the horizon. So a six-hour window that
sits entirely in the small hours is discounted hard, and one across the middle of
the San Francisco afternoon is not.

Two guards: the per-hour multiplier is floored at 0.1, so the prior can tilt a
probability but **never takes it to exactly zero** — "never at 4am" is not a
claim 44 events can support; and every probability is capped at 99%, because
multiplying a hazard by up to 24 can otherwise turn a high estimate into
certainty, which 44 events cannot support either.

Because the prior can lift a six-hour window more than the 24-hour window that
contains it, the 24-hour figure is raised to at least the six-hour one. A longer
horizon is never reported as less likely than a shorter one inside it.

### 4. Your own resets

When this machine has observed a reset for itself — the local early-reset
detector (#1320) or a banked-credit grant (#1322) — and that observation is more
recent than the newest reset in the public record, "since last reset" counts from
yours, and the sentence says "since the last reset on this machine". This is an
*input* to the model, not an import: neither feature has to land before the
forecast works, and with no local events the forecast conditions on the global
record exactly as it does today.

### 5. The confidence label, and why it says "low"

`confidence` is `low` unless a walk-forward backtest over the same record beats
the base rate. The backtest rebuilds the model from each prefix of the record,
asks it at fixed offsets after each reset for the chance the next one lands
within 24 hours, and scores it (Brier) against what happened — and against a
constant predictor set to the same prefix's base rate. Nothing after the probe is
visible to either. It ships as a test, in `tests/reset-forecast.test.ts`.

**On the record CodeBurn ships, the model does not beat the base rate.** Over 220
walk-forward probes its Brier score is 0.132 against the base rate's 0.129. So
the shipped label is `low`, and the test asserts that it is — if a future refresh
of the record flips the result, that test fails and somebody looks at the claim
rather than quietly upgrading it.

This is the honest reading: across these 44 events, how long you have already
waited tells you very little that the overall rate does not. The forecast is
still worth printing — "typically a couple of days, and almost never overnight in
San Francisco" is real information — but it is not a schedule, and the label says
so.

## Staleness

A record older than 14 days is stale. The client keeps reporting the numbers,
because the record is still the record, but the caveat line says how old it is,
the confidence drops to `low`, and the notification never fires.

## The notification

Off by default, and the only quota notice in CodeBurn that is. The others report
something that already happened; this one reports a probability, and a
probability that arrives uninvited is a worse trade.

Settings → General → Codex Reset Forecast turns it on and picks a threshold
(default: a 50% chance within six hours). It fires at most once per crossing and
re-arms only when the estimate falls back under the threshold, so it cannot nag.
The fired state is persisted, so relaunching does not repeat it. Moving the
threshold, or a new reset landing, starts a new crossing. A failed refresh is no
opinion, and leaves the state exactly as it was.

The text says what it is before it says a number:

> **Codex reset forecast**
> A statistical estimate from public reset history, not an announcement from
> OpenAI. 62% chance (47 to 77%) of a Codex limit reset in the next 6h. 1.7d
> since the last global reset. Nothing has reset yet and nothing was changed.

It has no buttons, no link and no side effects. Nothing in this feature spends,
redeems, requests or refreshes anything.

## What this is not

- **It is not an announcement.** OpenAI publishes these on no schedule and
  through no structured channel CodeBurn reads. Nothing here has inside
  knowledge.
- **It is not advice to burn your quota.** The expensive failure mode is
  spending down capacity on a reset that does not come. That is why the wording
  is "chance", why the range is always printed, and why the confidence label is
  earned by a backtest rather than asserted.
- **It is not audited data.** A community tracker's record of a third party's
  informal announcements is the best public source there is, and it is still a
  community tracker's record of a third party's informal announcements.
- **It is not personalised**, beyond optionally counting from a reset your own
  machine observed. It knows nothing about your account and sends nothing
  anywhere.

## Related

- `docs/providers/codex.md` — how Codex quota is read in the first place
- Issue #725 — the quota epic, and the no-new-polling non-goal this feature has a
  narrow written exception to
