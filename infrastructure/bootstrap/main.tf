# One-time bootstrap for the CI/CD pipeline. Run this ONCE by hand (its own
# small state stays local); it creates what the main configuration and the
# GitHub Actions workflow depend on but cannot create for themselves:
#   - an S3 bucket + DynamoDB table for the main configuration's Terraform state
#   - an OIDC trust so GitHub Actions can assume AWS roles WITHOUT long-lived
#     access keys stored in GitHub
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "aws_region" {
  default = "us-east-1"
}

variable "project_name" {
  default = "support-portal"
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/name"
  default     = "an153an/aws-support-portal"
}

variable "create_oidc_provider" {
  description = "Set to false if this AWS account already has the token.actions.githubusercontent.com OIDC provider (only one is allowed per account)"
  type        = bool
  default     = true
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

# ---- Remote state ----
resource "aws_s3_bucket" "state" {
  bucket = "${var.project_name}-tfstate-${data.aws_caller_identity.current.account_id}"
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled" # lets you roll back a bad state file
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Prevents two pipeline runs (or a run and a laptop) applying at the same time.
resource "aws_dynamodb_table" "lock" {
  name         = "${var.project_name}-tflock"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }
}

# ---- GitHub OIDC ----
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS validates GitHub's certificate chain itself; this value is a required placeholder.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# Deploy role: assumable ONLY by workflow runs on this repo's main branch.
resource "aws_iam_role" "deploy" {
  name = "${var.project_name}-github-deploy"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.oidc_arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

# Terraform creates IAM roles, VPCs, RDS, Cognito, etc., so this role needs broad
# rights. The protection is WHO can assume it (the trust policy above), not a
# narrow policy. For a production system, replace this with a hand-scoped policy.
resource "aws_iam_role_policy_attachment" "deploy" {
  role       = aws_iam_role.deploy.name
  policy_arn = "arn:aws:iam::aws:policy/AdministratorAccess"
}

# Plan role: assumable by pull_request runs; read-only, plus state access.
resource "aws_iam_role" "plan" {
  name = "${var.project_name}-github-plan"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRoleWithWebIdentity"
      Principal = { Federated = local.oidc_arn }
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:pull_request"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "plan_readonly" {
  role       = aws_iam_role.plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "plan_state" {
  name = "terraform-state-access"
  role = aws_iam_role.plan.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:ListBucket"]
        Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]
      },
      {
        # `plan` takes the state lock; it only ever writes lock rows.
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:DeleteItem"]
        Resource = aws_dynamodb_table.lock.arn
      },
    ]
  })
}

output "tf_state_bucket" {
  value = aws_s3_bucket.state.bucket
}

output "tf_lock_table" {
  value = aws_dynamodb_table.lock.name
}

output "deploy_role_arn" {
  description = "Set as the GitHub repository variable AWS_DEPLOY_ROLE_ARN"
  value       = aws_iam_role.deploy.arn
}

output "plan_role_arn" {
  description = "Set as the GitHub repository variable AWS_PLAN_ROLE_ARN"
  value       = aws_iam_role.plan.arn
}
