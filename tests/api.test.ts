import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../supabase/functions/_shared/handler.ts';
import { platformTokens } from '../supabase/functions/_shared/platform.ts';
import { studentStore, StoreError, type Student } from '../supabase/functions/_shared/students.ts';

// Fixtures are local test values, never read from production configuration.
const signingSecret = 'test-only-signing-secret-32-bytes-minimum';
const accessCode = 'test-only-platform-code';
function fixture() {
  const records = new Map<string, Student>();
  let operations = 0;
  const store = {
    async create(full_name: string, student_number: string) {
      operations++;
      if (records.has(student_number)) throw new StoreError('23505');
      const row = { id: crypto.randomUUID(), full_name, student_number };
      records.set(student_number, row);
      return row;
    },
    async find(number: string) { operations++; return records.get(number) ?? null; },
  };
  const config = { accessCode, signingSecret, store };
  const access = createHandler('access', config);
  const students = createHandler('students', config);
  async function call(path: string, body: unknown, token?: string) {
    return await (path.startsWith('/access') ? access : students)(new Request(`https://local.test/functions/v1${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    }));
  }
  async function token() {
    const response = await call('/access/verify', { access_code: accessCode });
    assert.equal(response.status, 200);
    return (await response.json()).access_token as string;
  }
  return { access, students, call, token, records, operations: () => operations };
}

test('correct access code issues a verifiable temporary token without disclosing code', async () => {
  const f = fixture();
  const response = await f.call('/access/verify', { access_code: accessCode });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.expires_in, 3600);
  assert.equal(body.token_type, 'Bearer');
  assert.ok(await platformTokens(signingSecret).verify(body.access_token));
  assert.ok(!JSON.stringify(body).includes(accessCode));
  assert.equal(f.operations(), 0);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('incorrect, missing, and invalid access codes fail', async () => {
  const f = fixture();
  assert.equal((await f.call('/access/verify', { access_code: 'wrong' })).status, 401);
  for (const access_code of [undefined, null, 123, '', '  ']) {
    assert.equal((await f.call('/access/verify', { access_code })).status, 400);
  }
});

test('registration and returning login preserve leading zeros and UUID, returning only needed fields', async () => {
  const f = fixture(); const token = await f.token();
  const response = await f.call('/students/register', { full_name: ' Student Name ', student_number: '00123' }, token);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.student.student_number, '00123');
  assert.equal(created.student.full_name, 'Student Name');
  assert.match(created.student.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(Object.keys(created.student).sort(), ['full_name', 'id', 'student_number']);
  const login = await f.call('/students/login', { student_number: '00123' }, token);
  assert.equal(login.status, 200);
  assert.deepEqual(await login.json(), created);
  assert.equal((await f.call('/students/login', { student_number: '123' }, token)).status, 404);
});

test('duplicate and concurrent registration cannot overwrite original name', async () => {
  const f = fixture(); const token = await f.token();
  const responses = await Promise.all(['First', 'Second'].map(full_name => f.call('/students/register', { full_name, student_number: '7' }, token)));
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  assert.equal(f.records.size, 1);
  assert.equal(f.records.get('7')?.full_name, 'First');
  const duplicate = await f.call('/students/register', { full_name: 'Changed', student_number: '7' }, token);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'student_number_exists');
  assert.equal(f.records.get('7')?.full_name, 'First');
});

test('unknown student returns clear 404', async () => {
  const f = fixture();
  const response = await f.call('/students/login', { student_number: 'unknown' }, await f.token());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'student_not_found');
});

test('both student routes reject missing, malformed, and forged tokens before storage', async () => {
  const f = fixture();
  for (const path of ['/students/register', '/students/login']) {
    for (const token of [undefined, 'invalid', 'v1.bad.bad']) {
      assert.equal((await f.call(path, { full_name: 'Student', student_number: '1' }, token)).status, 401);
    }
  }
  assert.equal(f.operations(), 0);
});

test('expired, tampered, and differently signed tokens fail; exact expiry is rejected', async () => {
  let now = 1000;
  const tokens = platformTokens(signingSecret, () => now);
  const { access_token } = await tokens.issue();
  assert.ok(await tokens.verify(access_token));
  const parts = access_token.split('.');
  parts[1] = parts[1].slice(0, -2) + 'AA';
  assert.equal(await tokens.verify(parts.join('.')), false);
  assert.equal(await platformTokens('another-test-only-secret-at-least-32-bytes', () => now).verify(access_token), false);
  now = 4600;
  assert.equal(await tokens.verify(access_token), false);
  const f = fixture();
  assert.equal((await f.call('/students/login', { student_number: '1' }, access_token)).status, 401);
});

test('invalid inputs are rejected; arbitrary string lengths are accepted', async () => {
  const f = fixture(); const token = await f.token();
  for (const student_number of [undefined, null, 12, true, {}, [], '', '  ']) {
    for (const path of ['/students/register', '/students/login']) {
      assert.equal((await f.call(path, { full_name: 'Name', student_number }, token)).status, 400);
    }
  }
  for (const full_name of [undefined, null, 12, [], '', ' ']) {
    assert.equal((await f.call('/students/register', { full_name, student_number: '1' }, token)).status, 400);
  }
  for (const body of [null, [], 'text']) assert.equal((await f.call('/students/login', body, token)).status, 400);
  for (const number of ['0', '0'.repeat(80)]) {
    assert.equal((await f.call('/students/register', { full_name: 'Name', student_number: number }, token)).status, 201);
  }
});

test('JSON, routing, method, and CORS behavior', async () => {
  const f = fixture();
  assert.equal((await f.access(new Request('https://local.test/access/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await f.access(new Request('https://local.test/access/verify', { method: 'POST', body: '{}' }))).status, 415);
  assert.equal((await f.access(new Request('https://local.test/access/verify'))).status, 405);
  assert.equal((await f.access(new Request('https://local.test/students/login'))).status, 404);
  const preflight = await f.students(new Request('https://local.test/students/register', { method: 'OPTIONS' }));
  assert.equal(preflight.status, 204);
  assert.ok(preflight.headers.get('Access-Control-Allow-Headers')?.includes('authorization'));
});

test('server configuration fails closed and database failures stay private', async () => {
  assert.throws(() => createHandler('access', { accessCode: '', signingSecret, store: fixture().records as never }));
  assert.throws(() => platformTokens('short'));
  assert.throws(() => createHandler('access', { accessCode: signingSecret, signingSecret, store: fixture().records as never }));
  const store = { async create() { throw new Error('private-db-detail'); }, async find() { throw new Error('private-db-detail'); } };
  const handler = createHandler('students', { accessCode, signingSecret, store });
  const { access_token } = await platformTokens(signingSecret).issue();
  const response = await handler(new Request('https://local.test/students/login', { method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: '{"student_number":"1"}' }));
  assert.equal(response.status, 500);
  assert.ok(!(await response.text()).includes('private-db-detail'));
});

test('PostgREST adapter projects fields, preserves strings, escapes filters, and maps duplicate errors', async () => {
  const row = { id: 'test-id', full_name: 'Name', student_number: '001', created_at: 'hidden' };
  const calls: { url: URL; init?: RequestInit }[] = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify([row]), { status: 200 });
  }) as typeof fetch;
  const store = studentStore('https://isolated.test', 'test-only-key', mockFetch);
  assert.deepEqual(await store.create('Name', '001'), { id: 'test-id', full_name: 'Name', student_number: '001' });
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { full_name: 'Name', student_number: '001' });
  assert.equal(calls[0].url.searchParams.get('select'), 'id,full_name,student_number');
  const filterValue = '00"\\,or=(id.not.is.null)';
  await store.find(filterValue);
  assert.equal(calls[1].url.searchParams.get('student_number'), 'eq.' + filterValue);
  assert.equal(calls[1].url.searchParams.get('limit'), '1');
  const duplicate = studentStore('https://isolated.test', 'test-only-key', (async () => new Response('{"code":"23505","message":"private"}', { status: 409 })) as typeof fetch);
  await assert.rejects(() => duplicate.create('Name', '001'), (e: unknown) => e instanceof StoreError && e.code === '23505');
});

test('adapter-backed fresh registration and number-only login preserve exact TEXT filters', async () => {
  const records = new Map<string, Student>();
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/rest/v1/students');
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      if (records.has(body.student_number)) return new Response('{"code":"23505"}', { status: 409 });
      const row = { id: crypto.randomUUID(), full_name: body.full_name, student_number: body.student_number };
      records.set(row.student_number, row);
      return new Response(JSON.stringify([row]), { status: 201 });
    }
    assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'select', 'student_number']);
    const filter = url.searchParams.get('student_number')!;
    assert.ok(filter.startsWith('eq.'));
    // Equality operands are the TEXT itself, not a quoted SQL/list literal.
    const row = records.get(filter.slice(3));
    return new Response(JSON.stringify(row ? [row] : []));
  }) as typeof fetch;
  const handler = createHandler('students', { accessCode, signingSecret, store: studentStore('https://isolated.test', 'test-only-key', transport) });
  const { access_token } = await platformTokens(signingSecret).issue();
  const call = (path: string, body: unknown) => handler(new Request(`https://isolated.test${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
  for (const student_number of ['00123', `TEST-ONLY-${crypto.randomUUID()}`, '00"\\,or=(id.not.is.null)&limit=999', ' 00123 ']) {
    const registered = await call('/students/register', { full_name: 'Synthetic Regression', student_number });
    assert.equal(registered.status, 201);
    const expected = await registered.json();
    const login = await call('/students/login', { student_number });
    assert.equal(login.status, 200);
    assert.deepEqual(await login.json(), expected);
    assert.equal(expected.student.student_number, student_number);
    assert.equal((await call('/students/register', { full_name: 'Duplicate', student_number })).status, 409);
  }
  assert.equal((await call('/students/login', { student_number: '123' })).status, 404);
});
