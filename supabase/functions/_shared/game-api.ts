import { GameError, type GameStore } from './game-store.ts';
import { json } from './http.ts';

const error = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function riyadhDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export async function gameApi(request: Request, path: string, store: GameStore, now: () => Date): Promise<Response> {
  try {
    if (path === '/games') return json({ games: await store.games() });
    if (path === '/leaderboard') return json({ leaderboard: await store.leaderboard() });
    if (path.startsWith('/students/')) {
      const studentId = path.split('/')[2];
      if (!uuid(studentId)) return error('invalid_input', 'student_id must be a UUID', 400);
      if (!await store.studentExists(studentId)) return error('student_not_found', 'Student not found', 404);
      const [games, attempts, total] = await Promise.all([store.games(), store.attempts(studentId), store.total(studentId)]);
      const playDate = riyadhDate(now());
      const dailyUsed = attempts.some(a => a.play_date === playDate);
      return json({ student_id: studentId, play_date: playDate, daily_slot_consumed: dailyUsed, ...total,
        games: games.map(game => {
          const attempt = attempts.find(a => a.game_id === game.id) ?? null;
          return { ...game, attempt, eligible_to_start: game.is_active && !attempt && !dailyUsed };
        }),
      });
    }
    if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
      return error('unsupported_media_type', 'Use application/json', 415);
    }
    let body: Record<string, unknown>;
    try {
      const data = await request.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
      body = data;
    } catch { return error('invalid_input', 'Expected a JSON object', 400); }
    if (path === '/attempts/start') {
      if (!uuid(body.student_id) || !Number.isInteger(body.game_id) || Number(body.game_id) < 1 || Number(body.game_id) > 5) {
        return error('invalid_input', 'student_id must be a UUID and game_id an integer from 1 to 5', 400);
      }
      if (!await store.studentExists(body.student_id)) return error('student_not_found', 'Student not found', 404);
      const game = (await store.games()).find(g => g.id === body.game_id);
      if (!game) return error('game_not_found', 'Game not found', 404);
      if (!game.is_active) return error('game_inactive', 'Game is inactive', 409);
      const attempts = await store.attempts(body.student_id);
      if (attempts.some(a => a.game_id === body.game_id)) return error('game_already_attempted', 'Game already attempted', 409);
      if (attempts.some(a => a.play_date === riyadhDate(now()))) return error('daily_limit_reached', 'A game was already started today in Asia/Riyadh', 409);
      return json({ attempt: await store.start(body.student_id, body.game_id as number) }, 201);
    }
    if (!uuid(body.attempt_id) || !Number.isInteger(body.score) || Number(body.score) < 0 || Number(body.score) > 100) {
      return error('invalid_input', 'attempt_id must be a UUID and score an integer from 0 to 100', 400);
    }
    const previous = await store.attempt(body.attempt_id);
    if (!previous) return error('attempt_not_found', 'Attempt not found', 404);
    if (previous.status !== 'started') return error('attempt_already_completed', 'Attempt already completed', 409);
    const saved = await store.finish(body.attempt_id, body.score as number, now().toISOString());
    if (!saved) return error('attempt_already_completed', 'Attempt already completed', 409);
    return json({ attempt: saved, ...await store.total(saved.student_id) });
  } catch (cause) {
    if (cause instanceof GameError && cause.code !== 'storage_error') return error(cause.code, 'Attempt conflicts with database eligibility or lifecycle rules', 409);
    return error('internal_error', 'Unable to process request', 500);
  }
}
