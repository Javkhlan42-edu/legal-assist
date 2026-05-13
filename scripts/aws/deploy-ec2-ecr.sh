#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-legal-assist}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
DOMAIN_NAME="${DOMAIN_NAME:-hop-on.dev}"
SSM_ENV_PARAMETER="${SSM_ENV_PARAMETER:-/${APP_NAME}/prod/env}"
GIT_REF="${GIT_REF:-main}"

: "${API_IMAGE:?API_IMAGE is required}"
: "${WEB_IMAGE:?WEB_IMAGE is required}"
: "${WORKER_IMAGE:?WORKER_IMAGE is required}"

INSTANCE_ID="${INSTANCE_ID:-}"
if [ -z "$INSTANCE_ID" ]; then
  INSTANCE_ID="$(aws ec2 describe-instances \
    --filters Name=tag:App,Values="$APP_NAME" Name=tag:Role,Values=app Name=instance-state-name,Values=running \
    --query 'Reservations[].Instances[0].InstanceId' \
    --output text | awk '{print $1}')"
fi

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "No running EC2 instance found for App=$APP_NAME Role=app" >&2
  exit 1
fi

echo "Waiting for SSM instance $INSTANCE_ID..."
for _ in $(seq 1 60); do
  STATUS="$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text 2>/dev/null || true)"
  if [ "$STATUS" = "Online" ]; then
    break
  fi
  sleep 10
done

if [ "${STATUS:-}" != "Online" ]; then
  echo "SSM is not online for $INSTANCE_ID. Wait for EC2 user-data to finish and rerun deploy." >&2
  exit 1
fi

COMMAND_FILE="$(mktemp)"
cat >"$COMMAND_FILE" <<JSON
{
  "commands": [
    "set -euo pipefail",
    "export AWS_REGION='${AWS_REGION}'",
    "export AWS_DEFAULT_REGION='${AWS_REGION}'",
    "export APP_DIR='/opt/legal-assist'",
    "export REPO_URL='https://github.com/Javkhlan42-edu/legal-assist.git'",
    "if ! command -v docker >/dev/null 2>&1; then echo 'Docker is not installed yet'; exit 1; fi",
    "if [ ! -d \"\\$APP_DIR/.git\" ]; then rm -rf \"\\$APP_DIR\" && git clone \"\\$REPO_URL\" \"\\$APP_DIR\"; fi",
    "cd \"\\$APP_DIR\"",
    "git fetch origin '${GIT_REF}'",
    "git checkout '${GIT_REF}'",
    "git pull --ff-only origin '${GIT_REF}'",
    "aws ssm get-parameter --name '${SSM_ENV_PARAMETER}' --with-decryption --query 'Parameter.Value' --output text > .env",
    "printf '\\nAPI_IMAGE=${API_IMAGE}\\nWEB_IMAGE=${WEB_IMAGE}\\nWORKER_IMAGE=${WORKER_IMAGE}\\nAWS_REGION=${AWS_REGION}\\nDOMAIN_NAME=${DOMAIN_NAME}\\n' >> .env",
    "aws ecr get-login-password --region '${AWS_REGION}' | docker login --username AWS --password-stdin '${API_IMAGE%%/*}'",
    "docker compose -f docker/docker-compose.ecr.yml pull",
    "docker compose -f docker/docker-compose.ecr.yml up -d --remove-orphans",
    "docker compose --env-file .env -f docker/docker-compose.ecr.yml exec -T api node scripts/apply-sql-migration.mjs migrations/007_retrieval_postgres_indexes.sql",
    "docker compose -f docker/docker-compose.ecr.yml ps"
  ]
}
JSON

COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "${APP_NAME} ECR deploy" \
  --parameters "file://${COMMAND_FILE}" \
  --query 'Command.CommandId' \
  --output text)"
rm -f "$COMMAND_FILE"

echo "SSM command: $COMMAND_ID"
aws ssm wait command-executed --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" || true

aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
  --output json

FINAL_STATUS="$(aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" --query Status --output text)"
if [ "$FINAL_STATUS" != "Success" ]; then
  exit 1
fi
