#!/bin/bash
set -e

# Setup nginx reverse proxy on VPS for yt2rutube
# This script configures VPS to accept video requests from Rutube
# and proxy them to the local machine via SSH reverse tunnel.
#
# Usage: ssh root@vps 'bash -s' < scripts/setup-vps-proxy.sh
# Or:    scp scripts/setup-vps-proxy.sh root@vps:/tmp/ && ssh root@vps bash /tmp/setup-vps-proxy.sh

TUNNEL_PORT=${TUNNEL_PORT:-8333}
NGINX_PORT=${NGINX_PORT:-80}

echo "=== yt2rutube VPS Proxy Setup ==="
echo "  Tunnel port: $TUNNEL_PORT"
echo "  Nginx port:  $NGINX_PORT"
echo ""

# 1. Install nginx
if ! command -v nginx &>/dev/null; then
    echo "[1/4] Installing nginx..."
    apt-get update -qq
    apt-get install -y -qq nginx
else
    echo "[1/4] nginx already installed"
fi

# 2. Allow GatewayPorts for SSH reverse tunnels
echo "[2/4] Configuring SSH..."
if ! grep -q "^GatewayPorts yes" /etc/ssh/sshd_config 2>/dev/null; then
    # Remove any existing GatewayPorts line and add the correct one
    sed -i '/^#\?GatewayPorts/d' /etc/ssh/sshd_config
    echo "GatewayPorts yes" >> /etc/ssh/sshd_config
    systemctl reload sshd
    echo "  GatewayPorts enabled, sshd reloaded"
else
    echo "  GatewayPorts already enabled"
fi

# 3. Configure nginx
echo "[3/4] Configuring nginx..."
cat > /etc/nginx/sites-available/yt2rutube-proxy <<NGINX
server {
    listen ${NGINX_PORT};
    server_name _;

    client_max_body_size 2G;
    proxy_buffering off;
    proxy_request_buffering off;

    location /video.mp4 {
        proxy_pass http://127.0.0.1:${TUNNEL_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_connect_timeout 10s;
    }

    location / {
        return 404 "yt2rutube proxy";
    }
}
NGINX

# Enable site
ln -sf /etc/nginx/sites-available/yt2rutube-proxy /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx
echo "  nginx configured and reloaded"

# 4. Open firewall if ufw is active
echo "[4/4] Checking firewall..."
if command -v ufw &>/dev/null && ufw status | grep -q "active"; then
    ufw allow ${NGINX_PORT}/tcp
    ufw allow ${TUNNEL_PORT}/tcp
    echo "  Ports ${NGINX_PORT} and ${TUNNEL_PORT} opened in ufw"
else
    echo "  No active ufw firewall detected, skipping"
fi

# Get public IP
PUBLIC_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || echo "<VPS_IP>")

echo ""
echo "=== Done! ==="
echo ""
echo "VPS is ready. On your local machine, add to .env:"
echo ""
echo "  VPS_HOST=${PUBLIC_IP}"
echo "  VPS_USER=root"
echo "  VPS_TUNNEL_PORT=${TUNNEL_PORT}"
echo "  VPS_PUBLIC_URL=http://${PUBLIC_IP}"
echo ""
echo "Or manually start the tunnel:"
echo "  ssh -R ${TUNNEL_PORT}:localhost:${TUNNEL_PORT} root@${PUBLIC_IP}"
echo ""
echo "For auto-reconnect, install autossh on local machine:"
echo "  brew install autossh   # macOS"
echo ""
