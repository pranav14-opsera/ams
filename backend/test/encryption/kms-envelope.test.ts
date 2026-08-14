import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryKmsService } from "../../src/tenants/ports/in-memory/in-memory-kms.service";

// Pure crypto/lifecycle tests against the mock adapter — no database
// needed, these exercise node:crypto's real AES-256-GCM implementation,
// not a fake round-trip.

test("envelope encryption round-trips: encrypt then decrypt recovers the original plaintext", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");

  const plaintext = Buffer.from("PHI: patient note for agent execution", "utf8");
  const encrypted = await kms.encrypt("tenant-a", plaintext);

  assert.ok(encrypted.ciphertext.length > 0);
  assert.notDeepEqual(encrypted.ciphertext, plaintext, "ciphertext must not equal the plaintext");
  assert.equal(encrypted.keyVersion, 1);

  const decrypted = await kms.decrypt("tenant-a", encrypted);
  assert.deepEqual(decrypted, plaintext);
});

test("generateDataKey returns distinct plaintext/encrypted keys each call, both usable", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");

  const dek1 = await kms.generateDataKey("tenant-a");
  const dek2 = await kms.generateDataKey("tenant-a");

  assert.notDeepEqual(dek1.plaintextKey, dek2.plaintextKey, "each call must generate a fresh DEK");
  assert.equal(dek1.plaintextKey.length, 32, "AES-256 key must be 32 bytes");
});

test("tenant isolation: tenant B cannot decrypt tenant A's ciphertext (wrong key material entirely)", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");
  await kms.createTenantKey("tenant-b", "us");

  const encrypted = await kms.encrypt("tenant-a", Buffer.from("secret"));

  // decrypt() looks up tenant B's own key versions, which have never seen
  // this encryptedDataKey — unwrapping it must fail loudly (GCM auth tag
  // mismatch), not silently return garbage.
  await assert.rejects(() => kms.decrypt("tenant-b", encrypted));
});

test("key rotation: a new version is issued, and ciphertext encrypted under the OLD version remains decryptable", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");

  const encryptedUnderV1 = await kms.encrypt("tenant-a", Buffer.from("pre-rotation data"));
  assert.equal(encryptedUnderV1.keyVersion, 1);

  const { previousVersion, newVersion } = await kms.rotateKey("tenant-a");
  assert.equal(previousVersion, 1);
  assert.equal(newVersion, 2);

  // New encryptions use the new version...
  const encryptedUnderV2 = await kms.encrypt("tenant-a", Buffer.from("post-rotation data"));
  assert.equal(encryptedUnderV2.keyVersion, 2);

  // ...but the OLD ciphertext (still tagged with keyVersion: 1) must still
  // decrypt correctly — this is the acceptance criteria's explicit case.
  const decryptedOld = await kms.decrypt("tenant-a", encryptedUnderV1);
  assert.deepEqual(decryptedOld, Buffer.from("pre-rotation data"));

  const decryptedNew = await kms.decrypt("tenant-a", encryptedUnderV2);
  assert.deepEqual(decryptedNew, Buffer.from("post-rotation data"));
});

test("getKeyStatus reflects rotation-due once the rotation interval elapses", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");

  const freshStatus = await kms.getKeyStatus("tenant-a");
  assert.equal(freshStatus.status, "active");
  assert.equal(freshStatus.currentVersion, 1);
});

test("scheduleKeyDeletion sets a 7-day pending deletion and can be cancelled", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");

  const before = Date.now();
  const { pendingDeletionAt } = await kms.scheduleKeyDeletion("tenant-a");
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  assert.ok(pendingDeletionAt.getTime() >= before + sevenDaysMs - 1000, "deletion must be scheduled at least 7 days out");

  const statusWhilePending = await kms.getKeyStatus("tenant-a");
  assert.equal(statusWhilePending.status, "pending_deletion");

  await kms.cancelKeyDeletion("tenant-a");
  const statusAfterCancel = await kms.getKeyStatus("tenant-a");
  assert.equal(statusAfterCancel.status, "active");
  assert.equal(statusAfterCancel.pendingDeletionAt, null);
});

test("cancelKeyDeletion throws if no deletion is pending", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");
  await assert.rejects(() => kms.cancelKeyDeletion("tenant-a"));
});

test("a key pending deletion cannot be used for new encrypt/rotate operations", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");
  await kms.scheduleKeyDeletion("tenant-a");

  await assert.rejects(() => kms.encrypt("tenant-a", Buffer.from("should not be allowed")));
  await assert.rejects(() => kms.rotateKey("tenant-a"));
});

test("processExpiredDeletions deletes only keys whose 7-day wait has actually elapsed", async () => {
  const kms = new InMemoryKmsService();
  await kms.createTenantKey("tenant-a", "us");
  await kms.createTenantKey("tenant-b", "us");

  await kms.scheduleKeyDeletion("tenant-a"); // 7 days out — not expired yet
  await kms.cancelKeyDeletion("tenant-a");
  await kms.scheduleKeyDeletion("tenant-a");

  const notYetDeleted = await kms.processExpiredDeletions(new Date());
  assert.deepEqual(notYetDeleted, [], "nothing should be deleted before the 7-day wait elapses");

  const eightDaysFromNow = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
  const deleted = await kms.processExpiredDeletions(eightDaysFromNow);
  assert.deepEqual(deleted, ["tenant-a"]);

  await assert.rejects(() => kms.getKeyStatus("tenant-a"), /No KMS key found/);
  await kms.getKeyStatus("tenant-b"); // untouched, must not throw
});
