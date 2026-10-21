# ---- Cognito user pool: accounts + roles ----
# Roles are Cognito *groups* (customer / agent / admin). The app signs users in
# against this pool and reads the group membership from the ID token.
resource "aws_cognito_user_pool" "main" {
  name                     = "${var.project_name}-users"
  username_attributes      = ["email"]
  auto_verified_attributes = [] # the app creates users via the admin API with email_verified=true

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "admin_only"
      priority = 1
    }
  }

  tags = { Name = "${var.project_name}-users" }
}

# Public client (no secret): the Node app calls InitiateAuth on the user's behalf
# with the USER_PASSWORD_AUTH flow, then verifies the returned ID token.
resource "aws_cognito_user_pool_client" "app" {
  name         = "${var.project_name}-app"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  id_token_validity             = 8
  token_validity_units {
    id_token = "hours"
  }
}

resource "aws_cognito_user_group" "roles" {
  for_each = {
    admin    = { precedence = 1, description = "Full access: manage users, delete tickets and articles" }
    agent    = { precedence = 2, description = "Support staff: work all tickets, publish KB articles" }
    customer = { precedence = 3, description = "Can raise and follow their own tickets" }
  }

  name         = each.key
  user_pool_id = aws_cognito_user_pool.main.id
  description  = each.value.description
  precedence   = each.value.precedence
}

# ---- Session signing key (cookie-session) ----
resource "random_password" "session" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "session" {
  name                    = "${var.project_name}/session"
  description             = "Key used to sign the portal's session cookies"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "session" {
  secret_id     = aws_secretsmanager_secret.session.id
  secret_string = random_password.session.result
}
