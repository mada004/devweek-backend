import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
const base=process.env.DEVWEEK_LOCAL_FUNCTIONS_URL;
assert.equal(new URL(base).origin,'http://127.0.0.1:55321');
assert.equal(process.env.DEVWEEK_ISOLATED_TEST,'1');
const container=process.env.DEVWEEK_LOCAL_DB_CONTAINER;
assert.match(container,/^supabase_db_devweek-e2e-[a-f0-9]{8}$/);
async function run(){
 const access=await fetch(base+'/access/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({access_code:process.env.DEVWEEK_LOCAL_ACCESS_CODE}),redirect:'error'});
 assert.equal(access.status,200);
 const auth=await access.json();
 const headers={'Content-Type':'application/json',Authorization:`Bearer ${auth.access_token}`};
 const number='0000-TRACE-ONLY-'+crypto.randomUUID();
 const registered=await fetch(base+'/students/register',{method:'POST',headers,body:JSON.stringify({full_name:'Synthetic Login Trace',student_number:number}),redirect:'error'});
 assert.equal(registered.status,201);
 const student=(await registered.json()).student;
 const login=await fetch(base+'/students/login',{method:'POST',headers,body:JSON.stringify({student_number:number}),redirect:'error'});
 const pg=execFileSync('docker',['exec','-i',container,'psql','-U','postgres','-d','postgres','-At'],{input:`SELECT student_number = '${number}' AND pg_typeof(student_number)::text = 'text' FROM public.students WHERE id = '${student.id}';\n`,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 assert.equal(pg,'t');
 const control=await fetch(base+'/students/login',{method:'POST',headers:{...headers,'x-devweek-trace-raw-eq':'1'},body:JSON.stringify({student_number:number}),redirect:'error'});
 const controlBody=await control.json();
 console.log(JSON.stringify({isolated_local:true,edge_registration_status:registered.status,edge_login_status:login.status,actual_edge_filter_quoted:login.headers.get('x-devweek-trace-quoted'),actual_postgrest_rows:login.headers.get('x-devweek-trace-rows'),postgres_exact_text_match:pg==='t',unquoted_control_login_status:control.status,unquoted_control_rows:control.headers.get('x-devweek-trace-rows'),unquoted_exact_match:controlBody.student?.student_number===number},null,2));
 assert.equal(control.status,200);
 assert.equal(controlBody.student?.id,student.id);
}
run().catch(()=>{console.log('Local login trace failed; raw responses/credentials suppressed');process.exitCode=1;});
