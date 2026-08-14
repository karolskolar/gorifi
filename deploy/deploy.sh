#!/bin/bash
# Gorifi Deployment Script
# Run this from your local machine to deploy to server

set -e

# Configuration - Update these values
SERVER_USER="root"
SERVER_HOST="gorifi"
# The app runs as this non-root user (SEC-I2). npm + pm2 run as it via runuser,
# and synced files are chowned to it. root's pm2 is intentionally empty.
APP_USER="gorifi"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get the directory where this script is located
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Check if server details are configured
if [ "$SERVER_HOST" = "your-server-ip" ]; then
  echo -e "${RED}Error: Please edit this script and set SERVER_HOST${NC}"
  exit 1
fi

# Parse arguments
ENVIRONMENT=""
DEPLOY_BACKEND=false
DEPLOY_FRONTEND=false
DEPLOY_FULL=false

show_usage() {
  echo "Usage: $0 <environment> [backend|frontend|full]"
  echo ""
  echo "Environments:"
  echo "  production - Deploy to production (gorifi.skolar.sk)"
  echo "  staging    - Deploy to staging/dev (gorifi-dev.skolar.sk)"
  echo ""
  echo "Components:"
  echo "  backend    - Deploy only backend"
  echo "  frontend   - Build and deploy only frontend"
  echo "  nginx      - Deploy only the nginx site config (reload, no app restart)"
  echo "  full       - Deploy backend + frontend + nginx config (default)"
  echo ""
  echo "Examples:"
  echo "  $0 production          # Full deploy to production"
  echo "  $0 staging             # Full deploy to staging"
  echo "  $0 staging backend     # Deploy only backend to staging"
  echo "  $0 production frontend # Deploy only frontend to production"
  echo "  $0 production nginx    # Reload nginx config only (e.g. a header change)"
  exit 1
}

# First argument: environment (required)
if [ $# -eq 0 ]; then
  show_usage
fi

case "$1" in
  production)
    ENVIRONMENT="production"
    REMOTE_PATH="/var/www/gorifi"
    PM2_APP="gorifi-backend"
    PORT=3000
    NGINX_SITE="gorifi"
    NGINX_SRC="nginx-gorifi.conf"
    ;;
  staging)
    ENVIRONMENT="staging"
    REMOTE_PATH="/var/www/gorifi-staging"
    PM2_APP="gorifi-staging"
    PORT=3001
    NGINX_SITE="gorifi-staging"
    NGINX_SRC="nginx-gorifi-staging.conf"
    ;;
  *)
    echo -e "${RED}Error: First argument must be 'production' or 'staging'${NC}"
    echo ""
    show_usage
    ;;
esac

# Second argument: component (optional, defaults to full)
if [ $# -eq 1 ]; then
  DEPLOY_FULL=true
else
  case "$2" in
    backend)
      DEPLOY_BACKEND=true
      ;;
    nginx)
      DEPLOY_NGINX_ONLY=true
      ;;
    frontend)
      DEPLOY_FRONTEND=true
      ;;
    full)
      DEPLOY_FULL=true
      ;;
    *)
      echo -e "${RED}Error: Invalid component '$2'${NC}"
      echo ""
      show_usage
      ;;
  esac
fi

DEPLOY_NGINX=false
if [ "$DEPLOY_NGINX_ONLY" = true ]; then
  DEPLOY_NGINX=true
fi
if [ "$DEPLOY_FULL" = true ]; then
  DEPLOY_BACKEND=true
  DEPLOY_FRONTEND=true
  DEPLOY_NGINX=true
fi

# Display deployment info
echo -e "${GREEN}=== Gorifi Deployment ===${NC}"
echo -e "Environment:       ${CYAN}$ENVIRONMENT${NC}"
echo -e "Server:            $SERVER_USER@$SERVER_HOST"
echo -e "Remote path:       $REMOTE_PATH"
echo -e "PM2 app:           $PM2_APP"
echo -e "Backend port:      $PORT"
echo -e "Deploy backend:    $DEPLOY_BACKEND"
echo -e "Deploy frontend:   $DEPLOY_FRONTEND"
echo -e "Deploy nginx:      $DEPLOY_NGINX ($NGINX_SITE)"
echo ""

# Staging warning
if [ "$ENVIRONMENT" = "staging" ]; then
  echo -e "${YELLOW}Deploying to STAGING environment${NC}"
  echo ""
fi

# Production confirmation
if [ "$ENVIRONMENT" = "production" ]; then
  echo -e "${YELLOW}Deploying to PRODUCTION environment${NC}"
  read -p "Are you sure? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Deployment cancelled."
    exit 0
  fi
  echo ""
fi

# Back up the production DB BEFORE touching anything (SEC-D2). Aborts the deploy
# if the backup fails (set -e) — never deploy without a fresh off-host backup.
if [ "$ENVIRONMENT" = "production" ]; then
  echo -e "${YELLOW}Backing up production DB (encrypted → Google Drive)...${NC}"
  ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $REMOTE_PATH/deploy && chown $APP_USER:$APP_USER $REMOTE_PATH/deploy"
  scp "$SCRIPT_DIR/backup-db.sh" "$SERVER_USER@$SERVER_HOST:$REMOTE_PATH/deploy/backup-db.sh"
  ssh "$SERVER_USER@$SERVER_HOST" "chown $APP_USER:$APP_USER $REMOTE_PATH/deploy/backup-db.sh && chmod +x $REMOTE_PATH/deploy/backup-db.sh && runuser -u $APP_USER -- bash $REMOTE_PATH/deploy/backup-db.sh deploy"
  echo -e "${GREEN}Pre-deploy backup complete.${NC}"
fi

# Deploy backend
if [ "$DEPLOY_BACKEND" = true ]; then
  echo -e "${YELLOW}Deploying backend to $ENVIRONMENT...${NC}"

  # Ensure remote directories exist
  ssh "$SERVER_USER@$SERVER_HOST" "mkdir -p $REMOTE_PATH/backend /var/log/gorifi /var/log/gorifi-staging"

  # Copy ecosystem config first (needed for PM2 start on first deploy)
  scp "$SCRIPT_DIR/ecosystem.config.cjs" "$SERVER_USER@$SERVER_HOST:$REMOTE_PATH/"
  ssh "$SERVER_USER@$SERVER_HOST" "chown $APP_USER:$APP_USER $REMOTE_PATH/ecosystem.config.cjs"

  # Sync backend files. Exclude node_modules and the DB glob (database.sqlite +
  # -wal + -shm — deleting a live WAL file risks data loss). Chown to the app user.
  rsync -avz --delete \
    --chown="$APP_USER:$APP_USER" \
    --exclude 'node_modules' \
    --exclude 'src/db/database.sqlite*' \
    "$PROJECT_DIR/backend/" \
    "$SERVER_USER@$SERVER_HOST:$REMOTE_PATH/backend/"

  # Install deps and restart AS the app user (apps live in the gorifi pm2 daemon).
  #
  # ⚠ RESTART FROM THE FILE, NEVER FROM THE APP NAME. `pm2 restart <name>` relaunches
  # from PM2's STORED per-process config and does NOT re-read ecosystem.config.cjs, so
  # any field added to that file (env, node_args, limits) never reaches the process —
  # the rsync + scp above land the new config and the restart silently ignores it.
  # Measured with PM2 7.0.3 on an already-running app whose file had just gained
  # `node_args`: restart-by-name left `node_args: []` and the child's `execArgv` empty;
  # `pm2 restart <file> --only <app>` applied it on the same daemon. That is how the
  # IA-T6 Mailgun `--env-file-if-exists` would have shipped dead — and `not_configured`
  # is the one outcome the approval dialog renders as NOTHING, so there would have been
  # no signal anywhere. (The mailer's boot log line is the second half of that fix.)
  #
  # `pm2 restart <file>` also STARTS an app that is not running yet ("Applications X not
  # running, starting..."), so it covers a first deploy on its own; the `pm2 start`
  # fallback is kept for a daemon-level failure, which is the only case left.
  ssh "$SERVER_USER@$SERVER_HOST" "runuser -u $APP_USER -- bash -lc 'cd $REMOTE_PATH/backend && npm ci --omit=dev && (pm2 restart $REMOTE_PATH/ecosystem.config.cjs --only $PM2_APP || pm2 start $REMOTE_PATH/ecosystem.config.cjs --only $PM2_APP) && pm2 save'"

  echo -e "${GREEN}Backend deployed to $ENVIRONMENT!${NC}"
fi

# Deploy frontend
if [ "$DEPLOY_FRONTEND" = true ]; then
  echo -e "${YELLOW}Building frontend for $ENVIRONMENT...${NC}"
  cd "$PROJECT_DIR/frontend"

  # Set environment variable for staging indicator
  if [ "$ENVIRONMENT" = "staging" ]; then
    VITE_STAGING=true npm run build
  else
    npm run build
  fi

  echo -e "${YELLOW}Deploying frontend to $ENVIRONMENT...${NC}"
  rsync -avz --delete \
    --chown="$APP_USER:$APP_USER" \
    "$PROJECT_DIR/frontend/dist/" \
    "$SERVER_USER@$SERVER_HOST:$REMOTE_PATH/frontend/dist/"

  echo -e "${GREEN}Frontend deployed to $ENVIRONMENT!${NC}"
fi

# Deploy the nginx site config.
#
# This exists because the config used to be reference-only and hand-copied, which
# let production drift from the repo — prod was missing the `location = /index.html`
# no-cache block for months, so it served a cacheable index.html and deploys did not
# take effect immediately.
#
# Ordered AFTER the frontend sync so a config referring to freshly built files is
# never live before those files exist. Backs up the current config, validates with
# `nginx -t` BEFORE reloading, and (via set -e) aborts the deploy rather than
# reloading a broken config. Only reached on a full deploy.
if [ "$DEPLOY_NGINX" = true ]; then
  echo -e "${YELLOW}Deploying nginx config ($NGINX_SITE)...${NC}"

  scp "$SCRIPT_DIR/$NGINX_SRC" "$SERVER_USER@$SERVER_HOST:/tmp/$NGINX_SITE.new"

  ssh "$SERVER_USER@$SERVER_HOST" "
    set -e
    TARGET=\$(readlink -f /etc/nginx/sites-enabled/$NGINX_SITE)
    cp \"\$TARGET\" \"/root/$NGINX_SITE.bak.\$(date +%s)\"
    cp /tmp/$NGINX_SITE.new \"\$TARGET\"
    rm -f /tmp/$NGINX_SITE.new
    nginx -t
    nginx -s reload
  "

  echo -e "${GREEN}nginx config deployed and reloaded ($NGINX_SITE).${NC}"
fi

echo ""
echo -e "${GREEN}=== Deployment Complete ($ENVIRONMENT) ===${NC}"
echo ""
echo "Verify with:"
echo "  ssh $SERVER_USER@$SERVER_HOST 'pm2 status && curl -s http://localhost:$PORT/api/health'"
