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
