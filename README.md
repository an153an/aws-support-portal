# AWS Support Portal

A simple support portal web app deployed on AWS, built for EMGT 308. It has two sections:

- **Tickets** — submit and track support tickets (open / in progress / closed)
- **Knowledge Base** — publish and browse help articles

The project demonstrates a 3-tier architecture on AWS covering **compute, storage, networking, security, and database**.

## Architecture

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
      │  EC2 (app)     │           │  EC2 (app)     │   (private subnets,
      │  Auto Scaling  │  ◄─────►  │  Auto Scaling  │    outbound via NAT GW)
      └───────┬───────┘           └───────┬───────┘
              │                           │
              └─────────────┬─────────────┘
                            │
                    ┌───────▼────────┐
                    │   RDS (MySQL)   │  (private subnets)
                    └────────────────┘

      S3 bucket (encrypted, private) — static assets pulled by EC2 at boot
```

| Pillar | AWS Service | Purpose |
|---|---|---|
| Compute | EC2 (Auto Scaling Group) | Runs the Node.js app |
| Storage | S3 | Static assets (`style.css`), encrypted & private |
| Networking | VPC, public/private subnets, ALB, NAT Gateway | Routes traffic, isolates app/db tier |
| Security | Security Groups, IAM roles | Least-privilege access between tiers |
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
Input variables consumed across the other files — no resources declared here. Notable ones: `vpc_cidr` (`10.0.0.0/16`), `public_subnet_cidrs`/`private_subnet_cidrs` (2 CIDRs each), `instance_type` (`t3.micro`), `db_instance_class` (`db.t3.micro`), and `db_password`/`key_pair_name`, which have no defaults and must be passed via `-var` or `TF_VAR_*` env vars at apply time (kept out of the repo intentionally).

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

IAM side — `aws_iam_role.ec2_role` (trust policy: `Principal.Service = "ec2.amazonaws.com"` via `sts:AssumeRole`) wrapped in `aws_iam_instance_profile.ec2_profile` (required to attach a role to an EC2 launch template) with this inline policy (`aws_iam_role_policy.ec2_policy`):

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
    },
    {
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "*"
    }
  ]
}
```

Scoped to one bucket ARN (not `"*"`) — no `PutObject`/`DeleteObject`/`iam:*`/`ec2:*`. `logs:*` is `Resource: "*"` only because log group ARNs don't exist yet at policy-creation time.

### `storage.tf`
- `aws_s3_bucket.assets` — bucket name includes `data.aws_caller_identity.current.account_id` to guarantee global uniqueness without hardcoding an org-specific prefix.
- `aws_s3_bucket_public_access_block.assets` — all four flags true; overrides any ACL/policy that might later grant public access, regardless of what gets misconfigured on the bucket itself.
- `aws_s3_bucket_server_side_encryption_configuration.assets` — default SSE-S3 (`AES256`) on all objects.
- `aws_s3_object.style_css` — uploads `app/public/style.css` to `static/style.css`; `etag = filemd5(...)` triggers a re-upload on `apply` whenever the local file changes.

### `database.tf`
- `aws_db_subnet_group.main` — built from `aws_subnet.private[*].id`, which is what forces RDS to live only in the private subnets (RDS subnet groups require ≥2 subnets in ≥2 AZs).
- `aws_db_instance.main` — `engine = "mysql"` `8.0`, `instance_class = var.db_instance_class` (`db.t3.micro`), `allocated_storage = 20` (GB, gp2 by default), `storage_encrypted = true`, `publicly_accessible = false`, `multi_az = false` (single-AZ to keep cost down for a class project — flip this to `true` for real HA), `skip_final_snapshot = true` (so `terraform destroy` doesn't hang waiting for a manual snapshot name — fine for a demo, you'd remove this in production).

### `compute.tf`
- `data "aws_ami" "amazon_linux"` — looks up the latest Amazon Linux 2023 x86_64 AMI by name filter at apply time, so the image is never hardcoded/stale.
- `aws_launch_template.app` — bundles the AMI, `instance_type`, `key_name`, the `app` security group, the IAM instance profile, and a base64-encoded `user_data` script rendered from `user_data.sh.tpl` with the RDS endpoint, DB credentials, and S3 bucket/key interpolated in via `templatefile()`.
- `aws_autoscaling_group.app` — `min_size = 1`, `desired_capacity = 2`, `max_size = 3`; deployed across `aws_subnet.private[*].id` (both AZs); registers instances into `aws_lb_target_group.app` automatically via `target_group_arns`.
- `aws_lb.app` — internet-facing (`internal = false`) ALB in the two public subnets, using the `alb` security group.
- `aws_lb_target_group.app` — routes to port 3000/HTTP on targets, with a health check hitting `GET /health` every 30s, 2 consecutive successes/failures to flip healthy/unhealthy.
- `aws_lb_listener.http` — listens on port 80, forwards everything to the target group (no path-based routing needed for a single-service app).

### `user_data.sh.tpl`
Runs once at first boot (root shell). `dnf install`s Node.js/npm/git, clones this repo into `/opt/app`, `npm install --production`, pulls `style.css` from S3 via `aws s3 cp` (auth via instance profile, no credentials in the script), writes `.env` with the interpolated DB values, then registers a `systemd` unit (`support-portal.service`, `Restart=always`) so the app survives crashes/reboots without a live SSH session.

### `outputs.tf`
`alb_dns_name`, `rds_endpoint`, `s3_bucket_name` — printed after `apply`, retrievable later via `terraform output`.

---

## Deployment flow (how it all fits together)

1. Terraform provisions the VPC/subnets/gateways, then the RDS instance, then the S3 bucket + uploaded asset, then the EC2 launch template/Auto Scaling Group/ALB (in dependency order, handled automatically by Terraform's resource graph).
2. Each EC2 instance boots with a **user-data script** (`infrastructure/user_data.sh.tpl`) that:
   - Installs Node.js
   - Clones this repo and installs the app's dependencies
   - Pulls `style.css` from the private S3 bucket via its IAM role
   - Writes a `.env` file with the RDS connection details (injected by Terraform, not committed to git)
   - Registers and starts the app as a `systemd` service, so it restarts automatically if it crashes or the instance reboots
3. The ALB health-checks each instance on `/health` and only routes traffic to instances that respond, so a broken deploy doesn't take down the whole app.

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

Two secrets are required and neither is stored in this repo:

- **`key_pair_name`** — an EC2 key pair for SSH access to the instances. If you don't have one, create it first:
  ```bash
  aws ec2 create-key-pair --key-name support-portal-key --region us-east-1 \
    --query 'KeyMaterial' --output text > support-portal-key.pem
  chmod 400 support-portal-key.pem
  ```
  AWS only stores the public half; the private `.pem` file above is the only copy and only exists on your machine. Losing it means you can no longer SSH into instances launched with that key pair (the app itself doesn't need SSH to run — this is only for manual debugging).

- **`db_password`** — the RDS MySQL master password. Generate a random one rather than typing something memorable:
  ```bash
  openssl rand -base64 24 | tr -dc 'A-Za-z0-9' | head -c 24
  ```

Put both into `infrastructure/terraform.tfvars` (already `.gitignore`'d — see `infrastructure/variables.tf` for the full variable list):

```hcl
db_password   = "<generated-password>"
key_pair_name = "support-portal-key"
```

Then:

```bash
cd infrastructure
terraform init
terraform apply
```

(Alternatively, pass them inline instead of a tfvars file: `terraform apply -var="db_password=..." -var="key_pair_name=..."`)

**Why this matters**: the `.pem` file and the DB password are both credentials that grant access to real infrastructure — if either were committed to a public GitHub repo, anyone could use them. `.gitignore` in this repo excludes `*.pem`, `.keys/`, and `terraform.tfvars` specifically so this can never happen by accident.

This provisions:
- A VPC with 2 public + 2 private subnets across 2 AZs
- An Internet Gateway + NAT Gateway
- An Application Load Balancer + Auto Scaling Group of EC2 instances running the app
- An RDS MySQL instance in the private subnets
- An encrypted, private S3 bucket (with the app's static asset pre-uploaded)
- Security groups restricting traffic tier-to-tier, and an IAM role scoped to exactly what the app needs

After `apply`, the app URL is printed as the `alb_dns_name` output.

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
- MySQL (via RDS)
- Terraform for infrastructure as code
