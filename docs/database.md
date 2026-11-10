# Database design

## Tables and relationships

- `students`: UUID primary key, unique required TEXT `student_number`, required `full_name`, creation timestamp. The number is user-chosen, not a university ID, with no digit-count rule.
- `games`: SMALLINT IDs 1 through 5, name, fixed `max_score` of 100, active flag, creation timestamp. Five rows are seeded with placeholder names pending confirmed names. The primary key and range check prevent a sixth game. The server role receives read access only; privileged maintenance must preserve the five seeded slots.
- `game_attempts`: UUID, student and game foreign keys, integer score, started/completed status, DATE `play_date`, start timestamp, completion timestamp. Foreign keys reject orphan attempts and prevent deleting referenced students/games.

## Constraints and concurrency

`UNIQUE(student_id, game_id)` consumes the game slot at start, even if interrupted. `UNIQUE(student_id, play_date)` consumes the daily slot. PostgreSQL unique indexes enforce these restrictions under simultaneous requests; competing transactions cannot both commit conflicting records. Future backend code should handle unique-violation SQLSTATE `23505`, rather than relying on check-before-insert.

Score is nullable until completion and otherwise must be 0 through 100. Started rows require NULL score and completion timestamp; completed rows require both. Only started/completed statuses are accepted. At most five distinct games at 100 points each bound total scores to 500, without requiring completion of all games.

Unique constraints create registration and student-lookup indexes; a separate game index covers the other foreign key. No redundant student index is needed.

## Riyadh calendar days

TIMESTAMPTZ stores instants; `play_date` stores the Asia/Riyadh calendar date. Defaults derive both start time and date from the same database statement time, independent of connection timezone. A CHECK requires `play_date = (started_at AT TIME ZONE 'Asia/Riyadh')::date`.

Future backend code must derive dates from trusted server time, never client-provided dates or start timestamps. Prefer omitting both columns on INSERT to use consistent database defaults. The day resets at Riyadh midnight, not 24 hours after the previous attempt. Completion on a later day retains the start date.

## Leaderboard

`leaderboard_view` left-joins students to completed attempts only, sums their scores, and counts completed games. Students with no completions appear with zero total and zero games. Started attempts contribute nothing. The view does not impose ordering; the backend should query:

```sql
SELECT student_id, full_name, total_score, games_completed
FROM public.leaderboard_view
ORDER BY total_score DESC, student_id ASC
LIMIT 3;
```

UUID ordering makes equal-score results deterministic; no business tie-breaking rule has been specified.

## Security and future backend integration

Target Supabase PostgreSQL 15+ with its existing anon, authenticated, and service_role roles. All tables enable RLS with no client policies. Explicit revocations deny PUBLIC, anon, and authenticated access to tables and view. The view uses `security_invoker = true` so underlying permissions and RLS apply as the caller.

Future server-side Edge Functions use a service-role key, which bypasses RLS but not SQL grants or triggers. The migration first revokes all table/view privileges from service_role as well as PUBLIC, anon, and authenticated, removing Supabase default table grants before granting the intended access. Games are SELECT-only: application INSERT, UPDATE, DELETE, and TRUNCATE are denied. Exactly five seeded definitions remain fixed during ordinary application operations without a game-count trigger. Privileged administrators can still alter seed data or permissions and must preserve the five slots. Never expose the service-role key or actual database credentials to frontend code.

The server can SELECT the view and underlying tables and INSERT/UPDATE students. For attempts it can INSERT only student_id/game_id and UPDATE only score/status/completed_at. Defaults therefore supply the UUID, started status, start instant, and Riyadh date. It cannot DELETE or TRUNCATE attempts. A narrowly scoped row trigger rejects deletion, insertion in completed state, identity/start-detail changes, and every update except started to completed. The existing checks require a valid completion score and timestamp. Completed attempts reject every subsequent update, including identical retries, so repeated completion cannot award points twice. RLS bypass does not bypass this trigger; administrators could explicitly disable it and remain trusted.

Future Edge Functions should start with an INSERT of student_id/game_id and complete with one UPDATE setting status = 'completed', score, and a server-derived completed_at, filtered by attempt ID and status = 'started'. A repeated conditional request changes zero rows; read the existing result rather than inserting another attempt. PostgreSQL serializes concurrent updates to the same row, and unique indexes serialize conflicting starts. No-op updates of started rows are deliberately rejected. Future code must validate inputs and check the shared static server-side access code. No student authentication is implemented.

`.env.example` holds empty server-only placeholders. Actual secrets belong in an ignored `.env` file or server secret storage. The access-code requirement is documented only; no API or access checking is implemented.

## Applying and verifying

Apply `supabase/migrations/001_initial_schema.sql` once to an authorized development Supabase database. It is transactional, not an idempotent reset script. Do not use a production database for verification.

In a disposable database verify duplicate-game inserts on later dates fail; different games on the same Riyadh day fail (including concurrent connections); scores -1 and 101 fail; inconsistent completion states fail; completed scores sum while started attempts do not; anonymous table/view operations fail. Roll back test data or discard the test database.

### Local verification performed (2026-11-10)

The migration was executed successfully on a separate disposable PostgreSQL 17.11 cluster, not the existing local server. Supabase role names were simulated with NOLOGIN roles (service_role with BYPASSRLS), schema usage, and broad default table grants to all three roles before migration. Tests passed for student insertion and unique TEXT numbers of different lengths, all five 100-point seeds, denial of application game writes/truncation, daily and per-game uniqueness, scores -1/101 rejected and 0/100 accepted, required completion fields, completion/retry/reopen rejection, identity and start-detail immutability, attempt deletion/truncation denial, completed-only leaderboard sums up to 500, top-three retrieval, RLS enabled, and denied client access to student numbers and the view. Separate competing connections also verified daily uniqueness, per-game uniqueness across dates, and single completion with no double award.

This verifies SQL execution and role-level behavior in PostgreSQL, not a full Supabase installation, PostgREST, or deployed Edge Functions. No cloud database or existing project database was used. The disposable cluster was stopped and removed after testing.

Reference: [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security).
