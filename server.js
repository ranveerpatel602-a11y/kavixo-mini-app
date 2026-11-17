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
  return { id: String(user.id), firstName: String(user.first_name || 'Explorer').slice(0,80) };
}

async function auth(req,res,next) {
  try {
    const raw = req.get('x-telegram-init-data') || req.body?.initData;
    req.tgUser = parseTelegramInitData(raw);
    await pool.query(
      'INSERT INTO kvxn_users(telegram_id,first_name) VALUES($1,$2) ON CONFLICT(telegram_id) DO UPDATE SET first_name=EXCLUDED.first_name',
      [req.tgUser.id, req.tgUser.firstName]
    );
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
  const { rows } = await pool.query('SELECT telegram_id,first_name,balance FROM kvxn_users WHERE telegram_id=$1',[req.tgUser.id]);
  const allowed = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(x=>x.trim()).filter(Boolean);\n  res.json({ user: rows[0], isAdmin: allowed.includes(req.tgUser.id) });
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
app.get('/api/channels', async (_req,res) => {
  const {rows}=await pool.query('SELECT id,platform,title,url FROM community_channels WHERE active=TRUE ORDER BY created_at DESC');
  res.json({channels:rows});
});

const __dirname=path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname,'dist')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'dist','index.html')));
migrate().then(()=>app.listen(port,'0.0.0.0',()=>console.log('KAVIXO API listening on '+port))).catch(err=>{console.error('Database initialization failed',err);process.exit(1)});
