# WO-002 connectivity integration test

Provisions one tiny (`t3.micro`) EC2 instance per subnet tier and verifies the
security-group/routing rules with real TCP handshakes, per WO-002's
`testing_strategy`. Requires a live AWS account — this is **not** run as part
of the offline `terraform test` suite in the parent directory.

## Run

```bash
cd infrastructure/terraform/networking/tests/integration
terraform init
terraform apply

# Wait ~2 minutes for the SSM agent to register, then:
./run_connectivity_checks.sh

terraform destroy   # tear down — these instances cost money while running
```

Requires the AWS CLI configured with credentials that can create EC2/IAM/SSM
resources, and `nc`/`curl` on the machine running the script.

## What it checks

| # | Check | Expected |
|---|-------|----------|
| 1 | Internal probe -> Data probe on 5432 | Succeeds |
| 2 | Public probe -> Data probe on 5432 | Blocked |
| 3 | Private probe -> internet (via NAT) | Succeeds |
| 4 | Data probe -> internet | Blocked (no route out of the data subnets) |
| 5 | Internet -> Public probe on 443 | Succeeds |

No SSH keys or bastion host are used — connectivity commands run via SSM Run
Command (`AmazonSSMManagedInstanceCore` on the instance role), except the
final internet-to-public-probe check, which runs directly from the machine
invoking the script.
