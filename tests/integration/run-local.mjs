import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,copyFileSync,existsSync,unlinkSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {mkdtempSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
if(!process.argv.includes('--confirm-local-writes'))throw new Error('Pass --confirm-local-writes to authorize synthetic writes in a disposable local stack');
const repo=fileURLToPath(new URL('../../',import.meta.url));
if(execFileSync('git',['branch','--show-current'],{cwd:repo,encoding:'utf8'}).trim()!=='phase-3-backend')throw new Error('Expected phase-3-backend');
const workspace=mkdtempSync(join(tmpdir(),'devweek-e2e-'));
const localProjectId='devweek-e2e-'+randomBytes(4).toString('hex');
const cli=repo+'/node_modules/supabase/dist/supabase.js';
const traceLogin=process.argv.includes('--trace-login');
// New unlinked workspace: never copy production linkage or environment files.
mkdirSync(workspace+'/supabase/migrations',{recursive:true});
let config=readFileSync(repo+'/supabase/config.toml','utf8').replace('project_id = "devweek-backend"','project_id = "'+localProjectId+'"').replace(/\b543(\d\d)\b/g,'553$1');
writeFileSync(workspace+'/supabase/config.toml',config);
copyFileSync(repo+'/supabase/migrations/001_initial_schema.sql',workspace+'/supabase/migrations/001_initial_schema.sql');
function copyTs(source,target){mkdirSync(target,{recursive:true});for(const item of readdirSync(source,{withFileTypes:true})){if(item.isDirectory())copyTs(join(source,item.name),join(target,item.name));else if(item.name.endsWith('.ts'))copyFileSync(join(source,item.name),join(target,item.name));}}
copyTs(repo+'/supabase/functions',workspace+'/supabase/functions');

if(traceLogin){
  // Diagnostic changes exist only in the unlinked temporary copy. Production
  // source is untouched. Capture the actual lookup filter/row count in headers.
  const studentsFile=workspace+'/supabase/functions/_shared/students.ts';
  let students=readFileSync(studentsFile,'utf8');
  const lookup='      const rows = await result(await transport(`${endpoint}?${query}`, { headers }));';
  if(!students.includes(lookup))throw new Error('Expected lookup diagnostic point missing');
  students=students.replace(lookup,`      const diagnostic = globalThis as unknown as { __devweekRawLookup?: boolean; __devweekLookup?: { quoted: boolean; rows: number } };
      if(diagnostic.__devweekRawLookup) query.set('student_number', 'eq.' + number);
${lookup}
      diagnostic.__devweekLookup = { quoted: query.get('student_number') === 'eq.' + JSON.stringify(number), rows: rows.length };`);
  writeFileSync(studentsFile,students);
  const serveFile=workspace+'/supabase/functions/_shared/serve.ts';
  let serve=readFileSync(serveFile,'utf8');
  serve=serve.replace('  Deno.serve(handler);',`  Deno.serve(async request => {
    const diagnostic = globalThis as unknown as { __devweekRawLookup?: boolean; __devweekLookup?: { quoted: boolean; rows: number } };
    diagnostic.__devweekRawLookup = request.headers.get('x-devweek-trace-raw-eq') === '1';
    diagnostic.__devweekLookup = undefined;
    const response = await handler(request);
    if(diagnostic.__devweekLookup){
      response.headers.set('x-devweek-trace-quoted', String(diagnostic.__devweekLookup.quoted));
      response.headers.set('x-devweek-trace-rows', String(diagnostic.__devweekLookup.rows));
    }
    return response;
  });`);
  writeFileSync(serveFile,serve);
}

const accessCode=randomBytes(24).toString('hex');
const signingSecret=randomBytes(48).toString('hex');
const secretFile=workspace+'/.local-secrets.env';
writeFileSync(secretFile,`PLATFORM_ACCESS_CODE=${accessCode}\nPLATFORM_TOKEN_SIGNING_SECRET=${signingSecret}\n`,{mode:0o600});
function command(args,{timeout=600000}={}){
  return new Promise(resolve=>{
    const child=spawn(process.execPath,[cli,'--workdir',workspace,...args],{cwd:workspace,stdio:['ignore','pipe','pipe'],windowsHide:true});
    let stdout='';child.stdout.on('data',chunk=>{stdout+=chunk.toString();});
    let text='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{text=(text+chunk.toString()).slice(-4000000);});
    const timer=setTimeout(()=>{child.kill();},timeout);
    child.on('exit',code=>{clearTimeout(timer);resolve({code,text,stdout});});
  });
}
let serving;
let stage='local-start';
const timer=setInterval(()=>console.log(`Isolated local test stage: ${stage}; raw CLI output suppressed.`),30000);
try{
 console.log('Starting unlinked disposable local stack on ports 55321/55322; production is not a target.');
 const result=await command(['start','--exclude','gotrue,realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,logflare,vector,supavisor','--yes']);
 if(result.code!==0){console.log(JSON.stringify({stage,exit:result.code,imagePullIssue:/pull.*denied|failed.*pull|failed.*download|TLS handshake timeout|unexpected EOF|net\/http/i.test(result.text),portConflict:/already allocated|address already in use/i.test(result.text),details:'CLI output suppressed to avoid displaying local credentials'}));process.exitCode=1;}
 else{
  stage='local-functions-serve';
  serving=spawn(process.execPath,[cli,'--workdir',workspace,'functions','serve','--no-verify-jwt','--env-file',secretFile],{cwd:workspace,stdio:['ignore','pipe','pipe'],windowsHide:true});
  // Runtime output can contain local credentials, so never print or persist it.
  serving.stdout.on('data',()=>{});serving.stderr.on('data',()=>{});
  const base='http://127.0.0.1:55321/functions/v1';
  let ready=false;
  for(let i=0;i<60;i++){
    await new Promise(resolve=>setTimeout(resolve,2000));
    try{const r=await fetch(base+'/games',{signal:AbortSignal.timeout(2000)});const b=await r.json();if(r.status===401&&b.error?.code==='invalid_platform_token'){ready=true;break;}}catch{}
  }
  if(!ready)throw new Error('Local Edge Runtime did not become ready');
  stage='real-local-http-journey';
  const diagnostics = traceLogin ? {DEVWEEK_LOCAL_DB_CONTAINER:'supabase_db_'+localProjectId} : {};
  const testFile=traceLogin?'login-trace.mjs':'local-journey.mjs';
  const test=spawn(process.execPath,[repo+'/tests/integration/'+testFile],{cwd:repo,env:{...process.env,...diagnostics,DEVWEEK_ISOLATED_TEST:'1',DEVWEEK_LOCAL_FUNCTIONS_URL:base,DEVWEEK_LOCAL_ACCESS_CODE:accessCode,DEVWEEK_TEST_OPERATOR_CONFIRMED:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let safe='';test.stdout.on('data',chunk=>{safe+=chunk.toString();});test.stderr.on('data',()=>{});
  const exit=await new Promise(resolve=>test.on('exit',resolve));
  console.log(safe.trim());
  process.exitCode=exit===0?0:1;
 }
}catch(error){console.log(JSON.stringify({stage,error:['Local Edge Runtime did not become ready','Local metadata unavailable','Local metadata JSON parsing failed','Local service credential unavailable'].includes(error.message)?error.message:'Local orchestration failed; sensitive output suppressed'}));process.exitCode=1;}
finally{
 stage='local-cleanup';
 if(serving)serving.kill();
 const stopped=await command(['stop'],{timeout:60000});
 console.log(JSON.stringify({local_stop_exit:stopped.code,workspace,production_requests:0}));
 if(existsSync(secretFile))unlinkSync(secretFile);
 clearInterval(timer);
}
