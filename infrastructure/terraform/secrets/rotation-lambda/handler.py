"""Generic Secrets Manager rotation Lambda, implementing AWS's standard
four-step rotation lifecycle (createSecret / setSecret / testSecret /
finishSecret) and dispatching the "apply new credential to the live
service" and "verify it works" steps by the secret's `secret_type`
(postgres / redis / kafka_scram — see infrastructure/terraform/secrets/
variables.tf's managed_secrets map).

Reference: https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotate-secrets_lambda-function-overview.html

The driver libraries (psycopg2, redis, kafka-python) are imported lazily
inside each type-specific function rather than at module load time, so a
single Lambda deployment package doesn't need every driver bundled if only
some secret types are in use — whichever drivers a given deployment's
managed_secrets actually needs must be included in a Lambda layer attached
alongside this function.
"""

import json
import logging
import os

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))


def lambda_handler(event, context):
    import boto3

    service_client = boto3.client("secretsmanager", endpoint_url=os.environ.get("SECRETS_MANAGER_ENDPOINT"))
    return rotate(service_client, event)


def rotate(service_client, event):
    arn = event["SecretId"]
    token = event["ClientRequestToken"]
    step = event["Step"]

    metadata = service_client.describe_secret(SecretId=arn)
    if not metadata.get("RotationEnabled", False):
        raise ValueError(f"Secret {arn} is not enabled for rotation")

    versions = metadata["VersionIdsToStages"]
    if token not in versions:
        raise ValueError(f"Secret version {token} has no stage for rotation of secret {arn}")
    if "AWSCURRENT" in versions[token]:
        logger.info("Secret version %s already marked AWSCURRENT — nothing to do", token)
        return
    if "AWSPENDING" not in versions[token]:
        raise ValueError(f"Secret version {token} not set as AWSPENDING for rotation of secret {arn}")

    steps = {
        "createSecret": create_secret,
        "setSecret": set_secret,
        "testSecret": test_secret,
        "finishSecret": finish_secret,
    }
    step_fn = steps.get(step)
    if step_fn is None:
        raise ValueError(f"Invalid rotation step: {step}")
    return step_fn(service_client, arn, token)


def create_secret(service_client, arn, token):
    """Generate a new credential value and store it as the AWSPENDING version,
    preserving every other field (host, port, username, etc.) from AWSCURRENT."""
    try:
        service_client.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")
        logger.info("createSecret: AWSPENDING version %s already exists, skipping", token)
        return
    except service_client.exceptions.ResourceNotFoundException:
        pass

    current = json.loads(service_client.get_secret_value(SecretId=arn, VersionStage="AWSCURRENT")["SecretString"])
    secret_type = current["secret_type"]

    new_password = service_client.get_random_password(
        ExcludeCharacters='"@/\\\'`', PasswordLength=32, ExcludePunctuation=False
    )["RandomPassword"]

    pending = dict(current)
    pending[_password_field(secret_type)] = new_password

    service_client.put_secret_value(
        SecretId=arn,
        ClientRequestToken=token,
        SecretString=json.dumps(pending),
        VersionStages=["AWSPENDING"],
    )
    logger.info("createSecret: staged new %s credential as AWSPENDING", secret_type)


def set_secret(service_client, arn, token):
    """Apply the AWSPENDING credential to the live database/cache/broker.
    Authenticates with the still-valid AWSCURRENT credential to set the new
    AWSPENDING one — the pending version never carries the old credential
    itself, only its own new value."""
    current = json.loads(service_client.get_secret_value(SecretId=arn, VersionStage="AWSCURRENT")["SecretString"])
    pending = json.loads(service_client.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")["SecretString"])
    _dispatch(pending["secret_type"], _APPLY_FUNCTIONS)(current, pending)
    logger.info("setSecret: applied new %s credential to the live service", pending["secret_type"])


def test_secret(service_client, arn, token):
    """Verify the AWSPENDING credential actually authenticates."""
    pending = json.loads(service_client.get_secret_value(SecretId=arn, VersionId=token, VersionStage="AWSPENDING")["SecretString"])
    _dispatch(pending["secret_type"], _TEST_FUNCTIONS)(pending)
    logger.info("testSecret: verified new %s credential authenticates", pending["secret_type"])


def finish_secret(service_client, arn, token):
    """Promote AWSPENDING to AWSCURRENT, demoting the version that was
    AWSCURRENT (Secrets Manager keeps it as AWSPREVIOUS automatically)."""
    metadata = service_client.describe_secret(SecretId=arn)
    current_version_id = None
    for version_id, stages in metadata["VersionIdsToStages"].items():
        if "AWSCURRENT" in stages:
            if version_id == token:
                logger.info("finishSecret: version %s already AWSCURRENT", token)
                return
            current_version_id = version_id
            break

    service_client.update_secret_version_stage(
        SecretId=arn,
        VersionStage="AWSCURRENT",
        MoveToVersionId=token,
        RemoveFromVersionId=current_version_id,
    )
    logger.info("finishSecret: promoted %s to AWSCURRENT (was %s)", token, current_version_id)


def _dispatch(secret_type, table):
    fn = table.get(secret_type)
    if fn is None:
        raise ValueError(f"Unknown secret_type: {secret_type!r} — expected one of {sorted(table)}")
    return fn


_PASSWORD_FIELDS = {
    "postgres": "password",
    "redis": "auth_token",
    "kafka_scram": "password",
}


def _password_field(secret_type):
    field = _PASSWORD_FIELDS.get(secret_type)
    if field is None:
        raise ValueError(f"Unknown secret_type: {secret_type!r} — expected one of {sorted(_PASSWORD_FIELDS)}")
    return field


# --- Type-specific apply/test functions ------------------------------------
# Each connects with the CURRENT credential (still valid — it hasn't been
# demoted yet) and uses it to set the PENDING credential on the live
# service, then re-tests by connecting with the PENDING credential.

def _apply_postgres_credential(current, pending):
    import psycopg2  # Lambda layer dependency — see module docstring

    conn = psycopg2.connect(
        host=current["host"], port=current["port"], dbname=current["dbname"],
        user=current["username"], password=current["password"],
        connect_timeout=10,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                'ALTER USER "%s" WITH PASSWORD %%s' % pending["username"],
                (pending["password"],),
            )
        conn.commit()
    finally:
        conn.close()


def _test_postgres_credential(pending):
    import psycopg2

    conn = psycopg2.connect(
        host=pending["host"], port=pending["port"], dbname=pending["dbname"],
        user=pending["username"], password=pending["password"],
        connect_timeout=10,
    )
    conn.close()


def _apply_redis_credential(current, pending):
    import redis

    client = redis.Redis(
        host=current["host"], port=current["port"],
        password=current["auth_token"], ssl=True, socket_timeout=10,
    )
    client.config_set("requirepass", pending["auth_token"])


def _test_redis_credential(pending):
    import redis

    client = redis.Redis(
        host=pending["host"], port=pending["port"],
        password=pending["auth_token"], ssl=True, socket_timeout=10,
    )
    client.ping()


def _apply_kafka_credential(current, pending):
    from kafka.admin import KafkaAdminClient
    from kafka.admin import ConfigResource, ConfigResourceType

    admin = KafkaAdminClient(
        bootstrap_servers=current["bootstrap_servers"],
        security_protocol="SASL_SSL",
        sasl_mechanism="SCRAM-SHA-512",
        sasl_plain_username=current["username"],
        sasl_plain_password=current["password"],
    )
    try:
        resource = ConfigResource(ConfigResourceType.BROKER, "")
        admin.alter_configs({resource: {f"scram-sha-512={pending['username']}": pending["password"]}})
    finally:
        admin.close()


def _test_kafka_credential(pending):
    from kafka import KafkaAdminClient

    admin = KafkaAdminClient(
        bootstrap_servers=pending["bootstrap_servers"],
        security_protocol="SASL_SSL",
        sasl_mechanism="SCRAM-SHA-512",
        sasl_plain_username=pending["username"],
        sasl_plain_password=pending["password"],
    )
    admin.close()


_APPLY_FUNCTIONS = {
    "postgres": _apply_postgres_credential,
    "redis": _apply_redis_credential,
    "kafka_scram": _apply_kafka_credential,
}

_TEST_FUNCTIONS = {
    "postgres": _test_postgres_credential,
    "redis": _test_redis_credential,
    "kafka_scram": _test_kafka_credential,
}
