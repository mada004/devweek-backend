# Dev Week API: frontend integration handoff

## Deployment and base URLs

Confirmed deployment state as of 2026-11-11: all five Edge Functions are ACTIVE on Supabase project `devweek-backend` (`wjhbdtznydxozorfanrx`). The number-only login and saved-score confirmation fixes are deployed in v2.

| Function | Version | Routes |
| --- | --- | --- |
| access | 1 | `/access/verify` |
| students | 2 | `/students/register`, `/students/login`, `/students/{student_id}/progress` |
| games | 1 | `/games` |
| attempts | 2 | `/attempts/start`, `/attempts/finish` |
| leaderboard | 1 | `/leaderboard` |

- Hosted base URL: `https://wjhbdtznydxozorfanrx.supabase.co/functions/v1`
- Default local Supabase base URL: `http://127.0.0.1:54321/functions/v1`
- Disposable integration-test base URL: `http://127.0.0.1:55321/functions/v1`

Append the exact route path below to the selected base URL. For example, hosted login is `https://wjhbdtznydxozorfanrx.supabase.co/functions/v1/students/login`. Do not append a trailing slash to the documented paths. All examples use fictional participant data and illustrative timestamps.

## Headers, tokens and server configuration

Header profiles used in the route table:

| Profile | Required request headers |
| --- | --- |
| Access POST | `Content-Type: application/json` |
| Protected POST | `Content-Type: application/json` and `Authorization: Bearer <platform_access_token>` |
| Protected GET | `Authorization: Bearer <platform_access_token>`; no request body |

All routes except access verification require the temporary platform token. It expires after **3600 seconds**. Keep it in memory; do not put it in URLs or logs. On `401 invalid_platform_token`, ask the operator to verify the shared code again. There is no refresh endpoint. Do not substitute a student UUID, Supabase user JWT, or service-role key for this token. All five functions preserve `verify_jwt = false` at the gateway and validate custom platform tokens inside their handlers. No `apikey` header or Supabase Auth session is required by this API.

JSON responses have `Content-Type: application/json` and `Cache-Control: no-store`. OPTIONS on a documented route returns **204** with no body. CORS allows origin `*`, methods `GET, POST, OPTIONS`, and headers `authorization, apikey, content-type, x-client-info`; the flow does not use cookies.

The server secrets `PLATFORM_ACCESS_CODE` and `PLATFORM_TOKEN_SIGNING_SECRET` are configured remotely. Supabase supplies server-side `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. **Never hardcode the platform access code, signing secret, or service-role key in frontend source or public build-time environment variables.** The operator enters the access code at runtime; only the resulting temporary token is used for subsequent API calls. Secret rotation/management is not a frontend responsibility. Changing the signing secret invalidates issued tokens; changing only the shared code does not revoke existing tokens.

## Route summary

The success JSON and endpoint-specific errors are detailed below. Common errors also apply as described in the error section.

| Method and path | Header profile | Request JSON | Success |
| --- | --- | --- | --- |
| POST `/access/verify` | Access POST | `access_code` string | 200 token |
| POST `/students/register` | Protected POST | `full_name`, `student_number` strings | 201 student |
| POST `/students/login` | Protected POST | `student_number` string only | 200 student |
| GET `/games` | Protected GET | None | 200 games |
| GET `/students/{student_id}/progress` | Protected GET | None; UUID in path | 200 progress |
| POST `/attempts/start` | Protected POST | `student_id` UUID string, `game_id` integer 1-5 | 201 attempt |
| POST `/attempts/finish` | Protected POST | `attempt_id` UUID string, `score` integer 0-100 | 200 confirmed save |
| GET `/leaderboard` | Protected GET | None | 200 top-three array |

### POST /access/verify

Request:

```json
{"access_code":"<operator-entered code>"}
```

200 response:

```json
{"access_token":"<opaque runtime token>","token_type":"Bearer","expires_in":3600}
```

Blank/missing/non-string code: **400 `invalid_input`**. Incorrect code: **401 `invalid_access_code`**. The code is checked on the server and is not returned or stored as participant data.

### POST /students/register

Request:

```json
{"full_name":"Example Participant","student_number":"00123"}
```

201 response:

```json
{"student":{"id":"00000000-0000-0000-0000-000000000001","full_name":"Example Participant","student_number":"00123"}}
```

Both fields must be nonempty strings; whitespace-only values fail with **400 `invalid_input`**. Names are trimmed. **Student numbers remain strings**, with leading zeros, spaces and other characters preserved exactly; no numeric conversion or fixed digit count applies. Duplicate number: **409 `student_number_exists`**. Registration does not overwrite an existing name. Offer returning lookup instead of repeating registration.

### POST /students/login

Request (no name or password):

```json
{"student_number":"00123"}
```

200 response:

```json
{"student":{"id":"00000000-0000-0000-0000-000000000001","full_name":"Example Participant","student_number":"00123"}}
```

Use the exact previously registered string. Invalid/blank number: **400 `invalid_input`**. Unknown number: **404 `student_not_found`**; offer registration. Number-only lookup does not establish participant identity or ownership.

### GET /games

No request JSON. Example 200 response with the five seeded placeholder definitions:

```json
{"games":[
  {"id":1,"name":"Game 1","max_score":100,"is_active":true},
  {"id":2,"name":"Game 2","max_score":100,"is_active":true},
  {"id":3,"name":"Game 3","max_score":100,"is_active":true},
  {"id":4,"name":"Game 4","max_score":100,"is_active":true},
  {"id":5,"name":"Game 5","max_score":100,"is_active":true}
]}
```

Definitions include inactive games; do not assume every returned game is selectable. Each max_score is 100. Combine definitions with progress eligibility. This endpoint supplies metadata, not game assets or a reservation. Errors: **401 `invalid_platform_token`**, **500 `internal_error` / `server_configuration_error`**, plus common routing/method errors.

### GET /students/{student_id}/progress

No request JSON. Example path: `/students/00000000-0000-0000-0000-000000000001/progress`.

Example 200 response after one completed attempt:

```json
{
  "student_id":"00000000-0000-0000-0000-000000000001",
  "play_date":"2026-11-11",
  "daily_slot_consumed":true,
  "total_score":85,
  "games_completed":1,
  "games":[
    {"id":1,"name":"Game 1","max_score":100,"is_active":true,"attempt":{"id":"10000000-0000-0000-0000-000000000001","student_id":"00000000-0000-0000-0000-000000000001","game_id":1,"status":"completed","score":85,"play_date":"2026-11-11","started_at":"2026-11-11T12:00:00+00:00","completed_at":"2026-11-11T12:03:00.000Z"},"eligible_to_start":false},
    {"id":2,"name":"Game 2","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":false},
    {"id":3,"name":"Game 3","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":false},
    {"id":4,"name":"Game 4","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":false},
    {"id":5,"name":"Game 5","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":false}
  ]
}
```

`play_date` is the current Asia/Riyadh calendar date. Each game's `attempt` is null or the full attempt object shown above, including started attempts with null score/completion time. Eligibility requires an active game, no previous attempt for that game and no attempt started today. It is advisory and may change before Start commits. Only completed scores contribute to totals; the maximum across five games is 500. Progress uses separate reads, not a guaranteed single snapshot.

Errors: **400 `invalid_input`** for an invalid UUID; **404 `student_not_found`**; **401 `invalid_platform_token`**; **500 `internal_error` / `server_configuration_error`**, plus common routing/method errors.

### POST /attempts/start

Request, sent only after the operator explicitly presses Start:

```json
{"student_id":"00000000-0000-0000-0000-000000000001","game_id":1}
```

201 response:

```json
{"attempt":{"id":"10000000-0000-0000-0000-000000000001","student_id":"00000000-0000-0000-0000-000000000001","game_id":1,"status":"started","score":null,"play_date":"2026-11-11","started_at":"2026-11-11T12:00:00+00:00","completed_at":null}}
```

The database generates the attempt ID, start timestamp, Riyadh date and initial state. **Start consumes both that game's one-time slot and the participant's daily slot**, including interrupted play. Selecting/confirming a game must NOT call Start. No cancellation/release/reset endpoint exists. Do not retry Start automatically or create another attempt after an ambiguous response; reconcile via progress first. Prevent duplicate Start actions while a request is pending.

Errors: **400 `invalid_input`**; **401 `invalid_platform_token`**; **404 `student_not_found` / `game_not_found`**; **409 `game_inactive`, `game_already_attempted`, `daily_limit_reached`, `attempt_conflict` or `reference_conflict`**; **415 `unsupported_media_type`**; **500 `internal_error` / `server_configuration_error`**. On conflicts, refresh progress and show the relevant restriction. No client-supplied date or timestamp overrides server values.

### POST /attempts/finish

Request:

```json
{"attempt_id":"10000000-0000-0000-0000-000000000001","score":85}
```

Successful save and total retrieval: **200**.

```json
{
  "attempt":{"id":"10000000-0000-0000-0000-000000000001","student_id":"00000000-0000-0000-0000-000000000001","game_id":1,"status":"completed","score":85,"play_date":"2026-11-11","started_at":"2026-11-11T12:00:00+00:00","completed_at":"2026-11-11T12:03:00.000Z"},
  "total_score":85,"games_completed":1,
  "score_saved":true,"total_available":true
}
```

Successful save but failed total lookup: also **200**, not a failed score submission.

```json
{
  "attempt":{"id":"10000000-0000-0000-0000-000000000001","student_id":"00000000-0000-0000-0000-000000000001","game_id":1,"status":"completed","score":85,"play_date":"2026-11-11","started_at":"2026-11-11T12:00:00+00:00","completed_at":"2026-11-11T12:03:00.000Z"},
  "score_saved":true,"total_available":false,
  "total_score":null,"games_completed":null,
  "warning":{"code":"total_unavailable","message":"Score saved; updated total could not be retrieved"}
}
```

For either 200 variant, confirm `score_saved === true` and the completed attempt, then display **`attempt.score`**. With `total_available === false`, display the saved score normally; null totals mean unavailable, not zero. Refresh progress/leaderboard separately when reads recover. **Never resubmit an already confirmed score to obtain totals.**

Errors: **400 `invalid_input`** for malformed IDs/JSON or scores outside the integer range 0-100; **401 `invalid_platform_token`**; **404 `attempt_not_found`**; **409 `attempt_already_completed`, `attempt_conflict` or `reference_conflict`**; **415 `unsupported_media_type`**; **500 `internal_error` / `server_configuration_error`**. Repeated completion, even with the same score, returns 409 and cannot reopen or overwrite the completed attempt.

A 500 or network/lost-response error without confirmation does not establish whether persistence occurred. Keep the attempt ID and reconcile through progress when reads recover; never assume rollback, display an unconfirmed submitted score as saved, automatically resubmit, or create a replacement attempt. A completed matching attempt in progress confirms its saved score; a still-started attempt has no confirmed score. If progress is unavailable, retain the unresolved state rather than inventing success. The database enforces the lifecycle and unique slots; no client identity or timestamp is authoritative.

### GET /leaderboard

No request JSON. Example populated 200 response:

```json
{"leaderboard":[{"full_name":"Example Participant","total_score":85,"games_completed":1}]}
```

An empty result is `{"leaderboard":[]}`. At most three rows are returned, ordered by total_score descending, with student UUID ascending as the deterministic tie-breaker. Numbers and UUIDs are not exposed in leaderboard rows. The existing view can include participants with zero completions/totals; it does not require completing all games. This endpoint requires the platform token, including for a display screen.

Errors: **401 `invalid_platform_token`**, **500 `internal_error` / `server_configuration_error`**, plus common routing/method errors.

## Error envelope and common status codes

```json
{"error":{"code":"invalid_input","message":"Expected a JSON object"}}
```

Use the error code to choose the UI action; the message explains the specific failure. Ordinary error responses contain `error`, not a success confirmation. The finish warning above is part of a successful response.

| HTTP | Code | Frontend handling |
| --- | --- | --- |
| 400 | `invalid_input` | Correct JSON/field types; POST bodies must be objects. |
| 401 | `invalid_access_code` | Request operator correction; never guess codes automatically. |
| 401 | `invalid_platform_token` | Reverify the shared code; preserve unresolved attempt context. |
| 404 | `not_found` | Correct the exact route path. Endpoint-specific 404 codes are listed above. |
| 405 | `method_not_allowed` | Use the method documented for that route, including GET routes. |
| 409 | Endpoint-specific conflict | Do not repeat writes blindly; refresh/reconcile relevant state. |
| 415 | `unsupported_media_type` | Send `Content-Type: application/json` for POST. |
| 500 | `internal_error` / `server_configuration_error` | Do not expose internals; reconcile ambiguous writes. |

Unknown routes return 404 and wrong methods 405. For recognized protected requests, token checks precede body parsing and storage access. An unavailable server configuration can return 500. No database error details, access codes or credentials should be logged by frontend request/error reporting.

## Complete booth operator flow

1. **Verify access:** operator enters the shared code at runtime; POST `/access/verify`, then keep the temporary token in memory. Do not persist or log the entered code.
2. **Identify participant:** POST name and string number to `/students/register`, OR number only to `/students/login`. Use the returned `student.id`. On duplicate registration, offer returning lookup; on unknown number, offer registration.
3. **Fetch availability:** GET `/games` and `/students/{student_id}/progress`. Offer only active games whose `eligible_to_start` is true.
4. **Select and confirm:** operator selects and confirms the intended game in the UI. This is frontend state only; it must NOT create an attempt. The API has no operator-identity/confirmation endpoint.
5. **Press Start:** send one explicit POST `/attempts/start`. Disable repeat actions while pending. Do not retry automatically. On 201, retain `attempt.id`, student/game IDs and server start time before launching the game.
6. **Run the game:** associate its result with that returned attempt ID. An interruption does not release the daily or game slot.
7. **Submit final score:** when the game finishes, submit one integer score 0-100 to `/attempts/finish` with the retained attempt ID. Do not create another attempt.
8. **Confirm persistence:** on 200, require `score_saved === true` and a completed attempt. Use `attempt.score` as the confirmed saved score; totals may be unavailable. On an unconfirmed response, reconcile progress instead of claiming success.
9. **Show confirmation for 10 seconds:** the frontend displays the confirmed `attempt.score` and owns the 10-second timer. The backend responds immediately and has no display timer. `total_available === false` must not suppress this confirmation or trigger resubmission.
10. **Return to initial screen:** after the confirmation period, clear participant, game-selection, attempt and score UI state before the next participant. Keep a valid platform token only in memory for the operator session; after 3600 seconds, reverify access. Refresh leaderboard as needed.

This is a shared-code platform, not individual participant or booth-operator authentication. UUIDs are references, not proof of ownership; the token grants platform-wide access. Scores are range-checked submissions, not independently verified gameplay. No frontend, game SDK, authentication or anti-cheat feature is supplied by these APIs.

## Verification status and remaining gaps

These are recorded completed checks, not new tests performed during this documentation update:

| Scope | Verified results |
| --- | --- |
| Local unit/fault injection | **26 tests passed**; save-failure and saved-score/total-failure cases are distinct. Fault injection uses mock storage, not a real database outage. |
| Deno | All five function entry points passed type checks. |
| Isolated real HTTP integration | **20 checks passed** against disposable local PostgreSQL, PostgREST and Edge Runtime at port **55321**, including Register -> Login -> Start -> Finish -> Saved Score -> Progress -> Leaderboard and TEXT number regressions. |
| Hosted read-only integration | Access verification issued a usable 3600-second token; authenticated games returned five entries with max_score 100; leaderboard returned a valid empty array. These checks passed before the v2 updates to students/attempts; the three read-only/access functions remain at v1. |
| Hosted deployment/gateway | All five ACTIVE; students/attempts v2. CORS preflights returned 204, and missing/invalid-token checks returned 401. Post-v2 checks covered both updated functions, with no unexpected 500 on tested paths. |

**Still untested on the hosted database:** registration, successful returning-participant login, attempt start/finish, saved-score confirmation, participant progress for a newly written attempt, populated leaderboard aggregation, and post-save total-query failure. No production fixtures were inserted for testing. The local full journey does not imply those hosted write flows were executed. Real database cross-midnight/concurrency stress and real network/storage outage injection are also not established by these results.

Recorded test details and isolated setup: [integration-testing.md](integration-testing.md). Use Node.js 24+ for `npm.cmd test` (or `npm test` in a compatible shell). The default Supabase local API port is **54321**; the isolated runner deliberately uses **55321**. Do not point write-integration scripts at the hosted base URL. No schema or business-rule changes were required for the deployed fixes.
