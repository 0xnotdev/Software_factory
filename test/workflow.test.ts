import { strict as assert } from "node:assert";
import test from "node:test";
import { createAuthIsolationFixture } from "./fixtures/workflow/critical-auth-isolation.js";
import { handleProfileRequest } from "./fixtures/workflow/normal-api.js";

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
