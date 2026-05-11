# AWS EC2 Deployment

This project deploys to one AWS EC2 instance with Docker Compose and GitHub Actions.

Target AWS account:

- Account ID: `029458826874`
- Account name: `Javkhlan-42-edu`
- GitHub repo: `https://github.com/Javkhlan42-edu/legal-assist.git`

## 1. Create EC2

Use Ubuntu 24.04 LTS or Ubuntu 22.04 LTS.

Recommended minimum:

- Instance: `t3.medium` for testing, `t3.large` if ingestion and generation run on the same box
- Storage: 40-80 GB gp3
- Security group inbound: `22/tcp` from your IP, `80/tcp` from the internet

Install Docker on the instance:

```bash
curl -fsSL https://raw.githubusercontent.com/Javkhlan42-edu/legal-assist/main/scripts/aws/install-docker-ubuntu.sh | bash
newgrp docker
```

## 2. Prepare GitHub Secrets

In GitHub, open `Settings -> Secrets and variables -> Actions`.

Add these secrets:

- `DEPLOY_HOST`: EC2 public IP or domain
- `DEPLOY_USER`: usually `ubuntu`
- `DEPLOY_PORT`: usually `22`
- `DEPLOY_PATH`: `/opt/legal-assist`
- `DEPLOY_SSH_KEY`: private SSH key that can connect to the EC2 instance
- `PRODUCTION_ENV`: copy `.env.aws.example`, fill real values, then paste the whole file content

Add this repository variable if you want auto-deploy on every push to `main`:

- `ENABLE_SSH_DEPLOY`: `true`

If you prefer manual deploy only, do not set `ENABLE_SSH_DEPLOY`; run the `Deploy` workflow manually.

## 3. Deploy

The GitHub Actions workflow will:

1. SSH to EC2.
2. Clone or update `/opt/legal-assist`.
3. Write the `PRODUCTION_ENV` secret to `/opt/legal-assist/.env`.
4. Run:

```bash
docker compose -f docker/docker-compose.aws.yml up -d --build --remove-orphans
```

Then open:

```text
http://<EC2_PUBLIC_IP>
```

## 4. First Data Ingestion

After the first deploy, the database is empty unless you migrated data separately. Run ingestion once:

```bash
cd /opt/legal-assist
docker compose -f docker/docker-compose.aws.yml exec worker pnpm exec tsx src/index.ts ingest --source legalinfo --limit 938 --fresh
```

For Shuukh cases:

```bash
docker compose -f docker/docker-compose.aws.yml exec worker pnpm exec tsx src/index.ts ingest --source shuukh --limit 1500 --fresh
```

## 5. Useful Commands

```bash
docker compose -f docker/docker-compose.aws.yml ps
docker compose -f docker/docker-compose.aws.yml logs -f api
docker compose -f docker/docker-compose.aws.yml logs -f web
docker compose -f docker/docker-compose.aws.yml logs -f worker
docker compose -f docker/docker-compose.aws.yml restart api web nginx
```

## Notes

- Postgres is not exposed publicly; only Nginx port `80` is public.
- The web app calls API through the same origin via `/v1/...`, so browser CORS issues are avoided.
- Keep `.env` out of git. Use `PRODUCTION_ENV` GitHub secret for production.
