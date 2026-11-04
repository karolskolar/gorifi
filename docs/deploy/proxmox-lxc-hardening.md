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

# Runtime: Node 20 reached end-of-life on 2026-04-30 (no more security patches).
# setup-server.sh and the Dockerfile now pin Node 22 LTS (maintained until 2027-04-30).
# On an EXISTING container, upgrade in place. ⚠ Production AND staging share this
# container and ONE pm2 daemon, so this is a production change too (a few seconds of
# restart). ⚠ The CT has no `sudo` — use `runuser`, as deploy.sh does. Verified
# end-to-end on 2026-10-31 (Node 20.20.2 → 22.23.4, both apps 200 afterwards):
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
node --version   # expect v22.x
npm install -g pm2@6                               # rebuild the global pm2 against the new node (same major)
# Re-install native deps for the new ABI (127) for BOTH apps BEFORE any restart.
# better-sqlite3 11.10.0 has a Node 22 prebuilt, so this downloads a binary rather than compiling:
for d in gorifi gorifi-staging; do runuser -u gorifi -- bash -lc "cd /var/www/$d/backend && npm ci --omit=dev"; done
runuser -u gorifi -- bash -lc "pm2 save"
pm2 startup systemd -u gorifi --hp /home/gorifi    # regenerate the unit: it embeds the node path
systemctl daemon-reload
runuser -u gorifi -- bash -lc "pm2 kill"           # then resurrect UNDER systemd on the new node
systemctl restart pm2-gorifi.service
runuser -u gorifi -- bash -lc "pm2 ls && pm2 save"
curl -fsS http://127.0.0.1:3000/api/health         # both must be 200 before leaving
curl -fsS http://127.0.0.1:3001/api/health
```

⚠ `deploy/deploy.sh` rsyncs with `--exclude node_modules`; a `node_modules` built
under Node 20 (ABI 115) is NOT reused by Node 22 (ABI 127) — `better-sqlite3` throws
`NODE_MODULE_VERSION 115 ... requires 127` on first start. The `npm ci` above is the
fix (a regular `./deploy/deploy.sh <env>` run performs the same `npm ci --omit=dev`, so
deploying right after the runtime upgrade also heals it).

## 6. Verify

```bash
pct config <CTID> | grep -E 'unprivileged|memory|cores|swap'   # limits applied
pm2 ls                                                          # user column = gorifi, not root
sudo -u gorifi pm2 describe gorifi-backend | grep 'restarts'    # should stop climbing
ufw status                                                      # only 80-from-NPM + tailscale
```
