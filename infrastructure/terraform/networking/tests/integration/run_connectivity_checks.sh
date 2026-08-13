#!/bin/bash
#
# Runs the 5 connectivity checks from WO-002's testing_strategy against the
# live instances provisioned by `terraform apply` in this directory. Uses SSM
# Run Command exclusively — no SSH keys, no bastion host, no public IPs
# required. Requires: AWS CLI configured with credentials, instances already
# apply'd and SSM-registered (allow ~2 min after apply for the agent to come
# online).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"

PUBLIC_ID=$(terraform output -raw public_probe_instance_id)
PUBLIC_IP=$(terraform output -raw public_probe_public_ip)
PRIVATE_ID=$(terraform output -raw private_probe_instance_id)
DATA_ID=$(terraform output -raw data_probe_instance_id)
DATA_IP=$(terraform output -raw data_probe_private_ip)
LISTENER_DOC=$(terraform output -raw listener_document_name)

start_listener() {
  local instance="$1" port="$2"
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$instance" \
    --document-name "$LISTENER_DOC" \
    --parameters "port=$port" \
    --query 'Command.CommandId' --output text > /dev/null
  sleep 5
}

pass=0
fail=0

run_check() {
  local desc="$1" instance="$2" command="$3" expect_success="$4"

  cmd_id=$(aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$instance" \
    --document-name "AWS-RunShellScript" \
    --parameters "commands=[\"$command\"]" \
    --query 'Command.CommandId' --output text)

  sleep 8
  status=$(aws ssm get-command-invocation \
    --region "$REGION" \
    --command-id "$cmd_id" \
    --instance-id "$instance" \
    --query 'Status' --output text 2>/dev/null || echo "Failed")

  if [ "$expect_success" = "true" ] && [ "$status" = "Success" ]; then
    echo "PASS: $desc"
    pass=$((pass + 1))
  elif [ "$expect_success" = "false" ] && [ "$status" != "Success" ]; then
    echo "PASS: $desc (correctly blocked)"
    pass=$((pass + 1))
  else
    echo "FAIL: $desc (status=$status, expected_success=$expect_success)"
    fail=$((fail + 1))
  fi
}

echo "Starting TCP/5432 listener on the data-zone probe..."
start_listener "$DATA_ID" 5432

echo "Starting TCP/443 listener on the public-zone probe..."
start_listener "$PUBLIC_ID" 443

run_check "Internal -> Data on 5432 (must succeed)" \
  "$PRIVATE_ID" "timeout 5 nc -zv $DATA_IP 5432" "true"

run_check "Public -> Data on 5432 (must be blocked)" \
  "$PUBLIC_ID" "timeout 5 nc -zv $DATA_IP 5432" "false"

run_check "Private -> internet via NAT (must succeed)" \
  "$PRIVATE_ID" "curl -sS -m 5 -o /dev/null -w '%{http_code}' https://www.amazon.com" "true"

run_check "Data -> internet (must be blocked, no route)" \
  "$DATA_ID" "timeout 5 curl -sS -m 4 https://www.amazon.com" "false"

echo "Internet -> Public probe on 443 (must succeed; run from a host outside the VPC)"
if timeout 5 nc -zv "$PUBLIC_IP" 443 2>&1; then
  echo "PASS: Public instance reachable on 443 from outside"
  pass=$((pass + 1))
else
  echo "FAIL: Public instance not reachable on 443 from outside"
  fail=$((fail + 1))
fi

echo
echo "Results: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
