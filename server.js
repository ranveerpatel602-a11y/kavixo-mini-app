import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 8080);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
});
app.use(express.json({ limit: '32kb' }));

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kvxn_users (
      telegram_id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL DEFAULT 'Explorer',
      balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE kvxn_users ADD COLUMN IF NOT EXISTS mining_remainder NUMERIC(12,3) NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS mining_sessions (
      id BIGSERIAL PRIMARY KEY,
      telegram_id TEXT NOT NULL REFERENCES kvxn_users(telegram_id),
      rate NUMERIC(12,6) NOT NULL DEFAULT 0.025,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      elapsed_seconds BIGINT NOT NULL DEFAULT 0,
      points_credited BIGINT NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS mining_one_active_session_per_user ON mining_sessions(telegram_id) WHERE status='active';
    CREATE TABLE IF NOT EXISTS referrals (
      id BIGSERIAL PRIMARY KEY,
      inviter_telegram_id TEXT NOT NULL REFERENCES kvxn_users(telegram_id),
      invitee_telegram_id TEXT NOT NULL UNIQUE REFERENCES kvxn_users(telegram_id),
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (inviter_telegram_id <> invitee_telegram_id)
    );
    CREATE INDEX IF NOT EXISTS referrals_inviter_idx ON referrals(inviter_telegram_id, joined_at DESC);
    CREATE TABLE IF NOT EXISTS redeem_codes (
      code TEXT PRIMARY KEY,
      points INTEGER NOT NULL CHECK (points > 0),
      max_claims INTEGER,
      claims_count INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS redeem_claims (
      id BIGSERIAL PRIMARY KEY,
      code TEXT NOT NULL REFERENCES redeem_codes(code),
      telegram_id TEXT NOT NULL REFERENCES kvxn_users(telegram_id),
      points INTEGER NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(code, telegram_id)
    );
    CREATE TABLE IF NOT EXISTS app_missions (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      reward INTEGER NOT NULL CHECK (reward > 0),
      icon TEXT NOT NULL DEFAULT 'users',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO app_missions(title,description,reward,icon)
    SELECT v.title,v.description,v.reward,v.icon FROM (VALUES
      ('Join KAVIXO Community','Meet the explorers building our universe.',250,'users'),
      ('Follow project updates','Stay up to date with announcements.',150,'send'),
      ('Explore KAVIXO roadmap','Discover upcoming project milestones.',100,'route')
    ) AS v(title,description,reward,icon)
    WHERE NOT EXISTS (SELECT 1 FROM app_missions);
    CREATE TABLE IF NOT EXISTS channel_claims (
      id BIGSERIAL PRIMARY KEY,
      channel_id BIGINT NOT NULL REFERENCES community_channels(id) ON DELETE CASCADE,
      telegram_id TEXT NOT NULL REFERENCES kvxn_users(telegram_id),
      reward INTEGER NOT NULL DEFAULT 100,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(channel_id,telegram_id)
    );
    CREATE TABLE IF NOT EXISTS mission_claims (
      id BIGSERIAL PRIMARY KEY,
      mission_id BIGINT NOT NULL REFERENCES app_missions(id) ON DELETE CASCADE,
      telegram_id TEXT NOT NULL REFERENCES kvxn_users(telegram_id),
      reward INTEGER NOT NULL,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(mission_id,telegram_id)
    );
    CREATE TABLE IF NOT EXISTS admin_balance_adjustments (
      id BIGSERIAL PRIMARY KEY,
      admin_telegram_id TEXT NOT NULL REFERENCES kvxn_users(telegram_id),
      target_telegram_id TEXT NOT NULL REFERENCES kvxn_users(telegram_id),
      delta BIGINT NOT NULL CHECK (delta <> 0),
      balance_after BIGINT NOT NULL CHECK (balance_after >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS community_channels (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL CHECK (platform IN ('telegram','youtube')),
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

function parseTelegramInitData(initData) {
  if (!initData || !process.env.BOT_TOKEN) throw new Error('Telegram authentication is not configured');
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) throw new Error('Invalid Telegram session');
  params.delete('hash');
  const dataCheckString = [...params.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(process.env.BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calculated, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Telegram session verification failed');
  const authDate = Number(params.get('auth_date') || 0);
  if (!authDate || Math.abs(Date.now()/1000 - authDate) > 86400) throw new Error('Telegram session expired. Reopen the app.');
  const user = JSON.parse(params.get('user') || 'null');
  if (!user?.id) throw new Error('Telegram user not found');
  return { id: String(user.id), firstName: String(user.first_name || 'Explorer').slice(0,80), startParam: String(params.get('start_param') || '') };
}

async function auth(req,res,next) {
  try {
    const raw = req.get('x-telegram-init-data') || req.body?.initData;
    req.tgUser = parseTelegramInitData(raw);
    await pool.query(
      'INSERT INTO kvxn_users(telegram_id,first_name) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name',
      [req.tgUser.id, req.tgUser.firstName]
    );
    const match = /^ref_(\d+)$/.exec(req.tgUser.startParam || '');
    if (match && match[1] !== req.tgUser.id) {
      await pool.query('INSERT INTO referrals(inviter_telegram_id,invitee_telegram_id) VALUES($1,$2) ON CONFLICT(invitee_telegram_id) DO NOTHING',[match[1],req.tgUser.id]);
    }
    next();
  } catch (e) { res.status(401).json({ error: e.message || 'Authentication required' }); }
}
function admin(req,res,next) {
  const allowed = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x=>x.trim()).filter(Boolean);
  if (!allowed.includes(req.tgUser.id)) return res.status(403).json({ error: 'Admin access denied' });
  next();
}
function cleanCode(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g,'').slice(0,40);
}

app.get('/api/health', (_req,res) => res.json({ ok:true }));
app.get('/api/me', auth, async (req,res) => {
  const [userResult, miningResult] = await Promise.all([
    pool.query('SELECT telegram_id,first_name,balance FROM kvxn_users WHERE telegram_id=$1',[req.tgUser.id]),
    pool.query("SELECT started_at,rate FROM mining_sessions WHERE telegram_id=$1 AND status='active' ORDER BY id DESC LIMIT 1",[req.tgUser.id])
  ]);
  const allowed = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x=>x.trim()).filter(Boolean);
  const active = miningResult.rows[0];
  res.json({ user: userResult.rows[0], isAdmin: allowed.includes(req.tgUser.id), activeMining: active ? { startedAt: active.started_at, rate: Number(active.rate) } : null });
});
app.post('/api/mining/start', auth, async (req,res) => {
  try {
    await pool.query("INSERT INTO mining_sessions(telegram_id,rate) VALUES($1,0.025) ON CONFLICT DO NOTHING",[req.tgUser.id]);
    const {rows}=await pool.query("SELECT started_at,rate FROM mining_sessions WHERE telegram_id=$1 AND status='active' ORDER BY id DESC LIMIT 1",[req.tgUser.id]);
    if(!rows[0]) return res.status(409).json({error:'Could not start mining. Please try again.'});
    res.json({ok:true,startedAt:rows[0].started_at,rate:Number(rows[0].rate)});
  } catch(e) { res.status(500).json({error:'Could not start mining'}); }
});
app.post('/api/mining/stop', auth, async (req,res) => {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const found=await client.query("SELECT id,started_at,rate FROM mining_sessions WHERE telegram_id=$1 AND status='active' ORDER BY id DESC LIMIT 1 FOR UPDATE",[req.tgUser.id]);
    if(!found.rowCount) {
      const current=await client.query('SELECT balance FROM kvxn_users WHERE telegram_id=$1',[req.tgUser.id]);
      await client.query('COMMIT');
      return res.json({ok:true,creditedPoints:0,balance:current.rows[0]?.balance ?? 0});
    }
    const session=found.rows[0];
    const elapsed=Math.max(0,Math.floor((Date.now()-new Date(session.started_at).getTime())/1000));
    const user=await client.query('SELECT balance,mining_remainder FROM kvxn_users WHERE telegram_id=$1 FOR UPDATE',[req.tgUser.id]);
    const raw=elapsed*Number(session.rate)+Number(user.rows[0].mining_remainder||0);
    const credited=Math.floor(raw+1e-9);
    const remainder=Number((raw-credited).toFixed(3));
    const updated=await client.query('UPDATE kvxn_users SET balance=balance+$1::bigint,mining_remainder=$2 WHERE telegram_id=$3 RETURNING balance',[credited,remainder,req.tgUser.id]);
    await client.query("UPDATE mining_sessions SET status='completed',ended_at=NOW(),elapsed_seconds=$1,points_credited=$2 WHERE id=$3",[elapsed,credited,session.id]);
    await client.query('COMMIT');
    res.json({ok:true,elapsedSeconds:elapsed,creditedPoints:credited,balance:updated.rows[0].balance});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({error:'Could not credit mining rewards. Your active session is preserved; please retry.'});
  } finally { client.release(); }
});

app.post('/api/redeem', auth, async (req,res) => {
  const code = cleanCode(req.body?.code);
  if (!code) return res.status(400).json({ error:'Enter a redeem code' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT * FROM redeem_codes WHERE code=$1 FOR UPDATE',[code]);
    const item = found.rows[0];
    if (!item || !item.active) throw new Error('Invalid or inactive redeem code');
    if (item.expires_at && new Date(item.expires_at).getTime() < Date.now()) throw new Error('This redeem code has expired');
    if (item.max_claims !== null && item.claims_count >= item.max_claims) throw new Error('This redeem code has reached its claim limit');
    const already = await client.query('SELECT 1 FROM redeem_claims WHERE code=$1 AND telegram_id=$2',[code,req.tgUser.id]);
    if (already.rowCount) throw new Error('You have already claimed this code');
    await client.query('INSERT INTO redeem_claims(code,telegram_id,points) VALUES($1,$2,$3)',[code,req.tgUser.id,item.points]);
    const updated = await client.query('UPDATE kvxn_users SET balance=balance+$1 WHERE telegram_id=$2 RETURNING balance',[item.points,req.tgUser.id]);
    await client.query('UPDATE redeem_codes SET claims_count=claims_count+1 WHERE code=$1',[code]);
    await client.query('COMMIT');
    res.json({ ok:true, points:item.points, balance:updated.rows[0].balance });
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error:e.message || 'Could not claim code' });
  } finally { client.release(); }
});

app.get('/api/referrals', auth, async (req,res) => {
  const [items,total] = await Promise.all([
    pool.query('SELECT r.invitee_telegram_id AS telegram_id,u.first_name,r.joined_at FROM referrals r JOIN kvxn_users u ON u.telegram_id=r.invitee_telegram_id WHERE r.inviter_telegram_id=$1 ORDER BY r.joined_at DESC LIMIT 100',[req.tgUser.id]),
    pool.query('SELECT COUNT(*)::int AS total FROM referrals WHERE inviter_telegram_id=$1',[req.tgUser.id])
  ]);
  res.json({referrals:items.rows,total:total.rows[0].total});
});

app.get('/api/leaderboard', async (_req,res) => {
  const [users,total] = await Promise.all([
    pool.query('SELECT ROW_NUMBER() OVER (ORDER BY balance DESC, created_at ASC) AS rank, first_name, balance FROM kvxn_users WHERE balance > 0 ORDER BY balance DESC, created_at ASC LIMIT 50'),
    pool.query('SELECT COUNT(*)::int AS total FROM kvxn_users')
  ]);
  res.json({ users:users.rows, totalUsers:total.rows[0].total });
});
app.get('/api/admin/users', auth, admin, async (req,res) => {
  const search=String(req.query.search||'').trim().slice(0,80);
  const values=[];
  let where='';
  if(search){values.push('%'+search+'%');where='WHERE first_name ILIKE $1 OR telegram_id ILIKE $1';}
  const {rows}=await pool.query(`SELECT telegram_id,first_name,balance,created_at FROM kvxn_users ${where} ORDER BY balance DESC, created_at ASC LIMIT 100`,values);
  res.json({users:rows});
});
app.patch('/api/admin/users/:telegramId/balance', auth, admin, async (req,res) => {
  const target=String(req.params.telegramId||'').trim();
  const delta=Number(req.body?.delta);
  if(!target || target.length>40) return res.status(400).json({error:'Invalid Telegram user ID'});
  if(!Number.isSafeInteger(delta) || delta===0 || Math.abs(delta)>1000000000) return res.status(400).json({error:'Enter a non-zero whole-number adjustment up to 1,000,000,000'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const found=await client.query('SELECT balance FROM kvxn_users WHERE telegram_id=$1 FOR UPDATE',[target]);
    if(!found.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'User not found'});}
    const next=BigInt(found.rows[0].balance)+BigInt(delta);
    if(next<0n){await client.query('ROLLBACK');return res.status(400).json({error:'Points cannot go below zero'});}
    if(next>9223372036854775807n){await client.query('ROLLBACK');return res.status(400).json({error:'Balance exceeds the supported points limit'});}
    const updated=await client.query('UPDATE kvxn_users SET balance=$1::bigint WHERE telegram_id=$2 RETURNING balance',[next.toString(),target]);
    await client.query('INSERT INTO admin_balance_adjustments(admin_telegram_id,target_telegram_id,delta,balance_after) VALUES($1,$2,$3,$4)',[req.tgUser.id,target,delta,next.toString()]);
    await client.query('COMMIT');
    res.json({ok:true,telegramId:target,delta,balance:updated.rows[0].balance});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(500).json({error:'Could not update user points'});
  } finally {client.release();}
});
app.get('/api/admin/balance-adjustments', auth, admin, async (_req,res) => {
  const {rows}=await pool.query(`SELECT a.id,a.admin_telegram_id,a.target_telegram_id,u.first_name AS target_name,a.delta,a.balance_after,a.created_at FROM admin_balance_adjustments a JOIN kvxn_users u ON u.telegram_id=a.target_telegram_id ORDER BY a.created_at DESC LIMIT 30`);
  res.json({adjustments:rows});
});
app.get('/api/admin/redeem-codes', auth, admin, async (_req,res) => {
  const { rows } = await pool.query('SELECT code,points,max_claims,claims_count,expires_at,active,created_at FROM redeem_codes ORDER BY created_at DESC LIMIT 100');
  res.json({ codes:rows });
});
app.post('/api/admin/redeem-codes', auth, admin, async (req,res) => {
  const code = cleanCode(req.body?.code);
  const points = Number(req.body?.points);
  const maxClaims = req.body?.maxClaims === '' || req.body?.maxClaims == null ? null : Number(req.body.maxClaims);
  const expiresAt = req.body?.expiresAt ? new Date(req.body.expiresAt) : null;
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return res.status(400).json({error:'Use 3–40 letters, numbers, _ or -'});
  if (!Number.isSafeInteger(points) || points < 1 || points > 1000000000) return res.status(400).json({error:'Enter a valid positive KVXN points amount'});
  if (maxClaims !== null && (!Number.isSafeInteger(maxClaims) || maxClaims < 1)) return res.status(400).json({error:'Claim limit must be a positive whole number'});
  if (expiresAt && Number.isNaN(expiresAt.getTime())) return res.status(400).json({error:'Invalid expiry date'});
  try {
    await pool.query('INSERT INTO redeem_codes(code,points,max_claims,expires_at,created_by) VALUES($1,$2,$3,$4,$5)',[code,points,maxClaims,expiresAt,req.tgUser.id]);
    res.json({ok:true});
  } catch(e) { res.status(409).json({error:e.code==='23505'?'That code already exists':'Could not save redeem code'}); }
});
app.delete('/api/admin/redeem-codes/:code', auth, admin, async (req,res) => {
  const code=cleanCode(req.params.code);
  const r=await pool.query('UPDATE redeem_codes SET active=FALSE WHERE code=$1',[code]);
  if (!r.rowCount) return res.status(404).json({error:'Code not found'});
  res.json({ok:true});
});
app.get('/api/admin/channels', auth, admin, async (_req,res) => {
  const {rows}=await pool.query('SELECT id,platform,title,url,active,created_at FROM community_channels ORDER BY created_at DESC');
  res.json({channels:rows});
});
app.post('/api/admin/channels', auth, admin, async (req,res) => {
  const platform=String(req.body?.platform||'').toLowerCase();
  const title=String(req.body?.title||'').trim().slice(0,100);
  const url=String(req.body?.url||'').trim();
  let parsed;
  try { parsed=new URL(url); } catch { return res.status(400).json({error:'Enter a valid channel URL'}); }
  if (!['telegram','youtube'].includes(platform) || !title || !['https:'].includes(parsed.protocol)) return res.status(400).json({error:'Enter a valid Telegram or YouTube HTTPS channel'});
  if (platform==='telegram' && !/(^|\.)t\.me$/.test(parsed.hostname)) return res.status(400).json({error:'Use a t.me Telegram channel URL'});
  if (platform==='youtube' && !/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(parsed.hostname)) return res.status(400).json({error:'Use a YouTube channel URL'});
  const {rows}=await pool.query('INSERT INTO community_channels(platform,title,url) VALUES($1,$2,$3) RETURNING id,platform,title,url,active',[platform,title,url]);
  res.json({channel:rows[0]});
});
app.delete('/api/admin/channels/:id', auth, admin, async (req,res) => {
  const id=Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({error:'Invalid channel id'});
  const r=await pool.query('DELETE FROM community_channels WHERE id=$1',[id]);
  if (!r.rowCount) return res.status(404).json({error:'Channel not found'});
  res.json({ok:true});
});
app.get('/api/channels', auth, async (req,res) => {
  const {rows}=await pool.query("SELECT c.id,c.platform,c.title,c.url,(cc.id IS NOT NULL) AS claimed FROM community_channels c LEFT JOIN channel_claims cc ON cc.channel_id=c.id AND cc.telegram_id=$1 WHERE c.active=TRUE ORDER BY c.created_at DESC",[req.tgUser.id]);
  res.json({channels:rows});
});
app.post('/api/channels/:id/claim', auth, async (req,res) => {
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1) return res.status(400).json({error:'Invalid channel task'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const channel=await client.query('SELECT id FROM community_channels WHERE id=$1 AND active=TRUE FOR UPDATE',[id]);
    if(!channel.rowCount) throw new Error('This channel task is no longer available');
    const already=await client.query('SELECT id FROM channel_claims WHERE channel_id=$1 AND telegram_id=$2',[id,req.tgUser.id]);
    if(already.rowCount) throw new Error('You have already claimed this channel task');
    const reward=100;
    await client.query('INSERT INTO channel_claims(channel_id,telegram_id,reward) VALUES($1,$2,$3)',[id,req.tgUser.id,reward]);
    const updated=await client.query('UPDATE kvxn_users SET balance=balance+$1 WHERE telegram_id=$2 RETURNING balance',[reward,req.tgUser.id]);
    await client.query('COMMIT');
    res.json({ok:true,reward,balance:updated.rows[0].balance});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error:e.message||'Could not claim channel task'});
  } finally {client.release();}
});
app.get('/api/missions', auth, async (req,res) => {
  const {rows}=await pool.query("SELECT m.id,m.title,m.description,m.reward,m.icon,(mc.id IS NOT NULL) AS claimed FROM app_missions m LEFT JOIN mission_claims mc ON mc.mission_id=m.id AND mc.telegram_id=$1 WHERE m.active=TRUE ORDER BY m.id",[req.tgUser.id]);
  res.json({missions:rows});
});
app.post('/api/missions/:id/claim', auth, async (req,res) => {
  const id=Number(req.params.id);
  if(!Number.isSafeInteger(id)||id<1) return res.status(400).json({error:'Invalid mission'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const mission=await client.query('SELECT id,reward FROM app_missions WHERE id=$1 AND active=TRUE FOR UPDATE',[id]);
    if(!mission.rowCount) throw new Error('This mission is no longer available');
    const already=await client.query('SELECT id FROM mission_claims WHERE mission_id=$1 AND telegram_id=$2',[id,req.tgUser.id]);
    if(already.rowCount) throw new Error('You have already claimed this mission');
    const reward=Number(mission.rows[0].reward);
    await client.query('INSERT INTO mission_claims(mission_id,telegram_id,reward) VALUES($1,$2,$3)',[id,req.tgUser.id,reward]);
    const updated=await client.query('UPDATE kvxn_users SET balance=balance+$1 WHERE telegram_id=$2 RETURNING balance',[reward,req.tgUser.id]);
    await client.query('COMMIT');
    res.json({ok:true,reward,balance:updated.rows[0].balance});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error:e.message||'Could not claim mission'});
  } finally {client.release();}
});
app.get('/api/admin/missions', auth, admin, async (_req,res) => {
  const {rows}=await pool.query('SELECT id,title,description,reward,icon,active FROM app_missions ORDER BY id DESC');
  res.json({missions:rows});
});
app.post('/api/admin/missions', auth, admin, async (req,res) => {
  const title=String(req.body?.title||'').trim().slice(0,100);
  const description=String(req.body?.description||'').trim().slice(0,240);
  const reward=Number(req.body?.reward);
  const icon=String(req.body?.icon||'users').toLowerCase();
  if (!title || !description || !Number.isSafeInteger(reward) || reward<1 || reward>1000000) return res.status(400).json({error:'Enter a title, description and reward from 1 to 1,000,000'});
  if (!['users','send','route','gift','youtube'].includes(icon)) return res.status(400).json({error:'Choose a supported mission icon'});
  const {rows}=await pool.query('INSERT INTO app_missions(title,description,reward,icon) VALUES($1,$2,$3,$4) RETURNING id,title,description,reward,icon,active',[title,description,reward,icon]);
  res.json({mission:rows[0]});
});
app.delete('/api/admin/missions/:id', auth, admin, async (req,res) => {
  const id=Number(req.params.id);
  if (!Number.isSafeInteger(id)) return res.status(400).json({error:'Invalid mission id'});
  const r=await pool.query('DELETE FROM app_missions WHERE id=$1',[id]);
  if (!r.rowCount) return res.status(404).json({error:'Mission not found'});
  res.json({ok:true});
});
app.get('/api/channels', async (_req,res) => {
  const {rows}=await pool.query('SELECT id,platform,title,url FROM community_channels WHERE active=TRUE ORDER BY created_at DESC');
  res.json({channels:rows});
});

const __dirname=path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname,'dist')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));
migrate().then(()=>app.listen(port,'0.0.0.0',()=>console.log('KAVIXO API listening on '+port))).catch(err=>{console.error('Database initialization failed',err);process.exit(1)});
