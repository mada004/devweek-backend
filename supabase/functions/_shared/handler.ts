import { platformTokens } from './platform.ts';
import { StoreError, type StudentStore } from './students.ts';
import { cors, json } from './http.ts';
import { gameApi } from './game-api.ts';
import type { GameStore } from './game-store.ts';
export { json } from './http.ts';

const error = (code: string, message: string, status: number) => json({ error: { code, message } }, status);
export type FunctionGroup = 'access' | 'students' | 'games' | 'attempts' | 'leaderboard';
export function createHandler(group: FunctionGroup, config: {
  accessCode: string; signingSecret: string; store: StudentStore; games?: GameStore; now?: () => number;
}) {
  if (!config.accessCode || config.accessCode === config.signingSecret) throw new Error('Separate platform secrets required');
  const tokens = platformTokens(config.signingSecret, config.now);
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname.replace(/^\/functions\/v1/, '');
    const progress = group === 'students' && /^\/students\/[^/]+\/progress$/.test(path);
    const routes: Record<FunctionGroup, string[]> = {
      access: ['/access/verify'], students: ['/students/register', '/students/login'],
      games: ['/games'], attempts: ['/attempts/start', '/attempts/finish'], leaderboard: ['/leaderboard'],
    };
    if (!routes[group].includes(path) && !progress) return error('not_found', 'Endpoint not found', 404);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const method = progress || group === 'games' || group === 'leaderboard' ? 'GET' : 'POST';
    if (request.method !== method) return error('method_not_allowed', `Use ${method}`, 405);
    try {
      if (group !== 'access') {
        const match = /^Bearer ([^\s]+)$/i.exec(request.headers.get('Authorization') ?? '');
        if (!match || !await tokens.verify(match[1])) return error('invalid_platform_token', 'Valid platform access token required', 401);
      }
      if (progress || group === 'games' || group === 'attempts' || group === 'leaderboard') {
        if (!config.games) return error('server_configuration_error', 'Service is not configured', 500);
        return await gameApi(request, path, config.games, () => new Date((config.now?.() ?? Date.now() / 1000) * 1000));
      }
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        return error('unsupported_media_type', 'Use application/json', 415);
      }
      let body: Record<string, unknown>;
      try {
        const parsed = await request.json();
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        body = parsed;
      } catch { return error('invalid_input', 'Expected a JSON object', 400); }
      const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
      if (path === '/access/verify') {
        if (!nonempty(body.access_code)) return error('invalid_input', 'access_code must be a non-empty string', 400);
        if (!await tokens.matchesCode(body.access_code, config.accessCode)) return error('invalid_access_code', 'Incorrect access code', 401);
        return json(await tokens.issue());
      }
      if (!nonempty(body.student_number)) return error('invalid_input', 'student_number must be a non-empty string', 400);
      if (path === '/students/register') {
        if (!nonempty(body.full_name)) return error('invalid_input', 'full_name must be a non-empty string', 400);
        return json({ student: await config.store.create(body.full_name.trim(), body.student_number) }, 201);
      }
      const student = await config.store.find(body.student_number);
      return student ? json({ student }) : error('student_not_found', 'Student number not found', 404);
    } catch (cause) {
      if (cause instanceof StoreError && cause.code === '23505') return error('student_number_exists', 'Student number already registered', 409);
      // Do not return or log database errors, request bodies, or credentials.
      return error('internal_error', 'Unable to process request', 500);
    }
  };
}
