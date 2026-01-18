#!/bin/bash
# Gorifi Deployment Script
# Run this from your local machine to deploy to server

set -e

# Configuration - Update these values
SERVER_USER="root"
SERVER_HOST="your-server-ip"

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
  echo "  full       - Deploy both (default)"
  echo ""
  echo "Examples:"
  echo "  $0 production          # Full deploy to production"
  echo "  $0 staging             # Full deploy to staging"
  echo "  $0 staging backend     # Deploy only backend to staging"
  echo "  $0 production frontend # Deploy only frontend to production"
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
    ;;
  staging)
    ENVIRONMENT="staging"
    REMOTE_PATH="/var/www/gorifi-staging"
    PM2_APP="gorifi-staging"
    PORT=3001
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

if [ "$DEPLOY_FULL" = true ]; then
  DEPLOY_BACKEND=true
  DEPLOY_FRONTEND=true
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

# Deploy backend
if [ "$DEPLOY_BACKEND" = true ]; then
  echo -e "${YELLOW}Deploying backend to $ENVIRONMENT...${NC}"

  # Sync backend files (excluding node_modules and database)
  rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude 'src/db/database.sqlite' \
    "$PROJECT_DIR/backend/" \
    "$SERVER_USER@$SERVER_HOST:$REMOTE_PATH/backend/"

  # Install dependencies and restart
  ssh "$SERVER_USER@$SERVER_HOST" "cd $REMOTE_PATH/backend && npm install --production && pm2 restart $PM2_APP || pm2 start $REMOTE_PATH/ecosystem.config.cjs --only $PM2_APP"

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
    "$PROJECT_DIR/frontend/dist/" \
    "$SERVER_USER@$SERVER_HOST:$REMOTE_PATH/frontend/dist/"

  echo -e "${GREEN}Frontend deployed to $ENVIRONMENT!${NC}"
fi

# Copy deployment config files
echo -e "${YELLOW}Syncing config files...${NC}"
scp "$SCRIPT_DIR/ecosystem.config.cjs" "$SERVER_USER@$SERVER_HOST:$REMOTE_PATH/"

echo ""
echo -e "${GREEN}=== Deployment Complete ($ENVIRONMENT) ===${NC}"
echo ""
echo "Verify with:"
echo "  ssh $SERVER_USER@$SERVER_HOST 'pm2 status && curl -s http://localhost:$PORT/api/health'"
