import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAuthIsolationFixture } from "./fixtures/workflow/critical-auth-isolation.js";
import { handleProfileRequest } from "./fixtures/workflow/normal-api.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("normal API fixture preserves successful profile behavior", () => {
  assert.deepEqual(handleProfileRequest({ method: "GET", path: "/v1/profile" }), {
    status: 200,
    body: { display_name: "Fixture User" },
  });
  assert.deepEqual(
    handleProfileRequest({
      method: "PUT",
      path: "/v1/profile",
      body: JSON.stringify({ display_name: " Updated Name " }),
    }),
    { status: 200, body: { display_name: "Updated Name" } },
  );
});

test("normal API fixture rejects malformed, invalid, unknown, and unsupported requests", () => {
  assert.deepEqual(handleProfileRequest({ method: "PUT", path: "/v1/profile", body: "not-json" }), {
    status: 400,
    body: { error: "invalid_json" },
  });
  assert.deepEqual(
    handleProfileRequest({
      method: "PUT",
      path: "/v1/profile",
      body: JSON.stringify({ display_name: "  " }),
    }),
    { status: 400, body: { error: "invalid_profile" } },
  );
  assert.equal(handleProfileRequest({ method: "GET", path: "/v1/missing" }).status, 404);
  assert.equal(handleProfileRequest({ method: "POST", path: "/v1/profile" }).status, 405);
});

test("retained P-07 finding fails before repair and passes through the final API", () => {
  const before = spawnSync(
    process.execPath,
    ["test/fixtures/workflow/history/malformed-json-probe.mjs"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(before.status, 1, before.stdout + before.stderr);
  assert.match(before.stdout + before.stderr, /SyntaxError/);
  assert.deepEqual(handleProfileRequest({ method: "PUT", path: "/v1/profile", body: "not-json" }), {
    status: 400,
    body: { error: "invalid_json" },
  });
});

test("critical auth fixture allows each account to observe its own item", () => {
  const api = createAuthIsolationFixture();
  assert.deepEqual(api.request({ token: "fixture-token-a", method: "GET", itemId: "item-a" }), {
    status: 200,
    body: { id: "item-a", title: "Private A" },
  });
  assert.deepEqual(api.request({ token: "fixture-token-b", method: "GET", itemId: "item-b" }), {
    status: 200,
    body: { id: "item-b", title: "Private B" },
  });
});

test("critical auth fixture rejects absent and forged fixture credentials", () => {
  const api = createAuthIsolationFixture();
  assert.equal(api.request({ method: "GET", itemId: "item-a" }).status, 401);
  assert.equal(
    api.request({ token: "not-a-fixture-principal", method: "GET", itemId: "item-a" }).status,
    401,
  );
});

test("critical auth fixture conceals and preserves another account's item", () => {
  const api = createAuthIsolationFixture();
  const before = api.snapshot();

  assert.equal(
    api.request({ token: "fixture-token-b", method: "GET", itemId: "item-a" }).status,
    404,
  );
  assert.equal(
    api.request({
      token: "fixture-token-b",
      method: "PUT",
      itemId: "item-a",
      title: "Stolen",
      requestedOwner: "account-b",
    }).status,
    404,
  );
  assert.equal(
    api.request({ token: "fixture-token-b", method: "DELETE", itemId: "item-a" }).status,
    404,
  );
  assert.deepEqual(api.snapshot(), before);
});

test("critical auth fixture prevents cross-tenant identifier collision probes", () => {
  const api = createAuthIsolationFixture();
  const accountABefore = api
    .snapshot()
    .find((item) => item.owner === "account-a" && item.id === "item-a");

  assert.deepEqual(
    api.request({
      token: "fixture-token-b",
      method: "POST",
      itemId: "item-a",
      title: "Private B with tenant-local id",
    }),
    { status: 201, body: { id: "item-a", title: "Private B with tenant-local id" } },
  );
  assert.deepEqual(api.request({ token: "fixture-token-a", method: "GET", itemId: "item-a" }), {
    status: 200,
    body: { id: "item-a", title: "Private A" },
  });
  assert.deepEqual(api.request({ token: "fixture-token-b", method: "GET", itemId: "item-a" }), {
    status: 200,
    body: { id: "item-a", title: "Private B with tenant-local id" },
  });
  assert.deepEqual(
    api.snapshot().find((item) => item.owner === "account-a" && item.id === "item-a"),
    accountABefore,
  );
});

test("critical auth fixture validates title before tenant-local collision state", () => {
  const api = createAuthIsolationFixture();
  const before = api.snapshot();

  assert.deepEqual(
    api.request({ token: "fixture-token-b", method: "POST", itemId: "item-a", title: "" }),
    { status: 400, body: { error: "invalid_title" } },
  );
  assert.deepEqual(
    api.request({ token: "fixture-token-b", method: "POST", itemId: "unused", title: "" }),
    { status: 400, body: { error: "invalid_title" } },
  );
  assert.deepEqual(api.snapshot(), before);
});

test("critical auth fixture derives new item ownership from the principal", () => {
  const api = createAuthIsolationFixture();
  assert.equal(
    api.request({
      token: "fixture-token-b",
      method: "POST",
      itemId: "item-new",
      title: "Owned by B",
      requestedOwner: "account-a",
    }).status,
    201,
  );
  assert.equal(
    api.request({ token: "fixture-token-a", method: "GET", itemId: "item-new" }).status,
    404,
  );
  assert.deepEqual(api.request({ token: "fixture-token-b", method: "GET", itemId: "item-new" }), {
    status: 200,
    body: { id: "item-new", title: "Owned by B" },
  });
  assert.equal(api.snapshot().find((item) => item.id === "item-new")?.owner, "account-b");
});
