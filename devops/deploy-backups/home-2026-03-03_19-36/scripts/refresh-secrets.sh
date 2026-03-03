#!/bin/bash
# Fetch secrets from Infisical and write to .env
# Called on boot and can be called manually to refresh

INFISICAL_API=http://192.168.1.47:8080/api
CLIENT_ID=e55f4ca2-bed0-4287-97fb-db1ee349c274
PROJECT_ID=319a1db5-207d-49d0-a61d-3f3e6b440ded
ENV=dev
ENV_FILE=/opt/poller/.env
CLIENT_SECRET_FILE=/opt/poller/.infisical-secret

# Keys the home poller does NOT need (Fly.io ops credentials)
EXCLUDE_KEYS="FLY_API_TOKEN|FLY_MACHINE_ID|TS_AUTHKEY|CRON_SCHEDULE|HOME_PROXY_URL|PROXY_SERVER"

# Read client secret from file
if [ ! -f "$CLIENT_SECRET_FILE" ]; then
    echo "ERROR: Client secret file not found at $CLIENT_SECRET_FILE"
    exit 1
fi
CLIENT_SECRET=$(cat "$CLIENT_SECRET_FILE")

# Get access token
TOKEN=$(infisical login --method=universal-auth \
    --client-id="$CLIENT_ID" \
    --client-secret="$CLIENT_SECRET" \
    --domain="$INFISICAL_API" 2>/dev/null | grep -A1 "Access Token:" | tail -1 | tr -d " ")

if [ -z "$TOKEN" ]; then
    echo "ERROR: Failed to get access token"
    exit 1
fi

# Export secrets to .env
infisical export --env="$ENV" \
    --projectId="$PROJECT_ID" \
    --format=dotenv \
    --token="$TOKEN" \
    --domain="$INFISICAL_API" 2>/dev/null > "$ENV_FILE.tmp"

if [ -s "$ENV_FILE.tmp" ]; then
    # Remove keys the home poller doesn't need
    grep -vE "^($EXCLUDE_KEYS)=" "$ENV_FILE.tmp" > "$ENV_FILE.tmp2"
    mv "$ENV_FILE.tmp2" "$ENV_FILE.tmp"

    # Replace single quotes with double quotes (preserves values with spaces)
    sed -i "s/='/=\"/;s/'$/\"/" "$ENV_FILE.tmp"

    # Remove blank lines
    sed -i '/^$/d' "$ENV_FILE.tmp"

    # Add poller-specific vars not in Infisical
    cat >> "$ENV_FILE.tmp" << EOF
POLLER_ID=home
DATA_DIR=/opt/poller/data
FIRECRAWL_BASE_URL=http://localhost:3002
FLYIO_TAILSCALE_IP=100.90.171.110
BROWSER_MODE=local
PLAYWRIGHT_LAUNCH=1
PLAYWRIGHT_BROWSERS_PATH=/usr/local/share/playwright
EOF
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    chown root:root "$ENV_FILE"
    echo "Secrets refreshed at $(date)"
else
    echo "ERROR: Export returned empty, keeping existing .env"
    rm -f "$ENV_FILE.tmp"
    exit 1
fi
