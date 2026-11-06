# ---- Secrets Manager: database credentials ----
# Terraform generates the master password; it is never typed into
# terraform.tfvars or committed. It lives in the Terraform state (which is
# git-ignored) and in this secret, which the ECS execution role injects into
# the container as environment variables at task start.
resource "random_password" "db" {
  length  = 32
  special = false # RDS MySQL forbids / @ " and space; alphanumeric is simplest
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${var.project_name}/db"
  description             = "RDS MySQL connection details for the support portal"
  recovery_window_in_days = 0 # delete immediately on destroy so re-applies don't collide with a pending-deletion name
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username = var.db_username
    password = random_password.db.result
    host     = aws_db_instance.main.address
    port     = "3306"
    dbname   = var.db_name
  })
}

# ---- Secrets Manager: admin sign-in password and session-cookie signing key ----
# The admin view (/admin) is protected by one shared password. Terraform
# generates it, so nobody picks or commits one; read it with:
#   aws secretsmanager get-secret-value --secret-id support-portal/app \
#     --query SecretString --output text
resource "random_password" "admin" {
  length  = 20
  special = false
}

resource "random_password" "session" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "app" {
  name                    = "${var.project_name}/app"
  description             = "Admin password and session signing key for the support portal"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    admin_password = random_password.admin.result
    session_secret = random_password.session.result
  })
}
