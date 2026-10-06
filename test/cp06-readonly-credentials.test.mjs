import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Cp06AuthBlockedError,
  Cp06ReadOnlyCredentialStore,
} from "../scripts/cp06-readonly-credentials.mjs";

const providerId = "openai-codex";

async function withCredential(credential, action) {
  const root = await mkdtemp(join(tmpdir(), "factory-cp06-credential-store-"));
  const path = join(root, "DUMMY-auth.json");
  await writeFile(
    path,
    `${JSON.stringify({
      [providerId]: credential,
      "ignored-provider": { type: "api_key", key: "DUMMY-IGNORED" },
    })}\n`,
    { mode: 0o600 },
  );
  try {
    return await action({ path, root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function oauth(expires) {
  return {
    type: "oauth",
    access: "DUMMY-ACCESS",
    refresh: "DUMMY-REFRESH",
    expires,
  };
}

for (const [name, expires] of [
  ["expired", 0],
  ["near-expiry", 1_060_000],
]) {
  test(`${name} OAuth is rejected before refresh callback and persistence`, async () => {
    await withCredential(oauth(expires), async ({ path }) => {
      const before = await readFile(path);
      const store = await Cp06ReadOnlyCredentialStore.load({ path, providerId });
      assert.throws(
        () => store.assertUsableOAuth({ now: 1_000_000, minValidityMs: 300_000 }),
        Cp06AuthBlockedError,
      );
      let callbackCalls = 0;
      await assert.rejects(
        store.modify(providerId, async () => {
          callbackCalls += 1;
          return oauth(9_999_999);
        }),
        Cp06AuthBlockedError,
      );
      assert.equal(callbackCalls, 0);
      assert.deepEqual(await readFile(path), before);
      assert.deepEqual(store.audit(), {
        reads: 0,
        lists: 0,
        modify_denials: 1,
        delete_denials: 0,
      });
    });
  });
}

test("unexpired OAuth resolves from a clone without mutation", async () => {
  await withCredential(oauth(2_000_000), async ({ path }) => {
    const before = await readFile(path);
    const store = await Cp06ReadOnlyCredentialStore.load({ path, providerId });
    const info = store.assertUsableOAuth({ now: 1_000_000, minValidityMs: 300_000 });
    assert.equal(info.remainingValidityMs, 1_000_000);
    const credential = await store.read(providerId);
    credential.access = "DUMMY-MUTATED-CLONE";
    assert.equal((await store.read(providerId)).access, "DUMMY-ACCESS");
    assert.equal(await store.read("ignored-provider"), undefined);
    assert.deepEqual(await store.list(), [{ providerId, type: "oauth" }]);
    assert.deepEqual(await readFile(path), before);
  });
});

test("delete is denied without persistence", async () => {
  await withCredential(oauth(2_000_000), async ({ path }) => {
    const before = await readFile(path);
    const store = await Cp06ReadOnlyCredentialStore.load({ path, providerId });
    await assert.rejects(store.delete(providerId), Cp06AuthBlockedError);
    assert.deepEqual(await readFile(path), before);
    assert.equal(store.audit().delete_denials, 1);
  });
});

test("credential store rejects API keys, malformed OAuth, symlinks, and oversized files", async () => {
  await withCredential({ type: "api_key", key: "DUMMY" }, async ({ path, root }) => {
    await assert.rejects(
      Cp06ReadOnlyCredentialStore.load({ path, providerId }),
      Cp06AuthBlockedError,
    );
    const link = join(root, "DUMMY-link.json");
    await symlink(path, link);
    await assert.rejects(
      Cp06ReadOnlyCredentialStore.load({ path: link, providerId }),
      Cp06AuthBlockedError,
    );
    const large = join(root, "DUMMY-large.json");
    await writeFile(large, "x".repeat(1025));
    await assert.rejects(
      Cp06ReadOnlyCredentialStore.load({ path: large, providerId, maxBytes: 1024 }),
      Cp06AuthBlockedError,
    );
  });

  await withCredential(
    { type: "oauth", access: "DUMMY", refresh: "DUMMY", expires: "later" },
    async ({ path }) => {
      await assert.rejects(
        Cp06ReadOnlyCredentialStore.load({ path, providerId }),
        Cp06AuthBlockedError,
      );
    },
  );
});
