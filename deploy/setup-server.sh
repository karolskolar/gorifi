#!/bin/bash
# Gorifi Server Setup Script
# Run this on a fresh Debian/Ubuntu LXC container

set -e

echo "=== Gorifi Server Setup ==="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run as root (sudo)"
  exit 1
fi

echo "Step 1: Updating system..."
apt update && apt upgrade -y

echo "Step 2: Installing Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
apt install -y nodejs

echo "Step 3: Installing nginx..."
apt install -y nginx

echo "Step 4: Installing PM2..."
npm install -g pm2

echo "Step 5: Creating directories..."
mkdir -p /var/www/gorifi/backend
mkdir -p /var/www/gorifi/frontend/dist
mkdir -p /var/log/gorifi
mkdir -p /var/backups/gorifi

echo "Step 6: Setting up nginx..."
# Remove default site
rm -f /etc/nginx/sites-enabled/default

echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "1. Copy your backend files to /var/www/gorifi/backend/"
echo "2. Copy your frontend dist to /var/www/gorifi/frontend/dist/"
echo "3. Copy nginx-gorifi.conf to /etc/nginx/sites-available/gorifi"
echo "4. Run: ln -s /etc/nginx/sites-available/gorifi /etc/nginx/sites-enabled/"
echo "5. Run: cd /var/www/gorifi/backend && npm install --production"
echo "6. Copy ecosystem.config.cjs to /var/www/gorifi/"
echo "7. Run: pm2 start /var/www/gorifi/ecosystem.config.cjs"
echo "8. Run: pm2 save && pm2 startup"
echo "9. Run: nginx -t && systemctl reload nginx"
echo ""
echo "For HTTPS, run: apt install -y certbot python3-certbot-nginx && certbot --nginx"
