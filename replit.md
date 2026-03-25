# DOJ RP Case Portal

A Discord-authenticated case management portal for roleplay communities. Users sign in with Discord and can search, view, and create case records.

## Tech Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Auth**: Discord OAuth2
- **Sessions**: express-session
- **Storage**: Local JSON file (`data/cases.json`)
- **Frontend**: Server-side rendered HTML + plain CSS

## Project Structure

- `server.js` — Express server, all routes, HTML templates
- `public/styles.css` — Stylesheet
- `data/cases.json` — Case records (JSON file database)
- `.env.example` — Template for required environment variables

## Running the App

```bash
npm run dev   # development (watch mode)
npm start     # production
```

Runs on port 5000, bound to `0.0.0.0`.

## Environment Variables

Copy `.env.example` to `.env` and fill in:

| Variable | Description |
|---|---|
| `DISCORD_CLIENT_ID` | Discord application client ID |
| `DISCORD_CLIENT_SECRET` | Discord application client secret |
| `DISCORD_REDIRECT_URI` | OAuth callback URL (e.g. `https://your-domain/auth/discord/callback`) |
| `DISCORD_GUILD_ID` | (Optional) Restrict access to a specific Discord server |
| `SESSION_SECRET` | Random secret for session signing |
| `PORT` | Server port (defaults to 5000) |

## Deployment

Configured for VM deployment (always-on) since the app uses a local JSON file for persistent storage.
