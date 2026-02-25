#!/bin/bash
# StakTrakr Home Poller — LXC Ubuntu 24.04 setup script
# Run this once inside the LXC container as root.

set -e

echo "=== Installing Node.js 22 ==="
apt update
apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs

echo "Node: $(node -v), npm: $(npm -v)"

echo "=== Cloning StakScraper repo ==="
mkdir -p /opt/poller/data/retail
mkdir -p /opt/poller/data/api
mkdir -p /var/log
git clone https://github.com/lbruton/stakscrapr /opt/poller
cd /opt/poller

echo "=== Installing npm dependencies ==="
npm install

echo "=== Installing Chromium for Playwright ==="
npx playwright install chromium
npx playwright install-deps chromium

echo "=== Setting permissions ==="
chmod +x /opt/poller/run-home.sh

echo "=== Installing crontab ==="
cat > /etc/cron.d/retail-poller << 'EOF'
# StakTrakr home poller — runs at :30 past every hour
# Offset from Fly.io :00 run to stagger Turso writes
30 * * * * root /opt/poller/run-home.sh >> /var/log/retail-poller.log 2>&1
EOF
chmod 644 /etc/cron.d/retail-poller

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Copy .env.example to /opt/poller/.env and fill in Turso credentials"
echo "  2. Test run: bash /opt/poller/run-home.sh  (auto-fetches providers.json)"
echo "  3. Check logs: tail -f /var/log/retail-poller.log"
echo ""
echo "Source: https://github.com/lbruton/stakscrapr"
