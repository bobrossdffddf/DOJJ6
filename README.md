# DOJ RP Case Portal (Discord Login)

A lightweight DOJ roleplay portal where users authenticate with Discord, then search and create case records.

## Features
- Discord OAuth2 login (`identify guilds` scope).
- Optional Discord guild restriction via `DISCORD_GUILD_ID`.
- Case dashboard with keyword + status search.
- Add new cases from the web UI.
- JSON API endpoint: `GET /api/cases?q=...` (auth required).

## Quick Start
1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy env file and fill Discord settings:
   ```bash
   cp .env.example .env
   ```
3. In Discord Developer Portal, set OAuth redirect URI to match `DISCORD_REDIRECT_URI`.
4. Run app:
   ```bash
   npm start
   ```
5. Visit `http://localhost:3000`.

## Discord Setup
- Create an application at <https://discord.com/developers/applications>.
- Add OAuth2 redirect URI (example: `http://localhost:3000/auth/discord/callback`).
- Copy **Client ID** and **Client Secret** into `.env`.
- (Optional) Set `DISCORD_GUILD_ID` to only allow your DOJ RP server members.

## Data Storage
Cases are stored in `data/cases.json` for simplicity.

For production use, replace JSON storage with a real database and add role-based authorization.
