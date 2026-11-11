# Dev Week API — Phases 3A and 3B

Implemented locally as TypeScript Supabase Edge Functions; not deployed. No student Auth, passwords, or identity verification are used. The deployed database schema is unchanged.

## URLs and headers

Future hosted base URL: `https://wjhbdtznydxozorfanrx.supabase.co/functions/v1`.
Local base URL when functions are served: `http://127.0.0.1:54321/functions/v1`.

The three Phase 3A endpoints below use POST with `Content-Type: application/json`. Every endpoint except `/access/verify` requires `Authorization: Bearer <platform_access_token>`. No Supabase user JWT is required. All five function configurations (`access`, `students`, `games`, `attempts`, `leaderboard`) set `verify_jwt = false`; custom platform token verification runs inside the protected handlers. Do not substitute a student UUID for this token.

OPTIONS preflight returns 204. CORS permits browser origins with explicit bearer tokens, GET/POST methods, and JSON headers, without cookies. Responses use `Cache-Control: no-store`.

## POST /access/verify

```json
{ "access_code": "<code entered by visitor>" }
```

200 response:

```json
{ "access_token": "<signed platform token>", "token_type": "Bearer", "expires_in": 3600 }
```

The server verifies the exact submitted code against `PLATFORM_ACCESS_CODE` using Web Crypto HMAC verification. It never returns or stores that code in the database. Missing, blank, or non-string codes return 400; an incorrect code returns 401 (`invalid_access_code`).

The opaque token contains a signed purpose, issue time, expiry, and random nonce. HMAC-SHA256 uses `PLATFORM_TOKEN_SIGNING_SECRET`, a separate server-only secret of at least 32 bytes. Use a cryptographically random secret, not a human password or the access code. Tokens last one hour; changing the signing secret invalidates existing tokens. Changing the shared code alone does not revoke tokens already issued. There is no refresh endpoint: re-enter the shared code after expiry.

## POST /students/register

Requires the platform bearer token.

```json
{ "full_name": "Student Name", "student_number": "00123" }
```

201 response:

```json
{ "student": { "id": "<student UUID>", "full_name": "Student Name", "student_number": "00123" } }
```

Both fields must be non-empty strings. Names are trimmed; the number is preserved exactly, with no numeric conversion or fixed-length/digit rule. Whitespace-only values are rejected. Clients should send the same exact number on subsequent visits. A duplicate returns 409 (`student_number_exists`); registration uses INSERT, never upsert, so names are not overwritten. The existing database unique constraint handles concurrent duplicates.

## POST /students/login

Requires the platform bearer token.

```json
{ "student_number": "00123" }
```

200 returns the same `student` structure as registration. An unknown number returns 404 (`student_not_found`). Login performs exact string lookup and needs no name, password, or additional verification. This lookup intentionally does not establish student identity: anyone holding platform access and knowing a number can retrieve that student's ID/name/number. Future code must not treat a client-provided UUID as proof of identity.

## Error format

```json
{ "error": { "code": "invalid_input", "message": "student_number must be a non-empty string" } }
```

| HTTP | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_input` | Invalid JSON/object, missing, blank, or non-string required fields |
| 401 | `invalid_access_code` | Shared code incorrect |
| 401 | `invalid_platform_token` | Missing, malformed, tampered, or expired bearer token |
| 404 | `student_not_found` | Number is not registered |
| 404 | `not_found` | Unknown route |
| 405 | `method_not_allowed` | Method other than POST or OPTIONS |
| 409 | `student_number_exists` | Number already registered |
| 415 | `unsupported_media_type` | JSON Content-Type required |
| 500 | `server_configuration_error` | Missing or invalid server configuration |
| 500 | `internal_error` | Storage or unexpected request processing failure |

Database details, request bodies, credentials, and access codes are not logged or returned. Protected endpoints verify tokens before parsing input or calling storage.

## Frontend integration

1. POST the visitor-entered shared code to `/access/verify` over HTTPS.
2. Keep the returned token in memory and attach it as the bearer token on registration/login requests. Do not place tokens in URLs or logs.
3. First visits POST name and a string number to `/students/register`. On 409, direct the visitor to the returning login flow; do not overwrite the original name.
4. Returning visits POST only the string number to `/students/login`. On 404, offer registration.
5. Store only the returned student data needed by the UI. On token 401, request the shared code again. Phase 3B routes below provide games, progress, attempts, scores, and leaderboard.

Never embed PLATFORM_ACCESS_CODE, signing secret, or service-role credentials in frontend code. No direct table writes are allowed for anonymous clients; RLS and existing grants remain unchanged.

## Server configuration and local verification

Required server environment variables (empty placeholders in `.env.example`):

- `SUPABASE_URL`: backend project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only service-role credential for PostgREST calls.
- `PLATFORM_ACCESS_CODE`: shared static visitor code.
- `PLATFORM_TOKEN_SIGNING_SECRET`: independent random signing secret of at least 32 bytes.

Supabase supplies the first two to hosted Edge Functions. Configure the custom secrets through the authorized server secret store in a later deployment step. No secrets or functions have been deployed in Phases 3A/3B.

Run `npm.cmd test` on Node.js 24+ (or `npm test` in a compatible shell). Tests execute the actual request handlers and token logic against isolated in-memory storage; the PostgREST adapter uses mocked fetch. They make no hosted database calls. Tests cover correct/incorrect/missing codes, valid/duplicate registration, existing/unknown login, missing/invalid/expired tokens, leading zeros, invalid input, storage error privacy, and CORS. Runtime type checking: `deno check supabase/functions/access/index.ts supabase/functions/students/index.ts`.

If local integration testing is later authorized, serve functions using the CLI and an ignored server environment file with disposable local database credentials. Never point integration tests at the hosted production database. Node unit tests do not verify a deployed gateway, real PostgREST, or Docker-based Edge Runtime behavior. No rate limiter or student identity system is introduced in this phase.

Official references: [Edge Function security](https://supabase.com/docs/guides/functions/auth), [routing](https://supabase.com/docs/guides/functions/routing), and [testing](https://supabase.com/docs/guides/functions/unit-test).

## Phase 3B common rules

All routes below use the same `/functions/v1` base URL and require the platform bearer token. GET requests have no body. POST requests require JSON Content-Type. Numbers such as game IDs and scores must be JSON integers, not numeric strings. Student and attempt IDs must be UUID strings. Additional client fields such as start date, student identity claims, or completion timestamps are ignored; server/database values are authoritative.

The requested `/students//progress` route is interpreted as `/students/{student_id}/progress`.

### GET /games

200 response (all five fixed definitions, including inactive games):

```json
{"games":[
  {"id":1,"name":"Game 1","max_score":100,"is_active":true},
  {"id":2,"name":"Game 2","max_score":100,"is_active":true},
  {"id":3,"name":"Game 3","max_score":100,"is_active":true},
  {"id":4,"name":"Game 4","max_score":100,"is_active":true},
  {"id":5,"name":"Game 5","max_score":100,"is_active":true}
]}
```

### GET /students/{student_id}/progress

Example path: `/students/00000000-0000-0000-0000-000000000001/progress`.

200 response, before any attempt:

```json
{
  "student_id":"00000000-0000-0000-0000-000000000001",
  "play_date":"2026-11-10",
  "daily_slot_consumed":false,
  "total_score":0,
  "games_completed":0,
  "games":[
    {"id":1,"name":"Game 1","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":true},
    {"id":2,"name":"Game 2","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":true},
    {"id":3,"name":"Game 3","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":true},
    {"id":4,"name":"Game 4","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":true},
    {"id":5,"name":"Game 5","max_score":100,"is_active":true,"attempt":null,"eligible_to_start":true}
  ]
}
```

For played games, `attempt` contains the same full attempt structure shown below. Eligibility requires an active game, no previous attempt for that game, and no attempt started today in Riyadh. Interrupted attempts still consume slots. `total_score` and `games_completed` come from `leaderboard_view`; started attempts contribute nothing. Invalid UUID returns 400; unknown student returns 404 (`student_not_found`). Eligibility is advisory and can change before the start request commits.

### POST /attempts/start

Request:

```json
{"student_id":"00000000-0000-0000-0000-000000000001","game_id":1}
```

201 response:

```json
{"attempt":{
  "id":"10000000-0000-0000-0000-000000000001",
  "student_id":"00000000-0000-0000-0000-000000000001",
  "game_id":1,"status":"started","score":null,
  "play_date":"2026-11-10","started_at":"2026-11-10T12:00:00+00:00","completed_at":null
}}
```

The backend checks student existence, game existence/activity, and eligibility. It inserts only student_id/game_id. PostgreSQL supplies UUID, statement start time, Asia/Riyadh date, and started status. Its unique constraints arbitrate simultaneous requests even if both pass prechecks. No client date is trusted; no interrupted attempt is retried automatically.

### POST /attempts/finish

Request:

```json
{"attempt_id":"10000000-0000-0000-0000-000000000001","score":85}
```

200 response:

```json
{
  "attempt":{
    "id":"10000000-0000-0000-0000-000000000001",
    "student_id":"00000000-0000-0000-0000-000000000001",
    "game_id":1,"status":"completed","score":85,
    "play_date":"2026-11-10","started_at":"2026-11-10T12:00:00+00:00",
    "completed_at":"2026-11-10T12:03:00.000Z"
  },
  "total_score":85,"games_completed":1,
  "score_saved":true,"total_available":true
}
```

Only integer scores from 0 to 100 are accepted. Completion time is generated by the server. The UPDATE filters both ID and `status=started`; a competing completion cannot overwrite the winner. The existing database trigger also prevents reopening/reassignment/modification of completed attempts. A repeated completion returns 409, including an identical retry, and awards no additional points. Completion on another day retains the original play_date.

Score persistence and the subsequent total lookup are separate PostgREST operations. The local fix preserves the existing successful response fields and adds `score_saved: true` and `total_available: true`. No database migration or business rule changes are required. This fix has not been deployed to the hosted project.

If saving succeeds but retrieving the total fails, the response is still **HTTP 200** and confirms the saved attempt:

```json
{
  "attempt": {
    "id": "10000000-0000-0000-0000-000000000001",
    "student_id": "00000000-0000-0000-0000-000000000001",
    "game_id": 1,
    "status": "completed",
    "score": 85,
    "play_date": "2026-11-10",
    "started_at": "2026-11-10T12:00:00+00:00",
    "completed_at": "2026-11-10T12:03:00.000Z"
  },
  "score_saved": true,
  "total_available": false,
  "total_score": null,
  "games_completed": null,
  "warning": {
    "code": "total_unavailable",
    "message": "Score saved; updated total could not be retrieved"
  }
}
```

Both successful finish variants contain the complete saved attempt and `score_saved: true`. When `total_available` is true, aggregate fields are numbers; when false, both are null and `warning` is present. Null means unavailable, never zero. A save operation that throws still returns the existing HTTP 500 `internal_error`, without a saved attempt or success confirmation. A conditional update that finds no started attempt still returns HTTP 409 `attempt_already_completed`.

The frontend should display the confirmed `attempt.score` whenever HTTP 200 contains `score_saved: true` and a completed attempt. It can keep that saved-score screen visible for **10 seconds**, then return to the initial screen; this timer belongs entirely to the frontend. A missing aggregate must not hide the saved-score confirmation or cause the score to be submitted again. It can refresh progress separately when reads recover. Do not create a replacement attempt, retry completion to obtain totals, or substitute zero for null. HTTP 500 or a lost response provides no persistence confirmation; a transport failure can still be ambiguous, so reconcile through progress rather than assuming rollback. Progress reads are separate queries and may change during concurrent requests.

### GET /leaderboard

200 response:

```json
{"leaderboard":[
  {"full_name":"Student A","total_score":260,"games_completed":3},
  {"full_name":"Student B","total_score":180,"games_completed":2},
  {"full_name":"Student C","total_score":100,"games_completed":1}
]}
```

Queries the existing `leaderboard_view`, ordered by total_score DESC and student_id ASC for deterministic ties, limited to three rows. No number or student ID is exposed here. Fewer than three students produce fewer rows; no students produces an empty array. As defined by the view, students with no completions may appear with zero totals. Students need not finish all games. One attempt for each of five games with a maximum of 100 yields a maximum total of 500.

### Phase 3B errors

Errors use the existing `{ "error": { "code": "...", "message": "..." } }` format.

| HTTP | Code | Applies to |
| --- | --- | --- |
| 400 | `invalid_input` | Invalid UUID, game ID, score, JSON, or missing POST fields |
| 401 | `invalid_platform_token` | All routes: absent, expired, or invalid token |
| 404 | `student_not_found` | Start/progress: student does not exist |
| 404 | `game_not_found` | Start: game definition unavailable |
| 404 | `attempt_not_found` | Finish: attempt does not exist |
| 409 | `game_inactive` | Start: game is inactive |
| 409 | `game_already_attempted` | Start: game slot already consumed |
| 409 | `daily_limit_reached` | Start: Riyadh daily slot already consumed |
| 409 | `attempt_already_completed` | Finish: already completed, including competing requests |
| 409 | `attempt_conflict` | Database constraint/lifecycle conflict |
| 409 | `reference_conflict` | Referenced record changed during start |
| 404/405/415 | `not_found` / `method_not_allowed` / `unsupported_media_type` | Unknown route, wrong method, or POST without JSON Content-Type |
| 500 | `internal_error` / `server_configuration_error` | Storage failure or missing server configuration |

### Frontend and game team integration

Fetch `/games` and student progress after registration/login. Call start only when the user actually starts a game: it permanently consumes that game's attempt and today's slot. Save the returned attempt ID and start timestamp. Submit that attempt ID with the integer score to finish. Refresh progress and leaderboard after success. On any ambiguous response, inspect progress instead of creating a new attempt; on 409 show the conflict and refresh. Respect inactive games and eligibility flags. No actual game files or Game SDK are needed for this HTTP contract.

The shared platform token grants platform-wide access, not ownership of a student or attempt. Student and attempt UUIDs do not prove identity. Under the confirmed no-authentication design, anyone with a valid platform token and an attempt ID can submit its score. Scores are range-checked client submissions, not independently verified gameplay. No additional identity or anti-cheat mechanism is introduced.

Phase 3B adds isolated handler/storage tests in `tests/games.test.ts`. `npm.cmd test` runs both phases. Concurrency tests simulate atomic database behavior in mocks and check conflict handling; they do not replace PostgreSQL concurrency tests already performed in Phase 2. The hosted database receives no test records. Type-check all five `supabase/functions/*/index.ts` entry points with Deno. Deployed gateway/Edge Runtime integration remains untested.
