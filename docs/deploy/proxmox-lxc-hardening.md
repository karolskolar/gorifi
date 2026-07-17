# SEC-I2 — Proxmox LXC + PM2 hardening

Gorifi runs in a **Proxmox LXC container** with **PM2** (not Docker), so this is
the LXC/host equivalent of the container-hardening item. Audit refs: §M5
(resource limits, run-as-non-root), §L3 (runtime). Replace `<CTID>` with the
container's ID (find it with `pct list` on the Proxmox host).

> Observed: the production PM2 app had **83 restarts in ~47h** — almost certainly
> the 256 MB `max_memory_restart` clipping the `sql.js` in-memory DB + Node. This
> config raises that (and the ecosystem file in this repo is bumped to 512M).

## 1. Container resource limits + unprivileged (Proxmox host)

```bash
# On the Proxmox HOST (not inside the container):
pct set <CTID> --memory 1024 --swap 512      # hard cap 1 GB RAM + 512 MB swap
pct set <CTID> --cores 2                       # cap CPU cores
# Confirm it is UNPRIVILEGED (best isolation). Check /etc/pve/lxc/<CTID>.conf:
#   unprivileged: 1
# If it shows 0, migrate to an unprivileged CT (backup → restore as unprivileged);
# don't flip the flag in place.
```

`/etc/pve/lxc/<CTID>.conf` should end up with lines like:

```
unprivileged: 1
memory: 1024
swap: 512
cores: 2
features: nesting=0
```

Give the CT enough RAM headroom above what PM2 restarts at (1 GB CT for a 512 MB
app limit is comfortable).

## 2. Run the app as a non-root user (inside the container)

PM2 currently runs as **root** (`pm2 ls` shows `user: root`). Move it to a
dedicated unprivileged user:

```bash
# inside the CT
adduser --system --group --home /var/www gorifi
chown -R gorifi:gorifi /var/www/gorifi /var/www/gorifi-staging /var/log/gorifi /var/log/gorifi-staging

# stop the root-owned PM2, then start PM2 as the gorifi user
pm2 kill
sudo -u gorifi bash -lc 'cd /var/www/gorifi/backend && pm2 start /var/www/gorifi/ecosystem.config.cjs'
sudo -u gorifi bash -lc 'pm2 save'
# make it survive reboot under the gorifi user:
env PATH=$PATH pm2 startup systemd -u gorifi --hp /var/www
```

The deploy script's remote commands should then run as `gorifi`, not `root`
(update `SERVER_USER` / the `ssh` targets in `deploy/deploy.sh` accordingly).

## 3. PM2 memory limit

`deploy/ecosystem.config.cjs` in this repo is updated to `max_memory_restart:
'512M'`. Re-copy it and reload:

```bash
sudo -u gorifi bash -lc 'pm2 reload /var/www/gorifi/ecosystem.config.cjs'
```

If restarts persist, the real fix is the `sql.js` → `better-sqlite3` migration
(SEC-D1), which drops the whole-DB-in-memory model.

## 4. Firewall — only expose what NPM needs

The container should accept **:80 from the Nginx Proxy Manager host only**, plus
SSH (over Tailscale). Using the Proxmox firewall (host → CT → Firewall tab), or
inside the CT with `ufw`:

```bash
# inside the CT
ufw default deny incoming
ufw default allow outgoing
ufw allow from <NPM_HOST_IP> to any port 80 proto tcp
ufw allow in on tailscale0                      # SSH/admin over the tailnet
ufw --force enable
```

The app ports 3000/3001 must **not** be reachable directly — only via NPM on :80.

## 5. Automatic security updates + runtime

```bash
# inside the CT
apt-get update && apt-get install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades      # enable

# Runtime: setup-server.sh pins Node 18 (EOL). Move to Node 20 LTS (SEC-D3):
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node --version   # expect v20.x
```

## 6. Verify

```bash
pct config <CTID> | grep -E 'unprivileged|memory|cores|swap'   # limits applied
pm2 ls                                                          # user column = gorifi, not root
sudo -u gorifi pm2 describe gorifi-backend | grep 'restarts'    # should stop climbing
ufw status                                                      # only 80-from-NPM + tailscale
```
