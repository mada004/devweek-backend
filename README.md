# Dev Week backend

Backend for a university club platform with five independently developed HTML/CSS/JavaScript games. Phase 2 schema is deployed; Phase 3A access/registration and Phase 3B attempts/scores/leaderboard Edge Functions are implemented locally, not deployed.

## Technology stack

PostgreSQL 15+ through Supabase, SQL migrations, and TypeScript Supabase Edge Functions. There is no frontend or individual student authentication. Node.js 24+ runs isolated API unit tests with `npm.cmd test`.

## Confirmed business rules

- First visits use a name and user-provided number; returning visits use the number only. Numbers are unique TEXT, not university IDs, with no fixed digit count. Students have UUIDs; no student authentication is required.
- A shared static access code is checked against a server-only environment variable. Successful checks issue a one-hour platform token signed with a separate server secret; student endpoints require that token.
- Exactly five games, each worth up to 100 points; total score cannot exceed 500.
- Starting consumes one attempt per game and one game per Asia/Riyadh calendar day, including interrupted attempts.
- Students need not complete all games. Only completed scores count toward the top-three leaderboard.

## Database structure

`students` stores registration, `games` holds five seeded slots, and `game_attempts` links them. Unique constraints enforce per-game and per-day restrictions even under concurrency. `leaderboard_view` aggregates completed scores.

See [database documentation](docs/database.md) for security and integration details.

See [API documentation](docs/api.md) for requests, responses, headers, token handling, server configuration, and frontend/game team integration. Implemented POST endpoints are `/access/verify`, `/students/register`, `/students/login`, `/attempts/start`, and `/attempts/finish`; GET endpoints are `/games`, `/students/{student_id}/progress`, and `/leaderboard`, all under the Supabase `/functions/v1` base URL. Existing database constraints and anonymous access restrictions are unchanged.

## Project structure

```text
devweek-backend/
  supabase/
    functions/
      _shared/
      access/index.ts
      students/index.ts
      games/index.ts
      attempts/index.ts
      leaderboard/index.ts
    migrations/
      001_initial_schema.sql
  docs/
    api.md
    database.md
  .env.example
  .gitignore
  README.md
  tests/api.test.ts
  tests/games.test.ts
  package.json
```

## Future phases

Next steps require separate approval: deploy the Phase 3A/3B functions and server secrets, verify hosted integration, then integrate the games. No frontend, game implementation, or Game SDK is included. Use `.env.example` as configuration guidance; keep real credentials in ignored `.env` files or server secret storage. Never expose service-role keys to the frontend.
