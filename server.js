const express = require('express');
const session = require('express-session');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

const config = {
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  redirectUri: process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/discord/callback`,
  guildId: process.env.DISCORD_GUILD_ID || '',
  botToken: process.env.DISCORD_BOT_TOKEN || '',
  sessionSecret: process.env.SESSION_SECRET || 'replace-me-in-production'
};

const UPLOADS_DIR = path.join(__dirname, 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOADS_DIR, req.params.channelId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._\-]/g, '_');
    const unique = `${Date.now()}_${safe}`;
    cb(null, unique);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;

function canViewChannel(channel, userId, memberRoles, guildId) {
  const overwrites = channel.permission_overwrites || [];

  let allow = true;

  const everyoneOW = overwrites.find(ow => ow.id === guildId && ow.type === 0);
  if (everyoneOW) {
    if (BigInt(everyoneOW.deny) & VIEW_CHANNEL) allow = false;
    if (BigInt(everyoneOW.allow) & VIEW_CHANNEL) allow = true;
  }

  for (const roleId of (memberRoles || [])) {
    const roleOW = overwrites.find(ow => ow.id === roleId && ow.type === 0);
    if (roleOW) {
      if (BigInt(roleOW.deny) & VIEW_CHANNEL) allow = false;
      if (BigInt(roleOW.allow) & VIEW_CHANNEL) allow = true;
    }
  }

  const userOW = overwrites.find(ow => ow.id === userId && ow.type === 1);
  if (userOW) {
    if (BigInt(userOW.deny) & VIEW_CHANNEL) allow = false;
    if (BigInt(userOW.allow) & VIEW_CHANNEL) allow = true;
  }

  return allow;
}

async function getMemberRoles(userId) {
  if (!config.botToken || !config.guildId) return { roles: [], isAdmin: false };
  const res = await fetch(`https://discord.com/api/guilds/${config.guildId}/members/${userId}`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  if (!res.ok) return { roles: [], isAdmin: false };
  const member = await res.json();

  const rolesRes = await fetch(`https://discord.com/api/guilds/${config.guildId}/roles`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  let isAdmin = false;
  if (rolesRes.ok) {
    const allRoles = await rolesRes.json();
    for (const roleId of (member.roles || [])) {
      const role = allRoles.find(r => r.id === roleId);
      if (role && (BigInt(role.permissions) & ADMINISTRATOR)) {
        isAdmin = true;
        break;
      }
    }
  }

  return { roles: member.roles || [], isAdmin };
}

async function getAccessibleChannels(userId, memberRoles, isAdmin) {
  if (!config.botToken || !config.guildId) return [];
  const res = await fetch(`https://discord.com/api/guilds/${config.guildId}/channels`, {
    headers: { Authorization: `Bot ${config.botToken}` }
  });
  if (!res.ok) return [];
  const channels = await res.json();
  const dcChannels = channels.filter(ch => ch.name && ch.name.startsWith('dc-') && ch.type === 0);
  if (isAdmin) return dcChannels;
  return dcChannels.filter(ch => canViewChannel(ch, userId, memberRoles, config.guildId));
}

function getChannelFiles(channelId) {
  const dir = path.join(UPLOADS_DIR, channelId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map(filename => {
    const stat = fs.statSync(path.join(dir, filename));
    const originalName = filename.replace(/^\d+_/, '');
    return {
      filename,
      originalName,
      size: stat.size,
      uploadedAt: stat.mtime
    };
  }).sort((a, b) => b.uploadedAt - a.uploadedAt);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatChannelName(name) {
  return name.replace(/^dc-/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function escapeHtml(v = '') {
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function authUrl(state) {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'identify guilds',
    state,
    prompt: 'consent'
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

function layout({ title, body, user }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <nav class="topbar">
    <span class="topbar-brand">📁 Doc Portal</span>
    <div class="topbar-right">
      ${user ? `<span class="topbar-user">${escapeHtml(user.username)}</span><a class="btn-sm" href="/logout">Sign out</a>` : ''}
    </div>
  </nav>
  <main class="container">
    ${body}
  </main>
</body>
</html>`;
}

function ensureAuth(req, res, next) {
  if (!req.session.user) return res.redirect('/');
  return next();
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 6 }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (req.session.user) return res.redirect('/channels');

  const ready = Boolean(config.clientId && config.clientSecret);
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const body = `
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-icon">📁</div>
      <h1 class="login-title">Document Portal</h1>
      <p class="login-sub">Sign in with Discord to access your team's files.</p>
      ${ready
        ? `<a class="btn-discord" href="${authUrl(state)}">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03z"/></svg>
            Continue with Discord
          </a>`
        : `<div class="alert-box">Missing Discord credentials. Set <code>DISCORD_CLIENT_ID</code>, <code>DISCORD_CLIENT_SECRET</code>, and <code>DISCORD_BOT_TOKEN</code> in your environment.</div>`}
    </div>
  </div>`;

  return res.send(layout({ title: 'Sign In — Doc Portal', body, user: null }));
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send('Invalid OAuth state. Please retry login.');
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: 'authorization_code',
        code: String(code),
        redirect_uri: config.redirectUri
      })
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return res.status(401).send(`OAuth token error: ${escapeHtml(text)}`);
    }

    const token = await tokenRes.json();
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    if (!userRes.ok) return res.status(401).send('Unable to fetch Discord user profile.');
    const user = await userRes.json();

    if (config.guildId) {
      const guildRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${token.access_token}` }
      });
      if (!guildRes.ok) return res.status(403).send('Unable to verify guild membership.');
      const guilds = await guildRes.json();
      if (!guilds.some(g => g.id === config.guildId)) {
        return res.status(403).send('Access denied: you are not a member of the configured server.');
      }
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar
    };

    delete req.session.oauthState;
    return res.redirect('/channels');
  } catch (err) {
    return res.status(500).send(`Login failed: ${escapeHtml(err.message)}`);
  }
});

app.get('/channels', ensureAuth, async (req, res) => {
  const user = req.session.user;
  let channels = [];
  let error = null;

  if (!config.botToken || !config.guildId) {
    error = 'Set <code>DISCORD_BOT_TOKEN</code> and <code>DISCORD_GUILD_ID</code> to load channels.';
  } else {
    try {
      const { roles, isAdmin } = await getMemberRoles(user.id);
      channels = await getAccessibleChannels(user.id, roles, isAdmin);
    } catch (e) {
      error = `Could not load channels: ${escapeHtml(e.message)}`;
    }
  }

  const channelCards = channels.map(ch => {
    const files = getChannelFiles(ch.id);
    const label = formatChannelName(ch.name);
    return `
    <a class="channel-card" href="/channels/${escapeHtml(ch.id)}">
      <div class="channel-icon">📂</div>
      <div class="channel-info">
        <div class="channel-name">${escapeHtml(label)}</div>
        <div class="channel-meta">${files.length} document${files.length !== 1 ? 's' : ''}</div>
      </div>
      <svg class="channel-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
    </a>`;
  }).join('');

  const body = `
  <div class="page-header">
    <h1 class="page-title">My Channels</h1>
    <p class="page-sub">Showing channels you have access to.</p>
  </div>
  ${error ? `<div class="alert-box">${error}</div>` : ''}
  ${channels.length === 0 && !error
    ? `<div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>No <code>dc-</code> channels found that you have access to.</p>
      </div>`
    : `<div class="channel-list">${channelCards}</div>`}`;

  return res.send(layout({ title: 'Channels — Doc Portal', body, user }));
});

app.get('/channels/:channelId', ensureAuth, async (req, res) => {
  const user = req.session.user;
  const { channelId } = req.params;

  if (config.botToken && config.guildId) {
    try {
      const { roles, isAdmin } = await getMemberRoles(user.id);
      const accessible = await getAccessibleChannels(user.id, roles, isAdmin);
      if (!accessible.find(ch => ch.id === channelId)) {
        return res.status(403).send(layout({
          title: 'Access Denied',
          body: '<div class="alert-box">You do not have access to this channel.</div>',
          user
        }));
      }
    } catch (e) {
      return res.status(500).send(`Error verifying access: ${escapeHtml(e.message)}`);
    }
  }

  const files = getChannelFiles(channelId);
  const channelName = formatChannelName(`dc-${channelId}`);

  let resolvedName = channelName;
  if (config.botToken) {
    try {
      const chRes = await fetch(`https://discord.com/api/channels/${channelId}`, {
        headers: { Authorization: `Bot ${config.botToken}` }
      });
      if (chRes.ok) {
        const ch = await chRes.json();
        resolvedName = formatChannelName(ch.name);
      }
    } catch {}
  }

  const fileRows = files.map(f => `
  <div class="file-row">
    <div class="file-icon">📄</div>
    <div class="file-info">
      <div class="file-name">${escapeHtml(f.originalName)}</div>
      <div class="file-meta">${formatSize(f.size)} · ${new Date(f.uploadedAt).toLocaleDateString()}</div>
    </div>
    <div class="file-actions">
      <a class="btn-sm" href="/channels/${escapeHtml(channelId)}/files/${encodeURIComponent(f.filename)}" download="${escapeHtml(f.originalName)}">Download</a>
      <form method="post" action="/channels/${escapeHtml(channelId)}/files/${encodeURIComponent(f.filename)}/delete" style="display:inline">
        <button class="btn-sm btn-danger" type="submit" onclick="return confirm('Delete this file?')">Delete</button>
      </form>
    </div>
  </div>`).join('');

  const body = `
  <div class="page-header">
    <a class="back-link" href="/channels">← Back to channels</a>
    <h1 class="page-title">${escapeHtml(resolvedName)}</h1>
    <p class="page-sub">${files.length} document${files.length !== 1 ? 's' : ''} in this channel.</p>
  </div>

  <div class="upload-box">
    <form method="post" action="/channels/${escapeHtml(channelId)}/upload" enctype="multipart/form-data" id="uploadForm">
      <label class="upload-label" for="fileInput">
        <div class="upload-icon">⬆️</div>
        <div class="upload-text">Click to upload a file</div>
        <div class="upload-hint">Max 50 MB</div>
        <input type="file" id="fileInput" name="file" required style="display:none" onchange="this.closest('form').submit()"/>
      </label>
    </form>
  </div>

  <div class="file-list">
    ${files.length === 0
      ? `<div class="empty-state"><div class="empty-icon">📭</div><p>No documents yet. Upload one above.</p></div>`
      : fileRows}
  </div>`;

  return res.send(layout({ title: `${resolvedName} — Doc Portal`, body, user }));
});

app.post('/channels/:channelId/upload', ensureAuth, upload.single('file'), async (req, res) => {
  const { channelId } = req.params;
  if (!req.file) return res.status(400).send('No file uploaded.');
  return res.redirect(`/channels/${channelId}`);
});

app.get('/channels/:channelId/files/:filename', ensureAuth, (req, res) => {
  const { channelId, filename } = req.params;
  const filePath = path.join(UPLOADS_DIR, channelId, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send('File not found.');
  const originalName = filename.replace(/^\d+_/, '');
  res.download(filePath, originalName);
});

app.post('/channels/:channelId/files/:filename/delete', ensureAuth, (req, res) => {
  const { channelId, filename } = req.params;
  const filePath = path.join(UPLOADS_DIR, channelId, filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return res.redirect(`/channels/${channelId}`);
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Doc Portal running at http://0.0.0.0:${PORT}`);
});
