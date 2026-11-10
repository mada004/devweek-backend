# Dev Week backend

Database backend for a university club platform with five independently developed HTML/CSS/JavaScript games. Phase 2 provides structure and schema only.

## Technology stack

PostgreSQL 15+ through Supabase, SQL migrations, and future server-side Supabase Edge Functions. No APIs, frontend, or authentication are implemented.

## Confirmed business rules

- First visits use a name and user-provided number; returning visits use the number only. Numbers are unique TEXT, not university IDs, with no fixed digit count. Students have UUIDs; no student authentication is required.
- A shared static access code will be stored in a server-only environment variable. Its enforcement is a future phase.
- Exactly five games, each worth up to 100 points; total score cannot exceed 500.
- Starting consumes one attempt per game and one game per Asia/Riyadh calendar day, including interrupted attempts.
- Students need not complete all games. Only completed scores count toward the top-three leaderboard.

## Database structure

`students` stores registration, `games` holds five seeded slots, and `game_attempts` links them. Unique constraints enforce per-game and per-day restrictions even under concurrency. `leaderboard_view` aggregates completed scores.

See [database documentation](docs/database.md) for security and integration details.

## Project structure

```text
devweek-backend/
  supabase/
    migrations/
      001_initial_schema.sql
  docs/
    database.md
  .env.example
  .gitignore
  README.md
```

## Future phases

Apply and verify the migration in an authorized development database, implement server-side access-code checks and registration/attempt/leaderboard APIs, then integrate the games. No cloud project or dependencies are needed for this phase. Use `.env.example` as configuration guidance; keep real credentials in ignored `.env` files or server secret storage. Never expose service-role keys to the frontend.
