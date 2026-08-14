"""JWT signing key rotation.

Triggered on a schedule (see jwt-signing.tf). Each invocation:
  1. Creates a new KMS asymmetric SIGN_VERIFY key (the next generation).
  2. Points the "previous" alias at whatever key "current" points to right
     now (so tokens signed under the outgoing key keep verifying).
  3. Points "current" at the newly created key.
  4. Schedules deletion of the generation that was "previous" *before* this
     rotation ran (it has now had its full overlap window and is no longer
     referenced by either alias).

AWS KMS has no automatic rotation for asymmetric keys, so this rotation is
entirely our own responsibility to run correctly, including not deleting a
key that's still within its overlap window.
"""

import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def lambda_handler(event, context):
    kms = boto3.client("kms")

    current_alias = os.environ["CURRENT_ALIAS_NAME"]
    previous_alias = os.environ["PREVIOUS_ALIAS_NAME"]
    key_spec = os.environ.get("KEY_SPEC", "RSA_2048")
    overlap_days = int(os.environ.get("OVERLAP_DAYS", "7"))
    name_prefix = os.environ.get("NAME_PREFIX", "ams")
    environment = os.environ.get("ENVIRONMENT", "prod")

    return rotate(kms, current_alias, previous_alias, key_spec, overlap_days, name_prefix, environment)


def rotate(kms, current_alias, previous_alias, key_spec, overlap_days, name_prefix, environment):
    outgoing_current_key_id = _resolve_alias_target(kms, current_alias)
    outgoing_previous_key_id = _resolve_alias_target(kms, previous_alias)

    next_generation = _next_generation_number(kms, outgoing_current_key_id)

    new_key = kms.create_key(
        Description=f"{name_prefix}-{environment} JWT signing key (generation {next_generation})",
        KeyUsage="SIGN_VERIFY",
        CustomerMasterKeySpec=key_spec,
        Tags=[
            {"TagKey": "Project", "TagValue": name_prefix},
            {"TagKey": "Environment", "TagValue": environment},
            {"TagKey": "ManagedBy", "TagValue": "jwt-rotation-lambda"},
            {"TagKey": "Generation", "TagValue": str(next_generation)},
        ],
    )
    new_key_id = new_key["KeyMetadata"]["KeyId"]
    logger.info("Created new JWT signing key generation %s: %s", next_generation, new_key_id)

    # "previous" must move to the outgoing "current" key BEFORE "current"
    # moves to the new key, so there is never a moment where a token signed
    # moments ago under the outgoing key can't be verified via either alias.
    kms.update_alias(AliasName=previous_alias, TargetKeyId=outgoing_current_key_id)
    kms.update_alias(AliasName=current_alias, TargetKeyId=new_key_id)
    logger.info(
        "Rotated aliases: %s -> %s, %s -> %s",
        previous_alias, outgoing_current_key_id, current_alias, new_key_id,
    )

    deleted_key_id = None
    if outgoing_previous_key_id != outgoing_current_key_id:
        # The key that was "previous" before this rotation has now had its
        # full overlap window (it stopped being "current" one full rotation
        # period ago, i.e. >= overlap_days if the schedule and overlap are
        # configured sanely) and is no longer referenced by either alias —
        # safe to schedule for deletion.
        kms.schedule_key_deletion(KeyId=outgoing_previous_key_id, PendingWindowInDays=max(overlap_days, 7))
        deleted_key_id = outgoing_previous_key_id
        logger.info("Scheduled deletion of retired key %s (%s-day window)", deleted_key_id, max(overlap_days, 7))
    else:
        logger.info("No prior generation to retire yet (this is the first rotation)")

    return {
        "new_key_id": new_key_id,
        "new_generation": next_generation,
        "previous_key_id": outgoing_current_key_id,
        "scheduled_for_deletion": deleted_key_id,
    }


def _resolve_alias_target(kms, alias_name):
    paginator = kms.get_paginator("list_aliases")
    for page in paginator.paginate():
        for alias in page["Aliases"]:
            if alias["AliasName"] == alias_name:
                return alias["TargetKeyId"]
    raise ValueError(f"Alias {alias_name} not found — expected Terraform to have created it")


def _next_generation_number(kms, key_id):
    tags = kms.list_resource_tags(KeyId=key_id).get("Tags", [])
    for tag in tags:
        if tag["TagKey"] == "Generation":
            return int(tag["TagValue"]) + 1
    return 2
