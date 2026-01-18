# Session Summary

**Date:** 2026-01-18
**Status:** Deployment infrastructure ready, not yet deployed

## Summary

Added staging/dev environment support for deploying to Proxmox LXC container. Created deployment scripts, PM2 config, and nginx configs for running both production (`gorifi.skolar.sk`) and dev (`gorifi-dev.skolar.sk`) from the same container on different ports.

## Files Changed/Added

| File | Change |
|------|--------|
| `deploy/ecosystem.config.cjs` | Added `gorifi-staging` PM2 app on port 3001 |
| `deploy/nginx-gorifi.conf` | Updated server_name to `gorifi.skolar.sk` |
| `deploy/nginx-gorifi-staging.conf` | **NEW** - nginx config for dev environment |
| `deploy/deploy.sh` | Rewritten to require environment arg (production/staging) |
| `frontend/src/App.vue` | Added staging banner (amber bar when `VITE_STAGING=true`) |
| `CLAUDE.md` | Added deployment documentation |

## Current State

- Deployment scripts ready
- **Not yet deployed to server**
- Server needs one-time setup (directories, nginx, PM2)

## Next Steps

### 1. Server Setup (one-time)
```bash
# SSH into LXC container
apt update && apt install -y nodejs npm nginx
npm install -g pm2

# Create directories
mkdir -p /var/www/gorifi/{backend,frontend/dist}
mkdir -p /var/www/gorifi-staging/{backend,frontend/dist}
mkdir -p /var/log/gorifi /var/log/gorifi-staging

# Setup nginx
cp nginx-gorifi.conf /etc/nginx/sites-available/gorifi
cp nginx-gorifi-staging.conf /etc/nginx/sites-available/gorifi-staging
ln -s /etc/nginx/sites-available/gorifi /etc/nginx/sites-enabled/
ln -s /etc/nginx/sites-available/gorifi-staging /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx
```

### 2. Nginx Proxy Manager
Create proxy hosts:
- `gorifi.skolar.sk` → `<container-ip>:80` + SSL
- `gorifi-dev.skolar.sk` → `<container-ip>:80` + SSL

### 3. Configure & Deploy
```bash
# Edit deploy/deploy.sh - set SERVER_HOST
vim deploy/deploy.sh

# Deploy to dev first
./deploy/deploy.sh staging

# Verify
ssh root@<ip> 'pm2 status'
```

## How to Test Locally

```bash
# Backend
cd backend && npm run dev

# Frontend
cd frontend && npm run dev

# Test staging banner
VITE_STAGING=true npm run dev
```
