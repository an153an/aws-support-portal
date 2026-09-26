variable "aws_region" {
  default = "us-east-1"
}

variable "project_name" {
  default = "support-portal"
}

variable "vpc_cidr" {
  default = "10.0.0.0/16"
}

variable "public_subnet_cidrs" {
  default = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  default = ["10.0.11.0/24", "10.0.12.0/24"]
}

variable "instance_type" {
  default = "t3.micro"
}

variable "db_instance_class" {
  default = "db.t3.micro"
}

variable "db_name" {
  default = "support_portal"
}

variable "db_username" {
  default = "admin"
}

variable "db_password" {
  description = "Master password for RDS (set via terraform.tfvars or TF_VAR_db_password)"
  sensitive   = true
}

variable "key_pair_name" {
  description = "Existing EC2 key pair name for SSH access"
}
