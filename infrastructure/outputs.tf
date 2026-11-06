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

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}

output "app_secret_arn" {
  description = "Secrets Manager secret holding the admin password and session key"
  value       = aws_secretsmanager_secret.app.arn
}
