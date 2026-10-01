import { strict as assert } from "node:assert";
import { handleProfileRequest } from "./normal-api-before.mjs";

assert.deepEqual(handleProfileRequest({ method: "PUT", path: "/v1/profile", body: "not-json" }), {
  status: 400,
  body: { error: "invalid_json" },
});
