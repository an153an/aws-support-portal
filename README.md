# AWS Support Portal

A simple support portal web app deployed on AWS, built for EMGT 308. It has two sections:

- **Tickets** — submit and track support tickets (open / in progress / closed)
- **Knowledge Base** — publish and browse help articles

The project demonstrates a 3-tier architecture on AWS covering **compute, storage, networking, security, and database**.

## Architecture

The app is containerized and runs on **ECS Fargate** — no EC2 instances to patch or manage; AWS runs the containers directly.

```
                        Internet
                            │
                    ┌───────▼────────┐
                    │  Application    │
                    │  Load Balancer  │  (public subnets)
                    └───────┬────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
      ┌───────▼───────┐           ┌───────▼───────┐
      │ Fargate task   │           │ Fargate task   │   (private subnets,
      │  (container)   │  ◄─────►  │  (container)   │    outbound via NAT GW)
      └───────┬───────┘           └───────┬───────┘
              │                           │
              └─────────────┬─────────────┘
                            │
                    ┌───────▼────────┐
                    │   RDS (MySQL)   │  (private subnets)
                    └────────────────┘

      ECR — stores the built container image
      S3 bucket (encrypted, private) — static asset fetched by the container at startup
```

| Pillar | AWS Service | Purpose |
|---|---|---|
| Compute | ECS on Fargate | Runs the containerized Node.js app, no servers to manage |
| Storage | S3, ECR | Static assets (`style.css`) + the app's container image |
| Networking | VPC, public/private subnets, ALB, NAT Gateway | Routes traffic, isolates app/db tier |
| Security | Security Groups, IAM roles (task + execution) | Least-privilege access between tiers |
| Database | RDS (MySQL) | Stores tickets and KB articles |

## Repo structure

```
app/              Node.js/Express web app (tickets + knowledge base)
infrastructure/   Terraform IaC for the full AWS architecture
```

---

## Infrastructure details

Everything below lives in `infrastructure/` as Terraform (HCL) files, using the `hashicorp/aws` provider (`~> 5.0`). Resource names below match the `.tf` files exactly.

### `provider.tf`
Pins `required_version >= 1.5.0` for Terraform and `~> 5.0` for the AWS provider, and configures the provider with `region = var.aws_region`. Also declares `data "aws_availability_zones" "available"` (filtered to `state = "available"`), which `networking.tf` and `compute.tf` index into for AZ placement.

### `variables.tf`
Input variables consumed across the other files — no resources declared here. Notable ones: `vpc_cidr` (`10.0.0.0/16`), `public_subnet_cidrs`/`private_subnet_cidrs` (2 CIDRs each), `fargate_cpu`/`fargate_memory` (`256`/`512`, i.e. 0.25 vCPU / 512MB per task), `db_instance_class` (`db.t3.micro`), and `db_password`, which has no default and must be passed via `-var` or `TF_VAR_*` env vars at apply time (kept out of the repo intentionally).

### `networking.tf`
- `aws_vpc.main` — CIDR `10.0.0.0/16`, with `enable_dns_support` and `enable_dns_hostnames` set so instances get resolvable private DNS names.
- `aws_subnet.public[count.index]` (x2) — one per CIDR in `public_subnet_cidrs`, each pinned to a distinct AZ via `data.aws_availability_zones.available.names[count.index]`, with `map_public_ip_on_launch = true`.
- `aws_subnet.private[count.index]` (x2) — same pattern, no auto-assigned public IPs.
- `aws_internet_gateway.igw` — attached to the VPC; the only resource with a route to `0.0.0.0/0` on the public side.
- `aws_eip.nat` + `aws_nat_gateway.nat` — the NAT Gateway is provisioned in `aws_subnet.public[0]` and depends explicitly on the IGW (`depends_on`) since NAT requires the IGW to exist first.
- `aws_route_table.public` — a single `0.0.0.0/0 -> igw` route, associated with both public subnets via `aws_route_table_association.public[count.index]`.
- `aws_route_table.private` — a single `0.0.0.0/0 -> nat_gateway_id` route, associated with both private subnets the same way.

Net effect: public subnets route bidirectionally to the IGW; private subnets only route outbound via NAT — nothing from outside the VPC can open a connection into a private subnet directly.

### `security.tf`
Three `aws_security_group` resources, each referencing the previous SG's ID instead of a CIDR block (SG-to-SG references stay valid across instance replacement; IP allowlists don't):

| SG | Ingress rule | Egress |
|---|---|---|
| `alb` | `0.0.0.0/0` on 80/tcp and 443/tcp | all (`0.0.0.0/0`) |
| `app` | `security_groups = [aws_security_group.alb.id]` on 3000/tcp | all |
| `db` | `security_groups = [aws_security_group.app.id]` on 3306/tcp | all |

`app` is attached directly to each Fargate task's ENI (via `network_configuration` in `aws_ecs_service.app`) — Fargate's `awsvpc` networking mode gives every task its own network interface, so the same SG-to-SG model applies to containers exactly as it did to EC2 instances.

IAM side — **two roles**, intentionally split by what they're allowed to do:

- `aws_iam_role.ecs_execution_role` — trusted by `ecs-tasks.amazonaws.com`, with the AWS-managed `AmazonECSTaskExecutionRolePolicy` attached. This is what lets **ECS itself** pull the image from ECR and write container logs to CloudWatch — it has nothing to do with what the app can do.
- `aws_iam_role.ecs_task_role` — also trusted by `ecs-tasks.amazonaws.com`, but this is what the **application code** runs as. Its inline policy (`aws_iam_role_policy.ecs_task_policy`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::support-portal-assets-<account-id>",
        "arn:aws:s3:::support-portal-assets-<account-id>/*"
      ]
    }
  ]
}
```

Scoped to one bucket ARN (not `"*"`) — no `PutObject`/`DeleteObject`/`iam:*`/`ecs:*`. Splitting execution vs. task roles means a compromised app container still can't touch ECS/ECR/CloudWatch permissions — those belong to a role the app never assumes.

**Current IAM footprint is exactly these two roles** — `ecs_execution_role` and `ecs_task_role`, both defined here in `security.tf`, nothing attached outside of Terraform. (An earlier EC2-based iteration of this project briefly attached the AWS-managed `AmazonSSMManagedInstanceCore` policy to a since-deleted EC2 role, purely to debug a boot failure over Systems Manager — it was detached again immediately after and no longer exists, since that role itself was removed in the move to Fargate.)

### `storage.tf`
- `aws_s3_bucket.assets` — bucket name includes `data.aws_caller_identity.current.account_id` to guarantee global uniqueness without hardcoding an org-specific prefix.
- `aws_s3_bucket_public_access_block.assets` — all four flags true; overrides any ACL/policy that might later grant public access, regardless of what gets misconfigured on the bucket itself.
- `aws_s3_bucket_server_side_encryption_configuration.assets` — default SSE-S3 (`AES256`) on all objects.
- `aws_s3_object.style_css` — uploads `app/public/style.css` to `static/style.css`; `etag = filemd5(...)` triggers a re-upload on `apply` whenever the local file changes. The running container fetches this object itself at startup (`app/server.js`, `fetchStaticAsset()`) using the AWS SDK for JS and the task role's credentials — no `aws` CLI needed inside the container image.

### `database.tf`
- `aws_db_subnet_group.main` — built from `aws_subnet.private[*].id`, which is what forces RDS to live only in the private subnets (RDS subnet groups require ≥2 subnets in ≥2 AZs).
- `aws_db_instance.main` — `engine = "mysql"` `8.0`, `instance_class = var.db_instance_class` (`db.t3.micro`), `allocated_storage = 20` (GB, gp2 by default), `storage_encrypted = true`, `publicly_accessible = false`, `multi_az = false` (single-AZ to keep cost down for a class project — flip this to `true` for real HA), `skip_final_snapshot = true` (so `terraform destroy` doesn't hang waiting for a manual snapshot name — fine for a demo, you'd remove this in production).

### `compute.tf`
- `aws_ecr_repository.app` — a private container registry for the app's Docker image, with `scan_on_push = true` (Amazon ECR scans each pushed image for known OS/package vulnerabilities).
- `aws_ecs_cluster.main` — the logical grouping Fargate tasks run under. With Fargate there's no EC2 fleet backing this cluster — AWS manages the underlying compute entirely.
- `aws_cloudwatch_log_group.app` — where container stdout/stderr goes (7-day retention), since there's no instance to SSH into and `tail` a log file on.
- `aws_ecs_task_definition.app` — the container-level equivalent of the old launch template: image URI (`<ecr-repo>:latest`), CPU/memory (`fargate_cpu`/`fargate_memory`), the container's port (3000), its environment variables (DB connection info, S3 bucket/key — injected directly as task definition environment, not written to a file on disk), and which log group to ship output to. Also where `execution_role_arn` and `task_role_arn` are attached. `runtime_platform` explicitly pins `cpu_architecture = "X86_64"` — see "What actually broke" below for why this is spelled out rather than left to default.
- `aws_ecs_service.app` — keeps `desired_count = 2` tasks running on Fargate, in the private subnets, using the `app` security group (`network_configuration`), and registers each task into `aws_lb_target_group.app` (`load_balancer` block). If a task dies, ECS itself launches a replacement — the Fargate equivalent of what the Auto Scaling Group used to do.
- `aws_lb.app` — internet-facing (`internal = false`) ALB in the two public subnets, using the `alb` security group. Unchanged from the EC2 version.
- `aws_lb_target_group.app` — `target_type = "ip"` (not `"instance"`) since Fargate tasks are registered by their ENI's private IP, not an EC2 instance ID. Same health check as before: `GET /health` every 30s, 2 consecutive successes/failures to flip healthy/unhealthy.
- `aws_lb_listener.http` — listens on port 80, forwards everything to the target group. Unchanged.

### `outputs.tf`
`alb_dns_name`, `rds_endpoint`, `s3_bucket_name`, `ecr_repository_url` — printed after `apply`, retrievable later via `terraform output`. `ecr_repository_url` is where you push the built image before the ECS service can actually start healthy tasks.

---

## Deployment flow (how it all fits together)

1. `docker build` packages the app (`app/Dockerfile`) into a container image.
2. The image is pushed to the ECR repository Terraform creates (`aws_ecr_repository.app`).
3. Terraform provisions the VPC/subnets/gateways, the RDS instance, the S3 bucket + uploaded asset, the ECR repo, and the ECS cluster/task definition/service/ALB — in dependency order via Terraform's resource graph.
4. The ECS service launches Fargate tasks running the pushed image, each getting the RDS connection info and S3 bucket/key as container environment variables directly from the task definition (no boot script, no file written to disk).
5. On container startup, `app/server.js` fetches `style.css` from the private S3 bucket using the task's IAM role, then connects to RDS and starts listening.
6. The ALB health-checks each task on `/health` and only routes traffic to tasks that respond; ECS replaces any task that dies or fails checks.

## Running the app locally

```bash
cd app
cp .env.example .env   # fill in local/test DB credentials
npm install
npm start
```

Visit `http://localhost:3000`.

## Deploying the infrastructure

Requires [Terraform](https://developer.hashicorp.com/terraform/downloads) and AWS credentials configured (`aws configure`).

### Credentials this deployment needs

Only one secret is required, and it's never stored in this repo:

- **`db_password`** — the RDS MySQL master password. Generate a random one rather than typing something memorable:
  ```bash
  openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24
  ```

Put it into `infrastructure/terraform.tfvars` (already `.gitignore`'d — see `infrastructure/variables.tf` for the full variable list):

```hcl
db_password = "<generated-password>"
```

(There's no EC2 key pair to manage anymore — Fargate tasks don't have SSH access at all; debugging goes through CloudWatch Logs or `aws ecs execute-command` instead.)

### Build and deploy

```bash
cd infrastructure
terraform init
terraform apply    # creates the ECR repo, ECS cluster/service, ALB, RDS, VPC, etc.
```

The ECS service will be created but its tasks will fail to start until an image actually exists in ECR — that's expected on a first apply. Build and push one:

```bash
cd ../app
REPO_URL=$(cd ../infrastructure && terraform output -raw ecr_repository_url)
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin "${REPO_URL%/*}"
docker buildx build --platform linux/amd64 -t "$REPO_URL:latest" --push .
```

**Use `docker buildx build --platform linux/amd64`, not plain `docker build`** — see "What actually broke" below for why this matters if you're on an Apple Silicon (arm64) Mac. If `docker buildx` isn't available: `brew install docker-buildx`, then add `"cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]` to `~/.docker/config.json`.

Then force the service to pick up the new image (it won't retry a failed image pull on its own until told to):

```bash
aws ecs update-service --cluster support-portal-cluster --service support-portal-service --force-new-deployment --region us-east-1
```

This provisions:
- A VPC with 2 public + 2 private subnets across 2 AZs
- An Internet Gateway + NAT Gateway
- An Application Load Balancer + ECS Fargate service running the containerized app
- An ECR repository holding the app's container image
- An RDS MySQL instance in the private subnets
- An encrypted, private S3 bucket (with the app's static asset pre-uploaded, fetched by the container at runtime)
- Security groups restricting traffic tier-to-tier, and separate ECS execution/task IAM roles scoped to exactly what each needs

After `apply`, the app URL is printed as the `alb_dns_name` output (once tasks are healthy).

### What actually broke (and why it's worth knowing)

The first deploy to Fargate wasn't clean — both tasks crash-looped, cycling through `PENDING` → `RUNNING` → `STOPPED` every few seconds, with the ALB target group permanently unhealthy.

`aws ecs describe-tasks` showed `stoppedReason: "Essential container in task exited"`, exit code `255` — not useful on its own. The actual cause was in CloudWatch Logs (`/ecs/support-portal-app`):

```
exec /usr/local/bin/docker-entrypoint.sh: exec format error
```

**Root cause**: the image was built on an Apple Silicon (arm64) Mac with a plain `docker build`, which defaults to the *host's* architecture. Fargate tasks run on `X86_64` by default. The container never even got a chance to run Node — the kernel refused to execute an arm64 binary on an x86_64 machine at all, which is exactly what "exec format error" means.

**Fix**: install the `docker-buildx` plugin and build with an explicit target platform:

```bash
brew install docker-buildx
docker buildx build --platform linux/amd64 -t "$REPO_URL:latest" --push .
```

Also added `runtime_platform { cpu_architecture = "X86_64" }` to `aws_ecs_task_definition.app` (`compute.tf`) — not because it changes Fargate's default, but because it makes the requirement explicit in code instead of implicit in whoever happens to run the build command next (and on Apple Silicon hardware, that assumption breaks silently otherwise).

This is a genuinely common containerization pitfall: any team with both Apple Silicon laptops and x86-only cloud infrastructure hits this eventually. It's also unrelated to a similar-looking issue from an earlier iteration of this project (a plain-EC2 deployment) where a metadata-service token requirement (IMDSv2 on Amazon Linux 2023) broke a boot script the same way — different root cause, same lesson: a boot/runtime failure with no application-level error message is almost always an environment mismatch, not a bug in the app code itself.

### Restoring from a snapshot

By default `terraform apply` creates a brand-new, empty database. `terraform destroy` deletes the RDS instance permanently (`skip_final_snapshot = true`), so any tickets/articles created are lost unless you took a manual snapshot first:

```bash
aws rds create-db-snapshot \
  --db-instance-identifier support-portal-db \
  --db-snapshot-identifier <snapshot-name>
```

To have the *next* `terraform apply` restore that data instead of starting empty, set `db_snapshot_identifier` in `terraform.tfvars`:

```hcl
db_snapshot_identifier = "<snapshot-name>"
```

Terraform will restore the RDS instance from that snapshot (`database.tf`) — note this replaces any existing RDS instance if one is already running, since `db_name`/`username` are baked into the snapshot and can't be changed on restore.

To tear everything down:

```bash
terraform destroy
```

## Tech stack

- Node.js + Express + EJS (server-rendered views)
- Docker (containerized app, run on ECS Fargate)
- MySQL (via RDS)
- Terraform for infrastructure as code
