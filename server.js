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
const DATA_DIR      = path.join(__dirname, 'data');
const UPLOADS_DIR   = path.join(DATA_DIR, 'uploads');
const CASES_FILE    = path.join(DATA_DIR, 'cases.json');
const WARRANTS_FILE = path.join(DATA_DIR, 'warrants.json');
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');

for (const d of [DATA_DIR, UPLOADS_DIR])
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
for (const f of [CASES_FILE, WARRANTS_FILE, ACTIVITY_FILE])
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

// ════════════════════════════════════════════════════════════════════════════
// ROLE / PERMISSION SYSTEM
// ════════════════════════════════════════════════════════════════════════════

/*
  Tiers (each inherits from the ones below):
    citizen  – can view active warrants & run warrant searches
    clerk    – citizen + view/upload/download documents, view cases, add case notes
    lawyer   – clerk + create/edit cases, issue/execute warrants
    ag       – lawyer + delete cases/warrants, full admin

  Role detection works by matching the member's Discord role names (case-insensitive)
  against keyword lists. First match wins; list order is: ag → lawyer → clerk → citizen.
*/
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

// ── Discord permission helpers ────────────────────────────────────────────────
const VIEW_CHANNEL = 1n << 10n;
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
  if (isAdmin) roleNames.unshift('Attorney General'); // Discord admins → AG tier
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

// ── Badge helpers ─────────────────────────────────────────────────────────────
const CASE_STATUS_CLASS = { open:'badge-green', investigation:'badge-blue', pending:'badge-yellow', filed:'badge-purple', closed:'badge-gray', dismissed:'badge-red' };
const WARRANT_STATUS_CLASS = { active:'badge-green', executed:'badge-gray', expired:'badge-red', cancelled:'badge-red' };
const PRIORITY_CLASS = { low:'badge-gray', medium:'badge-yellow', high:'badge-orange', critical:'badge-red' };
const PERM_LEVEL_CLASS = { citizen:'badge-gray', clerk:'badge-blue', lawyer:'badge-purple', ag:'badge-green' };
const PERM_LEVEL_LABEL = { citizen:'Citizen / Texan', clerk:'Court Clerk', lawyer:'Lawyer / ADA', ag:'Attorney General' };

function badge(text, cls='badge-gray') {
  return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
}

// ── Charges list ──────────────────────────────────────────────────────────────
const COMMON_CHARGES = [
  'Murder (PC 187)','Attempted Murder (PC 664/187)','Manslaughter (PC 192)',
  'Assault (PC 240)','Battery (PC 242)','Assault with Deadly Weapon (PC 245)',
  'Robbery (PC 211)','Grand Theft Auto (PC 487[d])','Burglary (PC 459)',
  'Arson (PC 451)','Kidnapping (PC 207)','Carjacking (PC 215)',
  'Drug Possession (HS 11350)','Drug Trafficking (HS 11352)',
  'Possession of Firearm by Felon (PC 29800)','Brandishing a Weapon (PC 417)',
  'Money Laundering (PC 186.10)','Extortion (PC 518)','Vandalism (PC 594)',
  'Trespassing (PC 602)','Resisting Arrest (PC 148[a])','Obstruction of Justice (PC 148.9)',
  'Public Intoxication (PC 647[f])','Possession of Illegal Weapon (PC 12020)',
  'Reckless Driving (VC 23103)','DUI (VC 23152)','Evading Police (VC 2800.1)',
  'Felony Evading (VC 2800.2)','Hit and Run (VC 20001)','Street Racing (VC 23109)',
  'Speeding (VC 22350)','Driving with Suspended License (VC 14601)',
  'False Imprisonment (PC 236)','Perjury (PC 118)','Bribery (PC 67)',
  'Fraud (PC 532)','Identity Theft (PC 530.5)'
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
      return res.status(403).send(layout({ title: 'Access Denied — DOJ RP', body, user: req.session.user, page: '' }));
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

  const nav = user ? `
  <div class="subnav">
    <a class="subnav-link${page==='dashboard'?' active':''}" href="/dashboard">Dashboard</a>
    ${canWarrants ? `<a class="subnav-link${page==='warrants'?' active':''}" href="/warrants">Warrants</a>` : ''}
    ${canCases    ? `<a class="subnav-link${page==='cases'?' active':''}" href="/cases">Cases</a>` : ''}
    ${canDocs     ? `<a class="subnav-link${page==='channels'?' active':''}" href="/channels">Documents</a>` : ''}
    <a class="subnav-link${page==='search'?' active':''}" href="/search">Search</a>
  </div>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css"/>
</head>
<body>
  <nav class="topbar">
    <a class="topbar-brand" href="${user?'/dashboard':'/'}">DOJ RP Portal</a>
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
      <h1 class="login-title">DOJ RP Portal</h1>
      <p class="login-sub">Sign in with your Discord account. Access is determined by your server role.</p>
      ${ready
        ? `<a class="btn-discord" href="${authUrl(state)}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
            Sign in with Discord
          </a>
`
        : `<div class="alert-box">Discord credentials not configured. Set <code>DISCORD_CLIENT_ID</code> and <code>DISCORD_CLIENT_SECRET</code>.</div>`}
    </div>
  </div>`;
  return res.send(layout({ title: 'Sign In — DOJ RP Portal', body, user: null }));
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

    // Fetch roles from guild and determine permission level
    let permLevel = 'citizen';
    let roleNames = [];
    if (config.botToken && config.guildId) {
      try {
        const info = await fetchMemberInfo(user.id);
        roleNames = info.roleNames;
        permLevel = info.isAdmin ? 'ag' : detectPermLevel(roleNames);
      } catch { /* bot unavailable, default to citizen */ }
    } else {
      // No bot token configured — grant full access for setup purposes
      permLevel = 'ag';
      roleNames = ['Attorney General'];
    }

    req.session.user = { id: user.id, username: user.username, discriminator: user.discriminator, permLevel, roleNames };
    delete req.session.oauthState;
    return res.redirect('/dashboard');
  } catch (err) { return res.status(500).send(`Login failed: ${escapeHtml(err.message)}`); }
});

app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));

// Refresh roles mid-session (user visits /refresh-roles)
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
  const cases    = readJSON(CASES_FILE);
  const warrants = readJSON(WARRANTS_FILE);
  const activity = readJSON(ACTIVITY_FILE).slice(0, 10);

  const openCases      = cases.filter(c => !['closed','dismissed'].includes(c.status)).length;
  const activeWarrants = warrants.filter(w => w.status === 'active').length;
  const totalDocs      = getTotalFileCount();

  // Role display
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
      ${hasPerm(pl,'clerk')   ? '<span class="perm-chip perm-yes">✓ Documents</span>' : ''}
      ${hasPerm(pl,'lawyer')  ? '<span class="perm-chip perm-yes">✓ Create Cases</span>' : ''}
      ${hasPerm(pl,'lawyer')  ? '<span class="perm-chip perm-yes">✓ Issue Warrants</span>' : ''}
      ${hasPerm(pl,'ag')      ? '<span class="perm-chip perm-yes">✓ Full Admin</span>' : ''}
      ${!hasPerm(pl,'clerk')  ? '<span class="perm-chip perm-no">✗ Cases</span>' : ''}
      ${!hasPerm(pl,'clerk')  ? '<span class="perm-chip perm-no">✗ Documents</span>' : ''}
      ${!hasPerm(pl,'lawyer') ? '<span class="perm-chip perm-no">✗ Create/Edit</span>' : ''}
    </div>
  </div>`;

  // Citizen view — just warrant lookup
  if (pl === 'citizen') {
    const body = `
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <p class="page-sub">Signed in as ${escapeHtml(user.username)}.</p>
    </div>
    ${permBanner}
    <div class="card">
      <div class="card-title" style="margin-bottom:0.75rem">Warrant Lookup</div>
      <p style="font-size:0.9rem;color:#6b7280;margin-bottom:1rem">Search for active warrants by subject name or warrant number.</p>
      <form method="get" action="/warrants" class="filter-row">
        <input class="input" name="q" placeholder="Search by name or warrant number…" style="flex:1"/>
        <button class="btn-primary" type="submit">Search Warrants</button>
      </form>
    </div>
    <div class="alert-box" style="margin-top:0">
      Your Discord role gives you <strong>Citizen</strong> access. If you are DOJ staff, make sure you have the correct role assigned in the Discord server, then <a href="/refresh-roles" style="color:#92400e;text-decoration:underline">click here to refresh your access</a>.
    </div>`;
    return res.send(layout({ title: 'Dashboard — DOJ RP', body, user, page: 'dashboard' }));
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
  <a class="table-row-link" href="/cases/${c.id}">
    <span class="tr-cell mono">${escapeHtml(c.caseNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(c.title)}</span>
    <span class="tr-cell">${badge(c.status, CASE_STATUS_CLASS[c.status]||'badge-gray')}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:1rem">No cases yet.</p>';

  const body = `
  <div class="page-header row-between">
    <div>
      <h1 class="page-title">Dashboard</h1>
      <p class="page-sub">Signed in as ${escapeHtml(user.username)}.</p>
    </div>
    <div class="btn-group">
      ${hasPerm(pl,'lawyer') ? `<a class="btn-primary" href="/cases/new">+ New Case</a>` : ''}
      ${hasPerm(pl,'lawyer') ? `<a class="btn-sm" href="/warrants/new">Issue Warrant</a>` : ''}
    </div>
  </div>

  ${permBanner}

  <div class="stats-grid">
    <div class="stat-card"><div class="stat-number">${cases.length}</div><div class="stat-label">Total Cases</div></div>
    <div class="stat-card stat-card-green"><div class="stat-number">${openCases}</div><div class="stat-label">Active Cases</div></div>
    <div class="stat-card stat-card-red"><div class="stat-number">${activeWarrants}</div><div class="stat-label">Active Warrants</div></div>
    <div class="stat-card stat-card-blue"><div class="stat-number">${totalDocs}</div><div class="stat-label">Documents</div></div>
  </div>

  <div class="two-col">
    <div class="card">
      <div class="card-header">
        <span class="card-title">Recent Cases</span>
        ${hasPerm(pl,'lawyer') ? `<a class="btn-sm" href="/cases/new">+ New</a>` : ''}
      </div>
      <div class="table-rows">${recentCases}</div>
      <a class="card-footer-link" href="/cases">View all cases →</a>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Recent Activity</span></div>
      <div class="activity-list">${activityRows}</div>
    </div>
  </div>`;

  return res.send(layout({ title: 'Dashboard — DOJ RP', body, user, page: 'dashboard' }));
});

function activityIcon(type) {
  return { case_created:'NEW', case_updated:'UPD', case_closed:'CLO', warrant_issued:'WRT', warrant_executed:'EXE', file_uploaded:'DOC', note_added:'NOTE' }[type] || '–';
}

// ════════════════════════════════════════════════════════════════════════════
// CASES  (clerk = view only, lawyer+ = full write, ag = delete too)
// ════════════════════════════════════════════════════════════════════════════

app.get('/cases', requirePerm('clerk'), (req, res) => {
  const { q='', status='', type='', priority='' } = req.query;
  const pl = req.session.user.permLevel;
  let cases = readJSON(CASES_FILE);
  if (q)        cases = cases.filter(c => [c.caseNumber,c.title,c.subject,c.assignedOfficer,c.notes,...(c.charges||[])].join(' ').toLowerCase().includes(q.toLowerCase()));
  if (status)   cases = cases.filter(c => c.status === status);
  if (type)     cases = cases.filter(c => c.type === type);
  if (priority) cases = cases.filter(c => c.priority === priority);

  const rows = cases.map(c => `
  <a class="table-row-link" href="/cases/${c.id}">
    <span class="tr-cell mono">${escapeHtml(c.caseNumber)}</span>
    <span class="tr-cell fw">${escapeHtml(c.title)}</span>
    <span class="tr-cell">${escapeHtml(c.subject)}</span>
    <span class="tr-cell">${badge(c.status, CASE_STATUS_CLASS[c.status]||'badge-gray')}</span>
    <span class="tr-cell">${badge(c.priority||'low', PRIORITY_CLASS[c.priority||'low'])}</span>
    <span class="tr-cell muted-text">${fmtDate(c.createdAt)}</span>
  </a>`).join('') || '<p class="muted-text" style="padding:1.5rem">No cases match your filters.</p>';

  const body = `
  <div class="page-header row-between">
    <div><h1 class="page-title">Cases</h1><p class="page-sub">${cases.length} case${cases.length!==1?'s':''} found.</p></div>
    ${hasPerm(pl,'lawyer') ? `<a class="btn-primary" href="/cases/new">+ New Case</a>` : ''}
  </div>
  <div class="card" style="margin-bottom:1rem">
    <form method="get" class="filter-row">
      <input class="input-sm" name="q" value="${escapeHtml(q)}" placeholder="Search cases…"/>
      <select class="input-sm" name="status"><option value="">All statuses</option>${['open','investigation','pending','filed','closed','dismissed'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}</select>
      <select class="input-sm" name="type"><option value="">All types</option>${['criminal','traffic','civil','internal affairs'].map(t=>`<option value="${t}" ${type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}</select>
      <select class="input-sm" name="priority"><option value="">All priorities</option>${['low','medium','high','critical'].map(p=>`<option value="${p}" ${priority===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}</select>
      <button class="btn-primary" type="submit">Filter</button>
      <a class="btn-sm" href="/cases">Reset</a>
    </form>
  </div>
  <div class="card">
    <div class="table-header"><span>Case #</span><span>Title</span><span>Subject</span><span>Status</span><span>Priority</span><span>Filed</span></div>
    <div class="table-rows">${rows}</div>
  </div>`;

  return res.send(layout({ title: 'Cases — DOJ RP', body, user: req.session.user, page: 'cases' }));
});

app.get('/cases/new', requirePerm('lawyer'), (req, res) => {
  const chargeOptions = COMMON_CHARGES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  const body = `
  <div class="page-header"><a class="back-link" href="/cases">← Back to cases</a><h1 class="page-title">New Case</h1></div>
  <div class="card">
    <form method="post" action="/cases">
      <div class="form-grid">
        <div class="form-group"><label>Case Title <span class="req">*</span></label><input class="input" name="title" required placeholder="Brief description"/></div>
        <div class="form-group"><label>Subject / Defendant <span class="req">*</span></label><input class="input" name="subject" required placeholder="Full name"/></div>
        <div class="form-group"><label>Case Type <span class="req">*</span></label><select class="input" name="type" required><option value="criminal">Criminal</option><option value="traffic">Traffic</option><option value="civil">Civil</option><option value="internal affairs">Internal Affairs</option></select></div>
        <div class="form-group"><label>Priority</label><select class="input" name="priority"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option><option value="critical">Critical</option></select></div>
        <div class="form-group"><label>Assigned Officer / ADA</label><input class="input" name="assignedOfficer" placeholder="Officer or attorney name"/></div>
        <div class="form-group"><label>Prosecutor</label><input class="input" name="prosecutor" placeholder="Prosecutor name"/></div>
        <div class="form-group"><label>Incident Location</label><input class="input" name="location" placeholder="Where did this occur?"/></div>
        <div class="form-group"><label>Court Date</label><input class="input" type="date" name="courtDate"/></div>
      </div>
      <div class="form-group">
        <label>Charges</label>
        <p class="field-hint">Pick from the list or type custom ones comma-separated.</p>
        <select class="input" id="chargeSelect" onchange="addCharge(this)"><option value="">— Add a common charge —</option>${chargeOptions}</select>
        <input class="input" name="chargesRaw" id="chargesRaw" placeholder="Charges (comma-separated)" style="margin-top:0.5rem"/>
      </div>
      <div class="form-group"><label>Case Notes</label><textarea class="input" name="notes" rows="4" placeholder="Describe the incident, evidence, relevant details…"></textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Create Case</button><a class="btn-sm" href="/cases">Cancel</a></div>
    </form>
  </div>
  <script>function addCharge(s){if(!s.value)return;const f=document.getElementById('chargesRaw');f.value=f.value.trim()?(f.value.trim()+', '+s.value):s.value;s.value='';}</script>`;
  return res.send(layout({ title: 'New Case — DOJ RP', body, user: req.session.user, page: 'cases' }));
});

app.post('/cases', requirePerm('lawyer'), (req, res) => {
  const { title, subject, type, priority, assignedOfficer, prosecutor, location, courtDate, chargesRaw, notes } = req.body;
  if (!title || !subject || !type) return res.status(400).send('Missing required fields.');
  const charges = chargesRaw ? chargesRaw.split(',').map(c=>c.trim()).filter(Boolean) : [];
  const cases = readJSON(CASES_FILE);
  const newCase = {
    id: newId(), caseNumber: nextCaseNumber(), title, subject, type, status: 'open',
    priority: priority||'medium', assignedOfficer: assignedOfficer||'', prosecutor: prosecutor||'',
    location: location||'', courtDate: courtDate||'', charges, notes: notes||'', caseNotes: [],
    createdBy: req.session.user.username, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  cases.unshift(newCase);
  writeJSON(CASES_FILE, cases);
  logActivity('case_created', `Case ${newCase.caseNumber} created — ${title}`, req.session.user.username);
  return res.redirect(`/cases/${newCase.id}`);
});

app.get('/cases/:id', requirePerm('clerk'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const c = cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).send('Case not found.');
  const pl = req.session.user.permLevel;
  const linkedWarrants = readJSON(WARRANTS_FILE).filter(w => w.linkedCaseId === c.id);
  const canWrite  = hasPerm(pl, 'lawyer');
  const canDelete = hasPerm(pl, 'ag');

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
      </div>
    </div>
    <div class="btn-group">
      ${canWrite  ? `<a class="btn-sm" href="/cases/${c.id}/edit">Edit</a>` : ''}
      ${canDelete ? `<form method="post" action="/cases/${c.id}/delete" style="display:inline"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete this case?')">Delete</button></form>` : ''}
    </div>
  </div>
  <div class="detail-grid">
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Case Details</div>
      <dl class="detail-list">
        <dt>Subject</dt><dd>${escapeHtml(c.subject)}</dd>
        <dt>Assigned Officer / ADA</dt><dd>${escapeHtml(c.assignedOfficer||'—')}</dd>
        <dt>Prosecutor</dt><dd>${escapeHtml(c.prosecutor||'—')}</dd>
        <dt>Location</dt><dd>${escapeHtml(c.location||'—')}</dd>
        <dt>Court Date</dt><dd>${fmtDate(c.courtDate)}</dd>
        <dt>Filed By</dt><dd>${escapeHtml(c.createdBy)}</dd>
        <dt>Opened</dt><dd>${fmtDate(c.createdAt)}</dd>
        <dt>Last Updated</dt><dd>${fmtDate(c.updatedAt)}</dd>
        ${c.outcome?`<dt>Outcome</dt><dd>${escapeHtml(c.outcome)}</dd>`:''}
      </dl>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:0.75rem">Charges</div>
      <div class="tag-wrap">${chargesHtml}</div>
      <div class="card-title" style="margin-top:1.25rem;margin-bottom:0.75rem">Summary / Notes</div>
      <p class="case-notes-text">${escapeHtml(c.notes||'No notes.').replace(/\n/g,'<br/>')}</p>
    </div>
  </div>
  <div class="card">
    <div class="card-header">
      <span class="card-title">Linked Warrants</span>
      ${canWrite ? `<a class="btn-sm" href="/warrants/new?caseId=${c.id}">+ Issue Warrant</a>` : ''}
    </div>
    <div class="table-header" style="grid-template-columns:1fr 1fr 1fr 1fr"><span>Warrant #</span><span>Type</span><span>Status</span><span>Issued</span></div>
    <div class="table-rows" style="--cols:4">${warrantRows}</div>
  </div>
  <div class="card">
    <div class="card-title" style="margin-bottom:0.75rem">Case Notes</div>
    <div class="notes-list">${notesHtml}</div>
    <form method="post" action="/cases/${c.id}/notes" style="margin-top:0.75rem">
      <textarea class="input" name="text" rows="2" placeholder="Add a note…" required></textarea>
      <button class="btn-primary" style="margin-top:0.5rem" type="submit">Add Note</button>
    </form>
  </div>`;
  return res.send(layout({ title: `${c.caseNumber} — DOJ RP`, body, user: req.session.user, page: 'cases' }));
});

app.get('/cases/:id/edit', requirePerm('lawyer'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const c = cases.find(x => x.id === req.params.id);
  if (!c) return res.status(404).send('Case not found.');
  const chargeOptions = COMMON_CHARGES.map(ch=>`<option value="${escapeHtml(ch)}">${escapeHtml(ch)}</option>`).join('');
  const statusOptions = ['open','investigation','pending','filed','closed','dismissed'].map(s=>`<option value="${s}" ${c.status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('');
  const body = `
  <div class="page-header"><a class="back-link" href="/cases/${c.id}">← Back to case</a><h1 class="page-title">Edit Case — ${escapeHtml(c.caseNumber)}</h1></div>
  <div class="card">
    <form method="post" action="/cases/${c.id}/edit">
      <div class="form-grid">
        <div class="form-group"><label>Case Title <span class="req">*</span></label><input class="input" name="title" value="${escapeHtml(c.title)}" required/></div>
        <div class="form-group"><label>Subject <span class="req">*</span></label><input class="input" name="subject" value="${escapeHtml(c.subject)}" required/></div>
        <div class="form-group"><label>Status</label><select class="input" name="status">${statusOptions}</select></div>
        <div class="form-group"><label>Priority</label><select class="input" name="priority">${['low','medium','high','critical'].map(p=>`<option value="${p}" ${(c.priority||'medium')===p?'selected':''}>${p.charAt(0).toUpperCase()+p.slice(1)}</option>`).join('')}</select></div>
        <div class="form-group"><label>Assigned Officer / ADA</label><input class="input" name="assignedOfficer" value="${escapeHtml(c.assignedOfficer||'')}"/></div>
        <div class="form-group"><label>Prosecutor</label><input class="input" name="prosecutor" value="${escapeHtml(c.prosecutor||'')}"/></div>
        <div class="form-group"><label>Location</label><input class="input" name="location" value="${escapeHtml(c.location||'')}"/></div>
        <div class="form-group"><label>Court Date</label><input class="input" type="date" name="courtDate" value="${escapeHtml(c.courtDate||'')}"/></div>
      </div>
      <div class="form-group"><label>Outcome / Verdict</label><input class="input" name="outcome" value="${escapeHtml(c.outcome||'')}" placeholder="e.g. Guilty — 10 years"/></div>
      <div class="form-group">
        <label>Charges</label>
        <select class="input" id="chargeSelect" onchange="addCharge(this)"><option value="">— Add a common charge —</option>${chargeOptions}</select>
        <input class="input" name="chargesRaw" id="chargesRaw" value="${escapeHtml((c.charges||[]).join(', '))}" style="margin-top:0.5rem" placeholder="Comma-separated"/>
      </div>
      <div class="form-group"><label>Case Notes</label><textarea class="input" name="notes" rows="4">${escapeHtml(c.notes||'')}</textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Save Changes</button><a class="btn-sm" href="/cases/${c.id}">Cancel</a></div>
    </form>
  </div>
  <script>function addCharge(s){if(!s.value)return;const f=document.getElementById('chargesRaw');f.value=f.value.trim()?(f.value.trim()+', '+s.value):s.value;s.value='';}</script>`;
  return res.send(layout({ title: `Edit ${c.caseNumber} — DOJ RP`, body, user: req.session.user, page: 'cases' }));
});

app.post('/cases/:id/edit', requirePerm('lawyer'), (req, res) => {
  const cases = readJSON(CASES_FILE);
  const idx = cases.findIndex(x => x.id === req.params.id);
  if (idx===-1) return res.status(404).send('Case not found.');
  const { title, subject, status, priority, assignedOfficer, prosecutor, location, courtDate, outcome, chargesRaw, notes } = req.body;
  const charges = chargesRaw ? chargesRaw.split(',').map(c=>c.trim()).filter(Boolean) : [];
  Object.assign(cases[idx], { title, subject, status, priority, assignedOfficer, prosecutor, location, courtDate: courtDate||'', outcome: outcome||'', charges, notes: notes||'', updatedAt: new Date().toISOString() });
  writeJSON(CASES_FILE, cases);
  logActivity('case_updated', `Case ${cases[idx].caseNumber} updated`, req.session.user.username);
  return res.redirect(`/cases/${req.params.id}`);
});

app.post('/cases/:id/delete', requirePerm('ag'), (req, res) => {
  let cases = readJSON(CASES_FILE);
  const c = cases.find(x=>x.id===req.params.id);
  if (c) { cases = cases.filter(x=>x.id!==req.params.id); writeJSON(CASES_FILE, cases); logActivity('case_updated', `Case ${c.caseNumber} deleted`, req.session.user.username); }
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

// ════════════════════════════════════════════════════════════════════════════
// WARRANTS  (citizen = view active only, lawyer+ = create/execute, ag = delete)
// ════════════════════════════════════════════════════════════════════════════

app.get('/warrants', requirePerm('citizen'), (req, res) => {
  const { q='', status='', type='' } = req.query;
  const pl = req.session.user.permLevel;
  let warrants = readJSON(WARRANTS_FILE);

  // Citizens only see active warrants
  if (!hasPerm(pl,'clerk')) warrants = warrants.filter(w => w.status === 'active');

  if (q)      warrants = warrants.filter(w => [w.warrantNumber,w.subject,w.issuedBy,w.description].join(' ').toLowerCase().includes(q.toLowerCase()));
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

  const citizenNotice = !hasPerm(pl,'clerk') ? `<div class="alert-box">Showing <strong>active warrants only</strong>. Sign in with a staff role to see all warrant records.</div>` : '';

  const body = `
  <div class="page-header row-between">
    <div><h1 class="page-title">Warrants</h1><p class="page-sub">${warrants.length} warrant${warrants.length!==1?'s':''} found.</p></div>
    ${hasPerm(pl,'lawyer') ? `<a class="btn-primary" href="/warrants/new">+ Issue Warrant</a>` : ''}
  </div>
  ${citizenNotice}
  <div class="card" style="margin-bottom:1rem">
    <form method="get" class="filter-row">
      <input class="input-sm" name="q" value="${escapeHtml(q)}" placeholder="Search by name or warrant number…"/>
      ${hasPerm(pl,'clerk') ? `<select class="input-sm" name="status"><option value="">All statuses</option>${['active','executed','expired','cancelled'].map(s=>`<option value="${s}" ${status===s?'selected':''}>${s.charAt(0).toUpperCase()+s.slice(1)}</option>`).join('')}</select>` : ''}
      <select class="input-sm" name="type"><option value="">All types</option>${['arrest','search','bench'].map(t=>`<option value="${t}" ${type===t?'selected':''}>${t.charAt(0).toUpperCase()+t.slice(1)}</option>`).join('')}</select>
      <button class="btn-primary" type="submit">Search</button>
      <a class="btn-sm" href="/warrants">Reset</a>
    </form>
  </div>
  <div class="card">
    <div class="table-header" style="grid-template-columns:1fr 1.5fr 1fr 1fr 1fr"><span>Warrant #</span><span>Subject</span><span>Type</span><span>Status</span><span>Issued</span></div>
    <div class="table-rows">${rows}</div>
  </div>`;
  return res.send(layout({ title: 'Warrants — DOJ RP', body, user: req.session.user, page: 'warrants' }));
});

app.get('/warrants/new', requirePerm('lawyer'), (req, res) => {
  const { caseId='' } = req.query;
  const cases = readJSON(CASES_FILE);
  const caseOptions = cases.map(c=>`<option value="${c.id}" ${caseId===c.id?'selected':''}>${escapeHtml(c.caseNumber)} — ${escapeHtml(c.title)}</option>`).join('');
  const body = `
  <div class="page-header"><a class="back-link" href="/warrants">← Back to warrants</a><h1 class="page-title">Issue Warrant</h1></div>
  <div class="card">
    <form method="post" action="/warrants">
      <div class="form-grid">
        <div class="form-group"><label>Warrant Type <span class="req">*</span></label><select class="input" name="type" required><option value="arrest">Arrest Warrant</option><option value="search">Search Warrant</option><option value="bench">Bench Warrant</option></select></div>
        <div class="form-group"><label>Subject Name <span class="req">*</span></label><input class="input" name="subject" required placeholder="Full name of subject"/></div>
        <div class="form-group"><label>Issued By <span class="req">*</span></label><input class="input" name="issuedBy" required placeholder="Judge / Issuing authority"/></div>
        <div class="form-group"><label>Issue Date</label><input class="input" type="date" name="issuedAt" value="${new Date().toISOString().split('T')[0]}"/></div>
        <div class="form-group"><label>Expiry Date</label><input class="input" type="date" name="expiresAt"/></div>
        <div class="form-group"><label>Linked Case</label><select class="input" name="linkedCaseId"><option value="">— None —</option>${caseOptions}</select></div>
      </div>
      <div class="form-group"><label>Description / Probable Cause</label><textarea class="input" name="description" rows="4" placeholder="Describe the grounds for this warrant…"></textarea></div>
      <div class="form-actions"><button class="btn-primary" type="submit">Issue Warrant</button><a class="btn-sm" href="/warrants">Cancel</a></div>
    </form>
  </div>`;
  return res.send(layout({ title: 'Issue Warrant — DOJ RP', body, user: req.session.user, page: 'warrants' }));
});

app.post('/warrants', requirePerm('lawyer'), (req, res) => {
  const { type, subject, issuedBy, issuedAt, expiresAt, linkedCaseId, description } = req.body;
  if (!type||!subject||!issuedBy) return res.status(400).send('Missing required fields.');
  const warrants = readJSON(WARRANTS_FILE);
  const w = {
    id: newId(), warrantNumber: nextWarrantNumber(), type, status: 'active',
    subject, issuedBy, issuedAt: issuedAt||new Date().toISOString().split('T')[0],
    expiresAt: expiresAt||'', linkedCaseId: linkedCaseId||'',
    description: description||'', createdBy: req.session.user.username, createdAt: new Date().toISOString()
  };
  warrants.unshift(w);
  writeJSON(WARRANTS_FILE, warrants);
  logActivity('warrant_issued', `${w.type.charAt(0).toUpperCase()+w.type.slice(1)} warrant ${w.warrantNumber} issued for ${subject}`, req.session.user.username);
  return res.redirect(`/warrants/${w.id}`);
});

app.get('/warrants/:id', requirePerm('citizen'), (req, res) => {
  const warrants = readJSON(WARRANTS_FILE);
  const w = warrants.find(x=>x.id===req.params.id);
  if (!w) return res.status(404).send('Warrant not found.');
  const pl = req.session.user.permLevel;
  // Citizens can only view active warrants
  if (!hasPerm(pl,'clerk') && w.status !== 'active') return res.status(403).send('You can only view active warrants.');
  const cases = readJSON(CASES_FILE);
  const linkedCase = w.linkedCaseId ? cases.find(c=>c.id===w.linkedCaseId) : null;
  const canWrite  = hasPerm(pl,'lawyer');
  const canDelete = hasPerm(pl,'ag');

  const body = `
  <div class="page-header row-between">
    <div>
      <a class="back-link" href="/warrants">← Back to warrants</a>
      <h1 class="page-title">${escapeHtml(w.warrantNumber)}</h1>
      <div class="badge-row">${badge(w.type+' warrant','badge-blue')} ${badge(w.status, WARRANT_STATUS_CLASS[w.status]||'badge-gray')}</div>
    </div>
    <div class="btn-group">
      ${canWrite && w.status==='active' ? `
        <form method="post" action="/warrants/${w.id}/status" style="display:inline"><input type="hidden" name="status" value="executed"/><button class="btn-primary" type="submit">Mark Executed</button></form>
        <form method="post" action="/warrants/${w.id}/status" style="display:inline"><input type="hidden" name="status" value="cancelled"/><button class="btn-sm" type="submit">Cancel</button></form>` : ''}
      ${canDelete ? `<form method="post" action="/warrants/${w.id}/delete" style="display:inline"><button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete this warrant?')">Delete</button></form>` : ''}
    </div>
  </div>
  <div class="detail-grid">
    <div class="card">
      <div class="card-title" style="margin-bottom:1rem">Warrant Details</div>
      <dl class="detail-list">
        <dt>Subject</dt><dd>${escapeHtml(w.subject)}</dd>
        <dt>Type</dt><dd>${escapeHtml(w.type.charAt(0).toUpperCase()+w.type.slice(1))} Warrant</dd>
        <dt>Issued By</dt><dd>${escapeHtml(w.issuedBy)}</dd>
        <dt>Issue Date</dt><dd>${fmtDate(w.issuedAt)}</dd>
        <dt>Expires</dt><dd>${w.expiresAt?fmtDate(w.expiresAt):'No expiry'}</dd>
        ${hasPerm(pl,'clerk') ? `<dt>Created By</dt><dd>${escapeHtml(w.createdBy)}</dd>` : ''}
        ${linkedCase && hasPerm(pl,'clerk') ? `<dt>Linked Case</dt><dd><a href="/cases/${linkedCase.id}" class="link">${escapeHtml(linkedCase.caseNumber)} — ${escapeHtml(linkedCase.title)}</a></dd>` : ''}
      </dl>
    </div>
    <div class="card">
      <div class="card-title" style="margin-bottom:0.75rem">Description / Probable Cause</div>
      <p class="case-notes-text">${escapeHtml(w.description||'No description.').replace(/\n/g,'<br/>')}</p>
    </div>
  </div>`;
  return res.send(layout({ title: `${w.warrantNumber} — DOJ RP`, body, user: req.session.user, page: 'warrants' }));
});

app.post('/warrants/:id/status', requirePerm('lawyer'), (req, res) => {
  const warrants = readJSON(WARRANTS_FILE);
  const idx = warrants.findIndex(x=>x.id===req.params.id);
  if (idx===-1) return res.status(404).send('Not found.');
  warrants[idx].status = req.body.status;
  writeJSON(WARRANTS_FILE, warrants);
  logActivity('warrant_executed', `Warrant ${warrants[idx].warrantNumber} marked as ${req.body.status}`, req.session.user.username);
  return res.redirect(`/warrants/${req.params.id}`);
});

app.post('/warrants/:id/delete', requirePerm('ag'), (req, res) => {
  writeJSON(WARRANTS_FILE, readJSON(WARRANTS_FILE).filter(x=>x.id!==req.params.id));
  return res.redirect('/warrants');
});

// ════════════════════════════════════════════════════════════════════════════
// DOCUMENTS  (clerk+)
// ════════════════════════════════════════════════════════════════════════════

app.get('/channels', requirePerm('clerk'), async (req, res) => {
  const user = req.session.user;
  let channels=[], error=null;
  if (!config.botToken||!config.guildId) {
    error='Set <code>DISCORD_BOT_TOKEN</code> and <code>DISCORD_GUILD_ID</code> to load document channels.';
  } else {
    try {
      const { roleIds, isAdmin } = await fetchMemberInfo(user.id);
      channels = await getAccessibleChannels(user.id, roleIds, isAdmin);
    } catch(e) { error=`Could not load channels: ${escapeHtml(e.message)}`; }
  }
  const cards = channels.map(ch => {
    const files = getChannelFiles(ch.id);
    return `<a class="channel-card" href="/channels/${ch.id}">
      <div class="channel-info"><div class="channel-name">${escapeHtml(formatChannelName(ch.name))}</div><div class="channel-meta">${files.length} document${files.length!==1?'s':''}</div></div>
      <svg class="channel-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </a>`;
  }).join('');
  const body = `
  <div class="page-header"><h1 class="page-title">Documents</h1><p class="page-sub">Channels starting with <code>dc-</code> that you have access to in Discord.</p></div>
  ${error?`<div class="alert-box">${error}</div>`:''}
  ${channels.length===0&&!error?`<div class="empty-state"><p>No accessible <code>dc-</code> channels found.</p></div>`:`<div class="channel-list">${cards}</div>`}`;
  return res.send(layout({ title: 'Documents — DOJ RP', body, user, page: 'channels' }));
});

app.get('/channels/:channelId', requirePerm('clerk'), async (req, res) => {
  const user = req.session.user;
  const { channelId } = req.params;
  if (config.botToken && config.guildId) {
    try {
      const { roleIds, isAdmin } = await fetchMemberInfo(user.id);
      const accessible = await getAccessibleChannels(user.id, roleIds, isAdmin);
      if (!accessible.find(ch=>ch.id===channelId))
        return res.status(403).send(layout({ title:'Access Denied', body:'<div class="alert-box">You do not have access to this channel.</div>', user, page:'channels' }));
    } catch(e) { return res.status(500).send(`Error: ${escapeHtml(e.message)}`); }
  }
  let resolvedName = `Channel ${channelId}`;
  if (config.botToken) {
    try {
      const r = await fetch(`https://discord.com/api/channels/${channelId}`,{headers:{Authorization:`Bot ${config.botToken}`}});
      if (r.ok) { const ch=await r.json(); resolvedName=formatChannelName(ch.name); }
    } catch {}
  }
  const files = getChannelFiles(channelId);
  const fileRows = files.map(f => {
    const ext = (path.extname(f.originalName).toLowerCase().replace('.','').toUpperCase()) || 'FILE';
    return `
    <div class="file-row">
      <div class="file-ext">${ext}</div>
      <div class="file-info"><div class="file-name">${escapeHtml(f.originalName)}</div><div class="file-meta">${formatSize(f.size)} · ${fmtDate(f.uploadedAt)}</div></div>
      <div class="file-actions">
        <a class="btn-sm" href="/channels/${escapeHtml(channelId)}/files/${encodeURIComponent(f.filename)}" download="${escapeHtml(f.originalName)}">Download</a>
        <form method="post" action="/channels/${escapeHtml(channelId)}/files/${encodeURIComponent(f.filename)}/delete" style="display:inline">
          <button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete this file?')">Delete</button>
        </form>
      </div>
    </div>`;
  }).join('');
  const body = `
  <div class="page-header"><a class="back-link" href="/channels">← Back to documents</a><h1 class="page-title">${escapeHtml(resolvedName)}</h1><p class="page-sub">${files.length} document${files.length!==1?'s':''}</p></div>
  <div class="upload-box">
    <form method="post" action="/channels/${escapeHtml(channelId)}/upload" enctype="multipart/form-data">
      <label class="upload-label" for="fileInput">
        <div class="upload-text">Click to upload a file</div>
        <div class="upload-hint">Max 250 MB · Any file type</div>
        <input type="file" id="fileInput" name="file" required style="display:none" onchange="this.closest('form').submit()"/>
      </label>
    </form>
  </div>
  <div class="file-list">${files.length===0?`<div class="empty-state"><p>No documents yet.</p></div>`:fileRows}</div>`;
  return res.send(layout({ title: `${resolvedName} — DOJ RP`, body, user, page: 'channels' }));
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
// SEARCH  (results filtered by perm level)
// ════════════════════════════════════════════════════════════════════════════

app.get('/search', ensureAuth, (req, res) => {
  const { q='' } = req.query;
  const lq = q.toLowerCase().trim();
  const pl = req.session.user.permLevel;

  let caseResults=[], warrantResults=[], fileResults=[];
  if (lq) {
    if (hasPerm(pl,'clerk')) {
      const cases = readJSON(CASES_FILE);
      caseResults = cases.filter(c => [c.caseNumber,c.title,c.subject,c.assignedOfficer,c.notes,...(c.charges||[])].join(' ').toLowerCase().includes(lq)).slice(0,10);
    }
    const warrants = readJSON(WARRANTS_FILE);
    const searchableWarrants = hasPerm(pl,'clerk') ? warrants : warrants.filter(w=>w.status==='active');
    warrantResults = searchableWarrants.filter(w => [w.warrantNumber,w.subject,w.issuedBy,w.description].join(' ').toLowerCase().includes(lq)).slice(0,10);

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
  const total = caseResults.length + warrantResults.length + fileResults.length;
  const body = `
  <div class="page-header"><h1 class="page-title">Search</h1></div>
  <div class="card" style="margin-bottom:1.25rem">
    <form method="get" class="filter-row">
      <input class="input" name="q" value="${escapeHtml(q)}" placeholder="Search ${hasPerm(pl,'clerk')?'cases, documents, and':'active'} warrants…" style="flex:1" autofocus/>
      <button class="btn-primary" type="submit">Search</button>
    </form>
  </div>
  ${lq?`<p class="muted-text" style="margin-bottom:1rem">${total} result${total!==1?'s':''} for "<strong>${escapeHtml(q)}</strong>"</p>`:''}
  ${caseResults.length?`<div class="card" style="margin-bottom:1rem"><div class="card-title" style="margin-bottom:0.75rem">Cases (${caseResults.length})</div>${caseResults.map(c=>`<a class="table-row-link" href="/cases/${c.id}"><span class="tr-cell mono">${escapeHtml(c.caseNumber)}</span><span class="tr-cell fw">${escapeHtml(c.title)}</span><span class="tr-cell">${badge(c.status,CASE_STATUS_CLASS[c.status]||'badge-gray')}</span></a>`).join('')}</div>`:''}
  ${warrantResults.length?`<div class="card" style="margin-bottom:1rem"><div class="card-title" style="margin-bottom:0.75rem">Warrants (${warrantResults.length})</div>${warrantResults.map(w=>`<a class="table-row-link" href="/warrants/${w.id}"><span class="tr-cell mono">${escapeHtml(w.warrantNumber)}</span><span class="tr-cell fw">${escapeHtml(w.subject)}</span><span class="tr-cell">${badge(w.status,WARRANT_STATUS_CLASS[w.status]||'badge-gray')}</span></a>`).join('')}</div>`:''}
  ${fileResults.length?`<div class="card"><div class="card-title" style="margin-bottom:0.75rem">Documents (${fileResults.length})</div>${fileResults.map(f=>`<div class="file-row"><div class="file-ext">FILE</div><div class="file-info"><div class="file-name">${escapeHtml(f.originalName)}</div><div class="file-meta">${formatSize(f.size)}</div></div><a class="btn-sm" href="/channels/${f.channelId}/files/${encodeURIComponent(f.filename)}" download="${escapeHtml(f.originalName)}">Download</a></div>`).join('')}</div>`:''}
  ${lq&&total===0?`<div class="empty-state"><p>No results for "<strong>${escapeHtml(q)}</strong>".</p></div>`:''}
  ${!lq?`<div class="empty-state"><p>Enter a search term above.</p></div>`:''}`;
  return res.send(layout({ title: 'Search — DOJ RP', body, user: req.session.user, page: 'search' }));
});

app.listen(PORT, '0.0.0.0', () => console.log(`DOJ RP Portal running at http://0.0.0.0:${PORT}`));
