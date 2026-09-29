export interface AuthResponse {
  status: number;
  body: Record<string, unknown>;
}

interface Item {
  id: string;
  owner: "account-a" | "account-b";
  title: string;
}

const fixturePrincipals = new Map<string, Item["owner"]>([
  ["fixture-token-a", "account-a"],
  ["fixture-token-b", "account-b"],
]);

export function createAuthIsolationFixture(): {
  request(input: {
    token?: string;
    method: "GET" | "POST" | "PUT" | "DELETE";
    itemId: string;
    title?: string;
    requestedOwner?: string;
  }): AuthResponse;
  snapshot(): ReadonlyArray<Readonly<Item>>;
} {
  const itemKey = (owner: Item["owner"], id: string): string => `${owner}\u0000${id}`;
  const items = new Map<string, Item>([
    [itemKey("account-a", "item-a"), { id: "item-a", owner: "account-a", title: "Private A" }],
    [itemKey("account-b", "item-b"), { id: "item-b", owner: "account-b", title: "Private B" }],
  ]);

  return {
    request(input): AuthResponse {
      const principal = input.token === undefined ? undefined : fixturePrincipals.get(input.token);
      if (principal === undefined) {
        return { status: 401, body: { error: "unauthorized" } };
      }
      const key = itemKey(principal, input.itemId);
      const item = items.get(key);
      if (input.method === "POST") {
        if (typeof input.title !== "string" || input.title.trim().length === 0) {
          return { status: 400, body: { error: "invalid_title" } };
        }
        if (item !== undefined) return { status: 409, body: { error: "already_exists" } };
        const created: Item = {
          id: input.itemId,
          owner: principal,
          title: input.title.trim(),
        };
        items.set(key, created);
        return { status: 201, body: { id: created.id, title: created.title } };
      }
      if (item === undefined) {
        // Deliberately conceal whether another account owns this identifier.
        return { status: 404, body: { error: "not_found" } };
      }
      if (input.method === "GET") {
        return { status: 200, body: { id: item.id, title: item.title } };
      }
      if (input.method === "DELETE") {
        items.delete(key);
        return { status: 204, body: {} };
      }
      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        return { status: 400, body: { error: "invalid_title" } };
      }
      item.title = input.title.trim();
      return { status: 200, body: { id: item.id, title: item.title } };
    },
    snapshot(): ReadonlyArray<Readonly<Item>> {
      return [...items.values()].map((item) => ({ ...item }));
    },
  };
}
