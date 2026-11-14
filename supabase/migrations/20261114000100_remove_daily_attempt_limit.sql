BEGIN;

-- Keep event-wide per-game uniqueness, history, dates and lifecycle protection.
ALTER TABLE public.game_attempts DROP CONSTRAINT one_attempt_per_day;

COMMIT;
