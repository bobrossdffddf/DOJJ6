# DOJ Portal

A Discord-authenticated web portal for the State of Texas Department of Justice. Manage cases, warrants, defendants, subpoenas, evidence, and documents organized by Discord channel access.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Auth**: Discord OAuth2 + Bot Token
- **Sessions**: express-session + session-file-store
- **File Uploads**: multer (250 MB max)
- **Storage**: Local JSON files + local disk uploads
- **Frontend**: Server-side rendered HTML + plain CSS (white/minimal design)

## Features

- **Dashboard** — Stats overview (cases, warrants, pending trial, defendants, subpoenas, documents) + recent activity + upcoming hearings
- **Case Management** — Full CRUD: Criminal, Traffic, Civil, Internal Affairs, Juvenile cases with Texas Penal Code charges, evidence log, plea deal notes, sentencing, notes journal, court dates, priority, and status tracking. Clerks can create and edit cases; only AG-level can delete.
- **Warrant Tracker** — Issue and manage Arrest (AO-442), Search & Seizure (AO-093), and Bench warrants linked to cases. Each warrant auto-generates a filled official PDF upon creation. PDFs are served at `/warrant-pdfs/` and attached to Discord warrant lookups.
- **Defendant Records** — Track personal information, linked cases, and linked warrants per defendant
- **Subpoenas** — Issue Ad Testificandum and Duces Tecum subpoenas linked to cases
- **Evidence Log** — Log physical, digital, documentary, forensic, and testimonial evidence per case
- **Court Calendar** — Monthly hearing and trial schedule view
- **Document Channels** — Discord-permission-aware file storage organized by `dc-` channels
- **Global Search** — Search across cases, warrants, defendants, and file names
- **Activity Log** — Recent actions logged across all modules
- **Texas Penal Code** — 50+ pre-built charge list for quick selection

## Discord Bot Commands

| Command | Description |
|---|---|
| `/setup [warrant_channel] [case_channel]` | Post live lookup embeds with dropdowns |
| `/case [number]` | Look up a case by number |
| `/warrant [number]` | Look up a warrant by number |
| `/subpoena [number]` | Look up a subpoena by number |
| `/defendant [name]` | Search defendant records by name |
| `/lookup [name]` | Search all records for a person |
| `/activecases` | List all active/open cases |
| `/activewarrants` | List all active warrants |
| `/pending` | List cases pending trial |
| `/stats` | Show full system statistics |
| `/help` | List all available commands |

## Project Structure

- `server.js` — Express server, all routes, HTML templates, Discord API integration
- `bot.js` — Discord bot with slash commands and PDF attachment for warrant lookups
- `generate_warrant.py` — Fills AO-442 (Arrest) or AO-093 (Search & Seizure) PDF templates based on warrant type
- `public/styles.css` — White/minimal stylesheet
- `data/arrest_warrant_template.pdf` — AO-442 Arrest Warrant fillable template
- `data/search_warrant_template.pdf` — AO-093 Search and Seizure Warrant fillable template
- `data/cases.json` — Case records (includes evidence[], caseNotes[], charges[])
- `data/warrants.json` — Warrant records (includes pdfFile, pdfName for generated PDFs)
- `data/subpoenas.json` — Subpoena records
- `data/defendants.json` — Defendant records
- `data/activity.json` — Activity log (last 200 entries)
- `data/uploads/<channelId>/` — Uploaded files per Discord channel
- `data/uploads/warrant-pdfs/` — Auto-generated warrant PDFs (served at /warrant-pdfs/)

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
| `DISCORD_REDIRECT_URI` | OAuth callback URL |
| `DISCORD_GUILD_ID` | Discord server (guild) ID |
| `DISCORD_BOT_TOKEN` | Bot token — must be in the server with View Channels permission |
| `SESSION_SECRET` | Random string for session signing |
| `PORT` | Port (defaults to 5000) |

## Channel Documents

Only Discord channels whose names start with `dc-` are surfaced. The bot checks each user's Discord role permissions to determine which channels they can see.
