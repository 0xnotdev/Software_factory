export function handleProfileRequest(input) {
  if (input.path !== "/v1/profile") return { status: 404, body: { error: "not_found" } };
  if (input.method === "GET") return { status: 200, body: { display_name: "Fixture User" } };
  if (input.method !== "PUT") return { status: 405, body: { error: "method_not_allowed" } };
  const parsed = JSON.parse(input.body ?? "");
  const displayName = parsed?.display_name;
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return { status: 400, body: { error: "invalid_profile" } };
  }
  return { status: 200, body: { display_name: displayName.trim() } };
}
