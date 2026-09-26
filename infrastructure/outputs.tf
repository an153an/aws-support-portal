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
