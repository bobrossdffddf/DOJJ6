# DOJ RP Portal

A Discord-authenticated web portal for Department of Justice roleplay communities. Manage cases, warrants, and documents organized by Discord channel access.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Auth**: Discord OAuth2 + Bot Token
- **Sessions**: express-session
- **File Uploads**: multer (250 MB max)
- **Storage**: Local JSON files + local disk uploads
- **Frontend**: Server-side rendered HTML + plain CSS (white/minimal design)

## Features

- **Dashboard** — stats overview (cases, warrants, documents) + recent activity log
- **Case Management** — full CRUD: Criminal, Traffic, Civil, Internal Affairs cases with charges, notes, court dates, priority, and status tracking
- **Warrant Tracker** — issue and manage Arrest, Search, and Bench warrants linked to cases
- **Document Channels** — Discord-permission-aware file storage organized by `dc-` channels
- **Global Search** — search across cases, warrants, and file names
- **Activity Log** — recent actions logged across all modules
- **37 DOJ RP Charges** — pre-built charge list (PC/VC codes) for quick selection

## Project Structure

- `server.js` — Express server, all routes, HTML templates, Discord API integration
- `public/styles.css` — White/minimal stylesheet
- `data/cases.json` — Case records
- `data/warrants.json` — Warrant records
- `data/activity.json` — Activity log (last 200 entries)
- `data/uploads/<channelId>/` — Uploaded files per Discord channel

## Running the App

```bash
npm run dev   # development (watch mode)
npm start     # production
```

Runs on port 5000, bound to `0.0.0.0`.

## Required Environment Variables

| Variable | Description |
|---|---|
| `DISCORD_CLIENT_ID` | Discord app client ID |
| `DISCORD_CLIENT_SECRET` | Discord app client secret |
| `DISCORD_REDIRECT_URI` | OAuth callback URL (e.g. `https://your-domain/auth/discord/callback`) |
| `DISCORD_GUILD_ID` | Discord server (guild) ID |
| `DISCORD_BOT_TOKEN` | Bot token — bot must be in the server with View Channels permission |
| `SESSION_SECRET` | Random string for session signing |
| `PORT` | Port (defaults to 5000) |

## Channel Documents

Only Discord channels whose names start with `dc-` are surfaced. The bot checks each user's Discord role permissions to determine which channels they can see. Access matches Discord exactly.
