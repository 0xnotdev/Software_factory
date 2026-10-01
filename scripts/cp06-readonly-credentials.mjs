import { constants } from "node:fs";
import { open } from "node:fs/promises";

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class Cp06AuthBlockedError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "Cp06AuthBlockedError";
    this.code = "CP06_AUTH_BLOCKED";
  }
}

/**
 * A deliberately tiny pi-ai CredentialStore for the CP-06 proof worker.
 * It exposes one OAuth record and rejects every mutation before entering the
 * callback that provider auth resolution would use to refresh the record.
 */
export class Cp06ReadOnlyCredentialStore {
  #providerId;
  #credential;
  #audit = { reads: 0, lists: 0, modify_denials: 0, delete_denials: 0 };

  static async load(options) {
    const path = options?.path;
    const providerId = options?.providerId;
    const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    if (typeof path !== "string" || path.length === 0) {
      throw blocked("credential target path is missing");
    }
    if (typeof providerId !== "string" || providerId.length === 0) {
      throw blocked("expected OAuth provider is missing");
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw blocked("credential size bound is invalid");
    }

    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_CLOEXEC);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw blocked("credential target is not a regular file");
      if (before.size <= 0n || before.size > BigInt(maxBytes)) {
        throw blocked("credential target size is outside the allowed bound");
      }
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        bytes.length !== Number(before.size)
      ) {
        throw blocked("credential target changed while it was read");
      }
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch (cause) {
        throw blocked("credential target is not valid JSON", { cause });
      }
      const credential = parsed?.[providerId];
      validateOAuthCredential(credential);
      return new Cp06ReadOnlyCredentialStore(providerId, credential);
    } catch (cause) {
      if (cause instanceof Cp06AuthBlockedError) throw cause;
      throw blocked("credential target could not be opened read-only", { cause });
    } finally {
      await handle?.close();
    }
  }

  constructor(providerId, credential) {
    this.#providerId = providerId;
    this.#credential = structuredClone(credential);
  }

  assertUsableOAuth(options = {}) {
    const now = options.now ?? Date.now();
    const minValidityMs = options.minValidityMs ?? 300_000;
    if (!Number.isFinite(now) || !Number.isFinite(minValidityMs) || minValidityMs < 0) {
      throw blocked("OAuth validity preflight parameters are invalid");
    }
    const remainingValidityMs = this.#credential.expires - now;
    if (remainingValidityMs < minValidityMs) {
      throw blocked("OAuth credential is expired or too near expiry for a no-refresh run");
    }
    return {
      providerId: this.#providerId,
      type: "oauth",
      expires: this.#credential.expires,
      remainingValidityMs,
    };
  }

  async read(providerId, options) {
    options?.signal?.throwIfAborted();
    this.#audit.reads += 1;
    return providerId === this.#providerId ? structuredClone(this.#credential) : undefined;
  }

  async list(options) {
    options?.signal?.throwIfAborted();
    this.#audit.lists += 1;
    return [{ providerId: this.#providerId, type: "oauth" }];
  }

  async modify(_providerId, _callback, options) {
    options?.signal?.throwIfAborted();
    this.#audit.modify_denials += 1;
    throw blocked("CP-06 read-only credential store denies refresh and mutation");
  }

  async delete(_providerId, options) {
    options?.signal?.throwIfAborted();
    this.#audit.delete_denials += 1;
    throw blocked("CP-06 read-only credential store denies credential deletion");
  }

  audit() {
    return { ...this.#audit };
  }
}

function validateOAuthCredential(credential) {
  if (
    credential === null ||
    typeof credential !== "object" ||
    Array.isArray(credential) ||
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    credential.access.length === 0 ||
    typeof credential.refresh !== "string" ||
    credential.refresh.length === 0 ||
    !Number.isFinite(credential.expires)
  ) {
    throw blocked("expected provider does not contain one usable OAuth credential");
  }
}

function blocked(message, options) {
  return new Cp06AuthBlockedError(message, options);
}
