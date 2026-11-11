export type Student = { id: string; full_name: string; student_number: string };
export class StoreError extends Error {
  code: string;
  constructor(code: string) { super('Student storage operation failed'); this.code = code; }
}
export interface StudentStore {
  create(fullName: string, number: string): Promise<Student>;
  find(number: string): Promise<Student | null>;
}

// Direct PostgREST calls avoid a client session or student Auth dependency.
export function studentStore(url: string, serviceKey: string, transport: typeof fetch = fetch): StudentStore {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/students`;
  const headers = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  async function result(response: Response): Promise<Student[]> {
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new StoreError(error.code === '23505' ? '23505' : 'storage_error');
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.some(row => typeof row.id !== 'string' || typeof row.full_name !== 'string' || typeof row.student_number !== 'string')) {
      throw new StoreError('storage_error');
    }
    return rows.map(({ id, full_name, student_number }) => ({ id, full_name, student_number }));
  }
  return {
    async create(fullName, number) {
      const query = new URLSearchParams({ select: 'id,full_name,student_number' });
      const rows = await result(await transport(`${endpoint}?${query}`, {
        method: 'POST', headers: { ...headers, Prefer: 'return=representation' },
        body: JSON.stringify({ full_name: fullName, student_number: number }),
      }));
      if (rows.length !== 1) throw new StoreError('storage_error');
      return rows[0];
    },
    async find(number) {
      // An eq operand is the exact TEXT value, not a quoted SQL/list literal.
      // URLSearchParams keeps reserved characters inside this one filter value.
      const query = new URLSearchParams({ select: 'id,full_name,student_number', student_number: `eq.${number}`, limit: '1' });
      const rows = await result(await transport(`${endpoint}?${query}`, { headers }));
      return rows[0] ?? null;
    },
  };
}
