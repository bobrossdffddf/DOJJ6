const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const config = {
  clientId: process.env.DISCORD_CLIENT_ID || '',
  clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
  redirectUri: process.env.DISCORD_REDIRECT_URI || `http://localhost:${PORT}/auth/discord/callback`,
  guildId: process.env.DISCORD_GUILD_ID || '',
  sessionSecret: process.env.SESSION_SECRET || 'replace-me-in-production'
};

const casesPath = path.join(__dirname, 'data', 'cases.json');

function readCases() {
  try {
    const raw = fs.readFileSync(casesPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeCases(cases) {
  fs.writeFileSync(casesPath, `${JSON.stringify(cases, null, 2)}\n`, 'utf8');
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  <div class="container">
    <div class="card row" style="justify-content:space-between;">
      <div>
        <h1>DOJ RP Case Portal</h1>
        <small>Discord-authenticated case search and tracking</small>
      </div>
      <div class="row">
        ${user ? `<small>Signed in as <strong>${escapeHtml(user.username)}#${escapeHtml(user.discriminator || '0')}</strong></small><a class="btn" href="/logout">Log out</a>` : ''}
      </div>
    </div>
    ${body}
    <div class="footer">For RP use. Validate policies with your server leadership and moderators.</div>
  </div>
</body>
</html>`;
}

function ensureAuth(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/');
  }
  return next();
}

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 6
  }
}));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  if (req.session.user) {
    return res.redirect('/dashboard');
  }

  const ready = Boolean(config.clientId && config.clientSecret && config.redirectUri);
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const body = `
  <div class="card">
    <h2>Sign in with Discord</h2>
    <p class="muted">Use your DOJ RP Discord account to access the case portal.</p>
    ${ready
      ? `<a class="btn primary" href="${authUrl(state)}">Continue with Discord</a>`
      : `<p class="alert">Missing DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET / DISCORD_REDIRECT_URI in .env.</p>`}
  </div>
  <div class="card">
    <h2>Server Access Rule</h2>
    <p class="muted">If <code>DISCORD_GUILD_ID</code> is configured, only members of that guild can sign in.</p>
  </div>`;

  return res.send(layout({ title: 'Login | DOJ RP Case Portal', body }));
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send('Invalid OAuth state. Please retry login.');
  }

  try {
    const tokenBody = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'authorization_code',
      code: String(code),
      redirect_uri: config.redirectUri
    });

    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody
    });

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      return res.status(401).send(`OAuth token error: ${escapeHtml(text)}`);
    }

    const token = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` }
    });

    if (!userRes.ok) {
      return res.status(401).send('Unable to fetch Discord user profile.');
    }

    const user = await userRes.json();

    if (config.guildId) {
      const guildRes = await fetch('https://discord.com/api/users/@me/guilds', {
        headers: { Authorization: `Bearer ${token.access_token}` }
      });

      if (!guildRes.ok) {
        return res.status(403).send('Unable to verify Discord guild membership.');
      }

      const guilds = await guildRes.json();
      const inGuild = guilds.some((guild) => guild.id === config.guildId);
      if (!inGuild) {
        return res.status(403).send('Access denied: not a member of the configured DOJ RP server.');
      }
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar
    };

    delete req.session.oauthState;
    return res.redirect('/dashboard');
  } catch (error) {
    return res.status(500).send(`Login failed: ${escapeHtml(error.message)}`);
  }
});

app.get('/dashboard', ensureAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const statusFilter = String(req.query.status || '').trim().toLowerCase();

  const cases = readCases();
  const filtered = cases.filter((record) => {
    const haystack = [
      record.caseNumber,
      record.title,
      record.subject,
      record.status,
      record.officer,
      record.notes
    ].join(' ').toLowerCase();

    const qMatches = q ? haystack.includes(q) : true;
    const statusMatches = statusFilter ? String(record.status || '').toLowerCase() === statusFilter : true;
    return qMatches && statusMatches;
  });

  const rows = filtered.map((record) => {
    const statusClass = String(record.status || '').toLowerCase().includes('open') ? 'open' : 'pending';
    return `<tr>
      <td>${escapeHtml(record.caseNumber)}</td>
      <td>${escapeHtml(record.title)}</td>
      <td>${escapeHtml(record.subject)}</td>
      <td><span class="status ${statusClass}">${escapeHtml(record.status)}</span></td>
      <td>${escapeHtml(record.officer)}</td>
      <td>${escapeHtml(record.openedAt)}</td>
      <td>${escapeHtml(record.notes || '')}</td>
    </tr>`;
  }).join('');

  const body = `
    <div class="card">
      <h2>Search Cases</h2>
      <form method="get" action="/dashboard">
        <div class="grid">
          <div>
            <label for="q">Keyword</label>
            <input id="q" name="q" value="${escapeHtml(q)}" placeholder="Case #, person, title, notes" />
          </div>
          <div>
            <label for="status">Status</label>
            <select id="status" name="status">
              <option value="">All</option>
              <option value="open" ${statusFilter === 'open' ? 'selected' : ''}>Open</option>
              <option value="pending filing" ${statusFilter === 'pending filing' ? 'selected' : ''}>Pending Filing</option>
              <option value="closed" ${statusFilter === 'closed' ? 'selected' : ''}>Closed</option>
            </select>
          </div>
        </div>
        <div style="margin-top:0.75rem" class="row">
          <button class="btn primary" type="submit">Search</button>
          <a class="btn" href="/dashboard">Reset</a>
          <small class="muted">Showing ${filtered.length} of ${cases.length} cases</small>
        </div>
      </form>
    </div>

    <div class="card table-wrap">
      <table>
        <thead>
          <tr>
            <th>Case #</th><th>Title</th><th>Subject</th><th>Status</th><th>Officer</th><th>Opened</th><th>Notes</th>
          </tr>
        </thead>
        <tbody>
          ${rows || '<tr><td colspan="7">No matching cases found.</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Add Case</h2>
      <form method="post" action="/cases">
        <div class="grid">
          <div><label>Case Number</label><input name="caseNumber" required /></div>
          <div><label>Title</label><input name="title" required /></div>
          <div><label>Subject</label><input name="subject" required /></div>
          <div><label>Status</label><input name="status" value="Open" required /></div>
          <div><label>Officer</label><input name="officer" required /></div>
          <div><label>Opened Date</label><input type="date" name="openedAt" required /></div>
        </div>
        <label>Notes</label>
        <textarea name="notes" rows="3"></textarea>
        <div style="margin-top:0.75rem"><button class="btn primary" type="submit">Create Case</button></div>
      </form>
    </div>`;

  return res.send(layout({ title: 'Dashboard | DOJ RP Case Portal', body, user: req.session.user }));
});

app.get('/api/cases', ensureAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const data = readCases();
  const result = q
    ? data.filter((c) => JSON.stringify(c).toLowerCase().includes(q))
    : data;
  res.json(result);
});

app.post('/cases', ensureAuth, (req, res) => {
  const { caseNumber, title, subject, status, officer, openedAt, notes } = req.body;
  if (!caseNumber || !title || !subject || !status || !officer || !openedAt) {
    return res.status(400).send('Missing required fields.');
  }

  const cases = readCases();
  const nextId = cases.length ? Math.max(...cases.map((c) => Number(c.id) || 0)) + 1 : 1;

  cases.push({
    id: nextId,
    caseNumber: String(caseNumber).trim(),
    title: String(title).trim(),
    subject: String(subject).trim(),
    status: String(status).trim(),
    officer: String(officer).trim(),
    openedAt: String(openedAt).trim(),
    notes: String(notes || '').trim()
  });

  writeCases(cases);
  return res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.listen(PORT, () => {
  console.log(`DOJ RP portal running at http://localhost:${PORT}`);
});
