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

## Networking — why it's laid out this way

The VPC (`infrastructure/networking.tf`) splits into **public** and **private** subnets across two Availability Zones:

- **Public subnets** hold only the Application Load Balancer and the NAT Gateway. This is the only part of the architecture with a route to the Internet Gateway.
- **Private subnets** hold the EC2 instances and the RDS database. They have **no direct inbound path from the internet** — their only route out is through the NAT Gateway, which lets them download packages (e.g. `npm install`, `aws s3 cp`) without ever being reachable from outside.
- Spanning **two AZs** means if one data center has an outage, the Auto Scaling Group and RDS subnet group still have healthy capacity elsewhere.

**Why not just put EC2 in a public subnet?** Because every additional resource with a public IP is one more thing an attacker can directly probe. Here, the only public-facing resource is the ALB — a single, well-understood front door — which is standard AWS "defense in depth" design.

## Security — the actual policies, and why

### Security Groups (stateful firewalls, tier-to-tier)

Each tier only accepts traffic from the tier in front of it — nothing accepts open internet traffic except the ALB:

| Security Group | Inbound allowed from | Port |
|---|---|---|
| `alb-sg` | `0.0.0.0/0` (internet) | 80, 443 |
| `app-sg` | `alb-sg` only | 3000 |
| `db-sg` | `app-sg` only | 3306 (MySQL) |

This means even if someone found the private IP of an EC2 instance or the RDS endpoint, the security group would drop the connection unless it's coming from the permitted SG. **The database is not reachable from the internet or even directly from the ALB — only from the app tier.**

### IAM role for EC2 (least privilege)

Rather than giving the EC2 instances broad AWS access (or worse, hardcoding an access key on the box), they assume an IAM role with exactly two permissions:

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

(defined in `infrastructure/security.tf` as `aws_iam_role_policy.ec2_policy`)

- **`s3:GetObject` / `s3:ListBucket` scoped to one bucket ARN** — the instance can read the static asset bucket and nothing else. It cannot list or read any other bucket in the account, even other buckets it happens to own.
- **CloudWatch Logs actions** — lets the instance ship logs for observability, which is a low-risk, additive permission.
- No `s3:PutObject`, `s3:DeleteObject`, `iam:*`, `ec2:*`, etc. If the instance were compromised, the blast radius is capped at "can read one bucket's contents and write logs" — it can't pivot into modifying infrastructure, deleting data, or reading other resources.

This is the core idea of **least-privilege IAM**: grant only the exact actions and resources a role needs to do its job, scoped as narrowly as possible, so a compromised credential is as low-value as possible to an attacker.

### S3 bucket hardening

The asset bucket (`infrastructure/storage.tf`) is:
- **Fully blocked from public access** (`aws_s3_bucket_public_access_block`) — even if someone accidentally set a public ACL or bucket policy later, AWS ignores it at the account/bucket level.
- **Encrypted at rest** (AES-256 server-side encryption) — data on disk is encrypted even if the underlying storage were somehow exposed.

Instead of exposing static files via a public S3 URL, each EC2 instance pulls `style.css` from the bucket at boot using its IAM role (see `infrastructure/user_data.sh.tpl`). This means **the bucket never needs a public read policy** — access is only ever through an authenticated AWS API call from a role we control, which is more secure than "anyone with the link can read it."

### RDS hardening

- `publicly_accessible = false` — the database has no public endpoint at all, only a private one inside the VPC.
- `storage_encrypted = true` — data at rest is encrypted.
- Lives in the **private subnet group**, reachable only from the app tier's security group as described above.

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

```bash
cd infrastructure
terraform init
terraform apply \
  -var="db_password=<choose-a-password>" \
  -var="key_pair_name=<your-ec2-key-pair>"
```

This provisions:
- A VPC with 2 public + 2 private subnets across 2 AZs
- An Internet Gateway + NAT Gateway
- An Application Load Balancer + Auto Scaling Group of EC2 instances running the app
- An RDS MySQL instance in the private subnets
- An encrypted, private S3 bucket (with the app's static asset pre-uploaded)
- Security groups restricting traffic tier-to-tier, and an IAM role scoped to exactly what the app needs

After `apply`, the app URL is printed as the `alb_dns_name` output.

To tear everything down:

```bash
terraform destroy
```

## Tech stack

- Node.js + Express + EJS (server-rendered views)
- MySQL (via RDS)
- Terraform for infrastructure as code
