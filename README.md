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
      │  Auto Scaling  │  ◄─────►  │  Auto Scaling  │    reached via NAT GW)
      └───────┬───────┘           └───────┬───────┘
              │                           │
              └─────────────┬─────────────┘
                            │
                    ┌───────▼────────┐
                    │   RDS (MySQL)   │  (private subnets)
                    └────────────────┘

      S3 bucket (encrypted, private) — static assets / config
```

| Pillar | AWS Service | Purpose |
|---|---|---|
| Compute | EC2 (Auto Scaling Group) | Runs the Node.js app |
| Storage | S3 | Static assets, encrypted & private |
| Networking | VPC, public/private subnets, ALB, NAT Gateway | Routes traffic, isolates app/db tier |
| Security | Security Groups, IAM roles | Least-privilege access between tiers |
| Database | RDS (MySQL) | Stores tickets and KB articles |

## Repo structure

```
app/              Node.js/Express web app (tickets + knowledge base)
infrastructure/   Terraform IaC for the full AWS architecture
```

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
- An encrypted, private S3 bucket
- Security groups restricting traffic tier-to-tier, and an IAM role scoped to what the app needs

After `apply`, the app URL is printed as the `alb_dns_name` output. Each EC2 instance pulls this repo and starts the app via its user-data script (see `infrastructure/user_data.sh.tpl`).

To tear everything down:

```bash
terraform destroy
```

## Tech stack

- Node.js + Express + EJS (server-rendered views)
- MySQL (via RDS)
- Terraform for infrastructure as code
