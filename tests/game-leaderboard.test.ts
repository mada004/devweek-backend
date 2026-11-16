import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/_shared/handler.ts';
import { gameStore } from '../supabase/functions/_shared/game-store.ts';
import { platformTokens } from '../supabase/functions/_shared/platform.ts';

const secret = 'test-only-per-game-signing-secret-at-least-32-bytes';
type Row = { id: string; game_id: number; status: string; score: number | null; completed_at: string | null; students: { full_name: string; student_number?: string } };
function fixture(data: Row[] = []) {
  let now = 10000;
  const calls: URL[] = [];
  const overall = [
    { full_name: 'Overall first', total_score: 500, games_completed: 5 },
    { full_name: 'Overall second', total_score: 250, games_completed: 3 },
    { full_name: 'Overall third', total_score: 250, games_completed: 4 },
  ];
  const transport = (async (input: string | URL | Request) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.pathname.endsWith('/leaderboard_view')) return new Response(JSON.stringify(overall));
    assert.equal(url.pathname, '/rest/v1/game_attempts');
    assert.equal(url.searchParams.get('select'), 'score,students!inner(full_name)');
    assert.equal(url.searchParams.get('status'), 'eq.completed');
    assert.equal(url.searchParams.get('order'), 'score.desc,completed_at.asc,id.asc');
    assert.equal(url.searchParams.get('limit'), '10');
    const gameId = Number(url.searchParams.get('game_id')?.slice(3));
    // Isolated PostgREST simulation; the adapter must send the exact filters/order above.
    const result = data.filter(row => row.game_id === gameId && row.status === 'completed')
      .sort((a, b) => b.score! - a.score! || a.completed_at!.localeCompare(b.completed_at!) || a.id.localeCompare(b.id))
      .slice(0, 10);
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const handler = createHandler('leaderboard', {
    accessCode: 'test-only-code', signingSecret: secret, now: () => now,
    games: gameStore('https://isolated.test', 'test-only-key', transport),
    store: { async create() { throw Error(); }, async find() { return null; } },
  });
  async function call(path: string, options: { token?: string | null; method?: string } = {}) {
    const token = options.token === undefined ? (await platformTokens(secret, () => now).issue()).access_token : options.token;
    return handler(new Request('https://isolated.test/functions/v1' + path, {
      method: options.method ?? 'GET', headers: { Origin: 'https://frontend.test', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    }));
  }
  return { call, calls, overall, setNow: (value: number) => { now = value; } };
}
const row = (id: number, score: number | null, completed = '2026-11-16T10:00:00Z', status = 'completed', game = 1): Row => ({
  id: String(id).padStart(32, '0'), game_id: game, score, completed_at: status === 'completed' ? completed : null,
  status, students: { full_name: 'Participant ' + id, student_number: 'must-not-leak' },
});

test('per-game top ten honors score, earliest completion and stable identical-time ties; zero is included', async () => {
  const data = [row(3, 95), row(2, 95), row(1, 95, '2026-11-16T09:00:00Z'), row(4, 100),
    ...[90, 80, 70, 60, 0, 0, 0].map((score, i) => row(i + 5, score)),
    row(12, 100, undefined, 'started'), row(13, 100, undefined, 'completed', 2)];
  const f = fixture(data);
  const response = await f.call('/leaderboard/games/1');
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.game_id, 1); assert.equal(result.max_score, 100);
  assert.deepEqual(result.leaderboard.map((r: { full_name: string }) => r.full_name), [4, 1, 2, 3, 5, 6, 7, 8, 9, 10].map(id => 'Participant ' + id));
  assert.deepEqual(result.leaderboard.map((r: { score: number }) => r.score), [100, 95, 95, 95, 90, 80, 70, 60, 0, 0]);
  assert.equal(new Set(result.leaderboard.map((r: { full_name: string }) => r.full_name)).size, 10);
  assert.ok(result.leaderboard.every((r: object) => JSON.stringify(Object.keys(r).sort()) === '["full_name","score"]'));
  assert.ok(!JSON.stringify(result).includes('must-not-leak'));
});

test('only completed selected-game attempts count; incomplete and empty games return an empty array', async () => {
  const f = fixture([row(1, null, undefined, 'started'), row(2, 100, undefined, 'completed', 2)]);
  assert.deepEqual(await (await f.call('/leaderboard/games/1')).json(), { game_id: 1, max_score: 100, leaderboard: [] });
  assert.deepEqual(await (await f.call('/leaderboard/games/5')).json(), { game_id: 5, max_score: 100, leaderboard: [] });
  assert.deepEqual(await (await f.call('/leaderboard/games/2')).json(), { game_id: 2, max_score: 100, leaderboard: [{ full_name: 'Participant 2', score: 100 }] });
});

test('distinct participants with equal names remain distinct (unique participant/game enforced by DB)', async () => {
  const data = [row(1, 95), row(2, 90)]; data[1].students.full_name = data[0].students.full_name;
  const response = await fixture(data).call('/leaderboard/games/1');
  assert.deepEqual((await response.json()).leaderboard, [{ full_name: 'Participant 1', score: 95 }, { full_name: 'Participant 1', score: 90 }]);
});

test('invalid game IDs return 400 and never query storage', async () => {
  const f = fixture();
  for (const id of ['0', '6', '-1', '1.5', '01', 'abc', 'NaN', '1e0']) {
    const response = await f.call('/leaderboard/games/' + id);
    assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'invalid_input');
  }
  assert.equal(f.calls.length, 0);
});

test('missing, invalid, tampered, expired tokens are rejected before storage and ID validation', async () => {
  const f = fixture();
  const expired = (await platformTokens(secret, () => 0).issue()).access_token;
  for (const token of [null, 'invalid', 'v1.invalid.invalid', expired]) {
    for (const path of ['/leaderboard/games/1', '/leaderboard/games/6', '/leaderboard']) {
      const response = await f.call(path, { token });
      assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'invalid_platform_token');
    }
  }
  assert.equal(f.calls.length, 0);
});

test('Overall response, top-three query and tie ordering remain exactly unchanged', async () => {
  const f = fixture();
  const before = await f.call('/leaderboard');
  assert.equal(before.status, 200);
  assert.equal(await before.text(), JSON.stringify({ leaderboard: f.overall }));
  assert.equal(f.calls[0].searchParams.get('select'), 'full_name,total_score,games_completed');
  assert.equal(f.calls[0].searchParams.get('order'), 'total_score.desc,student_id.asc');
  assert.equal(f.calls[0].searchParams.get('limit'), '3');
  await f.call('/leaderboard/games/1');
  assert.equal(await (await f.call('/leaderboard')).text(), JSON.stringify({ leaderboard: f.overall }));
});

test('per-game preflight and error CORS preserve existing behavior', async () => {
  const f = fixture();
  const preflight = await f.call('/leaderboard/games/1', { method: 'OPTIONS', token: null });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'authorization, apikey, content-type, x-client-info');
  assert.equal((await f.call('/leaderboard/games/1', { method: 'POST' })).status, 405);
  assert.equal((await f.call('/leaderboard/games/1', { token: null })).headers.get('Cache-Control'), 'no-store');
});
