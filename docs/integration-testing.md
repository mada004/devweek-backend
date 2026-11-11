# Isolated integration testing and defect-fix verification

This report records verification of the local fixes on `phase-3-backend` before the authorized Git handoff. No production data, function deployment, schema, migration, secret, constraint or authentication rule was changed during testing. Commit/push authorization was subsequently received; deployment remains unauthorized.

## Run safely

Prerequisites: Node.js 24, installed Supabase CLI 3.1.0, and the Docker Linux engine. No cloud project or paid resource is required.

```powershell
cd C:\Projects\devweek-backend
npm.cmd test
node tests/integration/run-local.mjs --confirm-local-writes
```

The orchestrator creates a unique, unlinked temporary workspace/project ID, copies the existing migration/function source/config, and uses local API/database ports 55321/55322. It never copies hosted linkage or environment files. It generates independent local test secrets, suppresses raw CLI/runtime output, deletes its temporary secret file, and stops its own stack afterward. Normal local Supabase backups may remain; unrelated local projects are not reused or stopped.

The HTTP harness rejects non-loopback targets, unexpected ports, URL credentials/query strings, and absent isolation/confirmation flags. It uses only synthetic participants and random test numbers. The synthetic operator acknowledgement is an explicit harness flag before start, not a new backend rule or proof of a real booth interaction. No frontend is implemented.

## Issue 1: exact number-only login

### Root cause established before changing lookup code

A temporary diagnostic copy of the students function captured only whether the actual PostgREST filter was quoted and how many rows it returned. This instrumentation was confined to the disposable workspace; it is not deployed or inserted into the real handler. The trace registered a fresh synthetic participant, called the real students login endpoint, and checked the exact stored PostgreSQL TEXT value through the named local database container.

Observed before the fix:

| Check | Result |
| --- | --- |
| Real Edge registration | HTTP 201 |
| Real Edge login with the exact same number | HTTP 404 |
| PostgreSQL equality and column TEXT type | True |
| Actual adapter filter used `eq."value"` | True |
| Actual PostgREST rows for that filter | 0 |
| Same local Edge request with diagnostic control filter `eq.value` | HTTP 200, 1 row, exact participant match |

The adapter incorrectly added SQL/list-style quotes and backslash escapes to a single equality operand. They became part of the value being matched. This was not a missing registration, numeric conversion, schema defect, or authentication requirement. The old mock fetch always returned a row and asserted the wrong filter construction, so it missed the integration defect.

The fix uses the exact string after `eq.` and lets `URLSearchParams` encode it as one query value. This matches the official Supabase client's [equality filter implementation](https://github.com/supabase/supabase-js/blob/master/packages/core/postgrest-js/src/PostgrestFilterBuilder.ts). No numeric conversion, trimming, name requirement or schema change is introduced.

`tests/api.test.ts` adds an adapter-backed fresh-registration/login regression and verifies leading zeros, spaces, quotes, backslashes and URL-reserved characters. The real local journey also tests these formats and checks that `0000123` is not treated as `123`.

To repeat the root-cause diagnostic locally:

```powershell
node tests/integration/run-local.mjs --confirm-local-writes --trace-login
```

On the fixed source, the normal and control login should both return 200. This mode adds diagnostic response headers only to temporary function copies and performs a read-only comparison in that disposable PostgreSQL container. It does not inspect production credentials. Earlier attempts to obtain local credentials through CLI status were abandoned because CLI 3.1 omits them; the final trace uses no service credential retrieval.

## Issue 2: finish confirmation after aggregation failure

The score UPDATE and aggregate SELECT are separate PostgREST operations. Previously they shared a broad error path, so a successful UPDATE followed by a failing SELECT returned the same generic HTTP 500 as a save failure.

The fix catches only the aggregate lookup after `store.finish` has returned the saved attempt:

- Normal HTTP 200 preserves `attempt`, numeric `total_score` and numeric `games_completed`, and adds `score_saved: true` and `total_available: true`.
- If aggregation fails after saving, HTTP 200 includes the saved `attempt`, `score_saved: true`, `total_available: false`, null aggregate fields, and `warning.code: total_unavailable`.
- A save failure still returns HTTP 500 `internal_error`, without a saved attempt/success marker.
- A completed attempt cannot be completed again: HTTP 409 `attempt_already_completed`. The conditional UPDATE and database lifecycle/uniqueness constraints are unchanged. No extra score write or automatic retry is introduced.

See `docs/api.md` for the full normal/degraded response structures. The frontend must display the confirmed `attempt.score`, not an unavailable total, for its own 10-second confirmation screen. The backend returns immediately and implements no timer. Aggregates can be refreshed separately; do not resubmit the score to obtain them or convert null to zero. A network failure/lost response can still be ambiguous and requires progress reconciliation.

Separate unit fault injections verify both save failure before mutation and successful save followed by failed aggregate lookup. They verify persistence state, exact response metadata, progress reconciliation and prevention of double-save/reopening. These injections use mock storage; no real database outage was induced.

## Real local journey assertions

The fixed journey must not bypass login. It verifies:

1. Local access verification, without printing its token.
2. Fresh registration (201), duplicate rejection (409), exact number-only login (200).
3. Fresh registration/login regressions for leading-zero, reserved-character and surrounding-space TEXT values; mismatched `123` lookup is 404.
4. Five fixed games, max_score 100 each.
5. Explicit synthetic operator acknowledgement followed by first start (201), with database-generated ID/time and Riyadh date.
6. Second game on the same Riyadh date rejected (409 `daily_limit_reached`).
7. Same-game replay rejected (409 `game_already_attempted`).
8. Finish with 85 (200), confirmed saved attempt plus available total, one completed game.
9. Progress shows saved score 85 and consumed daily slot.
10. Leaderboard aggregates the synthetic participant to 85/one completion.
11. Repeated finish with 25 rejected (409); progress remains 85.

Initial pre-fix real local runs established the login failure; the previous continuation using the registration ID was diagnostic only and was removed. It cannot be considered a passing full journey.

## Verification results

Final execution results are recorded below after the fixed local run. Automated unit tests are separate from real local HTTP/database tests.

### Final verification after both fixes - 2026-11-11

- `npm.cmd test`: **26 passed, 0 failed**. Existing access, registration, restriction, scoring, progress, leaderboard and concurrency-mock tests passed, plus fresh adapter-backed login and separate save/aggregate fault-injection regressions.
- Deno 2.9.6 `check` of all five function entry points: **passed**.
- `node tests/integration/run-local.mjs --confirm-local-writes`: **passed**, exit 0. All 20 real local HTTP checks passed, including login without bypass, TEXT edge cases, score_saved/total_available confirmation, persisted score and leaderboard aggregation. The stack used fresh disposable PostgreSQL, PostgREST and Edge Runtime on ports 55321/55322; production requests: zero. Cleanup stopped its stack with exit 0 and removed its local secret file.
- The root-cause trace ran successfully before changing `students.ts`: exact PostgreSQL TEXT match true, old filter quoted true/zero rows/404, raw equality control one row/200. Setup attempts that could not obtain local metadata were stopped and cleaned up; they were not counted as successful diagnostic tests.
- `git diff --check`: **passed**. New integration scripts also passed Node syntax checks.
- Normal real-database save/progress/aggregation were tested; failure injection used mock storage and is not a real database-outage test.

Full journey verified locally: **Register -> Login -> Start Game -> Finish Game -> Confirm Saved Score -> Progress -> Leaderboard**. No local journey bypasses the returning-login step now.

The only response-contract change is the finish success metadata/degraded-success variant documented in `docs/api.md`. Student lookup fields and login requirements are unchanged. Per-game/day uniqueness, atomic completion predicate and lifecycle trigger remain unchanged. The frontend owns its 10-second display and can render the confirmed `attempt.score` even when totals are unavailable.

### Current files and remaining gaps

Local changes in this task consist of:

- `supabase/functions/_shared/students.ts`: correct equality operand.
- `supabase/functions/_shared/game-api.ts`: distinguish saved score from aggregate-read failure.
- `tests/api.test.ts`: exact TEXT adapter/fresh-registration regression and corrected filter assertion.
- `tests/games.test.ts`: separate save-failure and saved-score/total-failure regressions.
- `tests/integration/local-journey.mjs`: full strict journey and real TEXT regression cases.
- `tests/integration/run-local.mjs`: safe isolated orchestration and temporary-copy diagnostic support.
- `tests/integration/login-trace.mjs`: real Edge/PostgREST/PostgreSQL root-cause diagnostic with sanitized results.
- `docs/api.md`: exact finish response variants and frontend handling.
- `docs/integration-testing.md`: safety, diagnosis and actual results.

Some test/orchestration files were already uncommitted from the preceding test task; that work was preserved and extended. At the verification snapshot, Git was on `phase-3-backend` with five modified tracked files and four new/untracked files. No commit, push or deployment had been performed at that point. The existing hosted project still runs its previously deployed code; these fixes need separate deployment authorization before hosted behavior changes. Hosted write testing remains intentionally unperformed. No schema change or new business feature is needed. Cross-midnight/concurrent real-database stress testing and real storage/network outage injection remain outside this verification pass.

### Pre-commit review - 2026-11-11

The complete 26-test unit suite, Deno checks for all five entry points, and integration-script syntax checks were repeated successfully. The 20 real isolated HTTP checks above were executed during the preceding fix verification, not rerun for the Git-only handoff. The exact nine-file scope was reviewed. A credential-pattern scan found no matching real keys, tokens, embedded database credentials or private data; test-only fixtures and runtime-generated local credentials are not production secrets. Temporary workspaces, local environment files, node_modules and generated artifacts are outside the proposed commit. Commit/push is authorized for phase-3-backend only; no deployment or merge is authorized.
