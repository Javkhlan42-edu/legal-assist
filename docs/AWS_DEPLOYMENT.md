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
- `OPENAI_API_KEY` (fallback if `PRODUCTION_ENV` does not include `OPENAI_API_KEY`)

`PRODUCTION_ENV` should contain the production runtime environment values. Env template files are intentionally not committed to this repository, so keep production values only in GitHub Secrets or another deployment secret manager. The deploy workflow refuses to continue if the runtime API container does not have a valid `OPENAI_API_KEY`, because otherwise production silently falls back to generic template answers instead of the high-quality LLM generation used locally.

Do not commit real secrets to git.

## 2. One-Click AWS Deploy

The `AWS Deploy` workflow runs automatically on pushes to `main`. It can also be started manually from GitHub Actions. While the rollout PR is open, pushes to `deploy/aws-ec2-ecr-https` also trigger the same workflow for verification.

The workflow runs on the repository self-hosted runner labeled `legal-assist-deploy`, installed on the EC2 host. This avoids GitHub-hosted runner provisioning failures and keeps Docker/ECR deployment close to the production host.

The workflow will:

1. Create ECR repositories if missing.
2. Build and push production images.
3. Sync `PRODUCTION_ENV` into `/opt/legal-assist/.env` on the EC2 self-hosted runner.
4. Pull and restart the new ECR images with Docker Compose.
5. Apply the Postgre retrieval index migration from `apps/api/migrations/007_retrieval_postgres_indexes.sql`.
6. Verify Postgre retrieval data and run `apps/api/scripts/check-runtime-config.mjs`, including an OpenAI chat smoke test.
7. Run a public HTTPS health check.

If GitHub Actions is unavailable or the self-hosted runner is offline, use the local SSH fallback below.

## 3. Local SSH/ECR Fallback

The first deployment was completed with the SSH fallback. The automated pipeline now uses the EC2 self-hosted GitHub Actions runner for push-based deploys.

Run from PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass `
  -File scripts\aws\deploy-local-ssh-ecr.ps1 `
  -CredentialsCsv "C:\Users\user\Downloads\github-actions_accessKeys.csv" `
  -GitRef "deploy/aws-ec2-ecr-https" `
  -InstanceType "t3.micro"
```

This fallback:

1. Verifies AWS credentials and account.
2. Creates or reuses ECR repositories.
3. Creates or reuses a Free Tier compatible EC2 instance, ALB, target group, and security groups.
4. Installs Docker on EC2 and enables a 6GB swap file for small-instance builds.
5. Builds `api`, `web`, and `worker` images on EC2.
6. Pushes the images to ECR.
7. Runs `docker/docker-compose.ecr.yml` with the generated production env.
8. Applies the Postgre retrieval index migration inside the API container.

Current public smoke-test URL:

```text
http://legal-assist-alb-1796940379.ap-southeast-1.elb.amazonaws.com
```

Health check:

```text
http://legal-assist-alb-1796940379.ap-southeast-1.elb.amazonaws.com/health
```

While testing through the raw ALB URL, include that HTTP origin in `CORS_ORIGIN`; otherwise login/signup POST requests will be rejected by the API CORS guard. The SSH fallback script adds this automatically:

```text
CORS_ORIGIN=https://hop-on.dev,https://www.hop-on.dev,http://hop-on.dev,http://www.hop-on.dev,http://legal-assist-alb-1796940379.ap-southeast-1.elb.amazonaws.com
```

## 4. Domain and HTTPS

If the Route53 hosted zone for `hop-on.dev` is newly created, copy the hosted zone name servers from the workflow logs and set them at the domain registrar.

ACM DNS validation only finishes after `hop-on.dev` is delegated to the Route53 hosted zone. If the first workflow run says `Certificate is PENDING_VALIDATION`, update the domain name servers and run `AWS Deploy` again. The second run will create the HTTPS listener after ACM becomes `ISSUED`.

Until ACM is issued, the ALB HTTP URL from the workflow logs is still usable for smoke testing.

Final production URL:

```text
https://hop-on.dev
```

Current status:

```text
hop-on.dev and www.hop-on.dev are delegated to Route53.
Route53 A alias records point to legal-assist-alb.
ACM certificate is ISSUED in ap-southeast-1.
ALB HTTPS listener on port 443 is attached.
Smoke tests:
  https://hop-on.dev/health -> 200
  https://hop-on.dev/auth -> 200
```

Current hosted zone name servers:

```text
ns-89.awsdns-11.com
ns-1940.awsdns-50.co.uk
ns-1099.awsdns-09.org
ns-797.awsdns-35.net
```

The GitHub Actions AWS user needs these permissions for future automated DNS and HTTPS updates:

- `acm:ListCertificates`
- `acm:RequestCertificate`
- `acm:DescribeCertificate`
- `route53:ChangeResourceRecordSets`

These permissions were added during the initial production domain setup. Keep them attached if future deploys should be able to renew DNS validation records, recreate certificates, or repair the HTTPS listener automatically.

## 5. Retrieval Data on AWS

The AWS deployment uses the PostgreSQL container on the EC2 host with the persistent Docker volume `docker_pgdata`. The API and worker connect to it through:

```text
DATABASE_URL=postgresql://postgres:${DB_PASSWORD}@postgres:5432/legal_chatbot
VECTOR_DB_PROVIDER=pgvector
```

Production deploys automatically apply `apps/api/migrations/007_retrieval_postgres_indexes.sql` after the API container starts. This keeps the `documents` and `chunks` lookup indexes in sync with the Postgre/pgvector retrieval code and improves production retrieval latency.

Docker images do not contain the production retrieval database. To make AWS behave like the local environment, copy the local `documents` and `chunks` tables, including pgvector embeddings, into the EC2 PostgreSQL volume:

```powershell
docker exec legal-chatbot-postgres pg_dump -U postgres -d legal_chatbot -Fc --data-only -t public.documents -t public.chunks -f /tmp/retrieval-documents-chunks.dump
docker cp legal-chatbot-postgres:/tmp/retrieval-documents-chunks.dump .\deploy-artifacts\retrieval-documents-chunks.dump
scp -i C:\Users\user\.ssh\legal-assist-key.pem .\deploy-artifacts\retrieval-documents-chunks.dump ubuntu@<EC2_PUBLIC_IP>:/tmp/retrieval-documents-chunks.dump
ssh -i C:\Users\user\.ssh\legal-assist-key.pem ubuntu@<EC2_PUBLIC_IP> "docker exec docker-postgres-1 psql -U postgres -d legal_chatbot -c 'TRUNCATE TABLE chunks, documents CASCADE;' && cat /tmp/retrieval-documents-chunks.dump | docker exec -i docker-postgres-1 pg_restore -U postgres -d legal_chatbot --data-only --single-transaction --disable-triggers && docker exec docker-postgres-1 psql -U postgres -d legal_chatbot -c 'ANALYZE documents; ANALYZE chunks;'"
```

Current restored retrieval dataset:

```text
documents=2153
chunks=64455
chunks_with_embedding=64455
legalinfo_chunks=57043
shuukh_chunks=7412
embedding_dimensions=3072
```

Verify after restore:

```sql
SELECT count(*) FROM chunks WHERE embedding IS NOT NULL;
SELECT metadata->>'source' AS source, count(*) FROM chunks GROUP BY 1;
```

If you want AWS to crawl and embed fresh data instead of restoring from local, run ingestion on the EC2 host:

```bash
cd /opt/legal-assist
docker compose --env-file .env -f docker/docker-compose.ecr.yml exec worker pnpm exec tsx src/index.ts ingest --source legalinfo --limit 938 --fresh
```

For Shuukh cases:

```bash
docker compose --env-file .env -f docker/docker-compose.ecr.yml exec worker pnpm exec tsx src/index.ts ingest --source shuukh --limit 1500 --fresh
```

## 6. Useful Commands

```bash
docker compose --env-file .env -f docker/docker-compose.ecr.yml ps
docker compose --env-file .env -f docker/docker-compose.ecr.yml logs -f api
docker compose --env-file .env -f docker/docker-compose.ecr.yml logs -f web
docker compose --env-file .env -f docker/docker-compose.ecr.yml logs -f worker
docker compose --env-file .env -f docker/docker-compose.ecr.yml restart api web nginx
```

## Notes

- Postgres is not exposed publicly; only Nginx port `80` is public.
- The ALB exposes public `80` and `443`; the EC2 security group accepts port `80` only from the ALB security group.
- The web app calls API through the same origin via `/v1/...`, so browser CORS issues are avoided.
- Keep `.env` out of git. Use `PRODUCTION_ENV` GitHub secret for production.
