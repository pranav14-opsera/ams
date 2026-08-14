"""Unit tests for the generic secret-rotation Lambda's dispatch and
version-management logic (the create/set/test/finish four-step lifecycle
and the by-secret_type dispatch table).

The database/cache/broker driver calls inside _apply_*_credential /
_test_*_credential are deliberately NOT exercised against real services
here — psycopg2/redis/kafka-python are Lambda-layer dependencies not
installed in this test environment, and there is no live database, Redis,
or Kafka cluster to rotate credentials against in CI. Those functions are
patched out via the dispatch tables so this suite verifies the rotation
*protocol* (the part entirely within this Lambda's control) is correct,
which is what a unit test can and should cover; actual credential
application against a live service is an integration-test concern (see
WO-003's acceptance criteria: CANNOT_VERIFY without live AWS infra).
"""

import json
import os
import sys
from unittest.mock import MagicMock

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import handler  # noqa: E402


class FakeClientError(Exception):
    pass


class FakeSecretsManagerClient:
    """A minimal in-memory stand-in for the boto3 secretsmanager client,
    just enough surface area to drive the four-step rotation lifecycle
    through realistic state transitions."""

    def __init__(self, initial_value, secret_type):
        self._versions = {"v1": {"stages": {"AWSCURRENT"}, "value": dict(initial_value, secret_type=secret_type)}}
        self.exceptions = MagicMock()
        self.exceptions.ResourceNotFoundException = FakeClientError

    def describe_secret(self, SecretId):
        return {
            "RotationEnabled": True,
            "VersionIdsToStages": {v: sorted(d["stages"]) for v, d in self._versions.items()},
        }

    def get_secret_value(self, SecretId, VersionId=None, VersionStage=None):
        if VersionId is not None:
            version = self._versions.get(VersionId)
            if version is None or VersionStage not in version["stages"]:
                raise FakeClientError(f"no version {VersionId} at stage {VersionStage}")
        else:
            version = next((d for d in self._versions.values() if VersionStage in d["stages"]), None)
            if version is None:
                raise FakeClientError(f"no version at stage {VersionStage}")
        if version["value"] is None:
            # Mirrors real Secrets Manager: a stage marker pre-registered by
            # start_rotation() has no retrievable value until PutSecretValue
            # (createSecret) has actually run.
            raise FakeClientError("no SecretString set for this version yet")
        return {"SecretString": json.dumps(version["value"])}

    def put_secret_value(self, SecretId, ClientRequestToken, SecretString, VersionStages):
        self._versions[ClientRequestToken] = {"stages": set(VersionStages), "value": json.loads(SecretString)}

    def get_random_password(self, **kwargs):
        return {"RandomPassword": "N3wP@ssw0rd-generated"}

    def update_secret_version_stage(self, SecretId, VersionStage, MoveToVersionId, RemoveFromVersionId):
        if RemoveFromVersionId is not None:
            self._versions[RemoveFromVersionId]["stages"].discard(VersionStage)
        self._versions[MoveToVersionId]["stages"].add(VersionStage)

    def current_value(self):
        version = next(d for d in self._versions.values() if "AWSCURRENT" in d["stages"])
        return version["value"]

    def start_rotation(self, token):
        """Simulates what Secrets Manager itself does before invoking a
        rotation Lambda for a new token: pre-registers an empty AWSPENDING
        marker so the version exists in VersionIdsToStages before
        createSecret ever runs."""
        self._versions.setdefault(token, {"stages": set(), "value": None})
        self._versions[token]["stages"].add("AWSPENDING")


@pytest.fixture
def postgres_client():
    return FakeSecretsManagerClient(
        {"host": "db.internal", "port": 5432, "dbname": "ams", "username": "app", "password": "old-pw"},
        "postgres",
    )


def test_full_rotation_lifecycle_promotes_new_password(postgres_client, monkeypatch):
    apply_calls = []
    test_calls = []
    monkeypatch.setitem(handler._APPLY_FUNCTIONS, "postgres", lambda current, pending: apply_calls.append((current, pending)))
    monkeypatch.setitem(handler._TEST_FUNCTIONS, "postgres", lambda pending: test_calls.append(pending))

    arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ams/dev/database-credentials"
    token = "new-version-token"
    postgres_client.start_rotation(token)

    handler.rotate(postgres_client, {"SecretId": arn, "ClientRequestToken": token, "Step": "createSecret"})
    handler.rotate(postgres_client, {"SecretId": arn, "ClientRequestToken": token, "Step": "setSecret"})
    handler.rotate(postgres_client, {"SecretId": arn, "ClientRequestToken": token, "Step": "testSecret"})
    handler.rotate(postgres_client, {"SecretId": arn, "ClientRequestToken": token, "Step": "finishSecret"})

    assert postgres_client.current_value()["password"] == "N3wP@ssw0rd-generated"
    assert postgres_client.current_value()["host"] == "db.internal"  # non-secret fields preserved
    assert len(apply_calls) == 1
    current_arg, pending_arg = apply_calls[0]
    assert current_arg["password"] == "old-pw"
    assert pending_arg["password"] == "N3wP@ssw0rd-generated"
    assert len(test_calls) == 1
    assert test_calls[0]["password"] == "N3wP@ssw0rd-generated"


def test_create_secret_is_idempotent(postgres_client):
    arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ams/dev/database-credentials"
    token = "retry-token"
    postgres_client.start_rotation(token)

    handler.rotate(postgres_client, {"SecretId": arn, "ClientRequestToken": token, "Step": "createSecret"})
    first_pending = postgres_client._versions[token]["value"]["password"]

    # Retried createSecret (e.g. after a Lambda timeout) must not generate a
    # second, different password for the same pending version.
    handler.rotate(postgres_client, {"SecretId": arn, "ClientRequestToken": token, "Step": "createSecret"})
    second_pending = postgres_client._versions[token]["value"]["password"]

    assert first_pending == second_pending


def test_finish_secret_is_idempotent_when_already_current(postgres_client):
    arn = "arn:aws:secretsmanager:us-east-1:123456789012:secret:ams/dev/database-credentials"

    # v1 is already AWSCURRENT; finishing on it again must be a safe no-op,
    # not attempt to remove AWSCURRENT from itself.
    handler.rotate(postgres_client, {"SecretId": arn, "ClientRequestToken": "v1", "Step": "finishSecret"})

    assert postgres_client.describe_secret(SecretId=arn)["VersionIdsToStages"]["v1"] == ["AWSCURRENT"]


def test_unknown_secret_type_raises_clear_error():
    client = FakeSecretsManagerClient({"host": "x"}, "mongodb")
    arn = "arn:secret"
    token = "t1"
    client.start_rotation(token)

    with pytest.raises(ValueError, match="Unknown secret_type"):
        handler.rotate(client, {"SecretId": arn, "ClientRequestToken": token, "Step": "createSecret"})


def test_rotation_rejected_if_not_enabled():
    client = FakeSecretsManagerClient({"host": "x"}, "postgres")
    client.describe_secret = lambda SecretId: {"RotationEnabled": False, "VersionIdsToStages": {}}

    with pytest.raises(ValueError, match="not enabled for rotation"):
        handler.rotate(client, {"SecretId": "arn:secret", "ClientRequestToken": "t1", "Step": "createSecret"})


def test_password_field_mapping_covers_all_secret_types():
    assert handler._password_field("postgres") == "password"
    assert handler._password_field("redis") == "auth_token"
    assert handler._password_field("kafka_scram") == "password"
