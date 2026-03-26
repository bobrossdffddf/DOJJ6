const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const config = {
  clientId:     process.env.DISCORD_CLIENT_ID     || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  redirectUri:  process.env.DISCORD_REDIRECT_URI  || `http://localhost:${PORT}/auth/discord/callback`,
  guildId:      process.env.DISCORD_GUILD_ID      || '',
  botToken:     process.env.DISCORD_BOT_TOKEN     || '',
  sessionSecret: process.env.SESSION_SECRET       || 'replace-me-in-production'
};

// ── Data paths ──────────────────────────────────────────────────────────────
const DATA_DIR        = path.join(__dirname, 'data');
const UPLOADS_DIR     = path.join(DATA_DIR, 'uploads');
const CASES_FILE             = path.join(DATA_DIR, 'cases.json');
const WARRANTS_FILE          = path.join(DATA_DIR, 'warrants.json');
const ACTIVITY_FILE          = path.join(DATA_DIR, 'activity.json');
const SUBPOENAS_FILE         = path.join(DATA_DIR, 'subpoenas.json');
const DEFENDANTS_FILE        = path.join(DATA_DIR, 'defendants.json');
const WARRANT_REQUESTS_FILE  = path.join(DATA_DIR, 'warrant_requests.json');
const WARRANT_REQ_UPLOADS_DIR = path.join(UPLOADS_DIR, 'warrant-requests');
const WARRANT_RETURN_UPLOADS_DIR = path.join(UPLOADS_DIR, 'warrant-returns');

for (const d of [DATA_DIR, UPLOADS_DIR, WARRANT_REQ_UPLOADS_DIR, WARRANT_RETURN_UPLOADS_DIR])
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
for (const f of [CASES_FILE, WARRANTS_FILE, ACTIVITY_FILE, SUBPOENAS_FILE, DEFENDANTS_FILE, WARRANT_REQUESTS_FILE])
  if (!fs.existsSync(f)) fs.writeFileSync(f, '[]');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
function newId() { return crypto.randomBytes(8).toString('hex'); }

// ── Activity log ─────────────────────────────────────────────────────────────
function logActivity(type, description, username) {
  const log = readJSON(ACTIVITY_FILE);
  log.unshift({ id: newId(), type, description, user: username, timestamp: new Date().toISOString() });
  writeJSON(ACTIVITY_FILE, log.slice(0, 200));
}

// ── Multer (250 MB max) ───────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS_DIR, req.params.channelId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 250 * 1024 * 1024 } });

const wrUploadStorage = multer.diskStorage({
  destination(req, file, cb) { cb(null, WARRANT_REQ_UPLOADS_DIR); },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const wrUpload = multer({ storage: wrUploadStorage, limits: { fileSize: 250 * 1024 * 1024 } });

const wrReturnStorage = multer.diskStorage({
  destination(req, file, cb) { cb(null, WARRANT_RETURN_UPLOADS_DIR); },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});
const wrReturnUpload = multer({ storage: wrReturnStorage, limits: { fileSize: 250 * 1024 * 1024 } });

// ════════════════════════════════════════════════════════════════════════════
// ROLE / PERMISSION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

const PERM = { citizen: 0, clerk: 1, lawyer: 2, ag: 3 };

const ROLE_KEYWORDS = {
  ag:     ['attorney general', 'ag', 'chief justice', 'chief', 'director', 'superintendent', 'secretary of state', 'governor', 'administrator'],
  lawyer: ['lawyer', 'attorney', 'ada', 'prosecutor', 'district attorney', 'judge', 'justice', 'counsel', 'solicitor', 'defender', 'barrister', 'litigation', 'dda', 'assistant da'],
  clerk:  ['clerk', 'paralegal', 'secretary', 'filing', 'registrar', 'notary', 'admin assistant', 'legal assistant', 'law clerk', 'court clerk']
};

function detectPermLevel(roleNames) {
  const lower = roleNames.map(n => n.toLowerCase());
  for (const [level, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (lower.some(n => keywords.some(k => n.includes(k)))) return level;
  }
  return 'citizen';
}

function hasPerm(userLevel, required) {
  return (PERM[userLevel] ?? 0) >= (PERM[required] ?? 0);
}

const VIEW_CHANNEL  = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;

function canViewChannel(channel, userId, memberRoleIds, guildId) {
  const ows = channel.permission_overwrites || [];
  let allow = true;
  const evOW = ows.find(o => o.id === guildId && o.type === 0);
  if (evOW) {
    if (BigInt(evOW.deny) & VIEW_CHANNEL) allow = false;
    if (BigInt(evOW.allow) & VIEW_CHANNEL) allow = true;
  }
  for (const rId of (memberRoleIds || [])) {
    const rOW = ows.find(o => o.id === rId && o.type === 0);
    if (rOW) {
      if (BigInt(rOW.deny) & VIEW_CHANNEL) allow = false;
      if (BigInt(rOW.allow) & VIEW_CHANNEL) allow = true;
    }
  }
  const uOW = ows.find(o => o.id === userId && o.type === 1);
  if (uOW) {
    if (BigInt(uOW.deny) & VIEW_CHANNEL) allow = false;
    if (BigInt(uOW.allow) & VIEW_CHANNEL) allow = true;
  }
  return allow;
}

async function fetchMemberInfo(userId) {
  if (!config.botToken || !config.guildId) return { roleIds: [], roleNames: [], isAdmin: false };
  const mRes = await fetch(`https://discord.com/api/guilds/${config.guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  if (!mRes.ok) return { roleIds: [], roleNames: [], isAdmin: false };
  const member = await mRes.json();

  const rRes = await fetch(`https://discord.com/api/guilds/${config.guildId}/roles`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  let isAdmin = false;
  let roleNames = [];
  if (rRes.ok) {
    const allRoles = await rRes.json();
    for (const rId of (member.roles || [])) {
      const role = allRoles.find(r => r.id === rId);
      if (role) {
        roleNames.push(role.name);
        if (BigInt(role.permissions) & ADMINISTRATOR) isAdmin = true;
      }
    }
  }
  if (isAdmin) roleNames.unshift('Attorney General');
  return { roleIds: member.roles || [], roleNames, isAdmin };
}

async function getAccessibleChannels(userId, roleIds, isAdmin) {
  if (!config.botToken || !config.guildId) return [];
  const res = await fetch(`https://discord.com/api/guilds/${config.guildId}/channels`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  if (!res.ok) return [];
  const channels = await res.json();
  const dc = channels.filter(c => c.name?.startsWith('dc-') && c.type === 0);
  if (isAdmin) return dc;
  return dc.filter(c => canViewChannel(c, userId, roleIds, config.guildId));
}

// ── File helpers ──────────────────────────────────────────────────────────────
function getChannelFiles(channelId) {
  const dir = path.join(UPLOADS_DIR, channelId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(fn => {
    const stat = fs.statSync(path.join(dir, fn));
    return { filename: fn, originalName: fn.replace(/^\d+_/, ''), size: stat.size, uploadedAt: stat.mtime };
  }).sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function getTotalFileCount() {
  if (!fs.existsSync(UPLOADS_DIR)) return 0;
  return fs.readdirSync(UPLOADS_DIR).reduce((sum, dir) => {
    const d = path.join(UPLOADS_DIR, dir);
    return sum + (fs.statSync(d).isDirectory() ? fs.readdirSync(d).length : 0);
  }, 0);
}

// ── Formatting helpers ─────────────────────────────────────────────────────────
function formatSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1048576).toFixed(1)} MB`;
}
function formatChannelName(name) {
  return name.replace(/^dc-/,'').replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
}
function escapeHtml(v='') {
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'});
}
function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function nextCaseNumber() {
  const cases = readJSON(CASES_FILE);
  const year = new Date().getFullYear();
  const nums = cases.map(c => { const m = String(c.caseNumber||'').match(/(\d+)$/); return m?parseInt(m[1]):0; });
  return `DOJ-${year}-${String((nums.length?Math.max(...nums):0)+1).padStart(4,'0')}`;
}
function nextWarrantNumber() {
  const warrants = readJSON(WARRANTS_FILE);
  const year = new Date().getFullYear();
  const nums = warrants.map(w => { const m = String(w.warrantNumber||'').match(/(\d+)$/); return m?parseInt(m[1]):0; });
  return `W-${year}-${String((nums.length?Math.max(...nums):0)+1).padStart(4,'0')}`;
}
function nextSubpoenaNumber() {
  const subs = readJSON(SUBPOENAS_FILE);
  const year = new Date().getFullYear();
  const nums = subs.map(s => { const m = String(s.subpoenaNumber||'').match(/(\d+)$/); return m?parseInt(m[1]):0; });
  return `SP-${year}-${String((nums.length?Math.max(...nums):0)+1).padStart(4,'0')}`;
}
function nextWarrantRequestNumber() {
  const reqs = readJSON(WARRANT_REQUESTS_FILE);
  const year = new Date().getFullYear();
  const nums = reqs.map(r => { const m = String(r.requestNumber||'').match(/(\d+)$/); return m?parseInt(m[1]):0; });
  return `WR-${year}-${String((nums.length?Math.max(...nums):0)+1).padStart(4,'0')}`;
}

// ── Badge helpers ─────────────────────────────────────────────────────────────
const CASE_STATUS_CLASS    = { open:'badge-green', investigation:'badge-blue', pending:'badge-yellow', filed:'badge-purple', closed:'badge-gray', dismissed:'badge-red' };
const WARRANT_STATUS_CLASS = { active:'badge-green', executed:'badge-gray', expired:'badge-red', cancelled:'badge-red' };
const PRIORITY_CLASS       = { low:'badge-gray', medium:'badge-yellow', high:'badge-orange', critical:'badge-red' };
const PERM_LEVEL_CLASS     = { citizen:'badge-gray', clerk:'badge-blue', lawyer:'badge-purple', ag:'badge-green' };
const PERM_LEVEL_LABEL     = { citizen:'Citizen', clerk:'Court Clerk', lawyer:'Attorney / ADA', ag:'Attorney General' };
const SUBPOENA_STATUS_CLASS = { pending:'badge-yellow', served:'badge-green', failed:'badge-red', quashed:'badge-gray' };
const PLEA_CLASS           = { 'not entered':'badge-gray', 'not guilty':'badge-green', 'guilty':'badge-red', 'no contest':'badge-yellow' };
const VERDICT_CLASS        = { pending:'badge-yellow', 'not guilty':'badge-green', guilty:'badge-red', dismissed:'badge-gray', mistrial:'badge-orange' };

function badge(text, cls='badge-gray') {
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

// ── Texas-specific data ────────────────────────────────────────────────────────
const TEXAS_COUNTIES = [
  'Anderson','Andrews','Angelina','Aransas','Archer','Armstrong','Atascosa','Austin','Bailey','Bandera',
  'Bastrop','Baylor','Bee','Bell','Bexar','Blanco','Borden','Bosque','Bowie','Brazoria','Brazos',
  'Brewster','Briscoe','Brooks','Brown','Burleson','Burnet','Caldwell','Calhoun','Cameron','Camp',
  'Carson','Cass','Castro','Chambers','Cherokee','Childress','Clay','Cochran','Coke','Coleman',
  'Collin','Collingsworth','Colorado','Comal','Comanche','Concho','Cooke','Corpus Christi',
  'Dallas','Denton','El Paso','Fort Bend','Galveston','Harris','Hays','Hidalgo','Jefferson',
  'Lubbock','McLennan','Montgomery','Nueces','Tarrant','Travis','Webb','Williamson'
];

const COURT_TYPES = [
  'Texas District Court',
  'Texas County Court at Law',
  'Texas Criminal District Court',
  'Municipal Court',
  'Justice of the Peace Court',
  'Court of Criminal Appeals',
  'Texas Court of Appeals'
];

const CASE_GRADES = [
  'Capital Felony',
  '1st Degree Felony',
  '2nd Degree Felony',
  '3rd Degree Felony',
  'State Jail Felony',
  'Class A Misdemeanor',
  'Class B Misdemeanor',
  'Class C Misdemeanor',
  'Civil'
];

// ── Texas Penal Code charges ──────────────────────────────────────────────────
const COMMON_CHARGES = [
  // Homicide - Texas Penal Code Title 5
  'Murder (TPC § 19.02)',
  'Capital Murder (TPC § 19.03)',
  'Manslaughter (TPC § 19.04)',
  'Criminally Negligent Homicide (TPC § 19.05)',
  // Assault - Title 5
  'Assault (TPC § 22.01)',
  'Aggravated Assault (TPC § 22.02)',
  'Deadly Conduct (TPC § 22.05)',
  'Terroristic Threat (TPC § 22.07)',
  'Sexual Assault (TPC § 22.011)',
  'Aggravated Sexual Assault (TPC § 22.021)',
  // Kidnapping - Title 4
  'Kidnapping (TPC § 20.03)',
  'Aggravated Kidnapping (TPC § 20.04)',
  'Unlawful Restraint (TPC § 20.02)',
  // Robbery - Title 7
  'Robbery (TPC § 29.02)',
  'Aggravated Robbery (TPC § 29.03)',
  // Property crimes - Title 7
  'Theft (TPC § 31.03)',
  'Burglary of a Habitation (TPC § 30.02)',
  'Burglary of a Building (TPC § 30.02)',
  'Burglary of a Vehicle (TPC § 30.04)',
  'Criminal Trespass (TPC § 30.05)',
  'Unauthorized Use of Motor Vehicle (TPC § 31.07)',
  'Arson (TPC § 28.02)',
  'Criminal Mischief (TPC § 28.03)',
  // Drug offenses - Texas Health & Safety Code
  'Possession of Controlled Substance (THSC § 481.115)',
  'Manufacture/Delivery of Controlled Substance (THSC § 481.112)',
  'Possession of Marijuana (THSC § 481.121)',
  'Delivery of Marijuana (THSC § 481.120)',
  'Possession of Drug Paraphernalia (THSC § 481.125)',
  // Weapons - Title 10
  'Unlawful Carrying of Weapon (TPC § 46.02)',
  'Felon in Possession of Firearm (TPC § 46.04)',
  'Unlawful Transfer of Firearm (TPC § 46.06)',
  'Prohibited Weapons (TPC § 46.05)',
  // DWI / Traffic - Transportation Code
  'Driving While Intoxicated (TPC § 49.04)',
  'DWI with Child Passenger (TPC § 49.045)',
  'Intoxication Assault (TPC § 49.07)',
  'Intoxication Manslaughter (TPC § 49.08)',
  'Evading Arrest — Vehicle (TPC § 38.04)',
  'Evading Arrest — Foot (TPC § 38.04)',
  'Reckless Driving (Tex. Transp. Code § 545.401)',
  'Street Racing (Tex. Transp. Code § 545.420)',
  'Driving While License Invalid (Tex. Transp. Code § 521.457)',
  // Obstruction / Government
  'Resisting Arrest (TPC § 38.03)',
  'Tampering with Evidence (TPC § 37.09)',
  'Tampering with Witness (TPC § 36.05)',
  'Perjury (TPC § 37.02)',
  'False Report to Police (TPC § 37.08)',
  'Retaliation (TPC § 36.06)',
  // Financial crimes
  'Money Laundering (TPC § 34.02)',
  'Bribery (TPC § 36.02)',
  'Forgery (TPC § 32.21)',
  'Fraud (TPC § 32.46)',
  'Identity Theft (TPC § 32.51)',
  'Credit Card Abuse (TPC § 32.31)',
  // Public order
  'Public Intoxication (TPC § 49.02)',
  'Disorderly Conduct (TPC § 42.01)',
  'Riot (TPC § 42.02)',
  'Prostitution (TPC § 43.02)',
  'Gambling Promotion (TPC § 47.03)',
  // Organized crime
  'Engaging in Organized Criminal Activity (TPC § 71.02)',
  'Conspiracy (TPC § 15.02)',
  'Criminal Solicitation (TPC § 15.03)'
];

// ── Auth helpers ──────────────────────────────────────────────────────────────
function authUrl(state) {
  return `https://discord.com/api/oauth2/authorize?${new URLSearchParams({
    client_id: config.clientId, redirect_uri: config.redirectUri,
    response_type: 'code', scope: 'identify guilds', state, prompt: 'consent'
  })}`;
}

function ensureAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  next();
}

function requirePerm(level) {
  return (req, res, next) => {
    if (!req.session.user) return res.redirect('/');
    if (!hasPerm(req.session.user.permLevel, level)) {
      const body = `
      <div class="access-denied">
        <h2>Access Denied</h2>
        <p>Your role (<strong>${PERM_LEVEL_LABEL[req.session.user.permLevel] || req.session.user.permLevel}</strong>) does not have access to this section.</p>
        <p class="muted-text">If you believe this is wrong, contact your supervisor — your Discord role controls your access.</p>
        <a class="btn-primary" href="/dashboard">Return to Dashboard</a>
      </div>`;
      return res.status(403).send(layout({ title: 'Access Denied — DOJ', body, user: req.session.user, page: '' }));
    }
    next();
  };
}

// ── Layout ────────────────────────────────────────────────────────────────────
function layout({ title, body, user, page = '' }) {
  const pl = user?.permLevel || 'citizen';
  const canCases    = user && hasPerm(pl, 'clerk');
  const canDocs     = user && hasPerm(pl, 'clerk');
  const canWarrants = user && hasPerm(pl, 'citizen');
  const canSubpoenas = user && hasPerm(pl, 'clerk');
  const canDefendants = user && hasPerm(pl, 'clerk');

  const canManageRequests = user && hasPerm(pl, 'clerk');

  const nav = user ? `
  <div class="subnav">
    <a class="subnav-link${page==='dashboard'?' active':''}" href="/dashboard">Dashboard</a>
    ${canWarrants        ? `<a class="subnav-link${page==='warrants'?' active':''}" href="/warrants">Warrants</a>` : ''}
    ${canCases           ? `<a class="subnav-link${page==='cases'?' active':''}" href="/cases">Cases</a>` : ''}
    ${canDefendants      ? `<a class="subnav-link${page==='defendants'?' active':''}" href="/defendants">Defendants</a>` : ''}
    ${canSubpoenas       ? `<a class="subnav-link${page==='subpoenas'?' active':''}" href="/subpoenas">Subpoenas</a>` : ''}
    ${canDocs            ? `<a class="subnav-link${page==='channels'?' active':''}" href="/channels">Documents</a>` : ''}
    ${canCases           ? `<a class="subnav-link${page==='calendar'?' active':''}" href="/calendar">Calendar</a>` : ''}
    <a class="subnav-link${page==='warrant-request'?' active':''}" href="/warrant-request">Request Warrant</a>
    ${canManageRequests  ? `<a class="subnav-link${page==='warrant-requests'?' active':''}" href="/warrant-requests">Warrant Requests</a>` : ''}
    <a class="subnav-link${page==='search'?' active':''}" href="/search">Search</a>
  </div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css"/>
  <link rel="icon" type="image/webp" href="/doj-logo.webp"/>
</head>
<body>
  <nav class="topbar">
    <a class="topbar-brand" href="${user?'/dashboard':'/'}"><img src="/doj-logo.webp" class="topbar-logo" alt="DOJ"/> DOJ Portal</a>
    <div class="topbar-right">
      ${user ? `
        ${badge(PERM_LEVEL_LABEL[pl]||pl, PERM_LEVEL_CLASS[pl]||'badge-gray')}
        <span class="topbar-user">${escapeHtml(user.username)}</span>
        <a class="btn-sm" href="/logout">Sign out</a>` : ''}
    </div>
  </nav>
  ${nav}
  <main class="container">
    ${body}
  </main>
</body>
</html>`;
}

// ── Express setup ─────────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

app.use(session({
  store: new FileStore({ path: SESSIONS_DIR, ttl: 21600, retries: 1, logFn: () => {} }),
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 6 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ── API (for Discord bot) ─────────────────────────────────────────────────────
app.get('/api/cases', (req, res) => {
  const key = req.headers['x-bot-key'];
  if (key !== process.env.BOT_API_KEY && process.env.BOT_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const cases = readJSON(CASES_FILE);
  const status = req.query.status || 'open';
  res.json(status === 'all' ? cases : cases.filter(c => !['closed','dismissed'].includes(c.status)));
});

app.get('/api/warrants', (req, res) => {
  const key = req.headers['x-bot-key'];
  if (key !== process.env.BOT_API_KEY && process.env.BOT_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const warrants = readJSON(WARRANTS_FILE);
  res.json(warrants.filter(w => w.status === 'active'));
});

app.get('/api/members', ensureAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2 || !config.botToken || !config.guildId) return res.json([]);
  try {
    const r = await fetch(
      `https://discord.com/api/guilds/${config.guildId}/members/search?query=${encodeURIComponent(q)}&limit=25`,
      { headers: { Authorization: `Bot ${config.botToken}` } }
    );
    if (!r.ok) return res.json([]);
    const members = await r.json();
    const names = members
      .filter(m => !m.user?.bot)
      .map(m => m.nick || m.user?.global_name || m.user?.username)
      .filter(Boolean);
    return res.json([...new Set(names)]);
  } catch { return res.json([]); }
});

// ════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/dashboard');
  const ready = Boolean(config.clientId && config.clientSecret);
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save();

  const body = `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-seal"><img src="/doj-logo.webp" class="login-logo-img" alt="Department of Justice Seal"/></div>
      <h1 class="login-title">DOJ Portal</h1>
      <p class="login-sub">State of Texas — Department of Justice<br/>Sign in with your Discord account. Access is determined by your server role.</p>
      ${ready
        ? `<a class="btn-discord" href="${authUrl(state)}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
            Sign in with Discord
          </a>`
        : `<div class="alert-box">Discord credentials not configured. Set <code>DISCORD_CLIENT_ID</code> and <code>DISCORD_CLIENT_SECRET</code>.</div>`}
    </div>
  </div>`;
  return res.send(layout({ title: 'Sign In — DOJ Portal', body, user: null }));
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState)
    return res.status(400).send('Invalid OAuth state. Please retry login.');
  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId, client_secret: config.clientSecret,
        grant_type: 'authorization_code', code: String(code), redirect_uri: config.redirectUri
      })
    });
    if (!tokenRes.ok) { const t = await tokenRes.text(); return res.status(401).send(`OAuth error: ${escapeHtml(t)}`); }
    const token = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } });
    if (!userRes.ok) return res.status(401).send('Could not fetch Discord profile.');
    const user = await userRes.json();

    if (config.guildId) {
      const gRes = await fetch('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (!gRes.ok) return res.status(403).send('Could not verify guild membership.');
      const guilds = await gRes.json();
      if (!guilds.some(g => g.id === config.guildId))
        return res.status(403).send('Access denied: not a member of the configured server.');
    }

    let permLevel = 'citizen';
    let roleNames = [];
    if (config.botToken && config.guildId) {
      try {
        const info = await fetchMemberInfo(user.id);
        roleNames = info.roleNames;
        permLevel = info.isAdmin ? 'ag' : detectPermLevel(roleNames);
      } catch { /* bot unavailable, default to citizen */ }
    } else {
      permLevel = 'ag';
      roleNames = ['Attorney General'];
    }

    req.session.user = { id: user.id, username: user.username, discriminator: user.discriminator, permLevel, roleNames };
    delete req.session.oauthState;
    return res.redirect('/dashboard');
  } catch (err) { return res.status(500).send(`Login failed: ${escapeHtml(err.message)}`); }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

app.get('/refresh-roles', ensureAuth, async (req, res) => {
  if (config.botToken && config.guildId) {
    try {
      const info = await fetchMemberInfo(req.session.user.id);
      req.session.user.roleNames = info.roleNames;
      req.session.user.permLevel = info.isAdmin ? 'ag' : detectPermLevel(info.roleNames);
    } catch {}
  }
  return res.redirect('/dashboard');
});

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD
// ════════════════════════════════════════════════════════════════════════════

app.get('/dashboard', ensureAuth, (req, res) => {
  const user = req.session.user;
  const pl = user.permLevel;
  const cases     = readJSON(CASES_FILE);
  const warrants  = readJSON(WARRANTS_FILE);
  const subpoenas = readJSON(SUBPOENAS_FILE);
  const activity  = readJSON(ACTIVITY_FILE).slice(0, 12);

  const openCases        = cases.filter(c => !['closed','dismissed'].includes(c.status)).length;
  const pendingTrial     = cases.filter(c => ['pending','filed'].includes(c.status)).length;
  const activeWarrants   = warrants.filter(w => w.status === 'active').length;
  const pendingSubpoenas = subpoenas.filter(s => s.status === 'pending').length;
  const totalDocs        = getTotalFileCount();
  const defendants       = readJSON(DEFENDANTS_FILE);

  const roleTagsHtml = (user.roleNames || []).length
    ? user.roleNames.map(r => `<span class="role-chip">${escapeHtml(r)}</span>`).join('')
    : '<span class="muted-text">No roles detected</span>';

  const permBanner = `
  <div class="perm-banner perm-${pl}">
    <div class="perm-banner-left">
      <div class="perm-banner-level">${PERM_LEVEL_LABEL[pl] || pl}</div>
      <div class="perm-banner-roles">${roleTagsHtml}</div>
    </div>
    <div class="perm-banner-rights">
      ${hasPerm(pl,'citizen') ? '<span class="perm-chip perm-yes">✓ Warrant Lookup</span>' : ''}
      ${hasPerm(pl,'clerk')   ? '<span class="perm-chip perm-yes">✓ View Cases</span>' : ''}
      ${hasPerm(pl,'clerk')   ? '<span class="perm-chip perm-yes">✓ Create & Edit Cases</span>' : ''}
      ${hasPerm(pl,'clerk')   ? '<span class="perm-chip perm-yes">✓ Documents</span>' : ''}
      ${hasPerm(pl,'clerk')   ? '<span class="perm-chip perm-yes">✓ Issue Warrants</span>' : ''}
      ${hasPerm(pl,'lawyer')  ? '<span class="perm-chip perm-yes">✓ Issue Subpoenas</span>' : ''}
      ${hasPerm(pl,'ag')      ? '<span class="perm-chip perm-yes">✓ Full Admin</span>' : ''}
      ${!hasPerm(pl,'clerk')  ? '<span class="perm-chip perm-no">✗ Cases</span>' : ''}
      ${!hasPerm(pl,'clerk')  ? '<span class="perm-chip perm-no">✗ Documents</span>' : ''}
      ${!hasPerm(pl,'lawyer') ? '<span class="perm-chip perm-no">✗ Issue Subpoenas</span>' : ''}
    </div>
  </div>`;

  if (pl === 'citizen') {
    const body = `
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <p class="page-sub">Signed in as ${escapeHtml(user.username)} · State of Texas DOJ</p>
    </div>
    ${permBanner}
    <div class="card">
      <div class="card-title" style="margin-bottom:0.75rem">Warrant Lookup</div>
      <p style="font-size:0.9rem;color:#6b7280;margin-bottom:1rem">Search for active warrants by subject name or warrant number.</p>
      <form method="get" action="/warrants" class="filter-row">
        <input class="input" name="q" placeholder="Name or warrant number…" style="flex:1"/>
        <button class="btn-primary" type="submit">Search Warrants</button>
      </form>
    </div>
    <div class="alert-box" style="margin-top:0">
      Your Discord role gives you <strong>Citizen</strong> access. If you are DOJ staff, ensure you have the correct role in the Discord server, then <a href="/refresh-roles" style="color:#92400e;text-decoration:underline">click here to refresh your access</a>.
    </div>`;
    return res.send(layout({ title: 'Dashboard — DOJ', body, user, page: 'dashboard' }));
  }

  const activityRows = activity.map(a => `
  <div class="activity-row">
    <span class="activity-icon">${activityIcon(a.type)}</span>
    <div class="activity-info">
      <span class="activity-desc">${escapeHtml(a.description)}</span>
      <span class="activity-meta">${escapeHtml(a.user)} · ${fmtDateTime(a.timestamp)}</span>
    </div>
  </div>`).join('') || '<p class="muted-text" style="padding:1rem">No recent activity.</p>';

  const recentCases = cases.slice(0,5).map(c => `
  <a class="table-row-link" href="/cases/${c.id}" style="--cols:3">
    <span class="tr-cell mono">${escapeHtml(c.caseNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(c.title)}</span>
    <span class="tr-cell">${badge(c.status, CASE_STATUS_CLASS[c.status]||'badge-gray')}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:1rem">No cases yet.</p>';

  // Upcoming court dates
  const today = new Date();
  const upcoming = cases
    .filter(c => c.courtDate && new Date(c.courtDate) >= today)
    .sort((a,b) => new Date(a.courtDate)-new Date(b.courtDate))
    .slice(0,4);

  const upcomingRows = upcoming.map(c => `
  <div class="activity-row">
    <span class="activity-icon" style="background:#dbeafe;color:#1d4ed8">DATE</span>
    <div class="activity-info">
      <span class="activity-desc"><a href="/cases/${c.id}" style="color:#111827">${escapeHtml(c.caseNumber)} — ${escapeHtml(c.title)}</a></span>
      <span class="activity-meta">${fmtDate(c.courtDate)} · ${escapeHtml(c.courtType||'Court')} · ${escapeHtml(c.county||'')} County</span>
    </div>
  </div>`).join('') || '<p class="muted-text" style="padding:1rem">No upcoming hearings.</p>';

  const body = `
  <div class="page-header row-between">
    <div>
      <h1 class="page-title">Dashboard</h1>
      <p class="page-sub">Signed in as ${escapeHtml(user.username)} · State of Texas DOJ</p>
    </div>
    <div class="btn-group">
      ${hasPerm(pl,'clerk') ? `<a class="btn-primary" href="/cases/new">+ New Case</a>` : ''}
      ${hasPerm(pl,'clerk') ? `<a class="btn-sm" href="/warrants/new">Issue Warrant</a>` : ''}
    </div>
  </div>

  ${permBanner}

  <div class="stats-grid">
    <div class="stat-card"><div class="stat-number">${cases.length}</div><div class="stat-label">Total Cases</div></div>
    <div class="stat-card stat-card-green"><div class="stat-number">${openCases}</div><div class="stat-label">Active Cases</div></div>
    <div class="stat-card stat-card-blue"><div class="stat-number">${pendingTrial}</div><div class="stat-label">Pending Trial</div></div>
    <div class="stat-card stat-card-red"><div class="stat-number">${activeWarrants}</div><div class="stat-label">Active Warrants</div></div>
    <div class="stat-card"><div class="stat-number">${defendants.length}</div><div class="stat-label">Defendant Records</div></div>
    <div class="stat-card"><div class="stat-number">${pendingSubpoenas}</div><div class="stat-label">Pending Subpoenas</div></div>
    <div class="stat-card"><div class="stat-number">${totalDocs}</div><div class="stat-label">Documents</div></div>
  </div>

  <div class="two-col">
    <div class="card">
      <div class="card-header">
        <span class="card-title">Recent Cases</span>
        ${hasPerm(pl,'clerk') ? `<a class="btn-sm" href="/cases/new">+ New</a>` : ''}
      </div>
      <div class="table-rows">${recentCases}</div>
      <a class="card-footer-link" href="/cases">View all cases →</a>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Upcoming Hearings</span><a class="btn-sm" href="/calendar">Calendar →</a></div>
      <div class="activity-list">${upcomingRows}</div>
    </div>
  </div>
  <div class="card">
    <div class="card-header"><span class="card-title">Recent Activity</span></div>
    <div class="activity-list">${activityRows}</div>
  </div>`;

  return res.send(layout({ title: 'Dashboard — DOJ', body, user, page: 'dashboard' }));
});

function activityIcon(type) {
  return {
    case_created:'NEW', case_updated:'UPD', case_closed:'CLO',
    warrant_issued:'WRT', warrant_executed:'EXE',
    file_uploaded:'DOC', note_added:'NOTE',
    subpoena_issued:'SUB', defendant_added:'DEF',
    evidence_added:'EVD', sentence_recorded:'SEN'
  }[type] || '–';
}

// ════════════════════════════════════════════════════════════════════════════
// CASES
// ════════════════════════════════════════════════════════════════════════════

app.get('/cases', requirePerm('clerk'), (req, res) => {
  const { q='', status='', type='', priority='', county='', grade='' } = req.query;
  const pl = req.session.user.permLevel;
  let cases = readJSON(CASES_FILE);
  if (q)       cases = cases.filter(c => [c.caseNumber,c.title,c.subject,c.assignedOfficer,c.defenseAttorney,c.notes,...(c.charges||[])].join(' ').toLowerCase().includes(q.toLowerCase()));
  if (status)  cases = cases.filter(c => c.status === status);
  if (type)    cases = cases.filter(c => c.type === type);
  if (priority) cases = cases.filter(c => c.priority === priority);
  if (county)  cases = cases.filter(c => c.county === county);
  if (grade)   cases = cases.filter(c => c.caseGrade === grade);

  const rows = cases.map(c => `
  <a class="table-row-link" href="/cases/${c.id}">
    <span class="tr-cell mono">${escapeHtml(c.caseNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(c.title)}</span>
    <span class="tr-cell">${escapeHtml(c.subject)}</span>
    <span class="tr-cell">${badge(c.status, CASE_STATUS_CLASS[c.status]||'badge-gray')}</span>
    <span class="tr-cell">${badge(c.priority||'low', PRIORITY_CLASS[c.priority||'low'])}</span>
    <span class="tr-cell muted-text">${fmtDate(c.createdAt)}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:1.5rem">No cases match your filters.</p>';

  const countyOptions = TEXAS_COUNTIES.map(cn=>`<option value="${cn}" ${county===cn?'selected':''}>${cn}</option>`).join('');
  const gradeOptions  = CASE_GRADES.map(g=>`<option value="${g}" ${grade===g?'selected':''}>${g}</option>`).join('');

  const body = `
  <div class="page-header row-between">
    <div><h1 class="page-title">Cases</h1><p class="page-sub">${cases.length} case${cases.length!==1?'s':''} found.</p></div>
    ${hasPerm(pl,'clerk') ? `<a class="btn-primary" href="/cases/new">+ New Case</a>` : ''}
  </div>
  <div class="card" style="margin-bottom:1rem">
    <form method="get" class="filter-row">
      <input class="input-sm" name="q" value="${escapeHtml(q)}" placeholder="Search cases…"/>
      <select class="input-sm" name="status"><option value="">All statuses</option>${['open','investigation','pending','filed','closed','dismissed'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}</select>
      <select class="input-sm" name="type"><option value="">All types</option>${['criminal','traffic','civil','internal affairs'].map(t=>`<option value="${t}" ${type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}</select>
      <select class="input-sm" name="priority"><option value="">All priorities</option>${['low','medium','high','critical'].map(p=>`<option value="${p}" ${priority===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}</select>
      <select class="input-sm" name="county"><option value="">All counties</option>${countyOptions}</select>
      <select class="input-sm" name="grade"><option value="">All grades</option>${gradeOptions}</select>
      <button class="btn-primary" type="submit">Filter</button>
      <a class="btn-sm" href="/cases">Reset</a>
    </form>
  </div>
  <div class="card">
    <div class="table-header"><span>Case #</span><span>Title</span><span>Subject</span><span>Status</span><span>Priority</span><span>Filed</span></div>
    <div class="table-rows">${rows}</div>
  </div>`;

  return res.send(layout({ title: 'Cases — DOJ', body, user: req.session.user, page: 'cases' }));
});

app.get('/cases/new', requirePerm('clerk'), (req, res) => {
  const chargeOptions = COMMON_CHARGES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const countyOptions = TEXAS_COUNTIES.map(cn=>`<option value="${cn}">${cn}</option>`).join('');
  const courtOptions  = COURT_TYPES.map(ct=>`<option value="${escapeHtml(ct)}">${escapeHtml(ct)}</option>`).join('');
  const gradeOptions  = CASE_GRADES.map(g=>`<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('');

  const body = `
  <div class="page-header"><a class="back-link" href="/cases">← Back to cases</a><h1 class="page-title">New Case</h1></div>
  <div class="card">
    <form method="post" action="/cases">
      <div class="section-label">Basic Information</div>
      <div class="form-grid">
        <div class="form-group"><label>Case Title <span class="req">*</span></label><input class="input" name="title" required placeholder="Brief description of the case"/></div>
        <div class="form-group"><label>Defendant / Subject <span class="req">*</span></label><input class="input" name="subject" required placeholder="Full legal name"/></div>
        <div class="form-group"><label>Case Type <span class="req">*</span></label><select class="input" name="type" required><option value="criminal">Criminal</option><option value="traffic">Traffic</option><option value="civil">Civil</option><option value="internal affairs">Internal Affairs</option></select></div>
        <div class="form-group"><label>Offense Grade</label><select class="input" name="caseGrade"><option value="">— Select —</option>${gradeOptions}</select></div>
        <div class="form-group"><label>Priority</label><select class="input" name="priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div>
        <div class="form-group"><label>County <span class="req">*</span></label><select class="input" name="county" required><option value="">— Select County —</option>${countyOptions}</select></div>
        <div class="form-group"><label>Court Type</label><select class="input" name="courtType"><option value="">— Select Court —</option>${courtOptions}</select></div>
        <div class="form-group"><label>Incident Location / Address</label><input class="input" name="location" placeholder="Street address, city, county"/></div>
      </div>
      <div class="section-label">Parties</div>
      <div class="form-grid">
        <div class="form-group"><label>Assigned Officer / ADA</label><input class="input" name="assignedOfficer" placeholder="Name of lead officer or ADA"/></div>
        <div class="form-group"><label>Prosecutor</label><input class="input" name="prosecutor" placeholder="Prosecuting attorney"/></div>
        <div class="form-group"><label>Defense Attorney</label><input class="input" name="defenseAttorney" placeholder="Defense counsel"/></div>
        <div class="form-group"><label>Presiding Judge</label><input class="input" name="presidingJudge" placeholder="Judge's name"/></div>
      </div>
      <div class="section-label">Plea & Dates</div>
      <div class="form-grid">
        <div class="form-group"><label>Defendant's Plea</label><select class="input" name="plea"><option value="not entered">Not Entered</option><option value="not guilty">Not Guilty</option><option value="guilty">Guilty</option><option value="no contest">No Contest</option></select></div>
        <div class="form-group"><label>Bond / Bail Amount ($)</label><input class="input" type="number" name="bondAmount" placeholder="0.00" min="0" step="0.01"/></div>
        <div class="form-group"><label>Hearing / Court Date</label><input class="input" type="date" name="courtDate"/></div>
        <div class="form-group"><label>Trial Date</label><input class="input" type="date" name="trialDate"/></div>
      </div>
      <div class="section-label">Charges</div>
      <div class="form-group">
        <p class="field-hint">Pick from the Texas Penal Code list or type custom charges comma-separated.</p>
        <select class="input" id="chargeSelect" onchange="addCharge(this)"><option value="">— Add a charge —</option>${chargeOptions}</select>
        <input class="input" name="chargesRaw" id="chargesRaw" placeholder="Charges appear here (comma-separated)" style="margin-top:0.5rem"/>
      </div>
      <div class="section-label">Narrative</div>
      <div class="form-group"><label>Case Summary / Probable Cause</label><textarea class="input" name="notes" rows="5" placeholder="Describe the incident, evidence, probable cause, relevant details…"></textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Create Case</button><a class="btn-sm" href="/cases">Cancel</a></div>
    </form>
  </div>
  <script>function addCharge(s){if(!s.value)return;const f=document.getElementById('chargesRaw');f.value=f.value.trim()?(f.value.trim()+', '+s.value):s.value;s.value='';}</script>`;
  return res.send(layout({ title: 'New Case — DOJ', body, user: req.session.user, page: 'cases' }));
});

app.post('/cases', requirePerm('clerk'), (req, res) => {
  const { title, subject, type, caseGrade, priority, county, courtType, location, assignedOfficer, prosecutor, defenseAttorney, presidingJudge, plea, bondAmount, courtDate, trialDate, chargesRaw, notes } = req.body;
  if (!title || !subject || !type || !county) return res.status(400).send('Missing required fields.');
  const charges = chargesRaw ? chargesRaw.split(',').map(c=>c.trim()).filter(Boolean) : [];
  const cases = readJSON(CASES_FILE);
  const newCase = {
    id: newId(), caseNumber: nextCaseNumber(), title, subject, type, caseGrade: caseGrade||'',
    status: 'open', priority: priority||'medium',
    county: county||'', courtType: courtType||'', location: location||'',
    assignedOfficer: assignedOfficer||'', prosecutor: prosecutor||'',
    defenseAttorney: defenseAttorney||'', presidingJudge: presidingJudge||'',
    plea: plea||'not entered', bondAmount: bondAmount ? parseFloat(bondAmount) : null,
    courtDate: courtDate||'', trialDate: trialDate||'',
    verdict: 'pending', sentence: '', charges, notes: notes||'', caseNotes: [],
    createdBy: req.session.user.username, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  cases.unshift(newCase);
  writeJSON(CASES_FILE, cases);
  logActivity('case_created', `Case ${newCase.caseNumber} created — ${title}`, req.session.user.username);

  if (!['civil', 'internal affairs'].includes(type)) {
    const defendants = readJSON(DEFENDANTS_FILE);
    const exists = defendants.some(d => d.fullName.toLowerCase() === subject.toLowerCase());
    if (!exists) {
      defendants.unshift({
        id: newId(), fullName: subject, dob: '',
        race: '', height: '', weight: '', hair: '', eyes: '',
        address: '', city: '', county: county||'', phone: '', notes: '',
        createdBy: req.session.user.username, createdAt: new Date().toISOString()
      });
      writeJSON(DEFENDANTS_FILE, defendants);
      logActivity('defendant_added', `Defendant record auto-created: ${subject}`, req.session.user.username);
    }
  }

  refreshBotEmbeds();
  return res.redirect(`/cases/${newCase.id}`);
});

app.get('/cases/:id', requirePerm('clerk'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const c = cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).send('Case not found.');
  const pl = req.session.user.permLevel;
  const linkedWarrants  = readJSON(WARRANTS_FILE).filter(w => w.linkedCaseId === c.id);
  const linkedSubpoenas = readJSON(SUBPOENAS_FILE).filter(s => s.linkedCaseId === c.id);
  const canEditCase = hasPerm(pl, 'clerk');
  const canWrite    = hasPerm(pl, 'lawyer');
  const canDelete   = hasPerm(pl, 'ag');

  const chargesHtml = (c.charges||[]).map(ch=>`<span class="tag">${escapeHtml(ch)}</span>`).join('') || '<span class="muted-text">None listed</span>';
  const notesHtml = (c.caseNotes||[]).map(n=>`
  <div class="note-entry">
    <div class="note-meta">${escapeHtml(n.author)} · ${fmtDateTime(n.timestamp)}</div>
    <div class="note-text">${escapeHtml(n.text)}</div>
  </div>`).join('') || '';

  const warrantRows = linkedWarrants.map(w=>`
  <a class="table-row-link" href="/warrants/${w.id}" style="--cols:4">
    <span class="tr-cell mono">${escapeHtml(w.warrantNumber)}</span>
    <span class="tr-cell">${escapeHtml(w.type)}</span>
    <span class="tr-cell">${badge(w.status, WARRANT_STATUS_CLASS[w.status]||'badge-gray')}</span>
    <span class="tr-cell muted-text">${fmtDate(w.issuedAt)}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:0.75rem">No warrants linked.</p>';

  const subpoenaRows = linkedSubpoenas.map(s=>`
  <div class="table-row-link" style="--cols:4">
    <span class="tr-cell mono">${escapeHtml(s.subpoenaNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(s.recipient)}</span>
    <span class="tr-cell">${badge(s.status, SUBPOENA_STATUS_CLASS[s.status]||'badge-gray')}</span>
    <span class="tr-cell muted-text">${fmtDate(s.dueDate)}</span>
  </div>`).join('') || '<p class="muted-text" style="padding:0.75rem">No subpoenas issued.</p>';

  const body = `
  <div class="page-header row-between">
    <div>
      <a class="back-link" href="/cases">← Back to cases</a>
      <h1 class="page-title">${escapeHtml(c.title)}</h1>
      <div class="badge-row">
        <span class="mono muted-text">${escapeHtml(c.caseNumber)}</span>
        ${badge(c.status, CASE_STATUS_CLASS[c.status]||'badge-gray')}
        ${badge(c.priority||'low', PRIORITY_CLASS[c.priority||'low'])}
        ${badge(c.type||'criminal','badge-blue')}
        ${c.caseGrade ? badge(c.caseGrade,'badge-purple') : ''}
      </div>
    </div>
    <div class="btn-group">
      ${canEditCase ? `<a class="btn-sm" href="/cases/${c.id}/edit">Edit Case</a>` : ''}
      ${canEditCase ? `<a class="btn-sm" href="/warrants/new?caseId=${c.id}">Issue Warrant</a>` : ''}
      ${canWrite    ? `<a class="btn-sm" href="/subpoenas/new?caseId=${c.id}">Issue Subpoena</a>` : ''}
      ${canDelete ? `<form method="post" action="/cases/${c.id}/delete" style="display:inline"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Permanently delete this case?')">Delete</button></form>` : ''}
    </div>
  </div>
  <div class="detail-grid three-col">
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Case Details</div>
      <dl class="detail-list">
        <dt>Case Number</dt><dd class="mono">${escapeHtml(c.caseNumber)}</dd>
        <dt>County</dt><dd>${escapeHtml(c.county||'—')} County, TX</dd>
        <dt>Court</dt><dd>${escapeHtml(c.courtType||'—')}</dd>
        <dt>Offense Grade</dt><dd>${escapeHtml(c.caseGrade||'—')}</dd>
        <dt>Incident Location</dt><dd>${escapeHtml(c.location||'—')}</dd>
        <dt>Filed By</dt><dd>${escapeHtml(c.createdBy)}</dd>
        <dt>Date Filed</dt><dd>${fmtDate(c.createdAt)}</dd>
        <dt>Last Updated</dt><dd>${fmtDate(c.updatedAt)}</dd>
      </dl>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Parties</div>
      <dl class="detail-list">
        <dt>Defendant</dt><dd><strong>${escapeHtml(c.subject)}</strong></dd>
        <dt>Defense Attorney</dt><dd>${escapeHtml(c.defenseAttorney||'—')}</dd>
        <dt>Prosecutor</dt><dd>${escapeHtml(c.prosecutor||'—')}</dd>
        <dt>Lead Officer / ADA</dt><dd>${escapeHtml(c.assignedOfficer||'—')}</dd>
        <dt>Presiding Judge</dt><dd>${escapeHtml(c.presidingJudge||'—')}</dd>
      </dl>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Status & Disposition</div>
      <dl class="detail-list">
        <dt>Plea</dt><dd>${badge(c.plea||'not entered', PLEA_CLASS[c.plea||'not entered']||'badge-gray')}</dd>
        <dt>Verdict</dt><dd>${badge(c.verdict||'pending', VERDICT_CLASS[c.verdict||'pending']||'badge-gray')}</dd>
        <dt>Bond / Bail</dt><dd>${c.bondAmount != null ? `$${Number(c.bondAmount).toLocaleString('en-US',{minimumFractionDigits:2})}` : '—'}</dd>
        <dt>Hearing Date</dt><dd>${fmtDate(c.courtDate)}</dd>
        <dt>Trial Date</dt><dd>${fmtDate(c.trialDate)}</dd>
        <dt>Sentence</dt><dd>${escapeHtml(c.sentence||'—')}</dd>
        ${c.outcome?`<dt>Outcome</dt><dd>${escapeHtml(c.outcome)}</dd>`:''}
        ${c.pleaDealNotes?`<dt>Plea Agreement</dt><dd>${escapeHtml(c.pleaDealNotes)}</dd>`:''}
      </dl>
    </div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Charges</div>
    <div class="tag-wrap">${chargesHtml}</div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Case Summary / Probable Cause</div>
    <p class="case-notes-text">${escapeHtml(c.notes||'No narrative entered.').replace(/\n/g,'<br/>')}</p>
  </div>
  <div class="card">
    <div class="card-header">
      <span class="card-title">Linked Warrants</span>
      ${canEditCase ? `<a class="btn-sm" href="/warrants/new?caseId=${c.id}">+ Issue Warrant</a>` : ''}
    </div>
    <div class="table-header" style="grid-template-columns:1fr 1fr 1fr 1fr"><span>Warrant #</span><span>Type</span><span>Status</span><span>Issued</span></div>
    <div class="table-rows" style="--cols:4">${warrantRows}</div>
  </div>
  <div class="card">
    <div class="card-header">
      <span class="card-title">Subpoenas</span>
      ${canWrite ? `<a class="btn-sm" href="/subpoenas/new?caseId=${c.id}">+ Issue Subpoena</a>` : ''}
    </div>
    <div class="table-header" style="grid-template-columns:1fr 1.5fr 1fr 1fr"><span>Subpoena #</span><span>Recipient</span><span>Status</span><span>Due</span></div>
    <div class="table-rows" style="--cols:4">${subpoenaRows}</div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Case Notes / Journal</div>
    <div class="notes-list">${notesHtml}</div>
    <form method="post" action="/cases/${c.id}/notes" style="margin-top:0.75rem">
      <textarea class="input" name="text" rows="3" placeholder="Add a note, hearing update, or journal entry…" required></textarea>
      <button class="btn-primary" style="margin-top:0.5rem" type="submit">Add Note</button>
    </form>
  </div>
  <div class="card">
    <div class="card-header">
      <span class="card-title">Evidence Log</span>
    </div>
    ${(c.evidence && c.evidence.length) ? `
    <div class="table-header" style="grid-template-columns:1.5fr 1fr 1.5fr 1fr 1fr"><span>Item</span><span>Type</span><span>Description</span><span>Collected By</span><span>Date</span></div>
    <div class="table-rows">
      ${(c.evidence||[]).map(e=>`
      <div class="table-row-link" style="--cols:5">
        <span class="tr-cell fw">${escapeHtml(e.item)}</span>
        <span class="tr-cell">${badge(e.type||'physical','badge-blue')}</span>
        <span class="tr-cell muted-text">${escapeHtml(e.description||'—')}</span>
        <span class="tr-cell muted-text">${escapeHtml(e.collectedBy||'—')}</span>
        <span class="tr-cell muted-text">${fmtDate(e.collectedAt)}</span>
      </div>`).join('')}
    </div>` : '<p class="muted-text" style="padding:0.75rem 0">No evidence logged yet.</p>'}
    ${canWrite ? `
    <form method="post" action="/cases/${c.id}/evidence" style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid #f3f4f6">
      <div class="form-grid">
        <div class="form-group"><label>Evidence Item <span class="req">*</span></label><input class="input" name="item" required placeholder="e.g. Firearm, SIM card, CCTV footage…"/></div>
        <div class="form-group"><label>Type</label><select class="input" name="type"><option value="physical">Physical</option><option value="digital">Digital</option><option value="documentary">Documentary</option><option value="testimonial">Testimonial</option><option value="forensic">Forensic</option><option value="other">Other</option></select></div>
        <div class="form-group"><label>Description</label><input class="input" name="description" placeholder="Brief description of the item"/></div>
        <div class="form-group"><label>Collected By</label><input class="input" name="collectedBy" placeholder="Officer or agency name"/></div>
        <div class="form-group"><label>Collection Date</label><input class="input" type="date" name="collectedAt"/></div>
        <div class="form-group"><label>Location Found</label><input class="input" name="locationFound" placeholder="Where the evidence was recovered"/></div>
      </div>
      <button class="btn-primary" type="submit">Add Evidence</button>
    </form>` : ''}
  </div>`;
  return res.send(layout({ title: `${c.caseNumber} — DOJ`, body, user: req.session.user, page: 'cases' }));
});

app.get('/cases/:id/edit', requirePerm('clerk'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const c = cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).send('Case not found.');
  const chargeOptions = COMMON_CHARGES.map(ch=>`<option value="${escapeHtml(ch)}">${escapeHtml(ch)}</option>`).join('');
  const statusOptions = ['open','investigation','pending','filed','closed','dismissed'].map(s=>`<option value="${s}" ${c.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('');
  const countyOptions = TEXAS_COUNTIES.map(cn=>`<option value="${cn}" ${c.county===cn?'selected':''}>${cn}</option>`).join('');
  const courtOptions  = COURT_TYPES.map(ct=>`<option value="${escapeHtml(ct)}" ${c.courtType===ct?'selected':''}>${escapeHtml(ct)}</option>`).join('');
  const gradeOptions  = CASE_GRADES.map(g=>`<option value="${escapeHtml(g)}" ${c.caseGrade===g?'selected':''}>${escapeHtml(g)}</option>`).join('');
  const pleaOptions   = ['not entered','not guilty','guilty','no contest'].map(p=>`<option value="${p}" ${(c.plea||'not entered')===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('');
  const verdictOptions= ['pending','not guilty','guilty','dismissed','mistrial'].map(v=>`<option value="${v}" ${(c.verdict||'pending')===v?'selected':''}>${v.charAt(0).toUpperCase()+v.slice(1)}</option>`).join('');

  const body = `
  <div class="page-header"><a class="back-link" href="/cases/${c.id}">← Back to case</a><h1 class="page-title">Edit Case — ${escapeHtml(c.caseNumber)}</h1></div>
  <div class="card">
    <form method="post" action="/cases/${c.id}/edit">
      <div class="section-label">Basic Information</div>
      <div class="form-grid">
        <div class="form-group"><label>Case Title <span class="req">*</span></label><input class="input" name="title" value="${escapeHtml(c.title)}" required/></div>
        <div class="form-group"><label>Defendant / Subject <span class="req">*</span></label><input class="input" name="subject" value="${escapeHtml(c.subject)}" required/></div>
        <div class="form-group"><label>Status</label><select class="input" name="status">${statusOptions}</select></div>
        <div class="form-group"><label>Offense Grade</label><select class="input" name="caseGrade"><option value="">— Select —</option>${gradeOptions}</select></div>
        <div class="form-group"><label>Priority</label><select class="input" name="priority">${['low','medium','high','critical'].map(p=>`<option value="${p}" ${(c.priority||'medium')===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}</select></div>
        <div class="form-group"><label>County</label><select class="input" name="county"><option value="">— Select County —</option>${countyOptions}</select></div>
        <div class="form-group"><label>Court Type</label><select class="input" name="courtType"><option value="">— Select Court —</option>${courtOptions}</select></div>
        <div class="form-group"><label>Incident Location</label><input class="input" name="location" value="${escapeHtml(c.location||'')}"/></div>
      </div>
      <div class="section-label">Parties</div>
      <div class="form-grid">
        <div class="form-group"><label>Lead Officer / ADA</label><input class="input" name="assignedOfficer" value="${escapeHtml(c.assignedOfficer||'')}"/></div>
        <div class="form-group"><label>Prosecutor</label><input class="input" name="prosecutor" value="${escapeHtml(c.prosecutor||'')}"/></div>
        <div class="form-group"><label>Defense Attorney</label><input class="input" name="defenseAttorney" value="${escapeHtml(c.defenseAttorney||'')}"/></div>
        <div class="form-group"><label>Presiding Judge</label><input class="input" name="presidingJudge" value="${escapeHtml(c.presidingJudge||'')}"/></div>
      </div>
      <div class="section-label">Plea, Verdict & Dates</div>
      <div class="form-grid">
        <div class="form-group"><label>Plea</label><select class="input" name="plea">${pleaOptions}</select></div>
        <div class="form-group"><label>Verdict</label><select class="input" name="verdict">${verdictOptions}</select></div>
        <div class="form-group"><label>Bond / Bail ($)</label><input class="input" type="number" name="bondAmount" value="${c.bondAmount != null ? c.bondAmount : ''}" min="0" step="0.01"/></div>
        <div class="form-group"><label>Sentence</label><input class="input" name="sentence" value="${escapeHtml(c.sentence||'')}" placeholder="e.g. 10 years TDCJ, probation…"/></div>
        <div class="form-group"><label>Hearing Date</label><input class="input" type="date" name="courtDate" value="${escapeHtml(c.courtDate||'')}"/></div>
        <div class="form-group"><label>Trial Date</label><input class="input" type="date" name="trialDate" value="${escapeHtml(c.trialDate||'')}"/></div>
      </div>
      <div class="form-group"><label>Outcome / Notes on Disposition</label><input class="input" name="outcome" value="${escapeHtml(c.outcome||'')}" placeholder="e.g. Guilty — sentenced 10 yrs TDCJ"/></div>
      <div class="form-group"><label>Plea Deal / Agreement Notes</label><textarea class="input" name="pleaDealNotes" rows="2" placeholder="Detail any plea agreement terms, conditions, or negotiations…">${escapeHtml(c.pleaDealNotes||'')}</textarea></div>
      <div class="section-label">Charges</div>
      <div class="form-group">
        <select class="input" id="chargeSelect" onchange="addCharge(this)"><option value="">— Add a charge —</option>${chargeOptions}</select>
        <input class="input" name="chargesRaw" id="chargesRaw" value="${escapeHtml((c.charges||[]).join(', '))}" style="margin-top:0.5rem" placeholder="Comma-separated"/>
      </div>
      <div class="section-label">Narrative</div>
      <div class="form-group"><label>Case Summary / Probable Cause</label><textarea class="input" name="notes" rows="5">${escapeHtml(c.notes||'')}</textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Save Changes</button><a class="btn-sm" href="/cases/${c.id}">Cancel</a></div>
    </form>
  </div>
  <script>function addCharge(s){if(!s.value)return;const f=document.getElementById('chargesRaw');f.value=f.value.trim()?(f.value.trim()+', '+s.value):s.value;s.value='';}</script>`;
  return res.send(layout({ title: `Edit ${c.caseNumber} — DOJ`, body, user: req.session.user, page: 'cases' }));
});

app.post('/cases/:id/edit', requirePerm('clerk'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const idx = cases.findIndex(x => x.id === req.params.id);
  if (idx===-1) return res.status(404).send('Case not found.');
  const { title, subject, status, caseGrade, priority, county, courtType, location, assignedOfficer, prosecutor, defenseAttorney, presidingJudge, plea, verdict, bondAmount, sentence, courtDate, trialDate, outcome, pleaDealNotes, chargesRaw, notes } = req.body;
  const charges = chargesRaw ? chargesRaw.split(',').map(c=>c.trim()).filter(Boolean) : [];
  Object.assign(cases[idx], {
    title, subject, status, caseGrade: caseGrade||'', priority, county: county||'',
    courtType: courtType||'', location: location||'', assignedOfficer, prosecutor,
    defenseAttorney: defenseAttorney||'', presidingJudge: presidingJudge||'',
    plea: plea||'not entered', verdict: verdict||'pending',
    bondAmount: bondAmount ? parseFloat(bondAmount) : null,
    sentence: sentence||'', courtDate: courtDate||'', trialDate: trialDate||'',
    outcome: outcome||'', pleaDealNotes: pleaDealNotes||'',
    charges, notes: notes||'', updatedAt: new Date().toISOString()
  });
  writeJSON(CASES_FILE, cases);
  logActivity('case_updated', `Case ${cases[idx].caseNumber} updated`, req.session.user.username);
  refreshBotEmbeds();
  return res.redirect(`/cases/${req.params.id}`);
});

app.post('/cases/:id/delete', requirePerm('ag'), (req, res) => {
  let cases = readJSON(CASES_FILE);
  const c = cases.find(x=>x.id===req.params.id);
  if (c) { cases = cases.filter(x=>x.id!==req.params.id); writeJSON(CASES_FILE, cases); logActivity('case_updated', `Case ${c.caseNumber} deleted`, req.session.user.username); refreshBotEmbeds(); }
  return res.redirect('/cases');
});

app.post('/cases/:id/notes', requirePerm('clerk'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const idx = cases.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  const text = (req.body.text||'').trim();
  if (!text) return res.redirect(`/cases/${req.params.id}`);
  if (!cases[idx].caseNotes) cases[idx].caseNotes = [];
  cases[idx].caseNotes.push({ id: newId(), author: req.session.user.username, text, timestamp: new Date().toISOString() });
  cases[idx].updatedAt = new Date().toISOString();
  writeJSON(CASES_FILE, cases);
  logActivity('note_added', `Note added to case ${cases[idx].caseNumber}`, req.session.user.username);
  return res.redirect(`/cases/${req.params.id}`);
});

app.post('/cases/:id/evidence', requirePerm('lawyer'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const idx = cases.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  const { item, type, description, collectedBy, collectedAt, locationFound } = req.body;
  if (!item || !item.trim()) return res.redirect(`/cases/${req.params.id}`);
  if (!cases[idx].evidence) cases[idx].evidence = [];
  cases[idx].evidence.push({
    id: newId(),
    item: item.trim(),
    type: type||'physical',
    description: description||'',
    collectedBy: collectedBy||'',
    collectedAt: collectedAt||'',
    locationFound: locationFound||'',
    addedBy: req.session.user.username,
    addedAt: new Date().toISOString()
  });
  cases[idx].updatedAt = new Date().toISOString();
  writeJSON(CASES_FILE, cases);
  logActivity('evidence_added', `Evidence logged on case ${cases[idx].caseNumber}: ${item.trim()}`, req.session.user.username);
  return res.redirect(`/cases/${req.params.id}`);
});

app.post('/cases/:id/evidence/:evidenceId/delete', requirePerm('lawyer'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const idx = cases.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  cases[idx].evidence = (cases[idx].evidence||[]).filter(e=>e.id!==req.params.evidenceId);
  cases[idx].updatedAt = new Date().toISOString();
  writeJSON(CASES_FILE, cases);
  return res.redirect(`/cases/${req.params.id}`);
});

// ════════════════════════════════════════════════════════════════════════════
// WARRANTS
// ════════════════════════════════════════════════════════════════════════════

app.get('/warrants', requirePerm('citizen'), (req, res) => {
  const { q='', status='', type='' } = req.query;
  const pl = req.session.user.permLevel;
  let warrants = readJSON(WARRANTS_FILE);

  if (!hasPerm(pl,'clerk')) warrants = warrants.filter(w => w.status === 'active');

  if (q)      warrants = warrants.filter(w => [w.warrantNumber,w.subject,w.issuedBy,w.description,w.judge].join(' ').toLowerCase().includes(q.toLowerCase()));
  if (status && hasPerm(pl,'clerk')) warrants = warrants.filter(w => w.status === status);
  if (type)   warrants = warrants.filter(w => w.type === type);

  const rows = warrants.map(w => `
  <a class="table-row-link" href="/warrants/${w.id}" style="--cols:5">
    <span class="tr-cell mono">${escapeHtml(w.warrantNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(w.subject)}</span>
    <span class="tr-cell">${badge(w.type,'badge-blue')}</span>
    <span class="tr-cell">${badge(w.status, WARRANT_STATUS_CLASS[w.status]||'badge-gray')}</span>
    <span class="tr-cell muted-text">${fmtDate(w.issuedAt)}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:1.5rem">No warrants match your search.</p>';

  const citizenNotice = !hasPerm(pl,'clerk') ? `<div class="alert-box">Showing <strong>active warrants only</strong>. Sign in with a staff role to access all warrant records.</div>` : '';

  const body = `
  <div class="page-header row-between">
    <div><h1 class="page-title">Warrants</h1><p class="page-sub">${warrants.length} warrant${warrants.length!==1?'s':''} found.</p></div>
    ${hasPerm(pl,'clerk') ? `<a class="btn-primary" href="/warrants/new">+ Issue Warrant</a>` : ''}
  </div>
  ${citizenNotice}
  <div class="card" style="margin-bottom:1rem">
    <form method="get" class="filter-row">
      <input class="input-sm" name="q" value="${escapeHtml(q)}" placeholder="Search by name, warrant #, or judge…"/>
      ${hasPerm(pl,'clerk') ? `<select class="input-sm" name="status"><option value="">All statuses</option>${['active','executed','expired','cancelled'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}</select>` : ''}
      <select class="input-sm" name="type"><option value="">All types</option>${['arrest','search','bench'].map(t=>`<option value="${t}" ${type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)} Warrant</option>`).join('')}</select>
      <button class="btn-primary" type="submit">Search</button>
      <a class="btn-sm" href="/warrants">Reset</a>
    </form>
  </div>
  <div class="card">
    <div class="table-header" style="grid-template-columns:1fr 1.5fr 1fr 1fr 1fr"><span>Warrant #</span><span>Subject</span><span>Type</span><span>Status</span><span>Issued</span></div>
    <div class="table-rows">${rows}</div>
  </div>`;
  return res.send(layout({ title: 'Warrants — DOJ', body, user: req.session.user, page: 'warrants' }));
});

app.get('/warrants/new', requirePerm('clerk'), (req, res) => {
  const { caseId='' } = req.query;
  const cases = readJSON(CASES_FILE);
  const countyOptions = TEXAS_COUNTIES.map(cn=>`<option value="${cn}">${cn}</option>`).join('');
  const caseOptions = cases.map(c=>`<option value="${c.id}" ${caseId===c.id?'selected':''}>${escapeHtml(c.caseNumber)} — ${escapeHtml(c.title)}</option>`).join('');
  const body = `
  <div class="page-header"><a class="back-link" href="/warrants">← Back to warrants</a><h1 class="page-title">Issue Warrant</h1></div>
  <div class="card">
    <form method="post" action="/warrants">
      <div class="form-grid">
        <div class="form-group"><label>Warrant Type <span class="req">*</span></label><select class="input" name="type" required><option value="arrest">Arrest Warrant</option><option value="search">Search Warrant</option><option value="bench">Bench Warrant</option></select></div>
        <div class="form-group"><label>Subject Name <span class="req">*</span></label><input class="input" name="subject" required placeholder="Full legal name of subject"/></div>
        <div class="form-group"><label>County <span class="req">*</span></label><select class="input" name="county" required><option value="">— Select County —</option>${countyOptions}</select></div>
        <div class="form-group"><label>Issuing Judge <span class="req">*</span></label><input class="input" name="judge" required placeholder="Honorable Judge name"/></div>
        <div class="form-group"><label>Subject DOB</label><input class="input" type="date" name="subjectDob"/></div>
        <div class="form-group"><label>Subject Description</label><input class="input" name="subjectDescription" placeholder="Height, weight, hair, eyes…"/></div>
        <div class="form-group"><label>Address / Location to Search or Arrest</label><input class="input" name="address" placeholder="Street address or last known location"/></div>
        <div class="form-group"><label>Linked Case</label><select class="input" name="linkedCaseId"><option value="">— None —</option>${caseOptions}</select></div>
        <div class="form-group"><label>Issue Date</label><input class="input" type="date" name="issuedAt" value="${new Date().toISOString().split('T')[0]}"/></div>
        <div class="form-group"><label>Expiration Date</label><input class="input" type="date" name="expiresAt"/></div>
      </div>
      <div class="form-group"><label>Probable Cause / Description <span class="req">*</span></label><textarea class="input" name="description" rows="4" required placeholder="Describe the probable cause, charges, and reason for this warrant…"></textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Issue Warrant</button><a class="btn-sm" href="/warrants">Cancel</a></div>
    </form>
  </div>`;
  return res.send(layout({ title: 'Issue Warrant — DOJ', body, user: req.session.user, page: 'warrants' }));
});

app.post('/warrants', requirePerm('clerk'), (req, res) => {
  const { type, subject, county, judge, subjectDob, subjectDescription, address, linkedCaseId, issuedAt, expiresAt, description } = req.body;
  if (!type || !subject || !county || !judge || !description) return res.status(400).send('Missing required fields.');
  const warrants = readJSON(WARRANTS_FILE);
  const w = {
    id: newId(), warrantNumber: nextWarrantNumber(), type, subject,
    county: county||'', judge: judge||'',
    subjectDob: subjectDob||'', subjectDescription: subjectDescription||'',
    address: address||'', linkedCaseId: linkedCaseId||'',
    status: 'active', issuedBy: req.session.user.username,
    issuedAt: issuedAt || new Date().toISOString().split('T')[0],
    expiresAt: expiresAt||'', executedAt: '', description
  };
  warrants.unshift(w);
  writeJSON(WARRANTS_FILE, warrants);
  logActivity('warrant_issued', `${type.charAt(0).toUpperCase()+type.slice(1)} Warrant ${w.warrantNumber} issued for ${subject}`, req.session.user.username);
  refreshBotEmbeds();
  return res.redirect(`/warrants/${w.id}`);
});

app.get('/warrants/:id', requirePerm('citizen'), (req, res) => {
  const warrants = readJSON(WARRANTS_FILE);
  const w = warrants.find(x => x.id === req.params.id);
  if (!w) return res.status(404).send('Warrant not found.');
  const pl = req.session.user.permLevel;
  if (!hasPerm(pl,'clerk') && w.status !== 'active') return res.status(403).send('Access denied.');
  const canWrite  = hasPerm(pl, 'lawyer');
  const canDelete = hasPerm(pl, 'ag');

  const linkedCase = w.linkedCaseId ? readJSON(CASES_FILE).find(c => c.id === w.linkedCaseId) : null;

  const body = `
  <div class="page-header row-between">
    <div>
      <a class="back-link" href="/warrants">← Back to warrants</a>
      <h1 class="page-title">${escapeHtml(w.type.charAt(0).toUpperCase()+w.type.slice(1))} Warrant</h1>
      <div class="badge-row">
        <span class="mono muted-text">${escapeHtml(w.warrantNumber)}</span>
        ${badge(w.status, WARRANT_STATUS_CLASS[w.status]||'badge-gray')}
        ${badge(w.type,'badge-blue')}
      </div>
    </div>
    <div class="btn-group">
      ${canWrite && w.status==='active' ? `
        <button class="btn-primary" type="button" onclick="document.getElementById('executeForm').style.display=document.getElementById('executeForm').style.display==='none'?'block':'none'">Mark Executed</button>` : ''}
      ${canWrite && w.status==='active' ? `<form method="post" action="/warrants/${w.id}/cancel" style="display:inline"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Cancel this warrant?')">Cancel</button></form>` : ''}
      ${canDelete ? `<form method="post" action="/warrants/${w.id}/delete" style="display:inline"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete this warrant?')">Delete</button></form>` : ''}
    </div>
  </div>
  <div class="detail-grid">
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Warrant Details</div>
      <dl class="detail-list">
        <dt>Warrant #</dt><dd class="mono">${escapeHtml(w.warrantNumber)}</dd>
        <dt>Type</dt><dd>${escapeHtml(w.type.charAt(0).toUpperCase()+w.type.slice(1))} Warrant</dd>
        <dt>County</dt><dd>${escapeHtml(w.county||'—')} County, TX</dd>
        <dt>Issuing Judge</dt><dd>${escapeHtml(w.judge||'—')}</dd>
        <dt>Issued By</dt><dd>${escapeHtml(w.issuedBy)}</dd>
        <dt>Issue Date</dt><dd>${fmtDate(w.issuedAt)}</dd>
        <dt>Expiration</dt><dd>${fmtDate(w.expiresAt)}</dd>
        ${w.executedAt ? `<dt>Executed</dt><dd>${fmtDate(w.executedAt)}</dd>` : ''}
      </dl>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Subject Information</div>
      <dl class="detail-list">
        <dt>Subject</dt><dd><strong>${escapeHtml(w.subject)}</strong></dd>
        <dt>Date of Birth</dt><dd>${fmtDate(w.subjectDob)}</dd>
        <dt>Description</dt><dd>${escapeHtml(w.subjectDescription||'—')}</dd>
        <dt>Address / Location</dt><dd>${escapeHtml(w.address||'—')}</dd>
        ${linkedCase ? `<dt>Linked Case</dt><dd><a class="link" href="/cases/${linkedCase.id}">${escapeHtml(linkedCase.caseNumber)} — ${escapeHtml(linkedCase.title)}</a></dd>` : ''}
      </dl>
    </div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Probable Cause / Description</div>
    <p class="case-notes-text">${escapeHtml(w.description||'').replace(/\n/g,'<br/>')}</p>
  </div>
  ${canWrite && w.status==='active' ? `
  <div id="executeForm" style="display:none">
    <div class="card">
      <div class="card-title" style="margin-bottom:0.75rem">Warrant Return — Mark as Executed</div>
      <p class="muted-text" style="margin-bottom:1rem;font-size:0.875rem">Optionally attach the signed warrant return document (up to 250 MB) before confirming execution.</p>
      <form method="post" action="/warrants/${w.id}/execute" enctype="multipart/form-data">
        <div class="form-group" style="margin-bottom:1rem">
          <label>Return Document <span class="muted-text" style="font-weight:400;font-size:0.8rem">(optional — max 250 MB)</span></label>
          <input class="input" type="file" name="returnDoc" accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.webp,.mp4,.mov,.zip"/>
          <p class="muted-text" style="font-size:0.78rem;margin-top:0.3rem">Accepted: PDF, Word, images, video, ZIP — up to 250 MB</p>
        </div>
        <div class="form-actions">
          <button class="btn-primary" type="submit" onclick="return confirm('Confirm execution of this warrant?')">Confirm Execution</button>
          <button class="btn-sm" type="button" onclick="document.getElementById('executeForm').style.display='none'">Cancel</button>
        </div>
      </form>
    </div>
  </div>` : ''}
  ${(w.status==='executed' || w.returnFile) ? `
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Warrant Return</div>
    <dl class="detail-list">
      ${w.executedBy ? `<dt>Executed By</dt><dd><strong>${escapeHtml(w.executedBy)}</strong></dd>` : ''}
      ${w.executedAt ? `<dt>Executed At</dt><dd>${fmtDate(w.executedAt)}</dd>` : ''}
      ${w.returnFile ? `<dt>Return Document</dt><dd><a class="link" href="/warrant-return-files/${encodeURIComponent(w.returnFile)}" download="${escapeHtml(w.returnFileName||w.returnFile)}">📎 ${escapeHtml(w.returnFileName||w.returnFile)}</a></dd>` : '<dt>Return Document</dt><dd class="muted-text">No document attached</dd>'}
    </dl>
  </div>` : ''}`;
  return res.send(layout({ title: `${w.warrantNumber} — DOJ`, body, user: req.session.user, page: 'warrants' }));
});

app.post('/warrants/:id/execute', requirePerm('lawyer'), wrReturnUpload.single('returnDoc'), (req, res) => {
  const warrants = readJSON(WARRANTS_FILE);
  const idx = warrants.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  warrants[idx].status = 'executed';
  warrants[idx].executedAt = new Date().toISOString();
  warrants[idx].executedBy = req.session.user.username;
  if (req.file) {
    warrants[idx].returnFile = req.file.filename;
    warrants[idx].returnFileName = req.file.originalname;
  }
  writeJSON(WARRANTS_FILE, warrants);
  logActivity('warrant_executed', `Warrant ${warrants[idx].warrantNumber} executed by ${req.session.user.username}`, req.session.user.username);
  refreshBotEmbeds();
  return res.redirect(`/warrants/${req.params.id}`);
});

app.post('/warrants/:id/cancel', requirePerm('lawyer'), (req, res) => {
  const warrants = readJSON(WARRANTS_FILE);
  const idx = warrants.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  warrants[idx].status = 'cancelled';
  writeJSON(WARRANTS_FILE, warrants);
  logActivity('warrant_executed', `Warrant ${warrants[idx].warrantNumber} cancelled`, req.session.user.username);
  refreshBotEmbeds();
  return res.redirect(`/warrants/${req.params.id}`);
});

app.post('/warrants/:id/delete', requirePerm('ag'), (req, res) => {
  let warrants = readJSON(WARRANTS_FILE);
  warrants = warrants.filter(x=>x.id!==req.params.id);
  writeJSON(WARRANTS_FILE, warrants);
  refreshBotEmbeds();
  return res.redirect('/warrants');
});

// ════════════════════════════════════════════════════════════════════════════
// DEFENDANTS
// ════════════════════════════════════════════════════════════════════════════

app.get('/defendants', requirePerm('clerk'), (req, res) => {
  const { q='' } = req.query;
  const pl = req.session.user.permLevel;
  let defendants = readJSON(DEFENDANTS_FILE);
  if (q) defendants = defendants.filter(d => [d.fullName, d.dob, d.address, d.notes].join(' ').toLowerCase().includes(q.toLowerCase()));

  const rows = defendants.map(d => `
  <a class="table-row-link" href="/defendants/${d.id}" style="--cols:4">
    <span class="tr-cell fw">${escapeHtml(d.fullName)}</span>
    <span class="tr-cell muted-text">${fmtDate(d.dob)}</span>
    <span class="tr-cell muted-text">${escapeHtml(d.address||'—')}</span>
    <span class="tr-cell muted-text">${fmtDate(d.createdAt)}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:1.5rem">No defendants on record.</p>';

  const body = `
  <div class="page-header row-between">
    <div><h1 class="page-title">Defendants</h1><p class="page-sub">${defendants.length} record${defendants.length!==1?'s':''} found.</p></div>
    ${hasPerm(pl,'lawyer') ? `<a class="btn-primary" href="/defendants/new">+ Add Defendant</a>` : ''}
  </div>
  <div class="card" style="margin-bottom:1rem">
    <form method="get" class="filter-row" id="defSearch">
      <div class="autocomplete-wrap" style="flex:1">
        <input class="input-sm" name="q" id="defQ" value="${escapeHtml(q)}" placeholder="Search by name or Discord username…" style="width:100%" autocomplete="off"/>
        <div class="autocomplete-list" id="defAC"></div>
      </div>
      <button class="btn-primary" type="submit">Search</button>
      <a class="btn-sm" href="/defendants">Reset</a>
    </form>
  </div>
  <script>
  (function(){
    const inp=document.getElementById('defQ'), list=document.getElementById('defAC');
    let timer;
    inp.addEventListener('input',function(){
      clearTimeout(timer);
      const v=inp.value.trim();
      if(v.length<2){list.classList.remove('open');list.innerHTML='';return;}
      timer=setTimeout(async()=>{
        const r=await fetch('/api/members?q='+encodeURIComponent(v));
        const names=await r.json();
        list.innerHTML=names.map(n=>'<div class="autocomplete-item">'+n+'</div>').join('');
        list.classList.toggle('open',names.length>0);
        list.querySelectorAll('.autocomplete-item').forEach(el=>{
          el.addEventListener('mousedown',function(e){e.preventDefault();inp.value=this.textContent;list.classList.remove('open');document.getElementById('defSearch').submit();});
        });
      },250);
    });
    document.addEventListener('click',function(e){if(!inp.contains(e.target)&&!list.contains(e.target))list.classList.remove('open');});
  })();
  </script>
  <div class="card">
    <div class="table-header" style="grid-template-columns:1.5fr 1fr 1.5fr 1fr"><span>Full Name</span><span>Date of Birth</span><span>Address</span><span>Added</span></div>
    <div class="table-rows">${rows}</div>
  </div>`;
  return res.send(layout({ title: 'Defendants — DOJ', body, user: req.session.user, page: 'defendants' }));
});

app.get('/defendants/new', requirePerm('lawyer'), (req, res) => {
  const countyOptions = TEXAS_COUNTIES.map(cn=>`<option value="${cn}">${cn}</option>`).join('');
  const body = `
  <div class="page-header"><a class="back-link" href="/defendants">← Back</a><h1 class="page-title">Add Defendant Record</h1></div>
  <div class="card">
    <form method="post" action="/defendants">
      <div class="form-grid">
        <div class="form-group"><label>Full Legal Name <span class="req">*</span></label><input class="input" name="fullName" required/></div>
        <div class="form-group"><label>Date of Birth</label><input class="input" type="date" name="dob"/></div>
        <div class="form-group"><label>Race / Ethnicity</label><input class="input" name="race" placeholder="As noted in official records"/></div>
        <div class="form-group"><label>Height</label><input class="input" name="height" placeholder="e.g. 5'10&quot;"/></div>
        <div class="form-group"><label>Weight</label><input class="input" name="weight" placeholder="e.g. 180 lbs"/></div>
        <div class="form-group"><label>Hair Color</label><input class="input" name="hair"/></div>
        <div class="form-group"><label>Eye Color</label><input class="input" name="eyes"/></div>
        <div class="form-group"><label>Address</label><input class="input" name="address" placeholder="Street address"/></div>
        <div class="form-group"><label>City</label><input class="input" name="city"/></div>
        <div class="form-group"><label>County</label><select class="input" name="county"><option value="">— Select —</option>${countyOptions}</select></div>
        <div class="form-group"><label>Phone</label><input class="input" name="phone" type="tel"/></div>
      </div>
      <div class="form-group"><label>Additional Notes</label><textarea class="input" name="notes" rows="3" placeholder="Known associates, aliases, priors…"></textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Save Record</button><a class="btn-sm" href="/defendants">Cancel</a></div>
    </form>
  </div>`;
  return res.send(layout({ title: 'Add Defendant — DOJ', body, user: req.session.user, page: 'defendants' }));
});

app.post('/defendants', requirePerm('lawyer'), (req, res) => {
  const { fullName, dob, race, height, weight, hair, eyes, address, city, county, phone, notes } = req.body;
  if (!fullName) return res.status(400).send('Name is required.');
  const defendants = readJSON(DEFENDANTS_FILE);
  const d = {
    id: newId(), fullName, dob: dob||'',
    race: race||'', height: height||'', weight: weight||'',
    hair: hair||'', eyes: eyes||'', address: address||'',
    city: city||'', county: county||'', phone: phone||'', notes: notes||'',
    createdBy: req.session.user.username, createdAt: new Date().toISOString()
  };
  defendants.unshift(d);
  writeJSON(DEFENDANTS_FILE, defendants);
  logActivity('defendant_added', `Defendant record added: ${fullName}`, req.session.user.username);
  return res.redirect(`/defendants/${d.id}`);
});

app.get('/defendants/:id', requirePerm('clerk'), (req, res) => {
  const defendants = readJSON(DEFENDANTS_FILE);
  const d = defendants.find(x => x.id === req.params.id);
  if (!d) return res.status(404).send('Record not found.');
  const pl = req.session.user.permLevel;
  const linkedCases = readJSON(CASES_FILE).filter(c => c.subject && c.subject.toLowerCase() === d.fullName.toLowerCase());
  const linkedWarrants = readJSON(WARRANTS_FILE).filter(w => w.subject && w.subject.toLowerCase() === d.fullName.toLowerCase());

  const caseRows = linkedCases.map(c=>`
  <a class="table-row-link" href="/cases/${c.id}" style="--cols:3">
    <span class="tr-cell mono">${escapeHtml(c.caseNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(c.title)}</span>
    <span class="tr-cell">${badge(c.status, CASE_STATUS_CLASS[c.status]||'badge-gray')}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:0.75rem">No linked cases found.</p>';

  const warrantRows = linkedWarrants.map(w=>`
  <a class="table-row-link" href="/warrants/${w.id}" style="--cols:3">
    <span class="tr-cell mono">${escapeHtml(w.warrantNumber)}</span>
    <span class="tr-cell">${badge(w.type,'badge-blue')}</span>
    <span class="tr-cell">${badge(w.status, WARRANT_STATUS_CLASS[w.status]||'badge-gray')}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:0.75rem">No linked warrants found.</p>';

  const body = `
  <div class="page-header row-between">
    <div>
      <a class="back-link" href="/defendants">← Back to defendants</a>
      <h1 class="page-title">${escapeHtml(d.fullName)}</h1>
      <p class="page-sub">Defendant Record</p>
    </div>
    ${hasPerm(pl,'ag') ? `<form method="post" action="/defendants/${d.id}/delete"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete this record?')">Delete</button></form>` : ''}
  </div>
  <div class="detail-grid">
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Personal Information</div>
      <dl class="detail-list">
        <dt>Full Name</dt><dd><strong>${escapeHtml(d.fullName)}</strong></dd>
        <dt>Date of Birth</dt><dd>${fmtDate(d.dob)}</dd>
        <dt>Race / Ethnicity</dt><dd>${escapeHtml(d.race||'—')}</dd>
        <dt>Height</dt><dd>${escapeHtml(d.height||'—')}</dd>
        <dt>Weight</dt><dd>${escapeHtml(d.weight||'—')}</dd>
        <dt>Hair Color</dt><dd>${escapeHtml(d.hair||'—')}</dd>
        <dt>Eye Color</dt><dd>${escapeHtml(d.eyes||'—')}</dd>
      </dl>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Contact & Location</div>
      <dl class="detail-list">
        <dt>Address</dt><dd>${escapeHtml(d.address||'—')}</dd>
        <dt>City</dt><dd>${escapeHtml(d.city||'—')}</dd>
        <dt>County</dt><dd>${escapeHtml(d.county||'—')}${d.county?' County, TX':''}</dd>
        <dt>Phone</dt><dd>${escapeHtml(d.phone||'—')}</dd>
        <dt>Added By</dt><dd>${escapeHtml(d.createdBy)}</dd>
        <dt>Date Added</dt><dd>${fmtDate(d.createdAt)}</dd>
      </dl>
      ${d.notes ? `<div class="card-title" style="margin-top:1rem;margin-bottom:0.5rem">Notes</div><p class="case-notes-text">${escapeHtml(d.notes).replace(/\n/g,'<br/>')}</p>` : ''}
    </div>
  </div>
  <div class="two-col">
    <div class="card">
      <div class="card-header"><span class="card-title">Cases (${linkedCases.length})</span></div>
      <div class="table-rows">${caseRows}</div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Warrants (${linkedWarrants.length})</span></div>
      <div class="table-rows">${warrantRows}</div>
    </div>
  </div>`;
  return res.send(layout({ title: `${d.fullName} — DOJ`, body, user: req.session.user, page: 'defendants' }));
});

app.post('/defendants/:id/delete', requirePerm('ag'), (req, res) => {
  let defendants = readJSON(DEFENDANTS_FILE);
  defendants = defendants.filter(x=>x.id!==req.params.id);
  writeJSON(DEFENDANTS_FILE, defendants);
  return res.redirect('/defendants');
});

// ════════════════════════════════════════════════════════════════════════════
// SUBPOENAS
// ════════════════════════════════════════════════════════════════════════════

app.get('/subpoenas', requirePerm('clerk'), (req, res) => {
  const { q='', status='' } = req.query;
  const pl = req.session.user.permLevel;
  let subpoenas = readJSON(SUBPOENAS_FILE);
  if (q)      subpoenas = subpoenas.filter(s => [s.subpoenaNumber,s.recipient,s.issuedBy,s.purpose].join(' ').toLowerCase().includes(q.toLowerCase()));
  if (status) subpoenas = subpoenas.filter(s => s.status === status);

  const rows = subpoenas.map(s => `
  <a class="table-row-link" href="/subpoenas/${s.id}" style="--cols:5">
    <span class="tr-cell mono">${escapeHtml(s.subpoenaNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(s.recipient)}</span>
    <span class="tr-cell">${badge(s.type||'testimony','badge-blue')}</span>
    <span class="tr-cell">${badge(s.status, SUBPOENA_STATUS_CLASS[s.status]||'badge-gray')}</span>
    <span class="tr-cell muted-text">${fmtDate(s.dueDate)}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:1.5rem">No subpoenas found.</p>';

  const body = `
  <div class="page-header row-between">
    <div><h1 class="page-title">Subpoenas</h1><p class="page-sub">${subpoenas.length} subpoena${subpoenas.length!==1?'s':''} found.</p></div>
    ${hasPerm(pl,'lawyer') ? `<a class="btn-primary" href="/subpoenas/new">+ Issue Subpoena</a>` : ''}
  </div>
  <div class="card" style="margin-bottom:1rem">
    <form method="get" class="filter-row">
      <input class="input-sm" name="q" value="${escapeHtml(q)}" placeholder="Search by recipient or subpoena #…"/>
      <select class="input-sm" name="status"><option value="">All statuses</option>${['pending','served','failed','quashed'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}</select>
      <button class="btn-primary" type="submit">Filter</button>
      <a class="btn-sm" href="/subpoenas">Reset</a>
    </form>
  </div>
  <div class="card">
    <div class="table-header" style="grid-template-columns:1fr 1.5fr 1fr 1fr 1fr"><span>Subpoena #</span><span>Recipient</span><span>Type</span><span>Status</span><span>Due Date</span></div>
    <div class="table-rows">${rows}</div>
  </div>`;
  return res.send(layout({ title: 'Subpoenas — DOJ', body, user: req.session.user, page: 'subpoenas' }));
});

app.get('/subpoenas/new', requirePerm('lawyer'), (req, res) => {
  const { caseId='' } = req.query;
  const cases = readJSON(CASES_FILE);
  const caseOptions = cases.map(c=>`<option value="${c.id}" ${caseId===c.id?'selected':''}>${escapeHtml(c.caseNumber)} — ${escapeHtml(c.title)}</option>`).join('');
  const body = `
  <div class="page-header"><a class="back-link" href="/subpoenas">← Back</a><h1 class="page-title">Issue Subpoena</h1></div>
  <div class="card">
    <form method="post" action="/subpoenas">
      <div class="form-grid">
        <div class="form-group"><label>Recipient Name <span class="req">*</span></label><input class="input" name="recipient" required placeholder="Full name of person or entity"/></div>
        <div class="form-group"><label>Subpoena Type</label><select class="input" name="type"><option value="testimony">Testimony (Ad Testificandum)</option><option value="documents">Documents (Duces Tecum)</option><option value="both">Testimony & Documents</option></select></div>
        <div class="form-group"><label>Linked Case</label><select class="input" name="linkedCaseId"><option value="">— None —</option>${caseOptions}</select></div>
        <div class="form-group"><label>Due Date / Appear By <span class="req">*</span></label><input class="input" type="date" name="dueDate" required/></div>
        <div class="form-group"><label>Hearing Location</label><input class="input" name="location" placeholder="Court address or meeting point"/></div>
        <div class="form-group"><label>Issued By (Attorney)</label><input class="input" name="issuedBy" value="${escapeHtml(req.session.user.username)}"/></div>
      </div>
      <div class="form-group"><label>Purpose / Instructions <span class="req">*</span></label><textarea class="input" name="purpose" rows="3" required placeholder="What is required of the recipient?"></textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Issue Subpoena</button><a class="btn-sm" href="/subpoenas">Cancel</a></div>
    </form>
  </div>`;
  return res.send(layout({ title: 'Issue Subpoena — DOJ', body, user: req.session.user, page: 'subpoenas' }));
});

app.post('/subpoenas', requirePerm('lawyer'), (req, res) => {
  const { recipient, type, linkedCaseId, dueDate, location, issuedBy, purpose } = req.body;
  if (!recipient || !dueDate || !purpose) return res.status(400).send('Missing required fields.');
  const subpoenas = readJSON(SUBPOENAS_FILE);
  const s = {
    id: newId(), subpoenaNumber: nextSubpoenaNumber(),
    recipient, type: type||'testimony', linkedCaseId: linkedCaseId||'',
    dueDate, location: location||'', issuedBy: issuedBy||req.session.user.username,
    purpose, status: 'pending', createdAt: new Date().toISOString()
  };
  subpoenas.unshift(s);
  writeJSON(SUBPOENAS_FILE, subpoenas);
  logActivity('subpoena_issued', `Subpoena ${s.subpoenaNumber} issued to ${recipient}`, req.session.user.username);
  return res.redirect(`/subpoenas/${s.id}`);
});

app.get('/subpoenas/:id', requirePerm('clerk'), (req, res) => {
  const subpoenas = readJSON(SUBPOENAS_FILE);
  const s = subpoenas.find(x => x.id === req.params.id);
  if (!s) return res.status(404).send('Subpoena not found.');
  const pl = req.session.user.permLevel;
  const linkedCase = s.linkedCaseId ? readJSON(CASES_FILE).find(c => c.id === s.linkedCaseId) : null;
  const canWrite = hasPerm(pl,'lawyer');

  const body = `
  <div class="page-header row-between">
    <div>
      <a class="back-link" href="/subpoenas">← Back to subpoenas</a>
      <h1 class="page-title">Subpoena — ${escapeHtml(s.subpoenaNumber)}</h1>
      <div class="badge-row">
        ${badge(s.status, SUBPOENA_STATUS_CLASS[s.status]||'badge-gray')}
        ${badge(s.type||'testimony','badge-blue')}
      </div>
    </div>
    <div class="btn-group">
      ${canWrite && s.status==='pending' ? `<form method="post" action="/subpoenas/${s.id}/serve"><button class="btn-primary" type="submit">Mark Served</button></form>` : ''}
      ${canWrite && s.status==='pending' ? `<form method="post" action="/subpoenas/${s.id}/quash"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Quash this subpoena?')">Quash</button></form>` : ''}
      ${hasPerm(pl,'ag') ? `<form method="post" action="/subpoenas/${s.id}/delete"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete?')">Delete</button></form>` : ''}
    </div>
  </div>
  <div class="card">
    <dl class="detail-list">
      <dt>Subpoena #</dt><dd class="mono">${escapeHtml(s.subpoenaNumber)}</dd>
      <dt>Recipient</dt><dd><strong>${escapeHtml(s.recipient)}</strong></dd>
      <dt>Type</dt><dd>${escapeHtml(s.type||'—')}</dd>
      <dt>Due Date</dt><dd>${fmtDate(s.dueDate)}</dd>
      <dt>Location</dt><dd>${escapeHtml(s.location||'—')}</dd>
      <dt>Issued By</dt><dd>${escapeHtml(s.issuedBy)}</dd>
      <dt>Filed</dt><dd>${fmtDate(s.createdAt)}</dd>
      ${linkedCase ? `<dt>Linked Case</dt><dd><a class="link" href="/cases/${linkedCase.id}">${escapeHtml(linkedCase.caseNumber)} — ${escapeHtml(linkedCase.title)}</a></dd>` : ''}
    </dl>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Purpose / Instructions</div>
    <p class="case-notes-text">${escapeHtml(s.purpose||'').replace(/\n/g,'<br/>')}</p>
  </div>`;
  return res.send(layout({ title: `${s.subpoenaNumber} — DOJ`, body, user: req.session.user, page: 'subpoenas' }));
});

app.post('/subpoenas/:id/serve', requirePerm('lawyer'), (req, res) => {
  const subpoenas = readJSON(SUBPOENAS_FILE);
  const idx = subpoenas.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  subpoenas[idx].status = 'served';
  writeJSON(SUBPOENAS_FILE, subpoenas);
  return res.redirect(`/subpoenas/${req.params.id}`);
});

app.post('/subpoenas/:id/quash', requirePerm('lawyer'), (req, res) => {
  const subpoenas = readJSON(SUBPOENAS_FILE);
  const idx = subpoenas.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  subpoenas[idx].status = 'quashed';
  writeJSON(SUBPOENAS_FILE, subpoenas);
  return res.redirect(`/subpoenas/${req.params.id}`);
});

app.post('/subpoenas/:id/delete', requirePerm('ag'), (req, res) => {
  let subpoenas = readJSON(SUBPOENAS_FILE);
  subpoenas = subpoenas.filter(x=>x.id!==req.params.id);
  writeJSON(SUBPOENAS_FILE, subpoenas);
  return res.redirect('/subpoenas');
});

// ════════════════════════════════════════════════════════════════════════════
// COURT CALENDAR
// ════════════════════════════════════════════════════════════════════════════

app.get('/calendar', requirePerm('clerk'), (req, res) => {
  const { month='' } = req.query;
  const cases = readJSON(CASES_FILE);
  const today = new Date();
  const targetDate = month ? new Date(month + '-01') : new Date(today.getFullYear(), today.getMonth(), 1);
  const monthStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
  const monthEnd   = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 0);

  const prevMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() - 1, 1);
  const nextMonth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;

  const hearings = cases.filter(c => c.courtDate && new Date(c.courtDate) >= monthStart && new Date(c.courtDate) <= monthEnd)
    .sort((a,b) => new Date(a.courtDate)-new Date(b.courtDate));
  const trials = cases.filter(c => c.trialDate && new Date(c.trialDate) >= monthStart && new Date(c.trialDate) <= monthEnd)
    .sort((a,b) => new Date(a.trialDate)-new Date(b.trialDate));

  const hearingRows = hearings.map(c => `
  <div class="calendar-event hearing">
    <div class="cal-event-date">${fmtDate(c.courtDate)}</div>
    <div class="cal-event-body">
      <a class="cal-event-title" href="/cases/${c.id}">${escapeHtml(c.caseNumber)} — ${escapeHtml(c.title)}</a>
      <div class="cal-event-meta">${badge('Hearing','badge-blue')} ${escapeHtml(c.courtType||'')} · ${escapeHtml(c.county||'')} County · ${escapeHtml(c.subject)}</div>
    </div>
  </div>`).join('') || '<p class="muted-text" style="padding:1rem">No hearings scheduled this month.</p>';

  const trialRows = trials.map(c => `
  <div class="calendar-event trial">
    <div class="cal-event-date">${fmtDate(c.trialDate)}</div>
    <div class="cal-event-body">
      <a class="cal-event-title" href="/cases/${c.id}">${escapeHtml(c.caseNumber)} — ${escapeHtml(c.title)}</a>
      <div class="cal-event-meta">${badge('Trial','badge-purple')} ${escapeHtml(c.courtType||'')} · ${escapeHtml(c.county||'')} County · ${escapeHtml(c.subject)}</div>
    </div>
  </div>`).join('') || '<p class="muted-text" style="padding:1rem">No trials scheduled this month.</p>';

  const monthLabel = targetDate.toLocaleDateString('en-US',{month:'long',year:'numeric'});

  const body = `
  <div class="page-header row-between">
    <div><h1 class="page-title">Court Calendar</h1><p class="page-sub">State of Texas — Department of Justice</p></div>
    <div class="btn-group">
      <a class="btn-sm" href="/calendar?month=${fmt(prevMonth)}">← Previous</a>
      <span style="font-weight:600;padding:0 0.5rem">${monthLabel}</span>
      <a class="btn-sm" href="/calendar?month=${fmt(nextMonth)}">Next →</a>
    </div>
  </div>
  <div class="two-col">
    <div class="card">
      <div class="card-header"><span class="card-title">Hearings (${hearings.length})</span></div>
      <div>${hearingRows}</div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Trials (${trials.length})</span></div>
      <div>${trialRows}</div>
    </div>
  </div>`;
  return res.send(layout({ title: `Calendar — DOJ`, body, user: req.session.user, page: 'calendar' }));
});

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENTS (Discord channel file storage)
// ════════════════════════════════════════════════════════════════════════════

app.get('/channels', requirePerm('clerk'), async (req, res) => {
  const user = req.session.user;
  let channels = [];
  try {
    channels = await getAccessibleChannels(user.id, user.roleIds || [], user.isAdmin || false);
  } catch {}

  if (!channels.length) {
    const body = `
    <div class="page-header"><h1 class="page-title">Documents</h1></div>
    <div class="empty-state"><p>No document channels configured. Ensure your bot is set up and channels are prefixed with <code>dc-</code>.</p></div>`;
    return res.send(layout({ title: 'Documents — DOJ', body, user, page: 'channels' }));
  }

  const channelCards = channels.map(ch => {
    const files = getChannelFiles(ch.id);
    return `
    <a class="channel-card" href="/channels/${ch.id}">
      <div class="channel-info">
        <div class="channel-name">${escapeHtml(formatChannelName(ch.name))}</div>
        <div class="channel-meta">${files.length} file${files.length!==1?'s':''}</div>
      </div>
      <span class="channel-arrow">→</span>
    </a>`;
  }).join('');

  const body = `
  <div class="page-header"><h1 class="page-title">Documents</h1><p class="page-sub">Files are organized by Discord case channel.</p></div>
  <div class="channel-list">${channelCards}</div>`;
  return res.send(layout({ title: 'Documents — DOJ', body, user, page: 'channels' }));
});

app.get('/channels/:channelId', requirePerm('clerk'), async (req, res) => {
  const user = req.session.user;
  const { channelId } = req.params;
  let channels = [];
  try { channels = await getAccessibleChannels(user.id, user.roleIds||[], user.isAdmin||false); } catch {}
  const channel = channels.find(c => c.id === channelId);
  const resolvedName = channel ? formatChannelName(channel.name) : channelId;

  const files = getChannelFiles(channelId);
  const fileRows = files.map(f => {
    const ext = path.extname(f.originalName).replace('.','').toUpperCase() || 'FILE';
    return `
    <div class="file-row">
      <div class="file-ext">${escapeHtml(ext)}</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(f.originalName)}</div>
        <div class="file-meta">${formatSize(f.size)} · ${fmtDateTime(f.uploadedAt)}</div>
      </div>
      <div class="file-actions">
        <a class="btn-sm" href="/channels/${channelId}/files/${encodeURIComponent(f.filename)}" download="${escapeHtml(f.originalName)}">Download</a>
        ${hasPerm(user.permLevel,'clerk') ? `<form method="post" action="/channels/${channelId}/files/${encodeURIComponent(f.filename)}/delete" style="display:inline"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete file?')">Delete</button></form>` : ''}
      </div>
    </div>`;
  }).join('');

  const body = `
  <div class="page-header row-between">
    <div><a class="back-link" href="/channels">← Back to documents</a><h1 class="page-title">${escapeHtml(resolvedName)}</h1></div>
  </div>
  <div class="upload-box">
    <form method="post" action="/channels/${channelId}/upload" enctype="multipart/form-data">
      <label class="upload-label" for="fileInput">
        <div class="upload-text">Click to upload a file</div>
        <div class="upload-hint">Max 250 MB · Any file type</div>
        <input type="file" id="fileInput" name="file" required style="display:none" onchange="this.closest('form').submit()"/>
      </label>
    </form>
  </div>
  <div class="file-list">${files.length===0?`<div class="empty-state"><p>No documents yet.</p></div>`:fileRows}</div>`;
  return res.send(layout({ title: `${resolvedName} — DOJ`, body, user, page: 'channels' }));
});

app.post('/channels/:channelId/upload', requirePerm('clerk'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).send('No file uploaded.');
  logActivity('file_uploaded', `"${req.file.originalname}" uploaded`, req.session.user.username);
  return res.redirect(`/channels/${req.params.channelId}`);
});

app.get('/channels/:channelId/files/:filename', requirePerm('clerk'), (req, res) => {
  const { channelId, filename } = req.params;
  const fp = path.join(UPLOADS_DIR, channelId, filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found.');
  res.download(fp, filename.replace(/^\d+_/,''));
});

app.post('/channels/:channelId/files/:filename/delete', requirePerm('clerk'), (req, res) => {
  const fp = path.join(UPLOADS_DIR, req.params.channelId, req.params.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  return res.redirect(`/channels/${req.params.channelId}`);
});

// ════════════════════════════════════════════════════════════════════════════
// WARRANT REQUESTS (citizen-facing)
// ════════════════════════════════════════════════════════════════════════════

const WR_STATUS_CLASS = { pending:'badge-yellow', approved:'badge-green', denied:'badge-red' };

app.get('/warrant-request', ensureAuth, (req, res) => {
  const countyOptions = TEXAS_COUNTIES.map(cn=>`<option value="${cn}">${cn}</option>`).join('');
  const user = req.session.user;
  const myRequests = readJSON(WARRANT_REQUESTS_FILE)
    .filter(r => r.requesterId === user.id)
    .slice(0, 10);
  const myRows = myRequests.map(r => `
  <div class="request-card">
    <div class="request-info">
      <div class="request-subject">${escapeHtml(r.subject)} <span class="mono muted-text">${escapeHtml(r.requestNumber)}</span></div>
      <div class="request-meta">${escapeHtml(r.type.charAt(0).toUpperCase()+r.type.slice(1))} Warrant · ${escapeHtml(r.county)} County · Filed ${fmtDate(r.createdAt)}</div>
      <div class="request-reason">${escapeHtml((r.reason||'').slice(0,200))}</div>
      ${r.reviewedBy ? `<div class="request-reviewer" style="margin-top:0.4rem;font-size:0.8rem;color:#6b7280">
        ${r.status==='approved'?'✅ Signed & approved':'❌ Reviewed'} by <strong>${escapeHtml(r.reviewedBy)}</strong> on ${fmtDate(r.reviewedAt)}
        ${r.reviewNote ? ` — <em>${escapeHtml(r.reviewNote)}</em>` : ''}
      </div>` : ''}
      ${r.attachmentName ? `<div style="margin-top:0.3rem;font-size:0.8rem"><a class="link" href="/warrant-request-files/${encodeURIComponent(r.attachmentFile)}" download="${escapeHtml(r.attachmentName)}">📎 ${escapeHtml(r.attachmentName)}</a></div>` : ''}
    </div>
    <div class="request-actions">${badge(r.status, WR_STATUS_CLASS[r.status]||'badge-gray')}</div>
  </div>`).join('') || '<p class="muted-text" style="padding:0.5rem 0">You have not submitted any warrant requests yet.</p>';

  const submitted = req.query.submitted === '1';
  const body = `
  ${submitted ? `<div class="alert-success" style="margin-bottom:1rem;padding:0.75rem 1rem;background:#d1fae5;border:1px solid #6ee7b7;border-radius:0.5rem;color:#065f46">Your warrant request has been submitted and is pending review.</div>` : ''}
  <div class="page-header">
    <h1 class="page-title">Request a Warrant</h1>
    <p class="page-sub">Submit a warrant request to the Department of Justice. A clerk or judge will review and sign your request.</p>
  </div>
  <div class="card">
    <form method="post" action="/warrant-request" enctype="multipart/form-data">
      <div class="section-label">Warrant Details</div>
      <div class="form-grid">
        <div class="form-group"><label>Subject Name <span class="req">*</span></label><input class="input" name="subject" required placeholder="Full legal name of the person you are reporting"/></div>
        <div class="form-group"><label>Warrant Type <span class="req">*</span></label><select class="input" name="type" required><option value="arrest">Arrest Warrant</option><option value="search">Search Warrant</option><option value="bench">Bench Warrant</option></select></div>
        <div class="form-group"><label>County <span class="req">*</span></label><select class="input" name="county" required><option value="">— Select County —</option>${countyOptions}</select></div>
        <div class="form-group"><label>Date of Incident</label><input class="input" type="date" name="incidentDate"/></div>
      </div>
      <div class="section-label">Your Information</div>
      <div class="form-grid">
        <div class="form-group"><label>Your Name <span class="req">*</span></label><input class="input" name="requesterDisplay" required value="${escapeHtml(user.username)}" placeholder="Your full name or alias"/></div>
        <div class="form-group"><label>Contact / Discord</label><input class="input" name="contact" value="${escapeHtml(user.username)}" placeholder="How to reach you"/></div>
      </div>
      <div class="section-label">Description</div>
      <div class="form-group"><label>Reason / Description <span class="req">*</span></label><textarea class="input" name="reason" rows="5" required placeholder="Describe the incident, why you believe a warrant is needed, any evidence or witnesses…"></textarea></div>
      <div class="section-label">Supporting Document <span class="muted-text" style="font-weight:400;font-size:0.8rem">(optional — max 250 MB)</span></div>
      <div class="form-group">
        <label>Attach File</label>
        <input class="input" type="file" name="attachment" accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg,.webp,.mp4,.mov,.zip"/>
        <p class="muted-text" style="font-size:0.78rem;margin-top:0.3rem">Accepted: PDF, Word, images, video, ZIP — up to 250 MB</p>
      </div>
      <div class="form-actions"><button class="btn-primary" type="submit">Submit Request</button></div>
    </form>
  </div>
  ${myRequests.length ? `
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Your Previous Requests</div>
    ${myRows}
  </div>` : ''}`;
  return res.send(layout({ title: 'Request Warrant — DOJ', body, user, page: 'warrant-request' }));
});

app.post('/warrant-request', ensureAuth, wrUpload.single('attachment'), (req, res) => {
  const { subject, type, county, incidentDate, requesterDisplay, contact, reason } = req.body;
  if (!subject || !type || !county || !reason) return res.status(400).send('Missing required fields.');
  const user = req.session.user;
  const reqs = readJSON(WARRANT_REQUESTS_FILE);
  const record = {
    id: newId(),
    requestNumber: nextWarrantRequestNumber(),
    requesterId: user.id,
    requesterUsername: user.username,
    requesterDisplay: requesterDisplay||user.username,
    contact: contact||'',
    subject, type, county, incidentDate: incidentDate||'',
    reason, status: 'pending',
    createdAt: new Date().toISOString(),
    reviewedBy: '', reviewedAt: '', reviewNote: '', linkedWarrantId: '',
    attachmentFile: req.file ? req.file.filename : '',
    attachmentName: req.file ? req.file.originalname : ''
  };
  reqs.unshift(record);
  writeJSON(WARRANT_REQUESTS_FILE, reqs);
  logActivity('warrant_issued', `Warrant request ${record.requestNumber} submitted for ${subject}`, user.username);
  return res.redirect('/warrant-request?submitted=1');
});

// Clerk/Judge warrant request management
app.get('/warrant-requests', requirePerm('clerk'), (req, res) => {
  const { status='' } = req.query;
  const pl = req.session.user.permLevel;
  let reqs = readJSON(WARRANT_REQUESTS_FILE);
  if (status) reqs = reqs.filter(r => r.status === status);

  const rows = reqs.map(r => `
  <div class="request-card">
    <div class="request-info">
      <div class="request-subject">${escapeHtml(r.subject)} <span class="mono muted-text">${escapeHtml(r.requestNumber)}</span></div>
      <div class="request-meta">
        ${badge(r.status, WR_STATUS_CLASS[r.status]||'badge-gray')}
        ${badge(r.type+' warrant','badge-blue')}
        · ${escapeHtml(r.county)} County · Submitted by <strong>${escapeHtml(r.requesterDisplay||r.requesterUsername)}</strong> · ${fmtDate(r.createdAt)}
      </div>
      <div class="request-reason">${escapeHtml((r.reason||'').slice(0,300))}</div>
      ${r.attachmentName ? `<div style="margin-top:0.4rem;font-size:0.8rem"><a class="link" href="/warrant-request-files/${encodeURIComponent(r.attachmentFile)}" download="${escapeHtml(r.attachmentName)}">📎 ${escapeHtml(r.attachmentName)}</a></div>` : ''}
      ${r.reviewedBy ? `
      <div style="margin-top:0.6rem;padding:0.5rem 0.75rem;background:${r.status==='approved'?'#f0fdf4':'#fef2f2'};border-radius:0.4rem;border:1px solid ${r.status==='approved'?'#bbf7d0':'#fecaca'}">
        <span style="font-size:0.8rem;font-weight:600;color:${r.status==='approved'?'#166534':'#991b1b'}">
          ${r.status==='approved'?'✅ Signed &amp; Approved':'❌ Denied'} by ${escapeHtml(r.reviewedBy)}
        </span>
        <span style="font-size:0.78rem;color:#6b7280"> · ${fmtDate(r.reviewedAt)}</span>
        ${r.reviewNote ? `<br/><span style="font-size:0.78rem;color:#374151;font-style:italic">"${escapeHtml(r.reviewNote)}"</span>` : ''}
      </div>` : ''}
    </div>
    <div class="request-actions" style="flex-direction:column;align-items:flex-end;gap:0.5rem;">
      ${r.status==='pending' && hasPerm(pl,'clerk') ? `
        <form method="post" action="/warrant-requests/${r.id}/approve" style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;">
          <input class="input-sm" name="note" placeholder="Signing note (optional)" style="width:160px"/>
          <button class="btn-primary" type="submit" style="font-size:0.8rem;padding:0.3rem 0.75rem">Sign &amp; Approve</button>
        </form>
        <form method="post" action="/warrant-requests/${r.id}/deny" style="display:flex;gap:0.4rem;align-items:center;flex-wrap:wrap;">
          <input class="input-sm" name="note" placeholder="Reason for denial" style="width:160px"/>
          <button class="btn-sm btn-danger" type="submit" style="font-size:0.8rem">Deny</button>
        </form>` : ''}
      ${r.linkedWarrantId ? `<a class="btn-sm" href="/warrants/${r.linkedWarrantId}" style="font-size:0.8rem">View Warrant →</a>` : ''}
    </div>
  </div>`).join('') || '<p class="muted-text" style="padding:1rem">No requests match your filter.</p>';

  const pending = readJSON(WARRANT_REQUESTS_FILE).filter(r=>r.status==='pending').length;
  const body = `
  <div class="page-header row-between">
    <div>
      <h1 class="page-title">Warrant Requests</h1>
      <p class="page-sub">${reqs.length} request${reqs.length!==1?'s':''} · ${pending} pending review &amp; signature</p>
    </div>
  </div>
  <div class="card" style="margin-bottom:1rem">
    <form method="get" class="filter-row">
      <select class="input-sm" name="status">
        <option value="">All statuses</option>
        ${['pending','approved','denied'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}
      </select>
      <button class="btn-primary" type="submit">Filter</button>
      <a class="btn-sm" href="/warrant-requests">Reset</a>
    </form>
  </div>
  <div>${rows}</div>`;
  return res.send(layout({ title: 'Warrant Requests — DOJ', body, user: req.session.user, page: 'warrant-requests' }));
});

app.post('/warrant-requests/:id/approve', requirePerm('clerk'), (req, res) => {
  const reqs = readJSON(WARRANT_REQUESTS_FILE);
  const idx = reqs.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).send('Not found.');
  const r = reqs[idx];
  const note = (req.body.note||'').trim();

  const warrants = readJSON(WARRANTS_FILE);
  const w = {
    id: newId(), warrantNumber: nextWarrantNumber(), type: r.type, subject: r.subject,
    county: r.county, judge: '', subjectDob: '', subjectDescription: '',
    address: '', linkedCaseId: '',
    status: 'active', issuedBy: req.session.user.username,
    issuedAt: new Date().toISOString().split('T')[0],
    expiresAt: '', executedAt: '',
    description: `Warrant request ${r.requestNumber} approved.\n\n${r.reason}`
  };
  warrants.unshift(w);
  writeJSON(WARRANTS_FILE, warrants);

  reqs[idx].status = 'approved';
  reqs[idx].reviewedBy = req.session.user.username;
  reqs[idx].reviewedAt = new Date().toISOString();
  reqs[idx].reviewNote = note;
  reqs[idx].linkedWarrantId = w.id;
  writeJSON(WARRANT_REQUESTS_FILE, reqs);

  logActivity('warrant_issued', `Warrant ${w.warrantNumber} approved from request ${r.requestNumber} — ${r.subject}`, req.session.user.username);
  refreshBotEmbeds();
  return res.redirect('/warrant-requests');
});

app.post('/warrant-requests/:id/deny', requirePerm('clerk'), (req, res) => {
  const reqs = readJSON(WARRANT_REQUESTS_FILE);
  const idx = reqs.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).send('Not found.');
  reqs[idx].status = 'denied';
  reqs[idx].reviewedBy = req.session.user.username;
  reqs[idx].reviewedAt = new Date().toISOString();
  reqs[idx].reviewNote = (req.body.note||'').trim();
  writeJSON(WARRANT_REQUESTS_FILE, reqs);
  return res.redirect('/warrant-requests');
});

app.get('/warrant-request-files/:filename', ensureAuth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const fp = path.join(WARRANT_REQ_UPLOADS_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found.');
  res.download(fp);
});

app.get('/warrant-return-files/:filename', requirePerm('clerk'), (req, res) => {
  const filename = path.basename(req.params.filename);
  const fp = path.join(WARRANT_RETURN_UPLOADS_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).send('File not found.');
  res.download(fp);
});

// ════════════════════════════════════════════════════════════════════════════
// SEARCH
// ════════════════════════════════════════════════════════════════════════════

app.get('/search', ensureAuth, (req, res) => {
  const { q='' } = req.query;
  const lq = q.toLowerCase().trim();
  const pl = req.session.user.permLevel;

  let caseResults=[], warrantResults=[], subpoenaResults=[], defendantResults=[], fileResults=[];
  if (lq) {
    if (hasPerm(pl,'clerk')) {
      caseResults = readJSON(CASES_FILE).filter(c => [c.caseNumber,c.title,c.subject,c.assignedOfficer,c.prosecutor,c.defenseAttorney,c.notes,...(c.charges||[])].join(' ').toLowerCase().includes(lq)).slice(0,10);
      subpoenaResults = readJSON(SUBPOENAS_FILE).filter(s => [s.subpoenaNumber,s.recipient,s.purpose].join(' ').toLowerCase().includes(lq)).slice(0,5);
      defendantResults = readJSON(DEFENDANTS_FILE).filter(d => [d.fullName,d.address].join(' ').toLowerCase().includes(lq)).slice(0,5);
    }
    const warrants = readJSON(WARRANTS_FILE);
    const searchableWarrants = hasPerm(pl,'clerk') ? warrants : warrants.filter(w=>w.status==='active');
    warrantResults = searchableWarrants.filter(w => [w.warrantNumber,w.subject,w.issuedBy,w.judge,w.description].join(' ').toLowerCase().includes(lq)).slice(0,10);

    if (hasPerm(pl,'clerk') && fs.existsSync(UPLOADS_DIR)) {
      for (const dir of fs.readdirSync(UPLOADS_DIR)) {
        const dp = path.join(UPLOADS_DIR, dir);
        if (!fs.statSync(dp).isDirectory()) continue;
        for (const fn of fs.readdirSync(dp)) {
          if (fn.replace(/^\d+_/,'').toLowerCase().includes(lq)) {
            const stat = fs.statSync(path.join(dp,fn));
            fileResults.push({ channelId: dir, filename: fn, originalName: fn.replace(/^\d+_/,''), size: stat.size });
            if (fileResults.length>=10) break;
          }
        }
        if (fileResults.length>=10) break;
      }
    }
  }
  const total = caseResults.length + warrantResults.length + subpoenaResults.length + defendantResults.length + fileResults.length;
  const body = `
  <div class="page-header"><h1 class="page-title">Search</h1></div>
  <div class="card" style="margin-bottom:1.25rem">
    <form method="get" class="filter-row">
      <input class="input" name="q" value="${escapeHtml(q)}" placeholder="Search cases, warrants, defendants, subpoenas, documents…" style="flex:1" autofocus/>
      <button class="btn-primary" type="submit">Search</button>
    </form>
  </div>
  ${lq?`<p class="muted-text" style="margin-bottom:1rem">${total} result${total!==1?'s':''} for "<strong>${escapeHtml(q)}</strong>"</p>`:''}
  ${caseResults.length?`<div class="card" style="margin-bottom:1rem"><div class="card-title" style="margin-bottom:0.75rem">Cases (${caseResults.length})</div>${caseResults.map(c=>`<a class="table-row-link" href="/cases/${c.id}" style="--cols:3"><span class="tr-cell mono">${escapeHtml(c.caseNumber)}</span><span class="tr-cell fw">${escapeHtml(c.title)}</span><span class="tr-cell">${badge(c.status,CASE_STATUS_CLASS[c.status]||'badge-gray')}</span></a>`).join('')}</div>`:''}
  ${warrantResults.length?`<div class="card" style="margin-bottom:1rem"><div class="card-title" style="margin-bottom:0.75rem">Warrants (${warrantResults.length})</div>${warrantResults.map(w=>`<a class="table-row-link" href="/warrants/${w.id}" style="--cols:3"><span class="tr-cell mono">${escapeHtml(w.warrantNumber)}</span><span class="tr-cell fw">${escapeHtml(w.subject)}</span><span class="tr-cell">${badge(w.status,WARRANT_STATUS_CLASS[w.status]||'badge-gray')}</span></a>`).join('')}</div>`:''}
  ${defendantResults.length?`<div class="card" style="margin-bottom:1rem"><div class="card-title" style="margin-bottom:0.75rem">Defendants (${defendantResults.length})</div>${defendantResults.map(d=>`<a class="table-row-link" href="/defendants/${d.id}" style="--cols:2"><span class="tr-cell fw">${escapeHtml(d.fullName)}</span><span class="tr-cell muted-text">${fmtDate(d.dob)}</span></a>`).join('')}</div>`:''}
  ${subpoenaResults.length?`<div class="card" style="margin-bottom:1rem"><div class="card-title" style="margin-bottom:0.75rem">Subpoenas (${subpoenaResults.length})</div>${subpoenaResults.map(s=>`<a class="table-row-link" href="/subpoenas/${s.id}" style="--cols:3"><span class="tr-cell mono">${escapeHtml(s.subpoenaNumber)}</span><span class="tr-cell fw">${escapeHtml(s.recipient)}</span><span class="tr-cell">${badge(s.status,SUBPOENA_STATUS_CLASS[s.status]||'badge-gray')}</span></a>`).join('')}</div>`:''}
  ${fileResults.length?`<div class="card"><div class="card-title" style="margin-bottom:0.75rem">Documents (${fileResults.length})</div>${fileResults.map(f=>`<div class="file-row"><div class="file-ext">FILE</div><div class="file-info"><div class="file-name">${escapeHtml(f.originalName)}</div><div class="file-meta">${formatSize(f.size)}</div></div><a class="btn-sm" href="/channels/${f.channelId}/files/${encodeURIComponent(f.filename)}" download="${escapeHtml(f.originalName)}">Download</a></div>`).join('')}</div>`:''}
  ${lq&&total===0?`<div class="empty-state"><p>No results for "<strong>${escapeHtml(q)}</strong>".</p></div>`:''}
  ${!lq?`<div class="empty-state"><p>Enter a search term above to search across all records.</p></div>`:''}`;
  return res.send(layout({ title: 'Search — DOJ', body, user: req.session.user, page: 'search' }));
});

let _bot = null;
let _lastBotErrLog = 0;
function refreshBotEmbeds() {
  if (!_bot) return;
  _bot.refreshEmbeds().catch(err => {
    const now = Date.now();
    if (now - _lastBotErrLog > 60000) {
      console.error('[DOJ Bot] Refresh error:', err.message);
      _lastBotErrLog = now;
    }
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`DOJ Portal running at http://0.0.0.0:${PORT}`);
  if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CLIENT_ID) {
    try { _bot = require('./bot'); } catch (err) { console.error('[DOJ Bot] Failed to start:', err.message); }
  } else {
    console.log('[DOJ Bot] No bot token configured — bot will not start.');
  }
});
