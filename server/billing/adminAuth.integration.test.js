import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { totpCode } from './totp.js';

const root=path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const scrypt=promisify(scryptCb);

async function freePort(){
  const server=createServer();server.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test('admin authentication is separate, requires TOTP enrollment, and gates admin APIs', { timeout:30000 }, async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'jibonguard-admin-test-')),dbPath=path.join(directory,'test.sqlite3'),port=await freePort();
  const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',APP_ENV:'test',JIBONGUARD_DB:dbPath,SESSION_SECRET:'s'.repeat(48),ADMIN_ENCRYPTION_KEY:'e'.repeat(48),TEXTBEE_API_KEY:'',GEMINI_API_KEY:''},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>output+=chunk.toString());child.stderr.on('data',chunk=>output+=chunk.toString());
  t.after(async()=>{child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000);});await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;let ready=false;
  for(let attempt=0;attempt<100;attempt++){
    if(child.exitCode!==null)break;
    try{const response=await fetch(`${base}/api/health`);if(response.ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(ready,true,`API did not start: ${output}`);
  const db=new DatabaseSync(dbPath),salt=randomBytes(16),password='ValidTestPassword1!';
  const digest=await scrypt(password,salt,64,{N:2**14,r:8,p:1,maxmem:64*1024*1024});
  db.prepare("INSERT INTO admin_users(id,email,password_hash,password_salt,role,created_at,updated_at) VALUES('admin-1','admin@example.test',?,?,'super_admin',1,1)").run(digest.toString('hex'),salt.toString('hex'));db.close();
  const csrfResponse=await fetch(`${base}/api/admin/auth/csrf`),csrf=(await csrfResponse.json()).csrf_token,cookie=csrfResponse.headers.get('set-cookie').split(';')[0],origin=base;
  const login=await fetch(`${base}/api/admin/auth/login`,{method:'POST',headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({email:'admin@example.test',password})});
  const loginData=await login.json();assert.equal(login.status,200,JSON.stringify(loginData));assert.equal(loginData.requiresTotpSetup,true);
  const sessionCookie=login.headers.get('set-cookie').split(';')[0],setupResponse=await fetch(`${base}/api/admin/auth/totp/setup`,{headers:{Cookie:`${cookie}; ${sessionCookie}`}}),setup=await setupResponse.json();
  assert.equal(setupResponse.status,200);
  const setupResult=await fetch(`${base}/api/admin/auth/totp/setup`,{method:'POST',headers:{Origin:origin,Cookie:`${cookie}; ${sessionCookie}`,'X-CSRF-Token':csrf,'Content-Type':'application/json'},body:JSON.stringify({code:totpCode(setup.secret)})});
  const setupData=await setupResult.json();assert.equal(setupResult.status,200,JSON.stringify(setupData));assert.equal(setupData.recovery_codes.length,10);
  const orgSessionRequest=await fetch(`${base}/api/admin/overview`,{headers:{Cookie:'jg_session=organization-only-session'}});
  assert.equal(orgSessionRequest.status,401);
  const overview=await fetch(`${base}/api/admin/overview`,{headers:{Cookie:`${cookie}; ${sessionCookie}`}});
  assert.equal(overview.status,200,await overview.text());
});
