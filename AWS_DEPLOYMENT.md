# AWS EC2 Deployment

This project deploys to AWS with this production path:

- GitHub Actions builds `api`, `web`, and `worker` Docker images.
- Images are pushed to AWS ECR.
- One EC2 instance runs Docker Compose with Postgres + API + Web + Worker + Nginx.
- An AWS Application Load Balancer exposes the app publicly.
- AWS ACM issues the TLS certificate.
- Route53 connects `hop-on.dev` to the ALB.

Target AWS account:

- Account ID: `029458826874`
- Account name: `Javkhlan-42-edu`
- GitHub repo: `https://github.com/Javkhlan42-edu/legal-assist.git`

## 1. Required GitHub Secrets

In GitHub, open `Settings -> Secrets and variables -> Actions`.

Required secrets:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION`
- `AWS_ACCOUNT_ID`
- `PRODUCTION_ENV`

`PRODUCTION_ENV` should contain the production `.env` values. Use `.env.aws.example` as the template.

Do not commit real secrets to git.

## 2. One-Click AWS Deploy

Run the `AWS Deploy` workflow manually from GitHub Actions.

The workflow will:

1. Create ECR repositories if missing.
2. Build and push production images.
3. Store `PRODUCTION_ENV` in SSM Parameter Store as a SecureString.
4. Create or reuse EC2, IAM role, security groups, ALB, target group, ACM certificate, and Route53 hosted zone.
5. Deploy the new ECR images to EC2 through AWS SSM.
6. Run a public health check.

## 3. Domain and HTTPS

If the Route53 hosted zone for `hop-on.dev` is newly created, copy the hosted zone name servers from the workflow logs and set them at the domain registrar.

ACM DNS validation only finishes after `hop-on.dev` is delegated to the Route53 hosted zone. If the first workflow run says `Certificate is PENDING_VALIDATION`, update the domain name servers and run `AWS Deploy` again. The second run will create the HTTPS listener after ACM becomes `ISSUED`.

Until ACM is issued, the ALB HTTP URL from the workflow logs is still usable for smoke testing.

Final production URL:

```text
https://hop-on.dev
```

## 4. First Data Ingestion

After the first deploy, the database is empty unless you migrated data separately. Run ingestion through SSM or Session Manager on the EC2 host:

```bash
cd /opt/legal-assist
docker compose -f docker/docker-compose.ecr.yml exec worker pnpm exec tsx src/index.ts ingest --source legalinfo --limit 938 --fresh
```

For Shuukh cases:

```bash
docker compose -f docker/docker-compose.ecr.yml exec worker pnpm exec tsx src/index.ts ingest --source shuukh --limit 1500 --fresh
```

## 5. Useful Commands

```bash
docker compose -f docker/docker-compose.ecr.yml ps
docker compose -f docker/docker-compose.ecr.yml logs -f api
docker compose -f docker/docker-compose.ecr.yml logs -f web
docker compose -f docker/docker-compose.ecr.yml logs -f worker
docker compose -f docker/docker-compose.ecr.yml restart api web nginx
```

## Notes

- Postgres is not exposed publicly; only Nginx port `80` is public.
- The ALB exposes public `80` and `443`; the EC2 security group accepts port `80` only from the ALB security group.
- The web app calls API through the same origin via `/v1/...`, so browser CORS issues are avoided.
- Keep `.env` out of git. Use `PRODUCTION_ENV` GitHub secret for production.
