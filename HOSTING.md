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
npm install --omit=dev
```

Replace the GitHub URL with wherever you store this project. Alternatively, copy files directly using `scp` or an SFTP client.

---

## 4. Create the environment file

```bash
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
mkdir -p /opt/doj-portal/data/uploads
```

The app creates JSON data files automatically on first run.

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

View live logs:
```bash
journalctl -u doj-portal -f
```

---

## 7. Expose the portal — Option A: Cloudflare Tunnel (Recommended)

Cloudflare Tunnel is the easiest option. It gives you HTTPS automatically with no port forwarding, no firewall rules, and no certificate management. You only need a free Cloudflare account and a domain pointed to Cloudflare.

### 7a. Install cloudflared

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
dpkg -i cloudflared.deb
```

### 7b. Log in and create the tunnel

```bash
cloudflared tunnel login
```

This opens a browser link. Authorize the domain you want to use. Then:

```bash
cloudflared tunnel create doj-portal
```

This creates the tunnel and saves credentials to `/root/.cloudflared/`.

### 7c. Create the tunnel config

```bash
nano /root/.cloudflared/config.yml
```

Paste (replace `YOUR_TUNNEL_ID` with the ID printed in the previous step, and `yourdomain.com` with your domain):
```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /root/.cloudflared/YOUR_TUNNEL_ID.json

ingress:
  - hostname: yourdomain.com
    service: http://localhost:5000
  - service: http_status:404
```

### 7d. Route your domain through the tunnel

```bash
cloudflared tunnel route dns doj-portal yourdomain.com
```

This automatically creates a CNAME record in Cloudflare DNS pointing your domain to the tunnel.

### 7e. Run the tunnel as a systemd service

```bash
cloudflared service install
systemctl enable cloudflared
systemctl start cloudflared
systemctl status cloudflared
```

### 7f. Update your environment file

Update `.env` to use your Cloudflare domain:
```
DISCORD_REDIRECT_URI=https://yourdomain.com/auth/callback
```

Then restart the portal:
```bash
systemctl restart doj-portal
```

Also add the redirect URI in the Discord Developer Portal under **OAuth2 → Redirects**.

---

## 7. Expose the portal — Option B: Nginx + Let's Encrypt

Use this if you prefer a traditional reverse proxy with a static IP and open ports (80/443).

### Install Nginx

```bash
apt install -y nginx
```

### Create the site config

```bash
nano /etc/nginx/sites-available/doj-portal
```

Paste (replace `yourdomain.com`):
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

### Add HTTPS with Let's Encrypt

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d yourdomain.com
```

Certbot will edit the config and set up auto-renewal automatically.

---

## 8. Discord Developer Portal configuration

1. Go to https://discord.com/developers/applications
2. Select your app
3. Under **OAuth2 → Redirects**, add: `https://yourdomain.com/auth/callback`
4. Under **Bot**, ensure the bot is in your server with:
   - `applications.commands` scope
   - `bot` scope
   - Permissions: View Channels, Send Messages, Read Message History

Bot invite URL:
```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot+applications.commands&guild_id=YOUR_GUILD_ID
```

---

## 9. Firewall (Option B / Nginx only)

If using Nginx, open ports 80 and 443. With Cloudflare Tunnel you do not need to open any ports.

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
git pull
npm install --omit=dev
systemctl restart doj-portal
```

---

## Proxmox-specific tips

- **LXC vs VM:** A Debian 12 LXC container works fine and uses less overhead than a full VM.
- **Static IP:** Set a static IP on the container/VM so your config stays consistent after reboots. With Cloudflare Tunnel you can use a dynamic IP — the tunnel handles it.
- **Backups:** The entire `data/` folder is where all records live. Back it up with Proxmox Backup Server or a cron job:
  ```bash
  0 3 * * * tar -czf /root/doj-backup-$(date +\%F).tar.gz /opt/doj-portal/data
  ```
- **Multiple nodes:** The app uses local JSON files, so it must run on a single node. For HA, mount a shared NFS/CephFS volume at `/opt/doj-portal/data` and keep the app running on one node at a time.
- **Cloudflare Tunnel on LXC:** Works without any special network configuration. The tunnel outbound-only connection means you never need to touch your Proxmox host's firewall or your router.
