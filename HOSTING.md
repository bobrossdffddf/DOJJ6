# DOJ Portal — Self-Hosting on Proxmox (Debian VM)

This guide assumes you have a Proxmox cluster with at least one Debian 12 (Bookworm) VM or LXC container available.

---

## 1. Prepare the Debian VM / Container

**Recommended specs:**
- 1–2 vCPUs
- 512 MB – 1 GB RAM
- 4 GB disk

**SSH into the VM and update:**
```bash
apt update && apt upgrade -y
```

---

## 2. Install Node.js 20

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node -v   # should print v20.x.x
npm -v
```

---

## 3. Install Git and clone the project

```bash
apt install -y git
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git /opt/doj-portal
cd /opt/doj-portal
npm install --production
```

Replace the GitHub URL with wherever you store this project. Alternatively, copy the project files directly using `scp` or an SFTP client.

---

## 4. Create the environment file

```bash
cp .env.example .env   # if it exists, otherwise:
nano /opt/doj-portal/.env
```

Paste and fill in the following:
```
DISCORD_CLIENT_ID=your_client_id
DISCORD_CLIENT_SECRET=your_client_secret
DISCORD_REDIRECT_URI=https://yourdomain.com/auth/callback
DISCORD_GUILD_ID=your_guild_id
DISCORD_BOT_TOKEN=your_bot_token
SESSION_SECRET=a_long_random_string_change_this
PORT=5000
```

Save and exit (`Ctrl+X`, `Y`, `Enter` in nano).

**Generate a strong SESSION_SECRET:**
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## 5. Ensure the data directory exists

```bash
mkdir -p /opt/doj-portal/data
mkdir -p /opt/doj-portal/data/uploads
```

The app will create JSON data files automatically on first run.

---

## 6. Run as a systemd service (auto-start on boot)

Create the service file:
```bash
nano /etc/systemd/system/doj-portal.service
```

Paste:
```ini
[Unit]
Description=DOJ Portal
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/doj-portal
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
EnvironmentFile=/opt/doj-portal/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:
```bash
systemctl daemon-reload
systemctl enable doj-portal
systemctl start doj-portal
systemctl status doj-portal
```

View logs at any time:
```bash
journalctl -u doj-portal -f
```

---

## 7. Set up a reverse proxy with Nginx (for HTTPS)

Install Nginx:
```bash
apt install -y nginx
```

Create the site config:
```bash
nano /etc/nginx/sites-available/doj-portal
```

Paste (replace `yourdomain.com` with your actual domain or VM IP):
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    client_max_body_size 300M;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable and test:
```bash
ln -s /etc/nginx/sites-available/doj-portal /etc/nginx/sites-enabled/
nginx -t
systemctl reload nginx
```

---

## 8. Add HTTPS with Let's Encrypt (optional but recommended)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
```

Certbot will automatically edit the Nginx config and set up auto-renewal.

Update your `.env` to use the HTTPS URL:
```
DISCORD_REDIRECT_URI=https://yourdomain.com/auth/callback
```

Also update the Discord app's OAuth2 redirect URIs at https://discord.com/developers/applications to match.

---

## 9. Discord Developer Portal configuration

1. Go to https://discord.com/developers/applications
2. Select your app
3. Under **OAuth2 → Redirects**, add: `https://yourdomain.com/auth/callback`
4. Under **Bot**, ensure the bot is invited to your server with:
   - `applications.commands` scope
   - `bot` scope
   - Permissions: View Channels, Send Messages, Read Message History

Bot invite URL format:
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot+applications.commands&guild_id=YOUR_GUILD_ID
```

---

## 10. Firewall (optional)

Allow only HTTP, HTTPS, and SSH:
```bash
apt install -y ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable
```

---

## Updating the app

```bash
cd /opt/doj-portal
git pull          # if using git
npm install --production
systemctl restart doj-portal
```

---

## Proxmox-specific tips

- **LXC vs VM:** A Debian 12 LXC container works fine and uses less overhead than a full VM.
- **Static IP:** Set a static IP on the container/VM inside Proxmox or via DHCP reservation so Nginx and Discord OAuth always resolve correctly.
- **Backups:** The entire `data/` folder is where all records live. Back it up with Proxmox Backup Server or a simple cron job:
  ```bash
  0 3 * * * tar -czf /root/doj-backup-$(date +\%F).tar.gz /opt/doj-portal/data
  ```
- **Multiple nodes:** The app uses local JSON files, so it must run on a single node. If you want HA, point a shared network volume (NFS/CephFS) at `/opt/doj-portal/data` and run the app on one node at a time.
