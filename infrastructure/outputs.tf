output "alb_dns_name" {
  description = "Public URL of the support portal (via the ALB)"
  value       = aws_lb.app.dns_name
}

output "rds_endpoint" {
  description = "RDS instance endpoint"
  value       = aws_db_instance.main.address
}

output "s3_bucket_name" {
  value = aws_s3_bucket.assets.bucket
}

output "ecr_repository_url" {
  description = "Push built images here before the ECS service can start tasks"
  value       = aws_ecr_repository.app.repository_url
}

output "db_secret_arn" {
  description = "Secrets Manager secret holding the DB credentials"
  value       = aws_secretsmanager_secret.db.arn
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.app.id
}

output "cloudwatch_dashboard_url" {
  description = "CloudWatch dashboard for the portal"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}
