# Muse Code (muse-code)

Meta's terminal coding agent, the `muse` CLI, launched in beta on 2026-08-05 and running on the Muse Spark model family. Unrelated to the consumer "Muse" personal-agent app, which runs on a Meta-hosted VM and writes nothing locally, and unrelated to Microsoft Research's Muse/WHAM model.

- **Source:** `src/providers/muse-code.ts`
- **Loading:** lazy (`src/providers/index.ts`)
- **Test:** `tests/providers/muse-code.test.ts`
- **Logo:** none. No Muse Code mark is published under terms we can vendor, so the README lists it as a text link, the way LingTai TUI is listed. Drop `assets/providers/muse-code.*` in and swap the link when one exists.

## Where it reads from

| Level | Env var | Default |
|---|---|---|
| sessions | — | `<root>/sessions` |
| root | `MUSE_DATA_DIR` | `$XDG_DATA_HOME/muse`, else `~/.local/share/muse` |

`MUSE_DATA_DIR` is the **exact** data directory, not a parent — the same contract `OPENCODE_DATA_DIR` has (#617), so a relocated or renamed install writing `<dir>/sessions/...` is found instead of silently reporting zero. An empty value is treated as unset.

Muse follows XDG on every platform it supports, macOS included: its launcher reads `XDG_CONFIG_HOME` for the credential path, and a real 1.1.1 binary wrote to `~/.local/share/muse` on macOS while this provider was being written. There is no `~/Library/Application Support` variant. Windows is not officially supported by Muse Code.

`probeRoots()` reports the resolved sessions dir, so `codeburn doctor` distinguishes "Muse Code is not installed" from "`MUSE_DATA_DIR` points somewhere empty" (#899).

## Storage format

```
sessions/YYYY/MM/DD/<session-id>/
  session.jsonl                            the transcript
  cron.db, goals.db                        SQLite state, not transcripts
  tool-outputs/, approval-review/          spill dirs
  subagent/<child-id>/session.jsonl        one transcript per delegated run
sessions/.msp-view-v1/<session-id>/        folded view of the SAME usage
```

Only `sessions/<4 digits>/<2>/<2>/<session-id>/session.jsonl` and its `subagent/*/session.jsonl` children are read. `.msp-view-v1/` holds `HEAD.json`, binary journal/index files and folded `snapshot-*.json` for the transcripts already counted; descending into it would double every call.

The transcript is append-only JSONL. **Two line shapes coexist**, and a parser that assumes only the first starts every session two records late:

```jsonc
// 1. the record itself
{"schema_version":1,"id":"<uuid>","stream":{"kind":"session","id":"<session-id>"},
 "sequence":3,"recorded_at":1789246716491567,"record_type":"event","durability":"durable",
 "causation_id":null,"payload_type":"runtime.session.metadata","payload_schema_version":1,
 "payload":{ ... }}

// 2. a transaction wrapper whose children are records escaped as JSON strings
{"retained_frame":"session_permission_transaction","frame_schema_version":1,
 "outer_log_ordinal":1,"transaction_id":"<uuid>",
 "children":[{"child_index":0,"record_json":"{\"schema_version\":1, ... }"}],
 "content_sha256":"sha256:..."}
```

`recorded_at` is **microseconds** since the epoch. `payload_schema_version` varies per payload type — it is 2 on approval records and 1 on their neighbours in Meta's own cookbook export — so nothing may treat it as a constant.

The records this provider reads:

| Record | Used for |
|---|---|
| `runtime.session.metadata` | `payload.record.workspace_root` (the project), `provider_id`, `build.{sha,semver}`; `model_id` as a model fallback |
| `runtime.user_intent.accepted` | `payload.refill_blocks[].text` — the turn preview |
| `runtime.session` / `payload.kind: "run"` / `event.kind: "goal_usage_attribution"` | the billed call: `event.record.usage_id`, `usage_family`, `quantity`, `owner` |
| same, `event.kind: "model_completed"` | the model name and `duration_ms`; the token fallback when no attribution accompanies the step |
| same, `event.kind: "assistant_tool_calls_committed"` | tool names |

Everything else — the task lifecycle under `runtime.session.task`, `session.opened.observed`, `session.workspace_branch.observed`, `session.end`, the effect streams — is skipped. An event kind this build does not know is counted and reported once per file, never fatal: `muse` auto-updates hourly.

## The two usage records, and the double count they cause

Muse Code 1.1.x writes **two** records for one model step, carrying the same numbers:

```jsonc
// seq 48 — the session-level projection. Has the identity and the owner.
{"kind":"goal_usage_attribution","record":{
  "schema_version":1,"usage_id":"usage-9130f80f-…","usage_family":"provider",
  "quantity":{"unit":"tokens","reported":true,"input_tokens":0,"output_tokens":0,
              "cached_tokens":0,"reasoning_tokens":0,"main_llm_steps":1},
  "owner":{"requester_kind":"main","session_id":"…","run_id":"…",
           "owner_id":"main-root","owner_type":"main_root"},
  "goal_attribution":{"mode":"none"}}}

// seq 49 — the run-stream record. Has the model name.
{"kind":"model_completed","usage":{"input_tokens":0,"output_tokens":0,
  "cached_tokens":0,"reasoning_tokens":0},"duration_ms":6}
```

Summing both doubles every call. CodeBurn takes tokens and identity from the attribution and the model name from `model_completed`, pairing them by position within a `run_id` — a run has one pair per model step, and `model_completed` is "one per model step; a run can have several". A step with a `model_completed` and no attribution (an older build, or a published excerpt that elides `usage_id`) is billed from the model event instead, keyed on its `source_run_record_id`.

Dedup is on **identity, never position**: `muse-code:<usage_id>`, held in the scan-wide `seenKeys`. That one key closes three separate double-count routes:

1. a 1.1.x re-emission of the same record inside one file;
2. a delegated run mirrored into the parent's log as well as into `subagent/<child-id>/session.jsonl` — Meta's own `muse trace inspect --help` says its projection includes hashed workflow-child run streams mirrored into the parent log (#6408), so this is documented behaviour, not a guess;
3. a forked session (`is_copied_context` in `muse export`) replaying the prefix it inherited, the hazard `dsh.ts` handles with `seedLength`.

Only `usage_family: "provider"` is billable. A `usage_family: "tool"` attribution rides the same run and is ignored.

Delegated work is billed to the **root** session, which is the directory above `subagent/` in the transcript's own path. Meta's MSP schema says child usage is never folded into the parent's cumulative — it rides the owning items — so the child's record is real spend wherever it appears; it just must not be counted twice.

## Cost

Muse records tokens, never dollars, so every call is priced from the shared tables.

- The bundled LiteLLM snapshot already carries `meta/muse-spark-1.1`, `-1.2`, `-1.2-contributor`, `-1.3`, `-1.3-contributor` **and** the bare spellings the logs use. **No alias is needed**, and none was added: `calculateCost('muse-spark-1.3-contributor', …)` already resolves to the contributor rates. The two tiers are 12.5x apart on input ($1.25 vs $0.10 per 1M), so `tests/providers/muse-code.test.ts` pins that they price apart.
- A call whose model cannot be read is reported as `unknown`, which costs $0 and raises codeburn's standard unpriced-model warning. It is **never** defaulted to a Muse Spark tier. That is Meta's own rule, not a workaround: `SessionTokenUsageParams.modelId` in the MSP wire schema says a null model is "never back-filled, an unpriced leg".
- **Reasoning tokens are already inside `output_tokens`.** Meta's MSP schema defines `TokenUsage.reasoningTokens` as output tokens spent on reasoning, so `muse-code` joins `claude`, `codex`, `copilot` and `dsh` in `REASONING_INCLUDED_IN_OUTPUT`; they are never added on top.
- **`input_tokens` is read as inclusive of `cached_tokens`**, so the uncached remainder is priced at the input rate and the cached share at the cache-read rate — the same normalization `codex.ts` applies to OpenAI counts. See the caveat below: this is the one pricing-relevant claim that a real Meta-provider session still has to confirm.
- `cache_write_tokens` appears on `model_completed.usage` in the published excerpts. It is only moved into the cache-write bucket when the pricing source publishes an explicit cache-write rate for the model; the Muse Spark rows do not, so those tokens stay in plain input rather than inventing a surcharge Meta never billed.
- `quantity.reported` is a boolean. When it is false, Muse did not measure what it is reporting, so the call is marked `costIsEstimated` rather than recorded as a confident zero.

## Quota

**None, deliberately.** There is no documented quota or usage HTTP API and no `muse` subcommand for it; `/usage` is an interactive TUI command only. Per a third-party implementation that tried, the plan-window numbers are not persisted to disk at all — they arrive as a `response.subscription_usage` frame at the end of a **live, billed model call**, so reading the quota would cost the user money on every refresh. CodeBurn ships no Muse quota adapter. Subscription users therefore see API-rate estimates, the same caveat Claude and Codex subscribers get.

## Caching

None at the provider level; the transcript is the cached source path and the normal parser/cache layers apply. The cache fingerprint invalidates on `MUSE_DATA_DIR` and `XDG_DATA_HOME` (`PROVIDER_ENV_VARS`).

## Provenance and what is still unverified

This provider was built without a paid Meta account. Its evidence comes from three places, and the split matters when a number looks wrong.

**Confirmed against a real `Muse Code 1.1.1 (1.1.1-R2514.1)` binary** (build sha `b934305d21`, macOS), whose `muse exec --provider echo` sessions were read off disk, cross-checked with `muse export`, `muse trace inspect` and the wire schema from `muse schema generate-json-schema`, all offline and unauthenticated:

- the session path, the date shards, `subagent/<child-id>/session.jsonl`, `.msp-view-v1/`;
- both line shapes, including the `retained_frame` wrapper and its escaped `record_json` children;
- `recorded_at` in microseconds;
- `runtime.session.metadata.record.{workspace_root, provider_id, build.semver, build.sha}`;
- the `goal_usage_attribution` record in full — `usage_id`, `usage_family`, `quantity.{unit, reported, input_tokens, output_tokens, cached_tokens, reasoning_tokens, main_llm_steps}`, `owner.{requester_kind, session_id, run_id, owner_id, owner_type}`;
- `model_completed.{usage, duration_ms}` and the fact that both records are written for one step;
- `runtime.user_intent.accepted.refill_blocks[]`, `session.opened.observed`, `session.end`, `session.workspace_branch.observed`;
- that reasoning is inside output, and that a null model is an unpriced leg (both from Meta's own wire schema).

**Confirmed only from published excerpts of real logs**, because the echo provider has no model and refuses `--model`:

- `model_completed.event.model`, and the literal spellings `muse-spark-1.2`, `muse-spark-1.3`, `muse-spark-1.2-contributor`, `muse-spark-1.3-contributor` with no `meta/` prefix. Sources: steipete/CodexBar PR #3587 (`MuseCostUsageScannerTests.swift`, the case named for a real Muse CLI runtime log) and superset-sh/superset (`packages/host-service/src/trpc/router/usage/history/muse.test.ts`, the case named for a real Muse Code 1.1.1 record).
- `runtime.session.metadata.record.model_id`, from superset's helper only.
- `cache_read_tokens` / `cache_write_tokens` on `model_completed.usage`, from CodexBar's excerpt.
- `assistant_tool_calls_committed.tool_calls[].name`, from SpecStory's `MUSE-FORMAT.md`.

**Still unverified by anyone, and the thing to check first if numbers look wrong:**

- **Whether `input_tokens` includes `cached_tokens`.** Meta's schema explicitly refuses to say: `TokenUsage.cachedTokens` is documented as living inside *or beside* `inputTokens`, provider-convention-dependent, which is why the counted-once `promptTokens` exists — and `promptTokens` is **not** in the durable log, only in the MSP `session/tokenUsage` projection. Neither published real-model excerpt is numerically decisive (one has `cached_tokens: 0`, the other carries no total). CodeBurn subtracts, following the one source that states the convention outright. If a real session shows otherwise, exactly one line in `src/providers/muse-code.ts` changes.
- The model id on a real `--provider meta` session: whether it lands on `model_completed`, on the metadata record, or on a session-level model event (the schema has `EffectiveModel` and `SessionModelChangedParams`). The parser reads all three, in that order.
- Whether subagent usage really is mirrored into the parent log in 1.1.1 (it is documented; the local echo runs' subagents failed before producing usage).
- `muse resume` behaviour: whether it appends to the existing transcript or opens a new one. `resume` needs a TTY, so it could not be exercised headlessly.
- Pricing against Muse's own `/usage`, which is the ground truth.

## When fixing a bug here

1. Reproduce with a minimal session dir: `sessions/2026/09/12/<id>/session.jsonl`. `tests/providers/muse-code.test.ts` has helpers that emit the exact envelope, attribution and completion shapes.
2. `tests/fixtures/muse-code/echo-session-1.1.1.jsonl` is the real binary's own log, excerpted; every counter in it is zero because the echo provider bills nothing, which is exactly the case that must not surface as a $0.00 call.
3. `tests/fixtures/muse-code/published-codexbar-pr3587.jsonl` and `published-superset-1.1.1.jsonl` are the token-bearing real-model excerpts. Each file's first line is a `_provenance` record naming where it came from.
4. Refresh the fixtures from a real install when the format moves; `muse` auto-updates hourly from the `muse-stable` channel, so it will.
