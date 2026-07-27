# GitHub Actions deployment

Every successful validation of `main` deploys a versioned release to `/opt/smart-study-backend`. The workflow connects as the restricted `deploy` user, preserves the production environment and uploads, runs Prisma production migrations, restarts one systemd service, verifies `/health`, and rolls back the application symlink if the health check fails.

## One-time Ubuntu setup

Run these commands on the server as `root`:

```bash
apt-get update
apt-get install -y rsync curl

adduser --disabled-password --gecos "" deploy
chown root:deploy /opt/smart-study-backend
chmod 775 /opt/smart-study-backend
install -d -o deploy -g deploy /opt/smart-study-backend/releases
install -d -o deploy -g deploy /opt/smart-study-backend/shared/uploads
```

Move or copy the existing production environment file:

```bash
cp /opt/smart-study-backend/.env /opt/smart-study-backend/shared/.env
chown deploy:deploy /opt/smart-study-backend/shared/.env
chmod 600 /opt/smart-study-backend/shared/.env
```

If the existing server already has uploaded files, preserve them before the first deployment:

```bash
cp -a /opt/smart-study-backend/uploads/. /opt/smart-study-backend/shared/uploads/
chown -R deploy:deploy /opt/smart-study-backend/shared/uploads
```

Ensure Node is installed system-wide and confirm its path:

```bash
command -v node
node --version
npm --version
```

The included service expects `/usr/bin/node`. If `command -v node` returns a different path, edit `deploy/smart-study-backend.service` before installing it.

Install the service and restricted sudo rule from this repository checkout:

```bash
cp deploy/smart-study-backend.service /etc/systemd/system/
cp deploy/smart-study-backend.sudoers /etc/sudoers.d/smart-study-backend-deploy
chmod 440 /etc/sudoers.d/smart-study-backend-deploy
visudo -cf /etc/sudoers.d/smart-study-backend-deploy
systemctl daemon-reload
systemctl enable smart-study-backend.service
```

The first GitHub deployment creates `current` and starts the service. Until then, do not start the new service because no release exists yet.

## Deployment SSH key

Create a dedicated key on your computer, not on GitHub or the server:

```bash
ssh-keygen -t ed25519 -C "smart-study-github-deploy" -f smart-study-deploy
```

On the server, add only the public key:

```bash
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
cat smart-study-deploy.pub >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

## GitHub secrets

Open the backend repository on GitHub, then **Settings → Secrets and variables → Actions**. Add:

- `SERVER_HOST`: server IP address or DNS hostname.
- `SERVER_SSH_KEY`: complete private deployment key, including BEGIN/END lines.
- `SERVER_KNOWN_HOSTS`: verified SSH host-key line for the server. Generate it
  with `ssh-keyscan -H YOUR_SERVER_IP`, then compare its fingerprint with the
  server's `/etc/ssh/ssh_host_ed25519_key.pub` before saving it.

Never commit the private key, `.env`, database URL, JWT secret, or Gemini key.

## First deployment

Push these files to `main`, or manually run **Deploy backend** from the Actions tab. Verify on the server:

```bash
systemctl status smart-study-backend.service
curl --fail http://127.0.0.1:4000/health
journalctl -u smart-study-backend.service -n 100 --no-pager
```

## Release layout

```text
/opt/smart-study-backend/
├── current -> releases/<git-sha>
├── releases/<git-sha>/
└── shared/
    ├── .env
    └── uploads/
```

Old releases are retained for manual rollback and should be cleaned up periodically after confirming newer releases are stable.

## Nginx WebSocket proxy

The Flutter production API URL uses the `/smart-study` prefix. The matching Nginx location must forward WebSocket upgrade headers as well as normal HTTP requests:

```nginx
location /smart-study/ {
    proxy_pass http://127.0.0.1:4000/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

After changing Nginx, verify and reload it with `nginx -t` and `systemctl reload nginx`.
