export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export function handleProfileRequest(input: {
  method: string;
  path: string;
  body?: string;
}): ApiResponse {
  if (input.path !== "/v1/profile") {
    return { status: 404, body: { error: "not_found" } };
  }
  if (input.method === "GET") {
    return { status: 200, body: { display_name: "Fixture User" } };
  }
  if (input.method !== "PUT") {
    return { status: 405, body: { error: "method_not_allowed" } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.body ?? "") as unknown;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "invalid_profile" } };
  }
  const displayName = (parsed as Record<string, unknown>).display_name;
  if (typeof displayName !== "string" || displayName.trim().length === 0) {
    return { status: 400, body: { error: "invalid_profile" } };
  }
  return { status: 200, body: { display_name: displayName.trim() } };
}
