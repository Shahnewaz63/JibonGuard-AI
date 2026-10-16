import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { runMigrations } from '../server/db/migrations.js';
import { writeAdminAudit } from '../server/billing/audit.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for(const line of (existsSync(path.join(root,'.env'))?await import('node:fs').then(fs=>fs.readFileSync(path.join(root,'.env'),'utf8')):'').split(/\r?\n/)){
  const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if(match&&!match[1].startsWith('#')&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
}

function readHidden(label){
  return new Promise((resolve,reject)=>{
    if(!stdin.isTTY||typeof stdin.setRawMode!=='function')return reject(new Error('Run admin:create from an interactive terminal.'));
    stdout.write(label);let value='';
    const finish=(error)=>{stdin.setRawMode(false);stdin.pause();stdin.removeListener('data',onData);stdout.write('\n');error?reject(error):resolve(value);};
    const onData=chunk=>{
      for(const byte of chunk){
        if(byte===3)return finish(new Error('Cancelled.'));
        if(byte===13||byte===10)return finish();
        if(byte===8||byte===127)value=value.slice(0,-1);else value+=String.fromCharCode(byte);
      }
    };
    stdin.setRawMode(true);stdin.resume();stdin.on('data',onData);
  });
}

const emailPrompt=createInterface({input:stdin,output:stdout});
try{
  if(String(process.env.ADMIN_ENCRYPTION_KEY||'').length<32)throw new Error('Set ADMIN_ENCRYPTION_KEY to a random value of at least 32 characters before creating the first admin.');
  const email=(await emailPrompt.question('Super admin email: ')).trim().toLowerCase();
  if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)throw new Error('Enter a valid email address.');
  const password=await readHidden('Strong password (14+ characters): ');
  const confirmation=await readHidden('Confirm password: ');
  if(password!==confirmation)throw new Error('Passwords do not match.');
  if(password.length<14||!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password)||!/[^A-Za-z0-9]/.test(password))throw new Error('Use 14+ characters with uppercase, lowercase, number, and symbol.');
  const dbPath=process.env.JIBONGUARD_DB||path.join(root,'jibonguard.sqlite3'),db=new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;');
  db.exec(`CREATE TABLE IF NOT EXISTS organizations(id TEXT PRIMARY KEY,name TEXT NOT NULL,organization_type TEXT NOT NULL,phone TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',estimated_workers INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workers(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,name TEXT NOT NULL,phone TEXT NOT NULL,site TEXT NOT NULL,job_type TEXT NOT NULL,workload TEXT NOT NULL DEFAULT 'Standard',risk_level TEXT NOT NULL DEFAULT 'Moderate',outdoor_minutes INTEGER NOT NULL DEFAULT 0,last_break TEXT NOT NULL DEFAULT '',consent_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sites(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,name TEXT NOT NULL,address TEXT NOT NULL DEFAULT '',latitude REAL,longitude REAL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(organization_id,name));`);
  runMigrations(db,{databasePath:dbPath,development:true});
  if(db.prepare('SELECT 1 FROM admin_bootstrap_state WHERE id=1').get())throw new Error('Admin bootstrap is already complete. Manage additional admins from the secured admin panel.');
  if(db.prepare('SELECT 1 FROM admin_users WHERE email=? COLLATE NOCASE').get(email))throw new Error('An admin with this email already exists.');
  const scrypt=promisify(scryptCb),salt=randomBytes(16),digest=await scrypt(password,salt,64,{N:2**14,r:8,p:1,maxmem:64*1024*1024}),id=randomBytes(18).toString('base64url'),stamp=Math.floor(Date.now()/1000);
  db.exec('BEGIN IMMEDIATE');
  try{
    db.prepare("INSERT INTO admin_users(id,email,password_hash,password_salt,role,created_at,updated_at) VALUES(?,?,?,?,'super_admin',?,?)").run(id,email,digest.toString('hex'),salt.toString('hex'),stamp,stamp);
    db.prepare('INSERT INTO admin_bootstrap_state(id,completed_at) VALUES(1,?)').run(stamp);
    writeAdminAudit(db,{adminId:id,role:'super_admin',action:'admin.bootstrap_created',targetType:'admin_user',targetId:id,after:{email},now:stamp});
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  db.close();
  stdout.write(`Created the first super admin. Open /admin and complete TOTP enrollment before using admin features.\n`);
}catch(error){
  stdout.write(`Admin bootstrap failed: ${error.message}\n`);process.exitCode=1;
}finally{emailPrompt.close();}
