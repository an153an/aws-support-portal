#!/usr/bin/env bash
# Create (or promote) the first admin user in the Cognito pool.
# Usage: scripts/create-admin.sh admin@example.com 'S0me-Passw0rd' "Admin Name"
set -euo pipefail

EMAIL="${1:?email required}"
PASSWORD="${2:?password required}"
NAME="${3:-Admin}"
REGION="${AWS_REGION:-us-east-1}"
POOL_ID="$(cd "$(dirname "$0")/../infrastructure" && terraform output -raw cognito_user_pool_id)"

aws cognito-idp admin-create-user --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" --message-action SUPPRESS \
  --user-attributes Name=email,Value="$EMAIL" Name=email_verified,Value=true Name=name,Value="$NAME" >/dev/null 2>&1 \
  || echo "User already exists — updating password and group only."

aws cognito-idp admin-set-user-password --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" --password "$PASSWORD" --permanent
aws cognito-idp admin-add-user-to-group --region "$REGION" --user-pool-id "$POOL_ID" \
  --username "$EMAIL" --group-name admin
echo "Done: $EMAIL is an admin. Sign in on the portal's /login page."
