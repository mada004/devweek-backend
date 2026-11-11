import assert from 'node:assert/strict';

const base = process.env.DEVWEEK_LOCAL_FUNCTIONS_URL;
const url = new URL(base || 'http://invalid.invalid');
assert.ok(['127.0.0.1','localhost'].includes(url.hostname), 'Only loopback integration targets are allowed');
assert.equal(url.protocol, 'http:');
assert.equal(url.port, '55321');
assert.equal(url.pathname, '/functions/v1');
assert.equal(url.username + url.password + url.search + url.hash, '');
assert.equal(process.env.DEVWEEK_ISOLATED_TEST, '1');
assert.equal(process.env.DEVWEEK_TEST_OPERATOR_CONFIRMED, '1');
const accessCode = process.env.DEVWEEK_LOCAL_ACCESS_CODE;
assert.ok(accessCode);
let token;
const results = [];
async function call(path, method='GET', body) {
  const response = await fetch(base + path, {
    method, headers: { 'Content-Type':'application/json', ...(token ? { Authorization:`Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect:'error', signal: AbortSignal.timeout(30000),
  });
  let data;
  try { data = await response.json(); } catch { throw new Error('Non-JSON local response'); }
  return { status: response.status, data };
}
function check(label, response, status, code) {
  // Log statuses only, never tokens, participant records or response bodies.
  const entry = { scenario:label, status:response.status, expected_status:status, passed:response.status===status && (!code || response.data.error?.code===code) };
  if (response.data.error?.code) entry.error_code = response.data.error.code;
  results.push(entry);
  assert.equal(response.status, status, label);
  if(code) assert.equal(response.data.error?.code, code, label);
}
try {
  const verified = await call('/access/verify','POST',{access_code:accessCode});
  check('local access verification',verified,200);
  token = verified.data.access_token;
  assert.equal(typeof token,'string');
  delete verified.data.access_token;
  const suffix = crypto.randomUUID();
  const full_name = `Synthetic E2E Participant ${suffix}`;
  const student_number = `TEST-ONLY-${suffix}`;
  const registration = await call('/students/register','POST',{full_name,student_number});
  check('register synthetic participant',registration,201);
  const student = registration.data.student;
  assert.equal(student.full_name,full_name);
  assert.equal(student.student_number,student_number);
  const duplicate = await call('/students/register','POST',{full_name:'Synthetic duplicate',student_number});
  check('reject duplicate registration',duplicate,409,'student_number_exists');
  const login = await call('/students/login','POST',{student_number});
  check('retrieve freshly registered participant by number only',login,200);
  assert.deepEqual(login.data.student,student);
  // Real PostgREST regressions: preserve leading zeros, quotes, backslashes,
  // spaces and URL-reserved characters without creating extra query filters.
  for (const [label,number] of [
    ['leading-zero TEXT','0000123'],
    ['reserved-character TEXT',`00"\\,or=(id.not.is.null)&limit=999-${suffix}`],
    ['surrounding-space TEXT',` 00123-${suffix} `],
  ]) {
    const created=await call('/students/register','POST',{full_name:'Synthetic Text Regression',student_number:number});
    check('register '+label,created,201);
    const found=await call('/students/login','POST',{student_number:number});
    check('lookup '+label,found,200);
    assert.deepEqual(found.data.student,created.data.student);
    assert.equal(found.data.student.student_number,number);
  }
  const numericMismatch=await call('/students/login','POST',{student_number:'123'});
  check('leading zeros are not numerically normalized',numericMismatch,404,'student_not_found');
  const games = await call('/games');
  check('read five fixed games',games,200);
  assert.equal(games.data.games.length,5);
  assert.ok(games.data.games.every(game=>game.max_score===100));

  // This harness represents the explicitly confirmed synthetic operator action.
  // There is no backend operator-authentication rule in the existing contract.
  const selectedGame = games.data.games.find(game=>game.id===1 && game.is_active);
  assert.ok(selectedGame);
  assert.equal(process.env.DEVWEEK_TEST_OPERATOR_CONFIRMED,'1');
  const started = await call('/attempts/start','POST',{student_id:student.id,game_id:selectedGame.id});
  check('start selected game after synthetic operator confirmation',started,201);
  const attempt = started.data.attempt;
  assert.equal(attempt.status,'started');
  assert.equal(attempt.score,null);
  const expectedDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Riyadh',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(attempt.started_at));
  assert.equal(attempt.play_date,expectedDate);
  const second = await call('/attempts/start','POST',{student_id:student.id,game_id:2});
  check('reject second game on same Riyadh date',second,409,'daily_limit_reached');
  const replay = await call('/attempts/start','POST',{student_id:student.id,game_id:1});
  check('reject replay of same game',replay,409,'game_already_attempted');
  const finished = await call('/attempts/finish','POST',{attempt_id:attempt.id,score:85});
  check('finish valid attempt and report saved score',finished,200);
  assert.equal(finished.data.score_saved,true);
  assert.equal(finished.data.total_available,true);
  assert.equal(finished.data.attempt.id,attempt.id);
  assert.equal(finished.data.attempt.status,'completed');
  assert.equal(finished.data.attempt.score,85);
  assert.equal(finished.data.total_score,85);
  assert.equal(finished.data.games_completed,1);
  const progress = await call(`/students/${student.id}/progress`);
  check('verify persisted score through participant progress',progress,200);
  assert.equal(progress.data.total_score,85);
  assert.equal(progress.data.games_completed,1);
  assert.equal(progress.data.daily_slot_consumed,true);
  assert.equal(progress.data.games.find(game=>game.id===1).attempt.score,85);
  assert.equal(progress.data.games.find(game=>game.id===1).attempt.status,'completed');
  const leaders = await call('/leaderboard');
  check('verify leaderboard aggregation',leaders,200);
  const row = leaders.data.leaderboard.find(row=>row.full_name===full_name);
  assert.ok(row);
  assert.equal(row.total_score,85);
  assert.equal(row.games_completed,1);
  const repeated = await call('/attempts/finish','POST',{attempt_id:attempt.id,score:25});
  check('reject repeated completion',repeated,409,'attempt_already_completed');
  const unchanged = await call(`/students/${student.id}/progress`);
  check('score unchanged after repeated completion',unchanged,200);
  assert.equal(unchanged.data.total_score,85);
  assert.equal(unchanged.data.games.find(game=>game.id===1).attempt.score,85);
  const passed=results.every(result=>result.passed);
  console.log(JSON.stringify({environment:'isolated-local',passed,results},null,2));
  if(!passed)process.exitCode=1;
} catch {
  console.log(JSON.stringify({environment:'isolated-local',passed:false,completed:results,failure:'Local status or response assertion failed; raw responses and credentials suppressed'},null,2));
  process.exitCode=1;
} finally {token='';}
