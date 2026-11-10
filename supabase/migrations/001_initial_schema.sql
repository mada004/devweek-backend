-- Supabase PostgreSQL 15+: assumes anon, authenticated, service_role exist.
BEGIN;

CREATE TABLE public.students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_number TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.games (
    id SMALLINT PRIMARY KEY CHECK (id BETWEEN 1 AND 5),
    name TEXT NOT NULL,
    max_score INTEGER NOT NULL DEFAULT 100 CHECK (max_score = 100),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Placeholder names until actual game names are supplied.
INSERT INTO public.games (id, name) VALUES
    (1, 'Game 1'), (2, 'Game 2'), (3, 'Game 3'), (4, 'Game 4'), (5, 'Game 5');

CREATE TABLE public.game_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES public.students(id),
    game_id SMALLINT NOT NULL REFERENCES public.games(id),
    score INTEGER CHECK (score BETWEEN 0 AND 100),
    status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed')),
    play_date DATE NOT NULL DEFAULT (statement_timestamp() AT TIME ZONE 'Asia/Riyadh')::date,
    started_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT one_attempt_per_game UNIQUE (student_id, game_id),
    CONSTRAINT one_attempt_per_day UNIQUE (student_id, play_date),
    CONSTRAINT riyadh_play_date CHECK (
        play_date = (started_at AT TIME ZONE 'Asia/Riyadh')::date
    ),
    CONSTRAINT attempt_completion CHECK (
        (status = 'started' AND score IS NULL AND completed_at IS NULL)
        OR (status = 'completed' AND score IS NOT NULL AND completed_at IS NOT NULL)
    )
);

-- Unique indexes already cover student lookup and the student foreign key.
CREATE INDEX game_attempts_game_id_idx ON public.game_attempts (game_id);

-- A single lifecycle guard: start once, complete once, never release a slot.
CREATE FUNCTION public.protect_attempt_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Attempts cannot be deleted' USING ERRCODE = '23514';
    ELSIF TG_OP = 'INSERT' THEN
        IF NEW.status IS DISTINCT FROM 'started' THEN
            RAISE EXCEPTION 'Attempts must begin as started' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF ROW(NEW.id, NEW.student_id, NEW.game_id, NEW.play_date, NEW.started_at)
       IS DISTINCT FROM
       ROW(OLD.id, OLD.student_id, OLD.game_id, OLD.play_date, OLD.started_at) THEN
        RAISE EXCEPTION 'Attempt identity and start details are immutable'
            USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'started' OR NEW.status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'Only started to completed is allowed'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER protect_attempt_lifecycle
BEFORE INSERT OR UPDATE OR DELETE ON public.game_attempts
FOR EACH ROW EXECUTE FUNCTION public.protect_attempt_lifecycle();
REVOKE ALL ON FUNCTION public.protect_attempt_lifecycle()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE VIEW public.leaderboard_view WITH (security_invoker = true) AS
SELECT s.id AS student_id, s.full_name,
       COALESCE(SUM(a.score), 0)::BIGINT AS total_score,
       COUNT(a.id) AS games_completed
FROM public.students AS s
LEFT JOIN public.game_attempts AS a
    ON a.student_id = s.id AND a.status = 'completed'
GROUP BY s.id, s.full_name;

ALTER TABLE public.students ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_attempts ENABLE ROW LEVEL SECURITY;

-- No client policies. Only trusted server operations receive grants.
REVOKE ALL ON TABLE public.students, public.games, public.game_attempts,
    public.leaderboard_view FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.students TO service_role;
GRANT SELECT ON public.games TO service_role;
GRANT SELECT ON public.game_attempts TO service_role;
-- Server derives start details from database defaults, not browser input.
GRANT INSERT (student_id, game_id) ON public.game_attempts TO service_role;
GRANT UPDATE (score, status, completed_at) ON public.game_attempts TO service_role;
GRANT SELECT ON public.leaderboard_view TO service_role;

COMMIT;
