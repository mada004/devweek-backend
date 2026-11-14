-- Run only in a NEW disposable PostgreSQL database as its owner.
-- No production connection details are included. Roles must already exist.
\set ON_ERROR_STOP on
\ir ../../supabase/migrations/001_initial_schema.sql
INSERT INTO public.students(id,student_number,full_name)
VALUES ('00000000-0000-0000-0000-000000000001','0001','Synthetic migration test');
INSERT INTO public.game_attempts(student_id,game_id)
VALUES ('00000000-0000-0000-0000-000000000001',1);
CREATE TEMP TABLE original_attempt AS SELECT * FROM public.game_attempts;
CREATE TEMP TABLE original_guards AS
SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
WHERE conrelid='public.game_attempts'::regclass AND conname <> 'one_attempt_per_day';
\ir ../../supabase/migrations/20261114000100_remove_daily_attempt_limit.sql
DO $$
BEGIN
 IF EXISTS(SELECT * FROM original_attempt EXCEPT SELECT * FROM public.game_attempts)
 THEN RAISE EXCEPTION 'Existing attempt changed'; END IF;
 IF EXISTS(SELECT * FROM original_guards EXCEPT
 SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.game_attempts'::regclass)
 THEN RAISE EXCEPTION 'Other constraint changed'; END IF;
 IF EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.game_attempts'::regclass AND conname='one_attempt_per_day')
 THEN RAISE EXCEPTION 'Daily constraint remains'; END IF;
END $$;
SET ROLE service_role;
INSERT INTO public.game_attempts(student_id,game_id)
SELECT '00000000-0000-0000-0000-000000000001'::uuid,n FROM generate_series(2,5) n;
RESET ROLE;
DO $$
BEGIN
 IF (SELECT count(*) FROM public.game_attempts) <> 5 OR
 (SELECT count(DISTINCT play_date) FROM public.game_attempts) <> 1
 THEN RAISE EXCEPTION 'Five same-day games failed'; END IF;
 BEGIN
  INSERT INTO public.game_attempts(student_id,game_id) VALUES('00000000-0000-0000-0000-000000000001',1);
  RAISE EXCEPTION 'Duplicate allowed';
 EXCEPTION WHEN unique_violation THEN NULL; END;
 BEGIN
  UPDATE public.game_attempts SET status='completed',score=101,completed_at=now();
  RAISE EXCEPTION 'Score over 100 allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
SET ROLE service_role;
UPDATE public.game_attempts SET status='completed',score=100,completed_at=now();
RESET ROLE;
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.leaderboard_view WHERE total_score=500 AND games_completed=5)
 THEN RAISE EXCEPTION 'Wrong leaderboard'; END IF;
 BEGIN
  UPDATE public.game_attempts SET score=50;
  RAISE EXCEPTION 'Completed score mutable';
 EXCEPTION WHEN check_violation THEN NULL; END;
 BEGIN
  DELETE FROM public.game_attempts;
  RAISE EXCEPTION 'Deletion allowed';
 EXCEPTION WHEN check_violation THEN NULL; END;
 IF EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.students'::regclass,'public.games'::regclass,'public.game_attempts'::regclass) AND NOT relrowsecurity)
 THEN RAISE EXCEPTION 'RLS lost'; END IF;
END $$;
SELECT 'PASS: history, constraints, five same-day games, scores, lifecycle, RLS, leaderboard' AS result;
