param(
  [string]$CredentialsCsv,
  [string]$AppName = 'legal-assist',
  [string]$DomainName = 'hop-on.dev',
  [string]$Region = 'ap-southeast-1',
  [string]$AccountId = '029458826874',
  [string]$GitRef = 'main',
  [string]$InstanceType = 't3.micro',
  [int]$RootVolumeSize = 80
)

$ErrorActionPreference = 'Stop'
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
  $global:PSNativeCommandUseErrorActionPreference = $false
}

function Invoke-AwsText {
  param([string[]]$Arguments)
  $output = & aws @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "aws $($Arguments -join ' ') failed"
  }
  return (($output -join "`n").Trim())
}

function Invoke-AwsJson {
  param([string[]]$Arguments)
  $text = Invoke-AwsText $Arguments
  if ([string]::IsNullOrWhiteSpace($text)) {
    return $null
  }
  return $text | ConvertFrom-Json
}

function New-RandomSecret {
  param([int]$Bytes = 32)
  $buffer = New-Object byte[] $Bytes
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($buffer)
  } finally {
    $rng.Dispose()
  }
  return [Convert]::ToBase64String($buffer).TrimEnd('=')
}

function Get-EnvMap {
  param([string]$Path)
  $map = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $idx = $line.IndexOf('=')
      $map[$line.Substring(0, $idx)] = $line.Substring($idx + 1)
    }
  }
  return $map
}

function Ensure-EcrRepository {
  param([string]$Name)
  & aws ecr describe-repositories --repository-names $Name *> $null
  if ($LASTEXITCODE -ne 0) {
    & aws ecr create-repository --repository-name $Name --image-scanning-configuration scanOnPush=true --encryption-configuration encryptionType=AES256 | Out-Null
  }
}

function Ensure-SecurityGroup {
  param([string]$Name, [string]$Description, [string]$VpcId)
  $id = Invoke-AwsText @('ec2', 'describe-security-groups', '--filters', "Name=group-name,Values=$Name", "Name=vpc-id,Values=$VpcId", '--query', 'SecurityGroups[0].GroupId', '--output', 'text')
  if (-not $id -or $id -eq 'None') {
    $id = Invoke-AwsText @('ec2', 'create-security-group', '--group-name', $Name, '--description', $Description, '--vpc-id', $VpcId, '--query', 'GroupId', '--output', 'text')
    & aws ec2 create-tags --resources $id --tags "Key=App,Value=$AppName" | Out-Null
  }
  return $id
}

if (-not $CredentialsCsv) {
  throw 'CredentialsCsv is required.'
}

$credentials = Import-Csv -LiteralPath $CredentialsCsv
$env:AWS_ACCESS_KEY_ID = $credentials[0].'Access key ID'
$env:AWS_SECRET_ACCESS_KEY = $credentials[0].'Secret access key'
$env:AWS_DEFAULT_REGION = $Region

$identity = Invoke-AwsJson @('sts', 'get-caller-identity')
if ($identity.Account -ne $AccountId) {
  throw "AWS account mismatch. Expected $AccountId, got $($identity.Account)."
}
Write-Host "AWS account verified: $($identity.Account)"

foreach ($repo in @('legal-assist-api', 'legal-assist-web', 'legal-assist-worker')) {
  Ensure-EcrRepository $repo
}
Write-Host 'ECR repositories verified.'

$keyName = "$AppName-key"
$sshDir = Join-Path $HOME '.ssh'
New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
$keyPath = Join-Path $sshDir "$keyName.pem"
$keyExists = $true
try {
  & aws ec2 describe-key-pairs --key-names $keyName *> $null
  if ($LASTEXITCODE -ne 0) { $keyExists = $false }
} catch {
  $keyExists = $false
}
if (-not $keyExists) {
  $keyMaterial = Invoke-AwsText @('ec2', 'create-key-pair', '--key-name', $keyName, '--query', 'KeyMaterial', '--output', 'text')
  Set-Content -LiteralPath $keyPath -Value $keyMaterial -NoNewline -Encoding ASCII
  & icacls $keyPath /inheritance:r /grant:r "$($env:USERNAME):R" | Out-Null
}
if (-not (Test-Path -LiteralPath $keyPath)) {
  throw "Key pair $keyName exists in AWS, but local private key is missing at $keyPath. Delete the AWS key pair or provide the original PEM."
}
Write-Host "SSH key ready: $keyPath"

$vpcId = Invoke-AwsText @('ec2', 'describe-vpcs', '--filters', 'Name=is-default,Values=true', '--query', 'Vpcs[0].VpcId', '--output', 'text')
$subnets = (Invoke-AwsText @('ec2', 'describe-subnets', '--filters', "Name=vpc-id,Values=$vpcId", 'Name=default-for-az,Values=true', '--query', 'Subnets[].SubnetId', '--output', 'text')) -split '\s+' | Where-Object { $_ }
if ($subnets.Count -lt 2) {
  throw 'At least two default subnets are required.'
}

$albSg = Ensure-SecurityGroup "$AppName-alb-sg" "$AppName public ALB" $vpcId
$ec2Sg = Ensure-SecurityGroup "$AppName-ec2-sg" "$AppName application host" $vpcId
try { & aws ec2 authorize-security-group-ingress --group-id $albSg --protocol tcp --port 80 --cidr 0.0.0.0/0 *> $null } catch {}
try { & aws ec2 authorize-security-group-ingress --group-id $albSg --protocol tcp --port 443 --cidr 0.0.0.0/0 *> $null } catch {}
try { & aws ec2 authorize-security-group-ingress --group-id $ec2Sg --protocol tcp --port 80 --source-group $albSg *> $null } catch {}
$myIp = (Invoke-RestMethod -Uri 'https://checkip.amazonaws.com' -TimeoutSec 10).Trim()
try { & aws ec2 authorize-security-group-ingress --group-id $ec2Sg --protocol tcp --port 22 --cidr "$myIp/32" *> $null } catch {}
Write-Host "Security groups verified. SSH allowed from $myIp/32."

$instanceIdText = Invoke-AwsText @('ec2', 'describe-instances', '--filters', "Name=tag:App,Values=$AppName", 'Name=tag:Role,Values=app', 'Name=instance-state-name,Values=pending,running,stopping,stopped', '--query', 'Reservations[].Instances[0].InstanceId', '--output', 'text')
$instanceId = $instanceIdText -split '\s+' | Where-Object { $_ -and $_ -ne 'None' } | Select-Object -First 1
if (-not $instanceId) {
  $ami = Invoke-AwsText @(
    'ec2', 'describe-images',
    '--owners', '099720109477',
    '--filters',
    'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*',
    'Name=architecture,Values=x86_64',
    'Name=virtualization-type,Values=hvm',
    '--query', 'sort_by(Images,&CreationDate)[-1].ImageId',
    '--output', 'text'
  )
  $userData = @'
#!/usr/bin/env bash
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git jq unzip
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | tee /etc/apt/keyrings/docker.asc >/dev/null
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
if [ ! -f /swapfile ]; then
  fallocate -l 6G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=6144
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
systemctl enable --now docker
usermod -aG docker ubuntu || true
mkdir -p /opt/legal-assist
chown -R ubuntu:ubuntu /opt/legal-assist
'@
  $userDataFile = Join-Path $env:TEMP 'legal-assist-user-data.sh'
  Set-Content -LiteralPath $userDataFile -Value $userData -NoNewline -Encoding ASCII
  $blockDeviceSpec = @(
    @{
      DeviceName = '/dev/sda1'
      Ebs = @{
        VolumeSize = $RootVolumeSize
        VolumeType = 'gp3'
        DeleteOnTermination = $false
      }
    }
  )
  $blockDevice = ConvertTo-Json -InputObject $blockDeviceSpec -Depth 5
  $blockDeviceFile = Join-Path $env:TEMP 'legal-assist-block-device.json'
  Set-Content -LiteralPath $blockDeviceFile -Value $blockDevice -NoNewline -Encoding ASCII
  $tagSpec = "ResourceType=instance,Tags=[{Key=Name,Value=$AppName-app},{Key=App,Value=$AppName},{Key=Role,Value=app}]"
  try {
    $instanceId = Invoke-AwsText @('ec2', 'run-instances', '--image-id', $ami, '--instance-type', $InstanceType, '--key-name', $keyName, '--subnet-id', $subnets[0], '--security-group-ids', $ec2Sg, '--associate-public-ip-address', '--block-device-mappings', "file://$blockDeviceFile", '--tag-specifications', $tagSpec, '--user-data', "file://$userDataFile", '--query', 'Instances[0].InstanceId', '--output', 'text')
  } finally {
    Remove-Item -LiteralPath $blockDeviceFile -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $userDataFile -Force -ErrorAction SilentlyContinue
}
& aws ec2 wait instance-running --instance-ids $instanceId
$instance = Invoke-AwsJson @('ec2', 'describe-instances', '--instance-ids', $instanceId, '--query', 'Reservations[0].Instances[0]')
$publicIp = $instance.PublicIpAddress
Write-Host "EC2 instance: $instanceId ($publicIp)"

$albName = "$AppName-alb"
$albExists = $true
try {
  & aws elbv2 describe-load-balancers --names $albName *> $null
  if ($LASTEXITCODE -ne 0) { $albExists = $false }
} catch {
  $albExists = $false
}
if ($albExists) {
  $albArn = Invoke-AwsText @('elbv2', 'describe-load-balancers', '--names', $albName, '--query', 'LoadBalancers[0].LoadBalancerArn', '--output', 'text')
} else {
  $albArgs = @('elbv2', 'create-load-balancer', '--name', $albName, '--type', 'application', '--scheme', 'internet-facing', '--security-groups', $albSg, '--subnets') + $subnets + @('--query', 'LoadBalancers[0].LoadBalancerArn', '--output', 'text')
  $albArn = Invoke-AwsText $albArgs
}
& aws elbv2 wait load-balancer-available --load-balancer-arns $albArn
$alb = Invoke-AwsJson @('elbv2', 'describe-load-balancers', '--load-balancer-arns', $albArn)
$albDns = $alb.LoadBalancers[0].DNSName
$albZoneId = $alb.LoadBalancers[0].CanonicalHostedZoneId
$tgName = "$AppName-tg"
$tgExists = $true
try {
  & aws elbv2 describe-target-groups --names $tgName *> $null
  if ($LASTEXITCODE -ne 0) { $tgExists = $false }
} catch {
  $tgExists = $false
}
if ($tgExists) {
  $tgArn = Invoke-AwsText @('elbv2', 'describe-target-groups', '--names', $tgName, '--query', 'TargetGroups[0].TargetGroupArn', '--output', 'text')
} else {
  $tgArn = Invoke-AwsText @('elbv2', 'create-target-group', '--name', $tgName, '--protocol', 'HTTP', '--port', '80', '--vpc-id', $vpcId, '--target-type', 'instance', '--health-check-path', '/health', '--query', 'TargetGroups[0].TargetGroupArn', '--output', 'text')
}
& aws elbv2 register-targets --target-group-arn $tgArn --targets "Id=$instanceId,Port=80" | Out-Null
$httpListener = Invoke-AwsText @('elbv2', 'describe-listeners', '--load-balancer-arn', $albArn, '--query', 'Listeners[?Port==`80`].ListenerArn | [0]', '--output', 'text')
if (-not $httpListener -or $httpListener -eq 'None') {
  & aws elbv2 create-listener --load-balancer-arn $albArn --protocol HTTP --port 80 --default-actions "Type=forward,TargetGroupArn=$tgArn" | Out-Null
}
Write-Host "ALB DNS: $albDns"

$zoneName = "$DomainName."
$zoneId = Invoke-AwsText @('route53', 'list-hosted-zones-by-name', '--dns-name', $zoneName, '--query', "HostedZones[?Name=='$zoneName' && Config.PrivateZone==``false``].Id | [0]", '--output', 'text')
if (-not $zoneId -or $zoneId -eq 'None') {
  $zoneId = Invoke-AwsText @('route53', 'create-hosted-zone', '--name', $DomainName, '--caller-reference', "$AppName-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())", '--hosted-zone-config', "Comment=$AppName production zone,PrivateZone=false", '--query', 'HostedZone.Id', '--output', 'text')
}
$zoneId = $zoneId -replace '^/hostedzone/', ''
$certArn = $null
$certStatus = 'SKIPPED_NO_ACM_PERMISSION'
try {
  $certArn = Invoke-AwsText @('acm', 'list-certificates', '--certificate-statuses', 'ISSUED', 'PENDING_VALIDATION', 'VALIDATION_TIMED_OUT', '--query', "CertificateSummaryList[?DomainName=='$DomainName'].CertificateArn | [0]", '--output', 'text')
  if (-not $certArn -or $certArn -eq 'None') {
    $certArn = Invoke-AwsText @('acm', 'request-certificate', '--domain-name', $DomainName, '--validation-method', 'DNS', '--idempotency-token', 'legalassist', '--query', 'CertificateArn', '--output', 'text')
  }
  Start-Sleep -Seconds 5
  $cert = Invoke-AwsJson @('acm', 'describe-certificate', '--certificate-arn', $certArn)
  $record = $cert.Certificate.DomainValidationOptions[0].ResourceRecord
  if ($record) {
    $validationChange = @{ Changes = @(@{ Action = 'UPSERT'; ResourceRecordSet = @{ Name = $record.Name; Type = $record.Type; TTL = 300; ResourceRecords = @(@{ Value = $record.Value }) } }) } | ConvertTo-Json -Depth 8
    $validationFile = Join-Path $env:TEMP 'legal-assist-r53-validation.json'
    Set-Content -LiteralPath $validationFile -Value $validationChange -NoNewline -Encoding ASCII
    & aws route53 change-resource-record-sets --hosted-zone-id $zoneId --change-batch "file://$validationFile" | Out-Null
    Remove-Item -LiteralPath $validationFile -Force -ErrorAction SilentlyContinue
  }
  $certStatus = Invoke-AwsText @('acm', 'describe-certificate', '--certificate-arn', $certArn, '--query', 'Certificate.Status', '--output', 'text')
} catch {
  Write-Warning "ACM certificate setup skipped: $($_.Exception.Message)"
}
$dnsAliasStatus = 'SKIPPED_NO_ROUTE53_CHANGE_PERMISSION'
$aliasChange = @{ Changes = @(@{ Action = 'UPSERT'; ResourceRecordSet = @{ Name = $DomainName; Type = 'A'; AliasTarget = @{ HostedZoneId = $albZoneId; DNSName = $albDns; EvaluateTargetHealth = $false } } }) } | ConvertTo-Json -Depth 8
$aliasFile = Join-Path $env:TEMP 'legal-assist-r53-alias.json'
Set-Content -LiteralPath $aliasFile -Value $aliasChange -NoNewline -Encoding ASCII
try {
  & aws route53 change-resource-record-sets --hosted-zone-id $zoneId --change-batch "file://$aliasFile" | Out-Null
  if ($LASTEXITCODE -eq 0) {
    $dnsAliasStatus = 'UPSERTED'
  } else {
    throw 'Route53 alias change failed.'
  }
} catch {
  Write-Warning "Route53 alias setup skipped: $($_.Exception.Message)"
} finally {
  Remove-Item -LiteralPath $aliasFile -Force -ErrorAction SilentlyContinue
}
if ($certArn -and $certStatus -eq 'ISSUED') {
  $httpsListener = Invoke-AwsText @('elbv2', 'describe-listeners', '--load-balancer-arn', $albArn, '--query', 'Listeners[?Port==`443`].ListenerArn | [0]', '--output', 'text')
  if (-not $httpsListener -or $httpsListener -eq 'None') {
    & aws elbv2 create-listener --load-balancer-arn $albArn --protocol HTTPS --port 443 --certificates "CertificateArn=$certArn" --default-actions "Type=forward,TargetGroupArn=$tgArn" | Out-Null
  }
}
$nameServers = Invoke-AwsText @('route53', 'get-hosted-zone', '--id', $zoneId, '--query', 'DelegationSet.NameServers', '--output', 'text')
Write-Host "Hosted zone: $zoneId"
Write-Host "Certificate status: $certStatus"
Write-Host "Hosted zone NS: $nameServers"
Write-Host "DNS alias status: $dnsAliasStatus"

$envMap = Get-EnvMap '.env'
$chatModel = if ($envMap.ContainsKey('OPENAI_CHAT_MODEL')) { $envMap['OPENAI_CHAT_MODEL'] } else { 'gpt-5.4' }
$embeddingModel = if ($envMap.ContainsKey('OPENAI_EMBEDDING_MODEL')) { $envMap['OPENAI_EMBEDDING_MODEL'] } else { 'text-embedding-3-small' }
$prodEnv = @(
  'NODE_ENV=production'
  'LOG_LEVEL=info'
  "CORS_ORIGIN=https://$DomainName,http://$DomainName,http://$albDns"
  'NEXT_PUBLIC_API_URL='
  'PUBLIC_HTTP_PORT=80'
  ('DB_PASSWORD=' + (New-RandomSecret 36))
  'VECTOR_DB_PROVIDER=pgvector'
  'VECTOR_DB_FALLBACK=false'
  ('OPENAI_API_KEY=' + $envMap['OPENAI_API_KEY'])
  ('OPENAI_CHAT_MODEL=' + $chatModel)
  ('OPENAI_EMBEDDING_MODEL=' + $embeddingModel)
  'EMBEDDING_PROVIDER=openai'
  'EMBEDDING_DIMENSION=3072'
  'OPENAI_TIMEOUT_MS=180000'
  'RETRIEVAL_SPEED_MODE=quality'
  'INCLUDE_RELATED_CASES=auto'
  'RETRIEVAL_TIMEOUT_MS=180000'
  'GENERATION_TIMEOUT_MS=180000'
  'RESPONSE_LATENCY_BUDGET_MS=240000'
  'USE_CROSS_RERANKER=false'
  ('JWT_SECRET=' + (New-RandomSecret 48))
  'GOOGLE_CLIENT_ID='
  'RATE_LIMIT_WINDOW_MS=60000'
  'RATE_LIMIT_MAX_REQUESTS=30'
  'PIPELINE_FAIL_FAST=false'
  'PIPELINE_MAX_CONSECUTIVE_FAILURES=20'
  'CRAWL_DELAY_MS=1000'
  'CRAWL_MAX_CONCURRENT=1'
) -join "`n"
$localProdEnv = Join-Path $env:TEMP 'legal-assist-prod.env'
Set-Content -LiteralPath $localProdEnv -Value $prodEnv -NoNewline -Encoding UTF8

$sshBase = @('-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=NUL', '-o', 'LogLevel=ERROR', '-i', $keyPath, "ubuntu@$publicIp")
for ($i = 0; $i -lt 90; $i++) {
  & ssh @sshBase 'echo ready' *> $null
  if ($LASTEXITCODE -eq 0) { break }
  Start-Sleep -Seconds 10
}
if ($LASTEXITCODE -ne 0) {
  throw 'SSH did not become ready.'
}
Write-Host 'SSH ready.'

$bootstrapScript = @'
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive
if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get update
  sudo apt-get install -y ca-certificates curl git jq unzip
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo tee /etc/apt/keyrings/docker.asc >/dev/null
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
if [ ! -f /swapfile ]; then
  sudo fallocate -l 6G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=6144
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
elif ! swapon --show | grep -q '^/swapfile'; then
  sudo swapon /swapfile || true
fi
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu || true
sudo mkdir -p /opt/legal-assist
sudo chown -R ubuntu:ubuntu /opt/legal-assist
docker --version
docker compose version
'@
$bootstrapScriptFile = Join-Path $env:TEMP 'legal-assist-bootstrap.sh'
Set-Content -LiteralPath $bootstrapScriptFile -Value $bootstrapScript -NoNewline -Encoding ASCII
& scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o LogLevel=ERROR -i $keyPath $bootstrapScriptFile "ubuntu@${publicIp}:/tmp/legal-assist-bootstrap.sh"
Remove-Item -LiteralPath $bootstrapScriptFile -Force -ErrorAction SilentlyContinue
& ssh @sshBase 'bash /tmp/legal-assist-bootstrap.sh'
if ($LASTEXITCODE -ne 0) {
  throw 'Remote bootstrap failed.'
}
& scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o LogLevel=ERROR -i $keyPath $localProdEnv "ubuntu@${publicIp}:/tmp/legal-assist-prod.env"
Remove-Item -LiteralPath $localProdEnv -Force -ErrorAction SilentlyContinue

$registry = "$AccountId.dkr.ecr.$Region.amazonaws.com"
$imageTag = "manual-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
$apiImage = "$registry/legal-assist-api:$imageTag"
$webImage = "$registry/legal-assist-web:$imageTag"
$workerImage = "$registry/legal-assist-worker:$imageTag"
$ecrPassword = Invoke-AwsText @('ecr', 'get-login-password', '--region', $Region)
$ecrPassword | ssh @sshBase "docker login --username AWS --password-stdin $registry"

$remoteScript = @"
set -euo pipefail
cd /opt
if [ ! -d legal-assist/.git ]; then
  mkdir -p legal-assist
  cd legal-assist
  find . -mindepth 1 -maxdepth 1 -exec rm -rf {} +
  git clone https://github.com/Javkhlan42-edu/legal-assist.git .
else
  cd legal-assist
fi
git fetch origin $GitRef
git checkout $GitRef
git pull --ff-only origin $GitRef
existing_db_password=""
existing_jwt_secret=""
if [ -f .env ]; then
  existing_db_password="`$(sed -n 's/^DB_PASSWORD=//p' .env | head -n1 || true)"
  existing_jwt_secret="`$(sed -n 's/^JWT_SECRET=//p' .env | head -n1 || true)"
fi
cp /tmp/legal-assist-prod.env .env
if [ -n "`$existing_db_password" ]; then
  grep -v '^DB_PASSWORD=' .env > .env.tmp || true
  printf 'DB_PASSWORD=%s\n' "`$existing_db_password" >> .env.tmp
  mv .env.tmp .env
fi
if [ -n "`$existing_jwt_secret" ]; then
  grep -v '^JWT_SECRET=' .env > .env.tmp || true
  printf 'JWT_SECRET=%s\n' "`$existing_jwt_secret" >> .env.tmp
  mv .env.tmp .env
fi
docker build -f docker/api.Dockerfile -t $apiImage .
docker push $apiImage
docker build -f docker/worker.Dockerfile -t $workerImage .
docker push $workerImage
docker build -f docker/web.Dockerfile --build-arg NEXT_PUBLIC_API_URL= -t $webImage .
docker push $webImage
printf '\nAPI_IMAGE=%s\nWEB_IMAGE=%s\nWORKER_IMAGE=%s\nAWS_REGION=%s\nDOMAIN_NAME=%s\n' '$apiImage' '$webImage' '$workerImage' '$Region' '$DomainName' >> .env
docker compose --env-file .env -f docker/docker-compose.ecr.yml pull
docker compose --env-file .env -f docker/docker-compose.ecr.yml up -d --remove-orphans
docker compose --env-file .env -f docker/docker-compose.ecr.yml exec -T api node scripts/apply-sql-migration.mjs migrations/007_retrieval_postgres_indexes.sql
docker compose --env-file .env -f docker/docker-compose.ecr.yml exec -T api node scripts/check-retrieval-db.mjs
docker compose --env-file .env -f docker/docker-compose.ecr.yml ps
"@
$remoteScriptFile = Join-Path $env:TEMP 'legal-assist-remote-deploy.sh'
Set-Content -LiteralPath $remoteScriptFile -Value $remoteScript -NoNewline -Encoding ASCII
& scp -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o LogLevel=ERROR -i $keyPath $remoteScriptFile "ubuntu@${publicIp}:/tmp/legal-assist-remote-deploy.sh"
Remove-Item -LiteralPath $remoteScriptFile -Force -ErrorAction SilentlyContinue
& ssh @sshBase 'bash /tmp/legal-assist-remote-deploy.sh'
if ($LASTEXITCODE -ne 0) {
  throw 'Remote build/push/deploy failed.'
}

Write-Host "PUBLIC_HTTP_URL=http://$albDns"
Write-Host "PUBLIC_DOMAIN=https://$DomainName"
Write-Host "CERT_STATUS=$certStatus"
Write-Host "HOSTED_ZONE_NS=$nameServers"
