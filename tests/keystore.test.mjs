import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const { createKeyStore } = await import("../dist/keystore.js");

/** Fresh sqlite-backed store on a unique temp path, already init()'d. */
async function freshStore() {
  const path = join(tmpdir(), `udm-keystore-${randomUUID()}.db`);
  const store = createKeyStore({ backend: "sqlite", sqlitePath: path });
  await store.init();
  return store;
}

// ---------------------------------------------------------------------------
// SQLite keystore backend
// ---------------------------------------------------------------------------

test("create: returns a udm_live_ secret and a matching record", async () => {
  const store = await freshStore();
  try {
    const { record, secret } = await store.create({
      name: "ci-bot",
      owner: "alice@example.com",
      tools: ["grafana", "datadog"],
      allowWrites: true,
    });
    assert.match(secret, /^udm_live_/);
    assert.equal(record.name, "ci-bot");
    assert.equal(record.owner, "alice@example.com");
    assert.deepEqual(record.tools, ["grafana", "datadog"]);
    assert.equal(record.allowWrites, true);
    assert.equal(record.revoked, false);
    assert.ok(record.id);
    assert.ok(record.createdAt);
  } finally {
    await store.close();
  }
});

test("verify: valid secret returns a KeyIdentity mirroring the record", async () => {
  const store = await freshStore();
  try {
    const { record, secret } = await store.create({
      name: "reader",
      owner: "bob@example.com",
      tools: ["jira"],
      allowWrites: false,
    });
    const identity = await store.verify(secret);
    assert.ok(identity);
    assert.equal(identity.name, record.name);
    assert.deepEqual(identity.tools, record.tools);
    assert.equal(identity.allowWrites, record.allowWrites);
  } finally {
    await store.close();
  }
});

test("verify: wrong/garbage secret returns undefined", async () => {
  const store = await freshStore();
  try {
    await store.create({ name: "k", owner: "carol@example.com", allowWrites: false });
    assert.equal(await store.verify("udm_live_not-a-real-secret"), undefined);
    assert.equal(await store.verify("totally-garbage"), undefined);
    assert.equal(await store.verify(""), undefined);
  } finally {
    await store.close();
  }
});

test("verify: after revoke by the owner the secret no longer verifies", async () => {
  const store = await freshStore();
  try {
    const { record, secret } = await store.create({
      name: "to-revoke",
      owner: "dave@example.com",
      allowWrites: true,
    });
    assert.ok(await store.verify(secret));
    assert.equal(await store.revoke(record.id, "dave@example.com"), true);
    assert.equal(await store.verify(secret), undefined);
  } finally {
    await store.close();
  }
});

test("verify: an expired key is rejected", async () => {
  const store = await freshStore();
  try {
    const past = new Date(Date.now() - 60_000).toISOString();
    const { secret } = await store.create({
      name: "expired",
      owner: "erin@example.com",
      allowWrites: false,
      expiresAt: past,
    });
    assert.equal(await store.verify(secret), undefined);
  } finally {
    await store.close();
  }
});

test("listByOwner: returns records without exposing secret or hash", async () => {
  const store = await freshStore();
  try {
    const owner = "frank@example.com";
    const { record } = await store.create({ name: "one", owner, tools: ["helm"], allowWrites: true });
    // A key owned by someone else must not appear.
    await store.create({ name: "other", owner: "someone-else@example.com", allowWrites: false });

    const list = await store.listByOwner(owner);
    assert.equal(list.length, 1);
    const [row] = list;
    assert.equal(row.id, record.id);
    assert.equal(row.name, "one");
    assert.equal(row.owner, owner);
    // No secret material of any kind must leak into the listing.
    assert.equal("secret" in row, false);
    assert.equal("hash" in row, false);
    for (const value of Object.values(row)) {
      assert.equal(typeof value === "string" && value.startsWith("udm_live_"), false);
    }
  } finally {
    await store.close();
  }
});

test("revoke: a non-owner cannot revoke; the key stays usable", async () => {
  const store = await freshStore();
  try {
    const { record, secret } = await store.create({
      name: "guarded",
      owner: "grace@example.com",
      allowWrites: true,
    });
    assert.equal(await store.revoke(record.id, "attacker@example.com"), false);
    // Still valid — the bad-owner revoke was a no-op.
    assert.ok(await store.verify(secret));
    const [row] = await store.listByOwner("grace@example.com");
    assert.equal(row.revoked, false);
  } finally {
    await store.close();
  }
});
