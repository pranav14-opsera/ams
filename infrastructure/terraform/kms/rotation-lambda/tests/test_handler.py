"""Unit tests for the JWT signing key rotation Lambda, run against a mocked
KMS backend (moto) — no real AWS account or credentials required."""

import os
import sys

import boto3
import pytest
from moto import mock_aws

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import handler  # noqa: E402


CURRENT_ALIAS = "alias/ams-dev-jwt-signing-current"
PREVIOUS_ALIAS = "alias/ams-dev-jwt-signing-previous"


@pytest.fixture
def kms():
    with mock_aws():
        client = boto3.client("kms", region_name="us-east-1")
        yield client


def _create_gen1_key(kms):
    key = kms.create_key(
        Description="ams-dev JWT signing key (generation 1)",
        KeyUsage="SIGN_VERIFY",
        CustomerMasterKeySpec="RSA_2048",
        Tags=[{"TagKey": "Generation", "TagValue": "1"}],
    )
    key_id = key["KeyMetadata"]["KeyId"]
    kms.create_alias(AliasName=CURRENT_ALIAS, TargetKeyId=key_id)
    kms.create_alias(AliasName=PREVIOUS_ALIAS, TargetKeyId=key_id)
    return key_id


def test_first_rotation_creates_generation_2_and_does_not_delete_anything(kms):
    gen1_key_id = _create_gen1_key(kms)

    result = handler.rotate(kms, CURRENT_ALIAS, PREVIOUS_ALIAS, "RSA_2048", 7, "ams", "dev")

    assert result["new_generation"] == 2
    assert result["previous_key_id"] == gen1_key_id
    assert result["scheduled_for_deletion"] is None  # first rotation: nothing to retire yet

    current_target = kms.list_aliases()["Aliases"]
    current = next(a for a in current_target if a["AliasName"] == CURRENT_ALIAS)
    previous = next(a for a in current_target if a["AliasName"] == PREVIOUS_ALIAS)
    assert current["TargetKeyId"] == result["new_key_id"]
    assert previous["TargetKeyId"] == gen1_key_id


def test_second_rotation_retires_generation_1(kms):
    gen1_key_id = _create_gen1_key(kms)
    first = handler.rotate(kms, CURRENT_ALIAS, PREVIOUS_ALIAS, "RSA_2048", 7, "ams", "dev")
    gen2_key_id = first["new_key_id"]

    second = handler.rotate(kms, CURRENT_ALIAS, PREVIOUS_ALIAS, "RSA_2048", 7, "ams", "dev")

    assert second["new_generation"] == 3
    assert second["previous_key_id"] == gen2_key_id
    assert second["scheduled_for_deletion"] == gen1_key_id

    gen1_description = kms.describe_key(KeyId=gen1_key_id)["KeyMetadata"]
    assert gen1_description["KeyState"] == "PendingDeletion"


def test_rotation_never_deletes_the_key_still_referenced_by_current_or_previous(kms):
    _create_gen1_key(kms)

    for _ in range(3):
        handler.rotate(kms, CURRENT_ALIAS, PREVIOUS_ALIAS, "RSA_2048", 7, "ams", "dev")

    current_key_id = handler._resolve_alias_target(kms, CURRENT_ALIAS)
    previous_key_id = handler._resolve_alias_target(kms, PREVIOUS_ALIAS)

    for key_id in (current_key_id, previous_key_id):
        state = kms.describe_key(KeyId=key_id)["KeyMetadata"]["KeyState"]
        assert state != "PendingDeletion"


def test_missing_alias_raises_clear_error(kms):
    with pytest.raises(ValueError, match="not found"):
        handler._resolve_alias_target(kms, "alias/does-not-exist")
