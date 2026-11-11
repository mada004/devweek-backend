import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, type FunctionGroup } from '../supabase/functions/_shared/handler.ts';
import { gameStore, GameError, type Attempt, type Game, type GameStore } from '../supabase/functions/_shared/game-store.ts';
import { platformTokens } from '../supabase/functions/_shared/platform.ts';
import { riyadhDate } from '../supabase/functions/_shared/game-api.ts';

const secret = 'test-only-phase-3b-signing-secret-32-bytes';
const studentId = '00000000-0000-0000-0000-000000000001';
function fixture() {
  let clock = new Date('2026-11-10T20:59:00Z');
  const attempts: Attempt[] = [];
  const games: Game[] = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, name: `Game ${i + 1}`, max_score: 100, is_active: true }));
  let writes = 0;
  let reads = 0;
  const students = [studentId, '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000004'];
  const totals = (id: string) => {
    const done = attempts.filter(a => a.student_id === id && a.status === 'completed');
    return { total_score: done.reduce((sum, a) => sum + a.score!, 0), games_completed: done.length };
  };
  const store: GameStore = {
    async games() { reads++; return structuredClone(games); },
    async studentExists(id) { reads++; return students.includes(id); },
    async attempts(id) { reads++; return structuredClone(attempts.filter(a => a.student_id === id)); },
    async attempt(id) { reads++; return structuredClone(attempts.find(a => a.id === id) ?? null); },
    async start(student_id, game_id) {
      // Simulates the DB's atomic unique checks independently of API prechecks.
      const play_date = riyadhDate(clock);
      if (attempts.some(a => a.student_id === student_id && a.game_id === game_id)) throw new GameError('game_already_attempted');
      if (attempts.some(a => a.student_id === student_id && a.play_date === play_date)) throw new GameError('daily_limit_reached');
      const row: Attempt = { id: crypto.randomUUID(), student_id, game_id, play_date, started_at: clock.toISOString(), completed_at: null, status: 'started', score: null };
      attempts.push(row); writes++; return structuredClone(row);
    },
    async finish(id, score, completed_at) {
      const row = attempts.find(a => a.id === id && a.status === 'started');
      if (!row) return null;
      Object.assign(row, { status: 'completed', score, completed_at }); writes++;
      return structuredClone(row);
    },
    async total(id) { reads++; return totals(id); },
    async leaderboard() {
      reads++;
      return students.map((id, i) => ({ id, full_name: `Student ${i + 1}`, ...totals(id) }))
        .sort((a, b) => b.total_score - a.total_score || a.id.localeCompare(b.id)).slice(0, 3)
        .map(({ id: _, ...row }) => row);
    },
  };
  const config = { accessCode: 'test-only-code', signingSecret: secret, store: { async create() { throw new Error(); }, async find() { return null; } }, games: store, now: () => clock.getTime() / 1000 };
  const handlers = Object.fromEntries((['games', 'students', 'attempts', 'leaderboard'] as FunctionGroup[]).map(group => [group, createHandler(group, config)]));
  async function call(path: string, body?: unknown, token?: string, method?: string) {
    const group = path.split('/')[1];
    const bearer = token ?? (await platformTokens(secret, config.now).issue()).access_token;
    return await handlers[group](new Request(`https://isolated.test/functions/v1${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }
  return { call, store, games, attempts, students, writes: () => writes, reads: () => reads, setTime: (date: string) => { clock = new Date(date); } };
}

test('valid start returns DB attempt ID/time and consumes game/daily slots', async () => {
  const f = fixture();
  const response = await f.call('/attempts/start', { student_id: studentId, game_id: 1, play_date: '2099-01-01', started_at: '2099-01-01' });
  assert.equal(response.status, 201);
  const { attempt } = await response.json();
  assert.match(attempt.id, /^[0-9a-f-]{36}$/);
  assert.equal(attempt.started_at, '2026-11-10T20:59:00.000Z');
  assert.equal(attempt.play_date, '2026-11-10');
  assert.equal(attempt.score, null);
  assert.equal(attempt.status, 'started');
  assert.equal(f.writes(), 1);
});

test('per-game restriction survives midnight and interrupted attempts', async () => {
  const f = fixture();
  await f.call('/attempts/start', { student_id: studentId, game_id: 1 });
  f.setTime('2026-11-10T21:00:00Z'); // Riyadh midnight, same UTC day.
  const duplicate = await f.call('/attempts/start', { student_id: studentId, game_id: 1 });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'game_already_attempted');
  assert.equal((await f.call('/attempts/start', { student_id: studentId, game_id: 2 })).status, 201);
  assert.equal(f.attempts.length, 2);
});

test('second game on the same Riyadh date is rejected', async () => {
  const f = fixture();
  await f.call('/attempts/start', { student_id: studentId, game_id: 1 });
  const response = await f.call('/attempts/start', { student_id: studentId, game_id: 2 });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'daily_limit_reached');
});

test('competing starts surface storage conflicts without duplicate attempts', async () => {
  for (const gameIds of [[1, 2], [1, 1]]) {
    const f = fixture();
    const results = await Promise.all(gameIds.map(game_id => f.call('/attempts/start', { student_id: studentId, game_id })));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    assert.equal(f.attempts.length, 1);
  }
});

test('valid completion returns saved score and completed-only total; replay is rejected', async () => {
  const f = fixture();
  const started = await (await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).json();
  const response = await f.call('/attempts/finish', { attempt_id: started.attempt.id, score: 100 });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.attempt.score, 100);
  assert.equal(saved.attempt.status, 'completed');
  assert.equal(saved.score_saved, true);
  assert.equal(saved.total_available, true);
  assert.equal(saved.total_score, 100);
  assert.equal(saved.games_completed, 1);
  assert.equal((await f.call('/attempts/finish', { attempt_id: started.attempt.id, score: 1 })).status, 409);
  assert.equal(f.attempts[0].score, 100);
  assert.equal((await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).status, 409);
});

test('competing finishes only award points once', async () => {
  const f = fixture();
  const { attempt } = await (await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).json();
  const results = await Promise.all([50, 90].map(score => f.call('/attempts/finish', { attempt_id: attempt.id, score })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.store.total(studentId)).games_completed, 1);
  assert.equal(f.writes(), 2); // one INSERT, one successful UPDATE
});

test('invalid scores and IDs are rejected; zero is a valid completed score', async () => {
  const f = fixture();
  const { attempt } = await (await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).json();
  for (const score of [-1, 101, 0.5, '10', null, undefined]) {
    assert.equal((await f.call('/attempts/finish', { attempt_id: attempt.id, score })).status, 400);
  }
  assert.equal(f.attempts[0].status, 'started');
  assert.equal((await f.call('/attempts/finish', { attempt_id: attempt.id, score: 0 })).status, 200);
  assert.deepEqual(await f.store.total(studentId), { total_score: 0, games_completed: 1 });
  for (const body of [{ student_id: 'bad', game_id: 1 }, { student_id: studentId, game_id: '1' }, { student_id: studentId, game_id: 6 }]) {
    assert.equal((await f.call('/attempts/start', body)).status, 400);
  }
  assert.equal((await f.call('/attempts/finish', { attempt_id: 'bad', score: 1 })).status, 400);
});

test('missing student/attempt, inactive game, malformed JSON and methods', async () => {
  const f = fixture();
  assert.equal((await f.call('/attempts/start', { student_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', game_id: 1 })).status, 404);
  assert.equal((await f.call('/attempts/finish', { attempt_id: crypto.randomUUID(), score: 1 })).status, 404);
  f.games[0].is_active = false;
  assert.equal((await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).status, 409);
  assert.equal((await f.call('/attempts/start', null)).status, 400);
  assert.equal((await f.call('/games', {}, undefined, 'POST')).status, 405);
});

test('progress reports five games, slot consumption, partial totals, and next-day eligibility', async () => {
  const f = fixture();
  const { attempt } = await (await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).json();
  await f.call('/attempts/finish', { attempt_id: attempt.id, score: 60 });
  const today = await (await f.call(`/students/${studentId}/progress`)).json();
  assert.equal(today.games.length, 5);
  assert.equal(today.total_score, 60);
  assert.equal(today.games_completed, 1);
  assert.equal(today.daily_slot_consumed, true);
  assert.ok(today.games.every((g: { eligible_to_start: boolean }) => !g.eligible_to_start));
  f.setTime('2026-11-10T21:00:00Z');
  const tomorrow = await (await f.call(`/students/${studentId}/progress`)).json();
  assert.equal(tomorrow.play_date, '2026-11-11');
  assert.equal(tomorrow.daily_slot_consumed, false);
  assert.equal(tomorrow.games[0].eligible_to_start, false);
  assert.equal(tomorrow.games[1].eligible_to_start, true);
  assert.equal((await f.call('/students/bad/progress')).status, 400);
  assert.equal((await f.call(`/students/${crypto.randomUUID()}/progress`)).status, 404);
});

test('leaderboard returns top three completed totals, partial completion, and deterministic ties', async () => {
  const f = fixture();
  for (let i = 0; i < f.students.length; i++) {
    const { attempt } = await (await f.call('/attempts/start', { student_id: f.students[i], game_id: 1 })).json();
    if (i < 3) await f.call('/attempts/finish', { attempt_id: attempt.id, score: [50, 90, 90][i] });
  }
  const { leaderboard } = await (await f.call('/leaderboard')).json();
  assert.deepEqual(leaderboard.map((r: { total_score: number }) => r.total_score), [90, 90, 50]);
  assert.equal(leaderboard[0].full_name, 'Student 2');
  assert.ok(leaderboard.every((r: { games_completed: number }) => r.games_completed === 1));
  assert.ok(!('student_number' in leaderboard[0]));
  const { games } = await (await f.call('/games')).json();
  assert.equal(games.length, 5);
  assert.ok(games.every((g: Game) => g.max_score === 100));
});

test('all new endpoints reject invalid platform token before storage and support preflight', async () => {
  const f = fixture();
  for (const [path, body] of [['/games', undefined], ['/leaderboard', undefined], [`/students/${studentId}/progress`, undefined], ['/attempts/start', {}], ['/attempts/finish', {}]] as const) {
    assert.equal((await f.call(path, body, 'invalid')).status, 401);
    const preflight = await f.call(path, undefined, 'invalid', 'OPTIONS');
    assert.equal(preflight.status, 204);
    assert.ok(preflight.headers.get('Access-Control-Allow-Methods')?.includes('GET'));
  }
  assert.equal(f.reads(), 0);
  assert.equal(f.writes(), 0);
});

test('PostgREST adapter uses database defaults, atomic completion predicate, view ordering, and maps constraint errors', async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify([{}]), { status: 200 });
  }) as typeof fetch;
  const store = gameStore('https://isolated.test', 'test-only-key', mockFetch);
  await store.start(studentId, 1);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { student_id: studentId, game_id: 1 });
  await store.finish(studentId, 100, '2026-11-10T21:00:00Z');
  assert.equal(calls[1].init?.method, 'PATCH');
  assert.equal(calls[1].url.searchParams.get('status'), 'eq.started');
  assert.deepEqual(Object.keys(JSON.parse(String(calls[1].init?.body))).sort(), ['completed_at', 'score', 'status']);
  await store.leaderboard();
  assert.equal(calls[2].url.pathname, '/rest/v1/leaderboard_view');
  assert.equal(calls[2].url.searchParams.get('order'), 'total_score.desc,student_id.asc');
  assert.equal(calls[2].url.searchParams.get('limit'), '3');
  for (const [constraint, code] of [['one_attempt_per_game', 'game_already_attempted'], ['one_attempt_per_day', 'daily_limit_reached']]) {
    const conflict = gameStore('https://isolated.test', 'test-only-key', (async () => new Response(JSON.stringify({ code: '23505', message: `duplicate constraint ${constraint}` }), { status: 409 })) as typeof fetch);
    await assert.rejects(() => conflict.start(studentId, 1), (e: unknown) => e instanceof GameError && e.code === code);
  }
});

test('finish confirms saved score when the separate total lookup fails', async () => {
  const f = fixture();
  const { attempt } = await (await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).json();
  const originalTotal = f.store.total;
  f.store.total = async () => { throw new GameError('storage_error'); };
  const response = await f.call('/attempts/finish', { attempt_id: attempt.id, score: 85 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.score_saved, true);
  assert.equal(body.total_available, false);
  assert.equal(body.total_score, null);
  assert.equal(body.games_completed, null);
  assert.deepEqual(body.warning, { code: 'total_unavailable', message: 'Score saved; updated total could not be retrieved' });
  assert.equal(body.attempt.id, attempt.id);
  assert.equal(body.attempt.status, 'completed');
  assert.equal(body.attempt.score, 85);
  assert.equal(f.attempts[0].score, 85);
  assert.equal(f.writes(), 2);
  assert.ok(!('error' in body));

  const repeated = await f.call('/attempts/finish', { attempt_id: attempt.id, score: 25 });
  assert.equal(repeated.status, 409);
  assert.equal((await repeated.json()).error.code, 'attempt_already_completed');
  assert.equal(f.writes(), 2);
  assert.equal(f.attempts[0].score, 85);
  f.store.total = originalTotal;
  const progress = await (await f.call(`/students/${studentId}/progress`)).json();
  assert.equal(progress.total_score, 85);
  assert.equal(progress.games_completed, 1);
  assert.equal(progress.games[0].attempt.score, 85);
});

test('actual finish save failure returns an error without success confirmation', async () => {
  const f = fixture();
  const { attempt } = await (await f.call('/attempts/start', { student_id: studentId, game_id: 1 })).json();
  f.store.finish = async () => { throw new GameError('storage_error'); };
  f.store.total = async () => { assert.fail('Total must not be read after a save failure'); };
  const response = await f.call('/attempts/finish', { attempt_id: attempt.id, score: 85 });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.deepEqual(body, { error: { code: 'internal_error', message: 'Unable to process request' } });
  assert.ok(!('score_saved' in body));
  assert.ok(!('attempt' in body));
  assert.equal(f.attempts[0].status, 'started');
  assert.equal(f.attempts[0].score, null);
  assert.equal(f.writes(), 1);
});
