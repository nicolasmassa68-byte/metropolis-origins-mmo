import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pg from 'pg';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
const scrypt=promisify(crypto.scrypt);

const PORT = Number(process.env.PORT || 10000);
const DATABASE_URL = process.env.DATABASE_URL;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN;
if (!DATABASE_URL || !FRONTEND_ORIGIN) {
  console.error('DATABASE_URL and FRONTEND_ORIGIN must be configured.');
  process.exit(1);
}
const pool = new pg.Pool({connectionString:DATABASE_URL,ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:false}});
const app = express();
app.disable('x-powered-by');
app.set('trust proxy',1);
app.use(helmet());
app.use(cors({origin:FRONTEND_ORIGIN.split(',').map(v=>v.trim())}));
app.use(express.json({limit:'16kb'}));
const WORLD=2048, CHUNK=32;
const ACCOUNT_SESSION_DAYS=30;
const ADMIN_EMAIL=(process.env.ADMIN_EMAIL||'').trim().toLowerCase();
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||'';
const emailOk=e=>typeof e==='string'&&e.trim().length<=254&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
const passwordOk=p=>typeof p==='string'&&p.length>=12&&p.length<=128;
async function passwordHash(p){const salt=crypto.randomBytes(16).toString('hex');const key=await scrypt(p,salt,64);return salt+':'+key.toString('hex')}
async function passwordVerify(p,stored){if(typeof stored!=='string')return false;const [salt,hex]=stored.split(':');if(!salt||!/^[a-f0-9]{128}$/.test(hex||''))return false;const key=await scrypt(p,salt,64);return crypto.timingSafeEqual(key,Buffer.from(hex,'hex'))}
async function issueSession(accountId){const raw=crypto.randomBytes(32).toString('hex');await pool.query(`INSERT INTO origins_account_sessions(account_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')`,[accountId,hash(raw)]);return raw}

// Toutes les dépenses sont vérifiées et prélevées dans une transaction PostgreSQL.
const COSTS=Object.freeze({
  hut:{wood:12,stone:2,food:4},fire:{wood:5,stone:3,food:0},
  store:{wood:18,stone:8,food:0},work:{wood:22,stone:10,food:0},
  gather:{wood:10,stone:2,food:0},farm:{wood:12,stone:5,food:8},
  guard:{wood:18,stone:12,food:0},palisade:{wood:9,stone:2,food:0},
  port:{wood:30,stone:12,food:0},
  rabbit_trap:{wood:8,stone:2,food:0},pen:{wood:25,stone:8,food:0}
});
const rateBuckets=new Map();
function throttle(label,max,windowMs){return (req,res,next)=>{
 const ip=req.ip||req.socket.remoteAddress||'unknown',key=label+':'+ip,now=Date.now();
 if(rateBuckets.size>10000){for(const [k,b] of rateBuckets)if(now>b.reset)rateBuckets.delete(k)}
 const b=rateBuckets.get(key);
 if(!b||now>b.reset){rateBuckets.set(key,{count:1,reset:now+windowMs});return next()}
 if(++b.count>max)return res.status(429).json({error:'Trop de requêtes. Réessaie plus tard.'});
 next();
}}

const EPOCH=Date.UTC(2026,10,18), DAY_MS=30*60*1000;
const worldDay=()=>Math.max(1,Math.floor((Date.now()-EPOCH)/DAY_MS)+1);
const seasons=['Printemps','Été','Automne','Hiver'];
const season=()=>seasons[Math.floor((worldDay()-1)/30)%4];
// Météo commune calculée par jour et saison, déterministe sans tables volumineuses.
function weather(day=worldDay()){
 const current=seasons[Math.floor((day-1)/30)%4];
 const v=Math.abs(Math.sin(day*12.9898+78.233)*43758.5453)%1;
 const kind=current==='Hiver'?(v<.43?'Neige':v<.64?'Vent':'Clair'):(v<.22?'Pluie':v<.32?'Vent':v<.37?'Orage':'Clair');
 return {kind,temperature:current==='Hiver'?-3:current==='Été'?24:current==='Automne'?11:15};
}

const professions=['sans métier','bûcheron','cueilleur','chasseur','tailleur de pierre','savant','pêcheur','éleveur'];
const TRAINING_DAYS=3; // Une formation dure 3 jours de jeu (90 minutes réelles).
const EXPEDITION_MS_PER_TILE=45*1000; // 45 secondes par parcelle à l'aller ET au retour.
const production={'bûcheron':'wood','cueilleur':'food','chasseur':'food','tailleur de pierre':'stone','savant':'knowledge','pêcheur':'food'};

const hash=v=>crypto.createHash('sha256').update(v).digest('hex');
const nameOk=s=>typeof s==='string'&&s.trim().length>=2&&s.trim().length<=24&&/^[\p{L}\p{N} '-]+$/u.test(s.trim());
function terrain(x,y){const v=Math.sin(x*.111+Math.cos(y*.017)*2)+Math.cos(y*.097-x*.019);return v<-1.42?'water':v>.85?'forest':v>.45?'rock':'grass';}
// Biomes uniquement visuels : compatibilité des villages et parcelles V25 conservée.
function biome(x,y){
  const t=terrain(x,y),temperature=Math.sin(x*.0047+y*.0021)+Math.cos(y*.0035),wet=Math.sin(x*.007-y*.009)+Math.cos(y*.006);
  if(t==='water')return 'water';
  if(temperature < -1.15)return t==='rock'?'snowrock':'tundra';
  if(temperature > 1.25 && wet < -.15)return t==='forest'?'scrub':'desert';
  if(t==='rock')return temperature < -.3?'highland':'rock';
  if(t==='forest')return temperature < -.4?'pine':wet > .85?'rainforest':'forest';
  return wet > 1.25?'marsh':wet < -.9?'drygrass':'grass';
}
function elevation(x,y){
  const h=Math.sin(x*.051+y*.023)*.44+Math.cos(y*.071-x*.015)*.34+Math.sin(x*.009-y*.013)*.55;
  return Math.round(Math.max(0,Math.min(3,1.2+h))*10)/10;
}
async function init(){
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_players (
    id BIGSERIAL PRIMARY KEY, name VARCHAR(25) NOT NULL, token_hash CHAR(64) UNIQUE NOT NULL,
    x INTEGER NOT NULL, y INTEGER NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), last_seen TIMESTAMPTZ DEFAULT now()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_discoveries (
    player_id BIGINT REFERENCES origins_players(id) ON DELETE CASCADE,
    x INTEGER NOT NULL, y INTEGER NOT NULL,
    PRIMARY KEY(player_id,x,y)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_buildings (
    id BIGSERIAL PRIMARY KEY, player_id BIGINT REFERENCES origins_players(id) ON DELETE CASCADE,
    x INTEGER NOT NULL, y INTEGER NOT NULL, kind VARCHAR(32) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now(), UNIQUE(x,y)
  )`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS wood INTEGER NOT NULL DEFAULT 30`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS food INTEGER NOT NULL DEFAULT 50`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS stone INTEGER NOT NULL DEFAULT 18`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS knowledge INTEGER NOT NULL DEFAULT 0`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS last_day INTEGER NOT NULL DEFAULT 1`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS navigation_researched BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS boats INTEGER NOT NULL DEFAULT 0`);
  // V31 : bâtiments de capture, animaux apprivoisés et rencontres d'expédition.
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS last_trap_day INTEGER`);
  await pool.query(`ALTER TABLE origins_players ADD COLUMN IF NOT EXISTS last_breed_day INTEGER`);
  await pool.query(`UPDATE origins_players SET last_trap_day=$1,last_breed_day=$1 WHERE last_trap_day IS NULL OR last_breed_day IS NULL`,[worldDay()]);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_animals (
    id BIGSERIAL PRIMARY KEY, player_id BIGINT NOT NULL REFERENCES origins_players(id) ON DELETE CASCADE,
    species VARCHAR(20) NOT NULL CHECK(species IN ('lapin','cochon','vache')),
    sex CHAR(1) NOT NULL CHECK(sex IN ('M','F')),
    created_day INTEGER NOT NULL,
    source VARCHAR(20) NOT NULL DEFAULT 'piège'
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS origins_animals_owner ON origins_animals(player_id)`);
  // V33: migration additive, les troupeaux existants restent intacts.
  await pool.query(`ALTER TABLE origins_animals ADD COLUMN IF NOT EXISTS hunger INTEGER NOT NULL DEFAULT 85`);
  await pool.query(`ALTER TABLE origins_animals ADD COLUMN IF NOT EXISTS thirst INTEGER NOT NULL DEFAULT 85`);
  await pool.query(`ALTER TABLE origins_animals ADD COLUMN IF NOT EXISTS health INTEGER NOT NULL DEFAULT 90`);
  await pool.query(`ALTER TABLE origins_animals ADD COLUMN IF NOT EXISTS cared_day INTEGER`);
  await pool.query(`UPDATE origins_animals SET cared_day=$1 WHERE cared_day IS NULL`,[worldDay()]);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_animal_encounters (
    id BIGSERIAL PRIMARY KEY,player_id BIGINT NOT NULL REFERENCES origins_players(id) ON DELETE CASCADE,
    expedition_id BIGINT UNIQUE, species VARCHAR(20) NOT NULL,
    sex CHAR(1) NOT NULL CHECK(sex IN ('M','F')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),resolved_at TIMESTAMPTZ,
    decision VARCHAR(16) CHECK(decision IN ('garder','abattre'))
  )`);
  await pool.query(`ALTER TABLE origins_animal_encounters ADD COLUMN IF NOT EXISTS biome VARCHAR(32)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_people (
    id BIGSERIAL PRIMARY KEY, player_id BIGINT REFERENCES origins_players(id) ON DELETE CASCADE,
    name VARCHAR(24) NOT NULL, age INTEGER NOT NULL DEFAULT 20,
    job VARCHAR(32) NOT NULL DEFAULT 'sans métier',
    mother_id BIGINT REFERENCES origins_people(id), father_id BIGINT REFERENCES origins_people(id),
    born_day INTEGER NOT NULL DEFAULT 1
  )`);
  // Migration V27 non destructive : âge actualisé au serveur, sans vieillir rétroactivement les tribus V26.
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS aged_at_day INTEGER`);
  await pool.query('UPDATE origins_people SET aged_at_day=$1 WHERE aged_at_day IS NULL',[worldDay()]);
  // V28 : migrations additives, sauvegardes V27 préservées.
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS hunger INTEGER NOT NULL DEFAULT 85`);
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS energy INTEGER NOT NULL DEFAULT 90`);
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS health INTEGER NOT NULL DEFAULT 100`);
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS home_building_id BIGINT`);
  // V29 : migrations non destructives : fondateurs et enfants modifiables, nouveaux arrivants verrouillés.
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS rename_allowed BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS training_until_day INTEGER`);
  await pool.query(`ALTER TABLE origins_people ADD COLUMN IF NOT EXISTS training_job VARCHAR(32)`);
  // Les deux premiers habitants de chaque tribu sont les fondateurs, y compris pour les anciennes sauvegardes.
  await pool.query(`WITH ranked AS (SELECT id, ROW_NUMBER() OVER(PARTITION BY player_id ORDER BY id) AS rn FROM origins_people) UPDATE origins_people p SET rename_allowed=TRUE FROM ranked r WHERE p.id=r.id AND r.rn<=2`);
  // Les personnes nées de deux parents connus restent renommables ; les arrivants sans filiation restent verrouillés.
  await pool.query(`UPDATE origins_people SET rename_allowed=TRUE WHERE mother_id IS NOT NULL AND father_id IS NOT NULL`);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_expeditions (
    id BIGSERIAL PRIMARY KEY, player_id BIGINT NOT NULL REFERENCES origins_players(id) ON DELETE CASCADE,
    x INTEGER NOT NULL,y INTEGER NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    outward_ms BIGINT NOT NULL, stay_ms BIGINT NOT NULL, return_ms BIGINT NOT NULL,
    completed_at TIMESTAMPTZ, CHECK(outward_ms>0 AND return_ms>0)
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS origins_encounter_expedition_unique ON origins_animal_encounters(expedition_id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS origins_one_active_expedition ON origins_expeditions(player_id) WHERE completed_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS origins_people_owner ON origins_people(player_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS origins_players_xy ON origins_players(x,y)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS origins_buildings_xy ON origins_buildings(x,y)`);
  // V37 : comptes indépendants des anciennes clés de village ; migrations non destructives.
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_accounts (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(254) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(12) NOT NULL DEFAULT 'player' CHECK(role IN ('player','admin')),
    player_id BIGINT UNIQUE REFERENCES origins_players(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`ALTER TABLE origins_accounts ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_admin_audit(id BIGSERIAL PRIMARY KEY, admin_account_id BIGINT NOT NULL REFERENCES origins_accounts(id), target_account_id BIGINT REFERENCES origins_accounts(id), action VARCHAR(32) NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await pool.query(`CREATE TABLE IF NOT EXISTS origins_account_sessions (
    id BIGSERIAL PRIMARY KEY,
    account_id BIGINT NOT NULL REFERENCES origins_accounts(id) ON DELETE CASCADE,
    token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS origins_sessions_account ON origins_account_sessions(account_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS origins_sessions_expiry ON origins_account_sessions(expires_at)`);
  if(ADMIN_EMAIL && emailOk(ADMIN_EMAIL) && passwordOk(ADMIN_PASSWORD)){
    const existing=await pool.query('SELECT id FROM origins_accounts WHERE email=$1',[ADMIN_EMAIL]);
    if(!existing.rowCount){const pwd=await passwordHash(ADMIN_PASSWORD);await pool.query("INSERT INTO origins_accounts(email,password_hash,role) VALUES($1,$2,'admin') ON CONFLICT (email) DO NOTHING",[ADMIN_EMAIL,pwd]);console.log('Compte administrateur initialisé');}
    else await pool.query("UPDATE origins_accounts SET role='admin' WHERE email=$1",[ADMIN_EMAIL]);
  }

}
async function sessionAccount(req){
 const token=(req.get('Authorization')||'').replace(/^Bearer\s+/i,'');
 if(!/^[0-9a-f]{64}$/.test(token))return null;
 const found=await pool.query(`SELECT a.id,a.email,a.role,a.player_id FROM origins_account_sessions s
 JOIN origins_accounts a ON a.id=s.account_id
 WHERE s.token_hash=$1 AND s.expires_at>now() AND a.suspended_at IS NULL`,[hash(token)]);
 return found.rows[0]||null;
}
async function auth(req,res,next){
 try{
  const token=(req.get('Authorization')||'').replace(/^Bearer\s+/i,'');
  if(!/^[0-9a-f]{64}$/.test(token))return res.status(401).json({error:'Session invalide'});
  const account=await sessionAccount(req);
  if(account){
   if(!account.player_id)return res.status(409).json({error:'Associe une tribu à ton compte avant de jouer'});
   req.account=account;
   const p=await pool.query('SELECT id,name,x,y FROM origins_players WHERE id=$1',[account.player_id]);
   if(!p.rows[0])return res.status(401).json({error:'Village introuvable'});
   req.player=p.rows[0];return next();
  }
  // Compatibilité : les clés V34-V36 restent valides pour récupérer son village.
  const q=await pool.query('SELECT id,name,x,y FROM origins_players WHERE token_hash=$1',[hash(token)]);
  if(!q.rows[0])return res.status(401).json({error:'Session inconnue'});
  req.player=q.rows[0];next();
 }catch(e){next(e)}
}
async function accountAuth(req,res,next){try{const a=await sessionAccount(req);if(!a)return res.status(401).json({error:'Compte non connecté'});req.account=a;next()}catch(e){next(e)}}
async function adminAuth(req,res,next){try{const a=await sessionAccount(req);if(!a||a.role!=='admin')return res.status(403).json({error:'Accès administrateur refusé'});req.account=a;next()}catch(e){next(e)}}
// V37 : inscription, connexion et rattachement explicite des anciennes tribus.
app.post('/api/accounts/register',throttle('register',6,60*60*1000),async(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(),password=req.body?.password;
 if(!emailOk(email)||!passwordOk(password))return res.status(400).json({error:'E-mail invalide ou mot de passe de moins de 12 caractères'});
 const key=String(req.body?.tribeKey||'').trim().toLowerCase();
 if(!/^[0-9a-f]{64}$/.test(key))return res.status(400).json({error:'Clé de tribu requise pour associer ta sauvegarde'});
 try{
  const village=(await pool.query('SELECT id FROM origins_players WHERE token_hash=$1',[hash(key)])).rows[0];
  if(!village)return res.status(404).json({error:'Clé de tribu introuvable'});
  const secret=await passwordHash(password);
  const a=await pool.query("INSERT INTO origins_accounts(email,password_hash,player_id) VALUES($1,$2,$3) RETURNING id,email,role,player_id",[email,secret,village.id]);
  // L'ancienne clé anonyme ne doit plus donner accès au village après rattachement.
  await pool.query('UPDATE origins_players SET token_hash=$2 WHERE id=$1',[village.id,hash(crypto.randomBytes(32).toString('hex'))]);
  const token=await issueSession(a.rows[0].id);res.status(201).json({token,account:a.rows[0]});
 }catch(e){if(e.code==='23505')return res.status(409).json({error:'E-mail déjà enregistré ou village déjà associé à un compte'});console.error(e);res.status(500).json({error:'Inscription impossible'})}
});
app.post('/api/accounts/login',throttle('login',15,15*60*1000),async(req,res)=>{
 const email=String(req.body?.email||'').trim().toLowerCase(),password=req.body?.password;
 if(!emailOk(email)||typeof password!=='string')return res.status(401).json({error:'Identifiants invalides'});
 const a=(await pool.query('SELECT * FROM origins_accounts WHERE email=$1',[email])).rows[0];
 if(!a||a.suspended_at||!await passwordVerify(password,a.password_hash))return res.status(401).json({error:'Identifiants invalides'});
 const token=await issueSession(a.id);res.json({token,account:{id:a.id,email:a.email,role:a.role,player_id:a.player_id}});
});
app.get('/api/accounts/me',accountAuth,(req,res)=>res.json({account:req.account}));
app.post('/api/accounts/claim',accountAuth,throttle('claim',8,60*60*1000),async(req,res)=>{
 const key=String(req.body?.tribeKey||'').trim().toLowerCase();
 if(!/^[0-9a-f]{64}$/.test(key))return res.status(400).json({error:'Clé de tribu invalide'});
 if(req.account.player_id)return res.status(409).json({error:'Ce compte possède déjà une tribu'});
 const p=(await pool.query('SELECT id FROM origins_players WHERE token_hash=$1',[hash(key)])).rows[0];
 if(!p)return res.status(404).json({error:'Clé de tribu introuvable'});
 try{await pool.query('UPDATE origins_accounts SET player_id=$1 WHERE id=$2 AND player_id IS NULL',[p.id,req.account.id]);await pool.query('UPDATE origins_players SET token_hash=$2 WHERE id=$1',[p.id,hash(crypto.randomBytes(32).toString('hex'))]);res.json({ok:true})}catch(e){if(e.code==='23505')return res.status(409).json({error:'Tribu déjà liée à un autre compte'});throw e}
});
app.post('/api/accounts/logout',accountAuth,async(req,res)=>{const raw=(req.get('Authorization')||'').replace(/^Bearer\s+/i,'');await pool.query('DELETE FROM origins_account_sessions WHERE token_hash=$1',[hash(raw)]);res.json({ok:true})});
app.get('/api/admin/overview',adminAuth,async(req,res)=>{
 const [players,accounts,people,buildings,animals]=await Promise.all([
  pool.query('SELECT COUNT(*)::int AS n FROM origins_players'),pool.query('SELECT COUNT(*)::int AS n FROM origins_accounts'),pool.query('SELECT COUNT(*)::int AS n FROM origins_people'),pool.query('SELECT COUNT(*)::int AS n FROM origins_buildings'),pool.query('SELECT COUNT(*)::int AS n FROM origins_animals')]);
 res.json({world:WORLD,players:players.rows[0].n,accounts:accounts.rows[0].n,people:people.rows[0].n,buildings:buildings.rows[0].n,animals:animals.rows[0].n});
});
app.get('/api/admin/accounts',adminAuth,async(req,res)=>{
 const rows=await pool.query('SELECT id,email,role,player_id,suspended_at,created_at FROM origins_accounts ORDER BY id DESC LIMIT 100');
 res.json({accounts:rows.rows});
});
app.post('/api/admin/accounts/:id/suspension',adminAuth,throttle('admin-action',25,60*1000),async(req,res)=>{
 const id=Number(req.params.id),suspended=req.body?.suspended;
 if(!Number.isSafeInteger(id)||id<1||typeof suspended!=='boolean')return res.status(400).json({error:'Paramètres invalides'});
 if(id===Number(req.account.id))return res.status(403).json({error:'Impossible de suspendre son propre compte'});
 const client=await pool.connect();try{
  await client.query('BEGIN');
  const a=(await client.query('SELECT id,role FROM origins_accounts WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!a){await client.query('ROLLBACK');return res.status(404).json({error:'Compte introuvable'})}
  if(a.role==='admin'){await client.query('ROLLBACK');return res.status(403).json({error:'Protection des autres administrateurs'})}
  await client.query('UPDATE origins_accounts SET suspended_at=$2 WHERE id=$1',[id,suspended?new Date():null]);
  if(suspended)await client.query('DELETE FROM origins_account_sessions WHERE account_id=$1',[id]);
  await client.query('INSERT INTO origins_admin_audit(admin_account_id,target_account_id,action) VALUES($1,$2,$3)',[req.account.id,id,suspended?'suspend':'restore']);
  await client.query('COMMIT');res.json({ok:true});
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
});
app.get('/api/admin/players',adminAuth,async(req,res)=>{
 const rows=await pool.query(`SELECT p.id,p.name,p.x,p.y,p.created_at,a.email AS account_email
 FROM origins_players p LEFT JOIN origins_accounts a ON a.player_id=p.id ORDER BY p.id DESC LIMIT 100`);
 res.json({players:rows.rows});
});
function validateCoord(x,y){return Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<WORLD&&y<WORLD;}
app.get('/api/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({ok:true,world:WORLD,version:37,day:worldDay(),season:season(),weather:weather()})}catch{res.status(503).json({ok:false})}});
app.post('/api/join',throttle('join',8,60*60*1000),async(req,res)=>{
  if(!nameOk(req.body?.name))return res.status(400).json({error:'Nom entre 2 et 25 caractères'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(894011)');
    const count=Number((await client.query('SELECT COUNT(*)::int AS n FROM origins_players')).rows[0].n);
    if(count>=2000){await client.query('ROLLBACK');return res.status(409).json({error:'Monde complet pour cette alpha'})}
    let x,y,found=false;
    for(let i=0;i<2000;i++){
      const ang=(count+i)*2.3999632297,r=35*Math.sqrt(count+i+1);
      x=Math.min(WORLD-60,Math.max(60,Math.round(WORLD/2+Math.cos(ang)*r)));
      y=Math.min(WORLD-60,Math.max(60,Math.round(WORLD/2+Math.sin(ang)*r)));
      if(terrain(x,y)==='water')continue;
      const near=await client.query('SELECT 1 FROM origins_players WHERE (x-$1)*(x-$1)+(y-$2)*(y-$2)<100 LIMIT 1',[x,y]);
      if(!near.rowCount){found=true;break}
    }
    if(!found){await client.query('ROLLBACK');return res.status(503).json({error:'Aucun emplacement disponible'})}
    const token=crypto.randomBytes(32).toString('hex');
    const p=(await client.query('INSERT INTO origins_players(name,token_hash,x,y) VALUES($1,$2,$3,$4) RETURNING id,name,x,y',[req.body.name.trim(),hash(token),x,y])).rows[0];
    const cells=[];for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(dx*dx+dy*dy<=5)cells.push([p.id,x+dx,y+dy]);
    for(const [id,a,b] of cells)await client.query('INSERT INTO origins_discoveries(player_id,x,y) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,a,b]);
    await client.query('INSERT INTO origins_buildings(player_id,x,y,kind) VALUES($1,$2,$3,$4)',[p.id,x,y,'chief']);
    await client.query(`UPDATE origins_players SET last_day=$2 WHERE id=$1`,[p.id,worldDay()]);
    await client.query(`INSERT INTO origins_people(player_id,name,age,job,born_day,aged_at_day) VALUES
      ($1,'Ada',24,'cueilleur',$2,$2),($1,'Noé',26,'bûcheron',$2,$2)`,[p.id,worldDay()]);
    await client.query('COMMIT');
    res.status(201).json({token,player:p,worldSize:WORLD});
  }catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Erreur serveur'})}finally{client.release()}
});
// Le serveur calcule les récoltes depuis la dernière visite : le navigateur ne peut pas fabriquer des ressources.
// Le rattrapage est plafonné à 14 jours pour limiter l'accumulation pendant l'absence.
const MEAT=Object.freeze({lapin:8,cochon:28,vache:40});
function capacity(pens){return pens*8}
// Chaque biome possède une faune plausible ; résultat déterministe pour éviter
// qu'un rafraîchissement de requête change une rencontre déjà attribuée.
const WILDLIFE_BY_BIOME=Object.freeze({
  grass:['lapin','lapin','cochon','vache'],drygrass:['lapin','cochon','vache'],
  forest:['lapin','cochon','cochon'],pine:['lapin','cochon'],rainforest:['cochon'],
  marsh:['cochon','lapin'],scrub:['lapin','cochon'],
  tundra:['lapin'],highland:['lapin','cochon'],rock:['lapin'],snowrock:['lapin'],
  desert:['lapin']
});
function encounterForTrip(trip){
  // Aucune rencontre de bétail en pleine mer : la navigation reste dédiée à l'exploration.
  const b=biome(Number(trip.x),Number(trip.y));
  const options=WILDLIFE_BY_BIOME[b]||[];
  if(!options.length)return null;
  const v=crypto.createHash('sha256').update(`wild:${trip.id}:${trip.x}:${trip.y}`).digest();
  if(v[0]>=110)return null;
  return {species:options[v[1]%options.length],sex:v[2]%2===0?'M':'F',biome:b};
}

async function syncVillage(id){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const player=(await client.query('SELECT * FROM origins_players WHERE id=$1 FOR UPDATE',[id])).rows[0];
    // Capture periodically using traps; each trapped rabbit is a persistent individual.
    // No retroactive flood: at most one rabbit per trap per server sync, capped by pens.
    const pens=Number((await client.query("SELECT COUNT(*)::int AS n FROM origins_buildings WHERE player_id=$1 AND kind='pen'",[id])).rows[0].n);
    const traps=Number((await client.query("SELECT COUNT(*)::int AS n FROM origins_buildings WHERE player_id=$1 AND kind='rabbit_trap'",[id])).rows[0].n);
    let animalCount=Number((await client.query('SELECT COUNT(*)::int AS n FROM origins_animals WHERE player_id=$1',[id])).rows[0].n);
    if(traps && pens && worldDay()-Number(player.last_trap_day)>=3){
      const slots=Math.max(0,capacity(pens)-animalCount),caught=Math.min(traps,slots,3);
      for(let n=0;n<caught;n++){
        const sex=(animalCount+n)%2===0?'F':'M';
        await client.query("INSERT INTO origins_animals(player_id,species,sex,created_day,source) VALUES($1,'lapin',$2,$3,'piège')",[id,sex,worldDay()]);
      }
      animalCount+=caught;
      await client.query('UPDATE origins_players SET last_trap_day=$2 WHERE id=$1',[id,worldDay()]);
    }
    const activeBreeder=(await client.query("SELECT 1 FROM origins_people WHERE player_id=$1 AND job='éleveur' AND age>=16 AND health>20 AND training_until_day IS NULL LIMIT 1",[id])).rowCount>0;
    // Besoins animaux : simules sur le serveur, maximum 14 jours de rattrapage.
    // L'éleveur apporte nourriture et eau, en consommant une petite quantité de réserve.
    const herdNeeds=(await client.query('SELECT id,hunger,thirst,health,cared_day FROM origins_animals WHERE player_id=$1 ORDER BY id FOR UPDATE',[id])).rows;
    let careFood=0;
    for(const a of herdNeeds){
      const days=Math.min(14,Math.max(0,worldDay()-Number(a.cared_day||worldDay())));
      if(!days)continue;
      const care=activeBreeder && player.food-careFood>=Math.ceil(days/3);
      if(care)careFood+=Math.ceil(days/3);
      const hunger=Math.max(0,Math.min(100,Number(a.hunger)+(care?5:-9)*days));
      const thirst=Math.max(0,Math.min(100,Number(a.thirst)+(care?6:-12)*days));
      const health=Math.max(0,Math.min(100,Number(a.health)+((hunger<25||thirst<25)?-6:care?2:0)*days));
      await client.query('UPDATE origins_animals SET hunger=$1,thirst=$2,health=$3,cared_day=$4 WHERE id=$5 AND player_id=$6',[hunger,thirst,health,worldDay(),a.id,id]);
    }
    if(careFood)await client.query('UPDATE origins_players SET food=GREATEST(0,food-$2) WHERE id=$1',[id,careFood]);
    // Simple breeding model: a pair of adults of the same species creates one offspring
    // per five world days; limited by enclosure capacity and total per-cycle births.
    if(pens && activeBreeder && worldDay()-Number(player.last_breed_day)>=3){
      const animals=(await client.query('SELECT species,sex,created_day,hunger,thirst,health FROM origins_animals WHERE player_id=$1',[id])).rows;
      let free=Math.max(0,capacity(pens)-animals.length);
      for(const species of ['lapin','cochon','vache']){
        if(!free)break;
        const herd=animals.filter(a=>a.species===species&&worldDay()-a.created_day>=5&&a.hunger>=35&&a.thirst>=35&&a.health>=50);
        if(herd.some(a=>a.sex==='M')&&herd.some(a=>a.sex==='F')){
          const sex=animals.length%2===0?'F':'M';
          await client.query('INSERT INTO origins_animals(player_id,species,sex,created_day,source) VALUES($1,$2,$3,$4,$5)',[id,species,sex,worldDay(),'naissance']);
          free--;
        }
      }
      await client.query('UPDATE origins_players SET last_breed_day=$2 WHERE id=$1',[id,worldDay()]);
    }
    // Une année de vie = 30 jours de jeu. Tous les changements d'âge sont transactionnels.
    await client.query(`UPDATE origins_people SET age=LEAST(99,age+FLOOR(GREATEST(0,$2-aged_at_day)/30)::int), aged_at_day=aged_at_day+30*FLOOR(GREATEST(0,$2-aged_at_day)/30)::int WHERE player_id=$1 AND aged_at_day IS NOT NULL`,[id,worldDay()]);
    // Terminer les formations une fois arrivées à échéance ; conserver leur date pour le calcul des récoltes.
    // Besoins : une mise à jour maximum par jour de jeu, plafonnée à 14 jours hors ligne.
    const people=(await client.query('SELECT id,name,age,job,mother_id,father_id,born_day,aged_at_day,hunger,energy,health,home_building_id,rename_allowed,training_until_day,training_job FROM origins_people WHERE player_id=$1 ORDER BY id',[id])).rows;
    const elapsed=Math.min(14,Math.max(0,worldDay()-player.last_day));
    const hasPort=Boolean((await client.query("SELECT 1 FROM origins_buildings WHERE player_id=$1 AND kind='port' LIMIT 1",[id])).rowCount);
    if(elapsed){
      const gain={wood:0,stone:0,food:0,knowledge:0};
      for(const person of people){
        const effectiveJob=person.training_until_day && person.training_until_day<=worldDay()?person.training_job:person.job;
        const activeDays=person.training_until_day ? Math.max(0,worldDay()-Math.max(Number(player.last_day),Number(person.training_until_day))) : elapsed;
        const key=production[effectiveJob];if(key && (effectiveJob!=='pêcheur'||hasPort))gain[key]+=activeDays*(effectiveJob==='chasseur'?2:effectiveJob==='pêcheur'?3:1);
      }
      // Un foyer/hutte protège les habitants ; météo défavorable augmente la fatigue.

      const finalFood=player.food+gain.food-people.length*elapsed;
      const feed=finalFood>=0;
      for(let i=0;i<people.length;i++){
        const person=people[i];
        const isChild=person.age<16;
        const underRoof=Boolean(person.home_building_id);
        let hunger=Math.max(0,Math.min(100,person.hunger+(feed?5:-13)*elapsed));
        // Travail plus fatigant, logement et repos améliorent la récupération.
        let energy=Math.max(0,Math.min(100,person.energy+(underRoof?4:-2)*elapsed-(isChild?0:person.job==='sans métier'?0:3)*elapsed));
        if(['Neige','Orage'].includes(weather().kind)&&!underRoof)energy=Math.max(0,energy-2*elapsed);
        let health=Math.max(0,Math.min(100,person.health+((hunger<25||energy<20)?-4:2)*elapsed));
        await client.query('UPDATE origins_people SET hunger=$1,energy=$2,health=$3 WHERE id=$4 AND player_id=$5',[hunger,energy,health,person.id,id]);
      }
      const cost=people.length*elapsed;
      await client.query(`UPDATE origins_players SET wood=LEAST(1000,wood+$2), stone=LEAST(1000,stone+$3),
        food=GREATEST(0,LEAST(1000,food+$4-$6)),knowledge=LEAST(1000,knowledge+$5),last_day=$7 WHERE id=$1`,
        [id,gain.wood,gain.stone,gain.food,gain.knowledge,cost,worldDay()]);
    }
    await client.query(`UPDATE origins_people SET job=training_job,training_job=NULL,training_until_day=NULL WHERE player_id=$1 AND training_until_day IS NOT NULL AND training_until_day<=$2`,[id,worldDay()]);
    const updated=(await client.query('SELECT wood,food,stone,knowledge,last_day,navigation_researched,boats FROM origins_players WHERE id=$1',[id])).rows[0];
    const currentPeople=(await client.query('SELECT id,name,age,job,mother_id,father_id,born_day,aged_at_day,hunger,energy,health,home_building_id,rename_allowed,training_until_day,training_job FROM origins_people WHERE player_id=$1 ORDER BY id',[id])).rows;
    const homes=(await client.query("SELECT id,x,y FROM origins_buildings WHERE player_id=$1 AND kind='hut' ORDER BY id",[id])).rows;
    // L'expédition ne révèle sa destination qu'une fois la durée aller + séjour + retour écoulée.
    const currentExp=(await client.query('SELECT * FROM origins_expeditions WHERE player_id=$1 AND completed_at IS NULL FOR UPDATE',[id])).rows[0];
    if(currentExp && Date.now()>=new Date(currentExp.started_at).getTime()+Number(currentExp.outward_ms)+Number(currentExp.stay_ms)+Number(currentExp.return_ms)){
      for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)if(validateCoord(currentExp.x+dx,currentExp.y+dy)&&dx*dx+dy*dy<=5){
        await client.query('INSERT INTO origins_discoveries(player_id,x,y) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,currentExp.x+dx,currentExp.y+dy]);
      }
      const wild=encounterForTrip(currentExp);
      if(wild){await client.query(`INSERT INTO origins_animal_encounters(player_id,expedition_id,species,sex,biome)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT (expedition_id) DO NOTHING`,[id,currentExp.id,wild.species,wild.sex,wild.biome]);}
      await client.query('UPDATE origins_expeditions SET completed_at=now() WHERE id=$1',[currentExp.id]);
    }
    const expedition=(await client.query('SELECT id,x,y,started_at,outward_ms,stay_ms,return_ms FROM origins_expeditions WHERE player_id=$1 AND completed_at IS NULL',[id])).rows[0]||null;
    const animals=(await client.query('SELECT id,species,sex,created_day,source,hunger,thirst,health FROM origins_animals WHERE player_id=$1 ORDER BY id',[id])).rows;
    const encounters=(await client.query('SELECT id,species,sex,biome,created_at FROM origins_animal_encounters WHERE player_id=$1 AND resolved_at IS NULL ORDER BY id LIMIT 5',[id])).rows;
    await client.query('COMMIT');
    return {resources:updated,people:currentPeople,homes,expedition,hasPort,animals,encounters,animalCapacity:capacity(pens),traps,activeBreeder,world:{day:worldDay(),season:season(),weather:weather()}};
  }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
app.get('/api/village',auth,async(req,res)=>res.json(await syncVillage(req.player.id)));
app.post('/api/rename',auth,throttle('rename',30,60*1000),async(req,res)=>{
  const id=Number(req.body?.id),name=req.body?.name?.trim();
  if(!Number.isSafeInteger(id)||!nameOk(name))return res.status(400).json({error:'Nom invalide (2 à 24 caractères)'});
  const r=await pool.query('UPDATE origins_people SET name=$1 WHERE id=$2 AND player_id=$3 AND rename_allowed=TRUE RETURNING id,name',[name,id,req.player.id]);
  if(!r.rowCount)return res.status(403).json({error:'Seuls les deux fondateurs et les enfants nés dans ta tribu peuvent être renommés'});
  res.json({person:r.rows[0]});
});
app.post('/api/job',auth,throttle('job',60,60*1000),async(req,res)=>{
  const id=Number(req.body?.id),job=req.body?.job;
  if(!Number.isSafeInteger(id)||!professions.includes(job))return res.status(400).json({error:'Métier invalide'});
  await syncVillage(req.player.id);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const person=(await client.query('SELECT * FROM origins_people WHERE id=$1 AND player_id=$2 FOR UPDATE',[id,req.player.id])).rows[0];
    if(!person||person.age<16)throw Object.assign(Error('Habitant introuvable ou trop jeune'),{status:400});
    if(person.training_until_day&&person.training_until_day>worldDay())throw Object.assign(Error('Cet habitant est déjà en formation'),{status:409});
    if(person.job===job)throw Object.assign(Error('Cet habitant exerce déjà ce métier'),{status:409});
    if(job==='éleveur' && !(await client.query("SELECT 1 FROM origins_buildings WHERE player_id=$1 AND kind='pen' LIMIT 1",[req.player.id])).rowCount)throw Object.assign(Error('Construis un enclos avant de former un éleveur'),{status:409});
    if(job==='pêcheur' && !(await client.query("SELECT 1 FROM origins_buildings WHERE player_id=$1 AND kind='port' LIMIT 1",[req.player.id])).rowCount)throw Object.assign(Error('Construis un port primitif avant de former un pêcheur'),{status:409});
    const until=job==='sans métier'?null:worldDay()+TRAINING_DAYS;
    const r=(await client.query('UPDATE origins_people SET job=$1,training_job=$2,training_until_day=$3 WHERE id=$4 RETURNING id,name,job,training_job,training_until_day',['sans métier',until?job:null,until,id])).rows[0];
    await client.query('COMMIT');res.json({person:r,training_days:until?TRAINING_DAYS:0});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Erreur affectation'})}finally{client.release()}
});
// Prototype de naissance : exige deux adultes distincts de la même tribu, une hutte et de la nourriture.
// La parenté complexe et la mortalité arriveront avec la simulation des générations.
app.post('/api/birth',auth,throttle('birth',15,60*60*1000),async(req,res)=>{
  const a=Number(req.body?.mother),b=Number(req.body?.father);
  if(!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a===b)return res.status(400).json({error:'Deux parents distincts requis'});
  await syncVillage(req.player.id);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const p=(await client.query('SELECT food FROM origins_players WHERE id=$1 FOR UPDATE',[req.player.id])).rows[0];
    const people=(await client.query('SELECT id,name,mother_id,father_id,age,training_until_day FROM origins_people WHERE player_id=$1 ORDER BY id',[req.player.id])).rows;
    const ma=people.find(q=>Number(q.id)===a),fa=people.find(q=>Number(q.id)===b);
    if(!ma||!fa||ma.age<18||fa.age<18)throw Object.assign(Error('Parents adultes requis'),{status:400});
    if([ma,fa].some(p=>p.training_until_day&&p.training_until_day>worldDay()))throw Object.assign(Error('Un parent est en formation et indisponible'),{status:409});
    // Interdit parents/enfants et fratrie; un arbre généalogique complet viendra plus tard.
    const isParent=(child,parent)=>[child.mother_id,child.father_id].some(z=>z&&String(z)===String(parent.id));
    const siblings=[ma.mother_id,ma.father_id].some(z=>z&&[fa.mother_id,fa.father_id].some(t=>t&&String(t)===String(z)));
    if(isParent(ma,fa)||isParent(fa,ma)||siblings)throw Object.assign(Error('Parenté proche interdite'),{status:400});
    const cooldown=await client.query('SELECT 1 FROM origins_people WHERE player_id=$1 AND mother_id=$2 AND father_id=$3 AND born_day>$4 LIMIT 1',[req.player.id,a,b,worldDay()-5]);
    if(cooldown.rowCount)throw Object.assign(Error('Attends 5 jours de jeu entre deux naissances'),{status:409});
    if(people.length>=30)throw Object.assign(Error('Maximum de 30 habitants pour cette alpha'),{status:409});
    const huts=Number((await client.query(`SELECT COUNT(*) FROM origins_buildings WHERE player_id=$1 AND kind='hut'`,[req.player.id])).rows[0].count);
    if(huts<1||p.food<20)throw Object.assign(Error('Il faut une hutte et 20 nourritures'),{status:409});
    await client.query('UPDATE origins_players SET food=food-20 WHERE id=$1',[req.player.id]);
    const babyName=req.body?.name?.trim()||'Enfant '+(people.length-1);
    if(!nameOk(babyName))throw Object.assign(Error('Prénom invalide (2 à 24 caractères)'),{status:400});
    const baby=(await client.query('INSERT INTO origins_people(player_id,name,age,mother_id,father_id,born_day,aged_at_day,rename_allowed) VALUES ($1,$2,0,$3,$4,$5,$5,TRUE) RETURNING *',
      [req.player.id,babyName,a,b,worldDay()])).rows[0];
    await client.query('COMMIT');res.status(201).json({person:baby});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Erreur naissance'})}finally{client.release()}
});
app.post('/api/housing',auth,throttle('housing',60,60*1000),async(req,res)=>{
  const id=Number(req.body?.id),home=req.body?.home===null?null:Number(req.body?.home);
  if(!Number.isSafeInteger(id)||(home!==null&&!Number.isSafeInteger(home)))return res.status(400).json({error:'Logement invalide'});
  if(home!==null){
    const h=await pool.query("SELECT id FROM origins_buildings WHERE id=$1 AND player_id=$2 AND kind='hut'",[home,req.player.id]);
    if(!h.rowCount)return res.status(404).json({error:'Cette hutte ne t’appartient pas'});
    const occupants=await pool.query('SELECT COUNT(*)::int AS total FROM origins_people WHERE player_id=$1 AND home_building_id=$2 AND id<>$3',[req.player.id,home,id]);
    if(occupants.rows[0].total>=3)return res.status(409).json({error:'Hutte complète (3 habitants maximum)'});
  }
  const r=await pool.query('UPDATE origins_people SET home_building_id=$1 WHERE id=$2 AND player_id=$3 RETURNING id,name,home_building_id',[home,id,req.player.id]);
  if(!r.rowCount)return res.status(404).json({error:'Habitant introuvable'});
  res.json({person:r.rows[0]});
});
// Resolve an expedition encounter once. All rewards and enclosure checks are transactional.
app.post('/api/encounter/decide',auth,throttle('encounter',20,60*1000),async(req,res)=>{
  const eid=Number(req.body?.id),decision=req.body?.decision;
  if(!Number.isSafeInteger(eid)||!['garder','abattre'].includes(decision))return res.status(400).json({error:'Choix invalide'});
  await syncVillage(req.player.id);
  const client=await pool.connect();
  try{await client.query('BEGIN');
    await client.query('SELECT id FROM origins_players WHERE id=$1 FOR UPDATE',[req.player.id]);
    const event=(await client.query('SELECT * FROM origins_animal_encounters WHERE id=$1 AND player_id=$2 AND resolved_at IS NULL FOR UPDATE',[eid,req.player.id])).rows[0];
    if(!event)throw Object.assign(Error('Rencontre déjà traitée ou introuvable'),{status:409});
    if(decision==='garder'){
      const pens=Number((await client.query("SELECT COUNT(*)::int AS n FROM origins_buildings WHERE player_id=$1 AND kind='pen'",[req.player.id])).rows[0].n);
      const count=Number((await client.query('SELECT COUNT(*)::int AS n FROM origins_animals WHERE player_id=$1',[req.player.id])).rows[0].n);
      if(!pens||count>=capacity(pens))throw Object.assign(Error('Construis un enclos avec de la place pour ramener cet animal vivant'),{status:409});
      await client.query('INSERT INTO origins_animals(player_id,species,sex,created_day,source) VALUES($1,$2,$3,$4,$5)',[req.player.id,event.species,event.sex,worldDay(),'expédition']);
    }else{
      await client.query('UPDATE origins_players SET food=LEAST(1000,food+$2) WHERE id=$1',[req.player.id,MEAT[event.species]]);
    }
    await client.query('UPDATE origins_animal_encounters SET resolved_at=now(),decision=$2 WHERE id=$1',[eid,decision]);
    await client.query('COMMIT');res.json({decision,species:event.species,food:decision==='abattre'?MEAT[event.species]:0});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Impossible de traiter la rencontre'})}finally{client.release()}
});
// V33: soins manuels : commande cote serveur, depense reelle et atomique.
app.post('/api/animals/care',auth,throttle('animal-care',25,60*1000),async(req,res)=>{
  const id=Number(req.body?.id);
  if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Animal invalide'});
  await syncVillage(req.player.id);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const owner=(await client.query('SELECT food FROM origins_players WHERE id=$1 FOR UPDATE',[req.player.id])).rows[0];
    const a=(await client.query('SELECT id,hunger,thirst,health FROM origins_animals WHERE id=$1 AND player_id=$2 FOR UPDATE',[id,req.player.id])).rows[0];
    if(!a)throw Object.assign(Error('Animal introuvable'),{status:404});
    if(Number(owner.food)<3)throw Object.assign(Error('Il faut 3 nourritures pour soigner cet animal'),{status:409});
    await client.query('UPDATE origins_players SET food=food-3 WHERE id=$1',[req.player.id]);
    await client.query('UPDATE origins_animals SET hunger=LEAST(100,hunger+25),thirst=LEAST(100,thirst+25),health=LEAST(100,health+12) WHERE id=$1',[id]);
    await client.query('COMMIT');res.json({ok:true,cost:{food:3}});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Soin impossible'});}finally{client.release()}
});
// Voluntary slaughter converts a domesticated animal into food and frees a pen slot.
app.post('/api/animals/slaughter',auth,throttle('slaughter',30,60*1000),async(req,res)=>{
  const id=Number(req.body?.id);if(!Number.isSafeInteger(id))return res.status(400).json({error:'Animal invalide'});
  await syncVillage(req.player.id);const client=await pool.connect();
  try{await client.query('BEGIN');await client.query('SELECT id FROM origins_players WHERE id=$1 FOR UPDATE',[req.player.id]);
    const a=(await client.query('DELETE FROM origins_animals WHERE id=$1 AND player_id=$2 RETURNING id,species,sex',[id,req.player.id])).rows[0];
    if(!a)throw Object.assign(Error('Animal introuvable'),{status:404});
    await client.query('UPDATE origins_players SET food=LEAST(1000,food+$2) WHERE id=$1',[req.player.id,MEAT[a.species]]);
    await client.query('COMMIT');res.json({animal:a,food:MEAT[a.species]});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Erreur élevage'})}finally{client.release()}
});
app.get('/api/config',(req,res)=>res.json({version:37,worldSize:WORLD,chunkSize:CHUNK,costs:COSTS,navigationCost:25,boatCost:{wood:35,stone:8},features:['economy','timed-roundtrip-expeditions','training','restricted-rename','exploration','jobs','births','seasons','terrain3d','biomes','aging','genealogy','villagers3d','needs','weather','housing','ui28','ui29','fishing','primitive-port','boat-research','sea-expeditions','animal-traps','enclosures','breeding','expedition-wildlife-choices','breeder-profession','biome-wildlife','placement-preview-confirmation','animal-needs','animal-care','animated-herds','contextual-codex']}));
app.get('/api/me',auth,async(req,res)=>{const p=req.player;const explored=(await pool.query('SELECT x,y FROM origins_discoveries WHERE player_id=$1 ORDER BY x,y LIMIT 30000',[p.id])).rows;const buildings=(await pool.query('SELECT id,x,y,kind FROM origins_buildings WHERE player_id=$1',[p.id])).rows;res.json({player:p,explored,buildings,worldSize:WORLD})});
app.get('/api/chunk',auth,async(req,res)=>{
  const cx=Number(req.query.cx),cy=Number(req.query.cy);
  if(!Number.isInteger(cx)||!Number.isInteger(cy)||cx<0||cy<0||cx>=WORLD/CHUNK||cy>=WORLD/CHUNK)return res.status(400).json({error:'Zone invalide'});
  const x0=cx*CHUNK,y0=cy*CHUNK;
  // Ne jamais révéler les implantations des autres joueurs hors du brouillard de guerre.
  const discovered=(await pool.query('SELECT x,y FROM origins_discoveries WHERE player_id=$1 AND x BETWEEN $2 AND $3 AND y BETWEEN $4 AND $5',[req.player.id,x0,x0+31,y0,y0+31])).rows;
  const visible=new Set(discovered.map(d=>d.x+','+d.y));
  const settlements=(await pool.query('SELECT id,name,x,y FROM origins_players WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4 LIMIT 80',[x0,x0+CHUNK-1,y0,y0+CHUNK-1])).rows.filter(p=>visible.has(p.x+','+p.y));
  const buildings=(await pool.query('SELECT player_id,x,y,kind FROM origins_buildings WHERE x BETWEEN $1 AND $2 AND y BETWEEN $3 AND $4 LIMIT 500',[x0,x0+CHUNK-1,y0,y0+CHUNK-1])).rows.filter(p=>visible.has(p.x+','+p.y));
  const types=[],heights=[];
  for(let y=y0;y<y0+CHUNK;y++){
    const row=[],rise=[];
    for(let x=x0;x<x0+CHUNK;x++){row.push(biome(x,y));rise.push(elevation(x,y));}
    types.push(row);heights.push(rise);
  }
  res.json({cx,cy,types,heights,settlements,buildings,discovered});
});
// Recherche et construction navale : toutes les dépenses sont validées en base sous verrou.
app.post('/api/research/navigation',auth,throttle('research',15,60*1000),async(req,res)=>{
  await syncVillage(req.player.id);const client=await pool.connect();
  try{await client.query('BEGIN');const p=(await client.query('SELECT knowledge,navigation_researched FROM origins_players WHERE id=$1 FOR UPDATE',[req.player.id])).rows[0];
    if(p.navigation_researched)throw Object.assign(Error('Navigation primitive déjà recherchée'),{status:409});
    if(p.knowledge<25)throw Object.assign(Error('Il faut 25 points de savoir pour découvrir la navigation primitive'),{status:409});
    await client.query('UPDATE origins_players SET knowledge=knowledge-25,navigation_researched=TRUE WHERE id=$1',[req.player.id]);
    await client.query('COMMIT');res.json({navigation_researched:true});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Recherche impossible'})}finally{client.release()}
});
app.post('/api/boat',auth,throttle('boat',20,60*1000),async(req,res)=>{
  await syncVillage(req.player.id);const client=await pool.connect();
  try{await client.query('BEGIN');const p=(await client.query('SELECT wood,stone,navigation_researched,boats FROM origins_players WHERE id=$1 FOR UPDATE',[req.player.id])).rows[0];
    if(!p.navigation_researched)throw Object.assign(Error('Recherche Navigation primitive nécessaire'),{status:403});
    if(!(await client.query("SELECT 1 FROM origins_buildings WHERE player_id=$1 AND kind='port' LIMIT 1",[req.player.id])).rowCount)throw Object.assign(Error('Construis un port primitif avant un bateau'),{status:403});
    if(p.boats>=3)throw Object.assign(Error('Maximum 3 bateaux pour cette alpha'),{status:409});
    if(p.wood<35||p.stone<8)throw Object.assign(Error('Bateau : 35 bois et 8 pierre nécessaires'),{status:409});
    const result=(await client.query('UPDATE origins_players SET wood=wood-35,stone=stone-8,boats=boats+1 WHERE id=$1 RETURNING boats',[req.player.id])).rows[0];
    await client.query('COMMIT');res.json({boats:result.boats});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Construction du bateau impossible'})}finally{client.release()}
});
app.post('/api/explore',auth,throttle('explore',20,60*1000),async(req,res)=>{
  const x=req.body?.x,y=req.body?.y,p=req.player;
  if(!validateCoord(x,y))return res.status(400).json({error:'Coordonnées invalides'});
  await syncVillage(p.id);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT id FROM origins_players WHERE id=$1 FOR UPDATE',[p.id]);
    const active=await client.query('SELECT 1 FROM origins_expeditions WHERE player_id=$1 AND completed_at IS NULL',[p.id]);
    if(active.rowCount)throw Object.assign(Error('Une expédition est déjà en cours. Attends son retour.'),{status:409});
    const sea=terrain(x,y)==='water';
    const owner=(await client.query('SELECT navigation_researched,boats FROM origins_players WHERE id=$1',[p.id])).rows[0];
    if(sea){
      if(!owner.navigation_researched||owner.boats<1)throw Object.assign(Error('Pour explorer la mer, recherche la navigation et construis un bateau au port'),{status:403});
      if(!(await client.query("SELECT 1 FROM origins_buildings WHERE player_id=$1 AND kind='port' LIMIT 1",[p.id])).rowCount)throw Object.assign(Error('Un port est nécessaire aux expéditions maritimes'),{status:403});
      // Un trajet en mer peut partir d'une côte découverte ou d'une autre case maritime découverte.
      const reachable=(await client.query('SELECT x,y FROM origins_discoveries WHERE player_id=$1 AND ABS(x-$2)<=8 AND ABS(y-$3)<=8',[p.id,x,y])).rows.some(q=>Math.hypot(q.x-x,q.y-y)<=8 && (terrain(q.x,q.y)==='water'||Math.abs(q.x-x)+Math.abs(q.y-y)<=3));
      if(!reachable)throw Object.assign(Error('La destination maritime doit être proche d’une côte ou mer déjà explorée (8 cases)'),{status:403});
    }else{
      const known=(await client.query('SELECT x,y FROM origins_discoveries WHERE player_id=$1 AND ABS(x-$2)<=2 AND ABS(y-$3)<=2',[p.id,x,y])).rows;
      if(!known.length)throw Object.assign(Error('Explore une zone voisine du territoire découvert'),{status:403});
    }
    const already=await client.query('SELECT 1 FROM origins_discoveries WHERE player_id=$1 AND x=$2 AND y=$3',[p.id,x,y]);
    if(already.rowCount)throw Object.assign(Error('Cette parcelle est déjà connue'),{status:409});
    const distance=Math.max(1,Math.ceil(Math.hypot(x-p.x,y-p.y)));
    const eachLeg=Math.max(60*1000,Math.min(20*60*1000,distance*EXPEDITION_MS_PER_TILE*(sea?0.65:1)));
    const stay=60*1000;
    const trip=(await client.query('INSERT INTO origins_expeditions(player_id,x,y,outward_ms,stay_ms,return_ms) VALUES($1,$2,$3,$4,$5,$4) RETURNING *',[p.id,x,y,eachLeg,stay])).rows[0];
    await client.query('COMMIT');res.status(202).json({expedition:trip,message:sea?'Expédition maritime lancée : navigation aller et retour':'Expédition terrestre lancée : aller et retour'});
  }catch(e){await client.query('ROLLBACK');res.status(e.status||500).json({error:e.status?e.message:'Impossible de lancer l’expédition'})}finally{client.release()}
});
app.post('/api/build',auth,throttle('build',60,60*1000),async(req,res)=>{
  const x=req.body?.x,y=req.body?.y,kind=req.body?.kind,cost=COSTS[kind];
  if(!validateCoord(x,y)||!Object.prototype.hasOwnProperty.call(COSTS,kind))return res.status(400).json({error:'Bâtiment ou emplacement invalide'});
  if(terrain(x,y)==='water')return res.status(400).json({error:'Construction impossible sur eau : place le port sur la côte'});
  if(kind==='rabbit_trap' && !['forest','grass'].includes(terrain(x,y)))return res.status(400).json({error:'Le piège à lapin doit être posé dans une forêt ou une plaine'});
  if(kind==='port' && ![[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy])=>validateCoord(x+dx,y+dy)&&terrain(x+dx,y+dy)==='water'))return res.status(400).json({error:'Le port doit être placé sur une terre adjacente à la mer'});
  await syncVillage(req.player.id);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const player=(await client.query('SELECT wood,stone,food FROM origins_players WHERE id=$1 FOR UPDATE',[req.player.id])).rows[0];
    const explored=await client.query('SELECT 1 FROM origins_discoveries WHERE player_id=$1 AND x=$2 AND y=$3',[req.player.id,x,y]);
    if(!explored.rowCount)throw Object.assign(new Error('Terrain non découvert'),{status:403});
    if(kind==='rabbit_trap'||kind==='pen'){const n=Number((await client.query('SELECT COUNT(*)::int AS n FROM origins_buildings WHERE player_id=$1 AND kind=$2',[req.player.id,kind])).rows[0].n);if(n>=10)throw Object.assign(Error('Maximum dix constructions de ce type par tribu'),{status:409});}
    const occupied=await client.query('SELECT 1 FROM origins_buildings WHERE x=$1 AND y=$2',[x,y]);
    if(occupied.rowCount)throw Object.assign(new Error('Parcelle occupée'),{status:409});
    if(player.wood<cost.wood||player.stone<cost.stone||player.food<cost.food)throw Object.assign(new Error('Ressources insuffisantes : '+cost.wood+' bois, '+cost.stone+' pierre, '+cost.food+' nourriture'),{status:409});
    await client.query('UPDATE origins_players SET wood=wood-$2,stone=stone-$3,food=food-$4 WHERE id=$1',[req.player.id,cost.wood,cost.stone,cost.food]);
    const building=(await client.query('INSERT INTO origins_buildings(player_id,x,y,kind) VALUES($1,$2,$3,$4) RETURNING id,x,y,kind',[req.player.id,x,y,kind])).rows[0];
    await client.query('COMMIT');
    res.status(201).json({building,cost});
  }catch(e){await client.query('ROLLBACK');if(e.code==='23505')return res.status(409).json({error:'Parcelle occupée'});if(e.status)return res.status(e.status).json({error:e.message});throw e}
  finally{client.release()}
});
app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Erreur interne'})});
await init();app.listen(PORT,'0.0.0.0',()=>console.log(`Origins MMO alpha listening on ${PORT}`));
