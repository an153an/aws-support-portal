# ---- S3 bucket for static assets / app config ----
resource "aws_s3_bucket" "assets" {
  bucket = "${var.project_name}-assets-${data.aws_caller_identity.current.account_id}"
  tags   = { Name = "${var.project_name}-assets" }
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_caller_identity" "current" {}

# Static asset (served by EC2 pulling it from S3 at boot via its IAM role —
# the bucket itself stays private, no public S3 URLs are ever exposed)
resource "aws_s3_object" "style_css" {
  bucket       = aws_s3_bucket.assets.id
  key          = "static/style.css"
  source       = "${path.module}/../app/public/style.css"
  etag         = filemd5("${path.module}/../app/public/style.css")
  content_type = "text/css"
}
