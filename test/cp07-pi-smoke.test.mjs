import test from "node:test";
import { resolve } from "node:path";
import { smoke } from "../scripts/cp07-pi-smoke.mjs";

test(
  "real Pi package discovery, command dispatch, CLI parity and runtime reload offline",
  { timeout: 90_000 },
  async () => {
    await smoke(
      resolve(process.env.CP07_PI_PACKAGE_ROOT ?? "node_modules/@earendil-works/pi-coding-agent"),
    );
  },
);
