#!/bin/bash
set -e
dnf install -y nodejs npm git

mkdir -p /opt/app
cd /opt/app
git clone https://github.com/an153an/aws-support-portal.git .
cd app
npm install --production

cat > .env <<EOF
PORT=3000
DB_HOST=${db_host}
DB_USER=${db_username}
DB_PASSWORD=${db_password}
DB_NAME=${db_name}
EOF

cat > /etc/systemd/system/support-portal.service <<'EOF'
[Unit]
Description=Support Portal App
After=network.target

[Service]
WorkingDirectory=/opt/app/app
ExecStart=/usr/bin/node server.js
Restart=always
User=ec2-user
EnvironmentFile=/opt/app/app/.env

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable support-portal
systemctl start support-portal
