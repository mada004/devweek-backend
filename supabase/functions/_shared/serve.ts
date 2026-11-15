import { createHandler, json, type FunctionGroup } from './handler.ts';
import { studentStore } from './students.ts';
import { gameStore } from './game-store.ts';

// Deno is provided by the Supabase Edge Runtime.
declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Promise<Response>): void };
export function serve(group: FunctionGroup) {
  let handler: (request: Request) => Promise<Response>;
  try {
    const required = (name: string) => {
      const value = Deno.env.get(name);
      if (!value) throw new Error('Missing server configuration');
      return value;
    };
    handler = createHandler(group, {
      accessCode: required('PLATFORM_ACCESS_CODE'),
      signingSecret: required('PLATFORM_TOKEN_SIGNING_SECRET'),
      store: studentStore(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY')),
      games: gameStore(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY')),
    });
  } catch {
    handler = async () => json({ error: { code: 'server_configuration_error', message: 'Service is not configured' } }, 500);
  }
  Deno.serve(handler);
}
