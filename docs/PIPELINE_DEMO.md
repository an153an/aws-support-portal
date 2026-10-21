# Demo guide: the GitHub Actions deploy pipeline

A script for showing the CI/CD pipeline live: **push code → tests → image build → ECR → Terraform → rolling deploy on ECS Fargate → smoke test**. The whole demo is about 10–15 minutes of talking, plus a pipeline run you narrate while it executes.

## What the pipeline does

```
 pull request ──► test (smoke tests, terraform fmt/validate) ──► plan (read-only role; shows what Terraform would change)

 push to main ──► test ──► deploy:
                              1. assume AWS role via OIDC           (no AWS keys stored in GitHub)
                              2. terraform init (S3 state + DynamoDB lock)
                              3. ensure ECR repository exists
                              4. docker buildx build --platform linux/amd64  →  push  :<git-sha> and :latest
                              5. terraform apply -var image_tag=<git-sha>    →  new ECS task definition, rolling deploy
                              6. wait for ECS services-stable
                              7. curl /health on the live ALB
```

Talking points worth making:

- **No secrets in GitHub.** The workflow gets short-lived AWS credentials by proving who it is (OIDC) to a role that only trusts *this repo's main branch*. The database password lives in Secrets Manager, never in the pipeline.
- **Every deploy is traceable.** The container image is tagged with the git commit SHA, so "what is running?" is answered by the ECS task definition.
- **Safe by default.** Pull requests can only *plan* (read-only role). Deploys are serialized (`concurrency`). A rollout that fails health checks is stopped and **rolled back automatically** (ECS deployment circuit breaker).

## One-time setup (do this before the demo; ~20 minutes plus the first deploy)

Prerequisites: AWS credentials for the account (`aws sts get-caller-identity` works), Terraform ≥ 1.5, the GitHub CLI (`gh auth status`), and push access to the repo.

**1. Create the state bucket and GitHub trust** (once per AWS account):

```bash
cd infrastructure/bootstrap
terraform init
terraform apply
# If it says the OIDC provider already exists: terraform apply -var create_oidc_provider=false
```

Note the outputs: `tf_state_bucket`, `tf_lock_table`, `deploy_role_arn`, `plan_role_arn`.

**2. Point the main configuration at that remote state.** If you already deployed with local state (`infrastructure/terraform.tfstate`), this migrates it:

```bash
cd ..                                  # infrastructure/
cp backend.hcl.example backend.hcl     # fill in the bucket name from step 1
terraform init -migrate-state -backend-config=backend.hcl
terraform plan                         # sanity check: should show only the pending changes you expect
```

**3. Give GitHub the (non-secret) settings the workflow needs:**

```bash
cd bootstrap
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(terraform output -raw deploy_role_arn)"
gh variable set AWS_PLAN_ROLE_ARN   --body "$(terraform output -raw plan_role_arn)"
gh variable set TF_STATE_BUCKET     --body "$(terraform output -raw tf_state_bucket)"
gh variable set TF_LOCK_TABLE       --body "$(terraform output -raw tf_lock_table)"
```

Optional: in the repo's **Settings → Environments → production**, add yourself as a *required reviewer* to show a manual approval gate before deploys.

**4. Warm it up.** Push to `main` (or **Actions → Build and deploy → Run workflow**) and let one full run finish. A first run that creates the infrastructure takes **20–25 minutes** (NAT gateway, Multi-AZ RDS, ALB). Later runs take **5–8 minutes**. Don't demo the first run.

**5. Create the first admin and check the site** (see the README, "Users and roles"):

```bash
scripts/create-admin.sh you@example.com 'A-Str0ng-Passw0rd' "Your Name"
```

Cost note: NAT gateway + ALB + Multi-AZ RDS cost a few dollars a day. For a cheaper demo set `db_multi_az = false` in `terraform.tfvars` (or `TF_VAR_db_multi_az`) before warming up, and run `terraform destroy` afterwards.

## The demo script

### 1. Show the pipeline definition (2 min)
Open `.github/workflows/deploy.yml`. Walk through the three jobs (`test`, `plan`, `deploy`), the `on:` triggers, and the `permissions: id-token: write` line. Show **Settings → Secrets and variables → Actions**: only *variables* (role ARNs and bucket names), no AWS keys.

### 2. A pull request: tests and a plan (3 min)
```bash
git checkout -b demo/banner-text
# make a small visible change, e.g. in app/views/partials-nav.ejs change the brand text:
#   <div class="brand">Support Portal</div>   ->   <div class="brand">Support Portal v2</div>
git commit -am "Demo: change the nav brand text"
git push -u origin demo/banner-text
gh pr create --fill
```
In the PR's **Checks** tab show `test` passing (smoke tests + `terraform validate`) and the `plan` job's output. Point out the plan is run with a *read-only* role: a PR can never change infrastructure.

### 3. Merge and watch the deploy (6–8 min, narrate while it runs)
```bash
gh pr merge --squash --delete-branch
gh run watch            # or open the Actions tab
```
Narrate each step as it turns green: OIDC login → state → ECR → **build & push (linux/amd64)** → `terraform apply` → *wait for ECS* → smoke test. The run summary prints the deployed commit and URL.

### 4. Prove what happened (2 min)
```bash
cd infrastructure
SHA=$(git rev-parse HEAD)
aws ecr describe-images --repository-name support-portal-app --image-ids imageTag=$SHA --query 'imageDetails[0].{pushed:imagePushedAt,tags:imageTags}'
aws ecs describe-services --cluster support-portal-cluster --services support-portal-service \
  --query 'services[0].deployments[].{status:status,running:runningCount,taskDef:taskDefinition,rollout:rolloutState}'
terraform output alb_dns_name
```
Open the ALB URL and show the new brand text. Open the **CloudWatch dashboard** (`terraform output cloudwatch_dashboard_url`) to show requests, healthy tasks, and the rolling replacement.

### 5. (Optional, memorable) A bad deploy rolls back by itself (5 min)
Break the health check on a branch, then merge it:
```js
// app/server.js
app.get('/health', (req, res) => res.status(500).send('broken'));
```
The tests still pass (they don't boot the server), the image builds, and Terraform starts the rollout. The new tasks fail ALB health checks, the **ECS circuit breaker** stops the rollout and rolls back to the previous task definition, and the `wait for ECS` step fails — **while the site keeps serving the old version the whole time**. Show the failed run, the site still working, and the `ROLLBACK` deployment in `aws ecs describe-services`. Then fix it:
```bash
git revert --no-edit HEAD && git push     # redeploys the last good code
```
> If you'd rather not wait on the circuit breaker, skip this step; it can take a few minutes to trip.

### 6. Roll back / redeploy any commit (1 min)
**Actions → Build and deploy →** open an older successful run → **Re-run all jobs** redeploys that commit's image tag and code. (Tags are immutable in practice because every deploy uses the commit SHA.)

## Teardown

```bash
cd infrastructure && terraform destroy          # app, VPC, RDS, ALB, ...
# then, if you want the CI plumbing gone too:
aws s3 rm s3://<state-bucket> --recursive       # versioned bucket: also delete old versions
cd bootstrap && terraform destroy
```

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Error: Not authorized to perform sts:AssumeRoleWithWebIdentity` | The run isn't on `main` (deploy role) or a same-repo PR (plan role), or `AWS_DEPLOY_ROLE_ARN` is wrong. The role trust is pinned to `repo:an153an/aws-support-portal`; if you forked, re-apply the bootstrap with `-var github_repo=<owner>/<name>`. |
| `Backend configuration changed` locally | Run `terraform init -backend-config=backend.hcl`. |
| Tasks crash-loop with `exec format error` | An arm64 image got deployed; the pipeline pins `linux/amd64`, but a manual `docker build` on an Apple Silicon Mac does not (see the README). |
| Deploy waits then fails at "wait for ECS" | The new tasks are unhealthy — check the `/ecs/support-portal-app` log group (logs are JSON; filter `level = "error"`). The circuit breaker will already have rolled back. |
| `terraform plan` wants to replace the database | Stop. `snapshot_identifier` changes are ignored on purpose, so this means something else changed (engine/name). Don't apply until you know why. |
