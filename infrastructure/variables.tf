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

variable "fargate_cpu" {
  description = "Task-level vCPU units (256 = 0.25 vCPU)"
  default     = "256"
}

variable "fargate_memory" {
  description = "Task-level memory in MB"
  default     = "512"
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

variable "db_snapshot_identifier" {
  description = "RDS snapshot to restore the database from. Leave null to create a fresh, empty database instead."
  type        = string
  default     = null
}

variable "alert_email" {
  description = "Email address to notify when a CloudWatch alarm fires. Leave empty to create the alarms without an email subscription."
  type        = string
  default     = ""
}

variable "min_tasks" {
  description = "Minimum (and initial) number of Fargate tasks; keep >= 2 so the service spans both AZs"
  type        = number
  default     = 2
}

variable "max_tasks" {
  description = "Maximum number of Fargate tasks autoscaling may run"
  type        = number
  default     = 6
}

variable "requests_per_task_target" {
  description = "Target ALB requests per task per minute for the request-count scaling policy"
  type        = number
  default     = 200
}

variable "db_multi_az" {
  description = "Run a synchronous standby replica in a second AZ with automatic failover. Roughly doubles the RDS instance cost; set to false for a cheap demo."
  type        = bool
  default     = true
}
