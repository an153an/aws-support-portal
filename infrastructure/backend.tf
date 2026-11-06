# Terraform state lives in S3 (with DynamoDB locking) so the GitHub Actions
# pipeline and developers share one source of truth. The bucket/table are
# created once by infrastructure/bootstrap; their names are supplied at init
# time rather than hard-coded:
#
#   terraform init -backend-config=backend.hcl        (see backend.hcl.example)
terraform {
  backend "s3" {}
}
