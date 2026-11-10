export type Game = { id: number; name: string; max_score: number; is_active: boolean };
export type Attempt = {
  id: string; student_id: string; game_id: number; status: 'started' | 'completed';
  score: number | null; play_date: string; started_at: string; completed_at: string | null;
};
export type Total = { total_score: number; games_completed: number };
export type Leader = Total & { full_name: string };
export class GameError extends Error {
  code: string;
  constructor(code: string) { super('Game storage operation failed'); this.code = code; }
}
export interface GameStore {
  games(): Promise<Game[]>;
  studentExists(id: string): Promise<boolean>;
  attempts(studentId: string): Promise<Attempt[]>;
  attempt(id: string): Promise<Attempt | null>;
  start(studentId: string, gameId: number): Promise<Attempt>;
  finish(id: string, score: number, completedAt: string): Promise<Attempt | null>;
  total(studentId: string): Promise<Total>;
  leaderboard(): Promise<Leader[]>;
}

export function gameStore(url: string, secret: string, transport: typeof fetch = fetch): GameStore {
  const headers = { apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const attemptFields = 'id,student_id,game_id,status,score,play_date,started_at,completed_at';
  async function rows<T>(table: string, query: Record<string, string>, method = 'GET', body?: unknown): Promise<T[]> {
    const response = await transport(`${url.replace(/\/$/, '')}/rest/v1/${table}?${new URLSearchParams(query)}`, {
      method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({}));
      const message = typeof failure?.message === 'string' ? failure.message : '';
      if (failure?.code === '23505') {
        if (message.includes('one_attempt_per_game')) throw new GameError('game_already_attempted');
        if (message.includes('one_attempt_per_day')) throw new GameError('daily_limit_reached');
        throw new GameError('attempt_conflict');
      }
      if (failure?.code === '23503') throw new GameError('reference_conflict');
      if (failure?.code === '23514') throw new GameError('attempt_conflict');
      throw new GameError('storage_error');
    }
    const data = await response.json();
    if (!Array.isArray(data)) throw new GameError('storage_error');
    return data;
  }
  return {
    games: () => rows<Game>('games', { select: 'id,name,max_score,is_active', order: 'id.asc' }),
    async studentExists(id) { return (await rows('students', { select: 'id', id: `eq.${id}`, limit: '1' })).length === 1; },
    attempts: studentId => rows<Attempt>('game_attempts', { select: attemptFields, student_id: `eq.${studentId}`, order: 'game_id.asc' }),
    async attempt(id) { return (await rows<Attempt>('game_attempts', { select: attemptFields, id: `eq.${id}`, limit: '1' }))[0] ?? null; },
    async start(studentId, gameId) {
      // Only granted insert columns: database generates time, Riyadh date, ID and status.
      const result = await rows<Attempt>('game_attempts', { select: attemptFields }, 'POST', { student_id: studentId, game_id: gameId });
      if (result.length !== 1) throw new GameError('storage_error');
      return result[0];
    },
    async finish(id, score, completedAt) {
      // Conditional UPDATE is atomic: a competing completion returns no row.
      const result = await rows<Attempt>('game_attempts', { select: attemptFields, id: `eq.${id}`, status: 'eq.started' }, 'PATCH', {
        status: 'completed', score, completed_at: completedAt,
      });
      if (result.length > 1) throw new GameError('storage_error');
      return result[0] ?? null;
    },
    async total(studentId) {
      const result = await rows<Total>('leaderboard_view', { select: 'total_score,games_completed', student_id: `eq.${studentId}`, limit: '1' });
      if (result.length !== 1) throw new GameError('storage_error');
      return result[0];
    },
    leaderboard: () => rows<Leader>('leaderboard_view', { select: 'full_name,total_score,games_completed', order: 'total_score.desc,student_id.asc', limit: '3' }),
  };
}
