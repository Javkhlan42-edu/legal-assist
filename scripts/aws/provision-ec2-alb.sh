#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${APP_NAME:-legal-assist}"
DOMAIN_NAME="${DOMAIN_NAME:-hop-on.dev}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t3.large}"
ROOT_VOLUME_SIZE="${ROOT_VOLUME_SIZE:-80}"
SSM_ENV_PARAMETER="${SSM_ENV_PARAMETER:-/${APP_NAME}/prod/env}"

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

emit_output() {
  local key="$1"
  local value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf '%s=%s\n' "$key" "$value" >>"$GITHUB_OUTPUT"
  fi
}

require aws
require jq
require python3

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [ -n "${AWS_ACCOUNT_ID:-}" ] && [ "$ACCOUNT_ID" != "$AWS_ACCOUNT_ID" ]; then
  echo "AWS account mismatch. Expected $AWS_ACCOUNT_ID, got $ACCOUNT_ID" >&2
  exit 1
fi

VPC_ID="$(aws ec2 describe-vpcs \
  --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' \
  --output text)"

if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
  echo "No default VPC found in $AWS_REGION. Create a VPC first or set up custom networking." >&2
  exit 1
fi

mapfile -t SUBNET_IDS < <(aws ec2 describe-subnets \
  --filters Name=vpc-id,Values="$VPC_ID" Name=default-for-az,Values=true \
  --query 'Subnets[].SubnetId' \
  --output text | tr '\t' '\n')

if [ "${#SUBNET_IDS[@]}" -lt 2 ]; then
  echo "At least two default subnets are required for an ALB." >&2
  exit 1
fi

ensure_security_group() {
  local name="$1"
  local description="$2"
  local group_id
  group_id="$(aws ec2 describe-security-groups \
    --filters Name=group-name,Values="$name" Name=vpc-id,Values="$VPC_ID" \
    --query 'SecurityGroups[0].GroupId' \
    --output text 2>/dev/null || true)"

  if [ -z "$group_id" ] || [ "$group_id" = "None" ]; then
    group_id="$(aws ec2 create-security-group \
      --group-name "$name" \
      --description "$description" \
      --vpc-id "$VPC_ID" \
      --query GroupId \
      --output text)"
    aws ec2 create-tags --resources "$group_id" --tags Key=App,Value="$APP_NAME"
  fi

  printf '%s\n' "$group_id"
}

ALB_SG_ID="$(ensure_security_group "${APP_NAME}-alb-sg" "${APP_NAME} public ALB")"
EC2_SG_ID="$(ensure_security_group "${APP_NAME}-ec2-sg" "${APP_NAME} application host")"

aws ec2 authorize-security-group-ingress \
  --group-id "$ALB_SG_ID" \
  --ip-permissions \
    IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges='[{CidrIp=0.0.0.0/0,Description="HTTP"}]' \
    IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges='[{CidrIp=0.0.0.0/0,Description="HTTPS"}]' \
  >/dev/null 2>&1 || true

aws ec2 authorize-security-group-ingress \
  --group-id "$EC2_SG_ID" \
  --ip-permissions "IpProtocol=tcp,FromPort=80,ToPort=80,UserIdGroupPairs=[{GroupId=$ALB_SG_ID,Description=\"ALB to app\"}]" \
  >/dev/null 2>&1 || true

ROLE_NAME="${APP_NAME}-ec2-role"
PROFILE_NAME="${APP_NAME}-ec2-profile"

if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "$TRUST_POLICY" >/dev/null
fi

aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore >/dev/null 2>&1 || true
aws iam attach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly >/dev/null 2>&1 || true

PARAM_POLICY="$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ssm:GetParameter"],
      "Resource": "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter${SSM_ENV_PARAMETER}"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "*"
    }
  ]
}
JSON
)"
aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name "${APP_NAME}-runtime-env" --policy-document "$PARAM_POLICY" >/dev/null

if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
fi

if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" \
  --query "InstanceProfile.Roles[?RoleName=='$ROLE_NAME'].RoleName" \
  --output text | grep -q "$ROLE_NAME"; then
  aws iam add-role-to-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" >/dev/null
  sleep 10
fi

INSTANCE_ID="$(aws ec2 describe-instances \
  --filters Name=tag:App,Values="$APP_NAME" Name=tag:Role,Values=app Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[0].InstanceId' \
  --output text | awk '{print $1}')"

if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  AMI_ID="$(aws ssm get-parameter \
    --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
    --query 'Parameter.Value' \
    --output text)"

  USER_DATA_FILE="$(mktemp)"
  cat >"$USER_DATA_FILE" <<'USERDATA'
#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git jq unzip awscli
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | tee /etc/apt/keyrings/docker.asc >/dev/null
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
usermod -aG docker ubuntu || true
snap install amazon-ssm-agent --classic || true
systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent.service || systemctl enable --now amazon-ssm-agent || true
mkdir -p /opt/legal-assist
chown -R ubuntu:ubuntu /opt/legal-assist
USERDATA

  INSTANCE_ID="$(aws ec2 run-instances \
    --image-id "$AMI_ID" \
    --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile Name="$PROFILE_NAME" \
    --subnet-id "${SUBNET_IDS[0]}" \
    --security-group-ids "$EC2_SG_ID" \
    --associate-public-ip-address \
    --block-device-mappings "[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${ROOT_VOLUME_SIZE},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":false}}]" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${APP_NAME}-app},{Key=App,Value=${APP_NAME}},{Key=Role,Value=app}]" \
    --user-data "file://${USER_DATA_FILE}" \
    --query 'Instances[0].InstanceId' \
    --output text)"
  rm -f "$USER_DATA_FILE"
fi

aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

ALB_NAME="${APP_NAME}-alb"
ALB_ARN="$(aws elbv2 describe-load-balancers --names "$ALB_NAME" --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)"
if [ -z "$ALB_ARN" ] || [ "$ALB_ARN" = "None" ]; then
  ALB_ARN="$(aws elbv2 create-load-balancer \
    --name "$ALB_NAME" \
    --type application \
    --scheme internet-facing \
    --security-groups "$ALB_SG_ID" \
    --subnets "${SUBNET_IDS[@]}" \
    --query 'LoadBalancers[0].LoadBalancerArn' \
    --output text)"
fi

aws elbv2 wait load-balancer-available --load-balancer-arns "$ALB_ARN"
ALB_DNS="$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].DNSName' --output text)"
ALB_ZONE_ID="$(aws elbv2 describe-load-balancers --load-balancer-arns "$ALB_ARN" --query 'LoadBalancers[0].CanonicalHostedZoneId' --output text)"

TG_NAME="${APP_NAME}-tg"
TG_ARN="$(aws elbv2 describe-target-groups --names "$TG_NAME" --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)"
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN="$(aws elbv2 create-target-group \
    --name "$TG_NAME" \
    --protocol HTTP \
    --port 80 \
    --vpc-id "$VPC_ID" \
    --target-type instance \
    --health-check-path /health \
    --query 'TargetGroups[0].TargetGroupArn' \
    --output text)"
fi

aws elbv2 register-targets --target-group-arn "$TG_ARN" --targets Id="$INSTANCE_ID",Port=80

HTTP_LISTENER_ARN="$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
  --query "Listeners[?Port==\`80\`].ListenerArn | [0]" \
  --output text 2>/dev/null || true)"
if [ -z "$HTTP_LISTENER_ARN" ] || [ "$HTTP_LISTENER_ARN" = "None" ]; then
  HTTP_LISTENER_ARN="$(aws elbv2 create-listener \
    --load-balancer-arn "$ALB_ARN" \
    --protocol HTTP \
    --port 80 \
    --default-actions Type=forward,TargetGroupArn="$TG_ARN" \
    --query 'Listeners[0].ListenerArn' \
    --output text)"
fi

ZONE_NAME="${DOMAIN_NAME}."
ZONE_ID="$(aws route53 list-hosted-zones-by-name \
  --dns-name "$ZONE_NAME" \
  --query "HostedZones[?Name=='$ZONE_NAME' && Config.PrivateZone==\`false\`].Id | [0]" \
  --output text)"

if [ -z "$ZONE_ID" ] || [ "$ZONE_ID" = "None" ]; then
  ZONE_ID="$(aws route53 create-hosted-zone \
    --name "$DOMAIN_NAME" \
    --caller-reference "${APP_NAME}-$(date +%s)" \
    --hosted-zone-config Comment="${APP_NAME} production zone",PrivateZone=false \
    --query 'HostedZone.Id' \
    --output text)"
fi
ZONE_ID="${ZONE_ID#/hostedzone/}"

CERT_ARN="$(aws acm list-certificates \
  --certificate-statuses ISSUED PENDING_VALIDATION INACTIVE EXPIRED VALIDATION_TIMED_OUT \
  --query "CertificateSummaryList[?DomainName=='$DOMAIN_NAME'].CertificateArn | [0]" \
  --output text)"
if [ -z "$CERT_ARN" ] || [ "$CERT_ARN" = "None" ]; then
  CERT_ARN="$(aws acm request-certificate \
    --domain-name "$DOMAIN_NAME" \
    --validation-method DNS \
    --idempotency-token "$(echo "$APP_NAME" | tr -cd '[:alnum:]' | cut -c1-32)" \
    --query CertificateArn \
    --output text)"
fi

for _ in $(seq 1 20); do
  VALIDATION_JSON="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --query 'Certificate.DomainValidationOptions[0].ResourceRecord' --output json)"
  if [ "$VALIDATION_JSON" != "null" ]; then
    break
  fi
  sleep 3
done

if [ "${VALIDATION_JSON:-null}" != "null" ]; then
  RECORD_NAME="$(echo "$VALIDATION_JSON" | jq -r '.Name')"
  RECORD_TYPE="$(echo "$VALIDATION_JSON" | jq -r '.Type')"
  RECORD_VALUE="$(echo "$VALIDATION_JSON" | jq -r '.Value')"
  CHANGE_FILE="$(mktemp)"
  cat >"$CHANGE_FILE" <<JSON
{
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$RECORD_NAME",
        "Type": "$RECORD_TYPE",
        "TTL": 300,
        "ResourceRecords": [{ "Value": "$RECORD_VALUE" }]
      }
    }
  ]
}
JSON
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "file://${CHANGE_FILE}" >/dev/null
  rm -f "$CHANGE_FILE"
fi

ALIAS_FILE="$(mktemp)"
cat >"$ALIAS_FILE" <<JSON
{
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$DOMAIN_NAME",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "$ALB_ZONE_ID",
          "DNSName": "$ALB_DNS",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
JSON
aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "file://${ALIAS_FILE}" >/dev/null
rm -f "$ALIAS_FILE"

CERT_STATUS="$(aws acm describe-certificate --certificate-arn "$CERT_ARN" --query 'Certificate.Status' --output text)"
if [ "$CERT_STATUS" = "ISSUED" ]; then
  HTTPS_LISTENER_ARN="$(aws elbv2 describe-listeners --load-balancer-arn "$ALB_ARN" \
    --query "Listeners[?Port==\`443\`].ListenerArn | [0]" \
    --output text 2>/dev/null || true)"
  if [ -z "$HTTPS_LISTENER_ARN" ] || [ "$HTTPS_LISTENER_ARN" = "None" ]; then
    aws elbv2 create-listener \
      --load-balancer-arn "$ALB_ARN" \
      --protocol HTTPS \
      --port 443 \
      --certificates CertificateArn="$CERT_ARN" \
      --default-actions Type=forward,TargetGroupArn="$TG_ARN" >/dev/null
  fi
else
  echo "Certificate is $CERT_STATUS. HTTPS listener will be created automatically on the next run after DNS validation completes." >&2
fi

NS_VALUES="$(aws route53 get-hosted-zone --id "$ZONE_ID" --query 'DelegationSet.NameServers' --output text)"

emit_output "instance_id" "$INSTANCE_ID"
emit_output "alb_dns" "$ALB_DNS"
emit_output "domain_name" "$DOMAIN_NAME"
emit_output "cert_status" "$CERT_STATUS"
emit_output "hosted_zone_id" "$ZONE_ID"

cat <<EOF
Provision complete.
Instance ID: $INSTANCE_ID
ALB DNS: $ALB_DNS
Domain: $DOMAIN_NAME
Certificate status: $CERT_STATUS
Hosted Zone ID: $ZONE_ID
Hosted Zone NS: $NS_VALUES
EOF
