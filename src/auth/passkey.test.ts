import { describe, expect, test } from "bun:test";
import type { AuthConfig } from "./config.ts";
import {
  assertCounterProgressed,
  buildAuthenticationOptions,
  buildRegistrationOptions,
} from "./passkey.ts";
import type { User, WebAuthnCredentialRecord } from "./types.ts";

const config: AuthConfig = {
  rpID: "localhost",
  rpName: "SmAIltalk",
  expectedOrigins: ["http://localhost:5173"],
  cookieSecure: false,
  sessionTtlSec: 604800,
  challengeTtlSec: 300,
  allowRegistration: true,
};

const user: User = {
  id: "opaque-user-id",
  username: "alice",
  displayName: "Alice",
  role: "viewer",
  createdAt: "2026-07-21T00:00:00.000Z",
};

function credential(id: string): WebAuthnCredentialRecord {
  return {
    id,
    userId: user.id,
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: ["internal"],
    createdAt: "2026-07-21T00:00:00.000Z",
  };
}

describe("buildRegistrationOptions", () => {
  test("rp / user / challenge を載せる", async () => {
    const options = await buildRegistrationOptions({
      config,
      user,
      existingCredentials: [],
    });
    expect(options.rp.id).toBe("localhost");
    expect(options.rp.name).toBe("SmAIltalk");
    expect(options.user.name).toBe("alice");
    expect(options.challenge).toBeTruthy();
    expect(options.authenticatorSelection?.residentKey).toBe("preferred");
    expect(options.authenticatorSelection?.userVerification).toBe("preferred");
  });

  test("existingCredentials が excludeCredentials に反映される", async () => {
    const options = await buildRegistrationOptions({
      config,
      user,
      existingCredentials: [credential("cred-1"), credential("cred-2")],
    });
    expect(options.excludeCredentials?.map((c) => c.id).sort()).toEqual(["cred-1", "cred-2"]);
  });
});

describe("buildAuthenticationOptions", () => {
  test("rpID / challenge を載せる", async () => {
    const options = await buildAuthenticationOptions({ config });
    expect(options.rpId).toBe("localhost");
    expect(options.challenge).toBeTruthy();
  });

  test("allowCredentials が反映される", async () => {
    const options = await buildAuthenticationOptions({
      config,
      allowCredentials: [credential("cred-1")],
    });
    expect(options.allowCredentials?.map((c) => c.id)).toEqual(["cred-1"]);
  });
});

describe("assertCounterProgressed(クローン検出)", () => {
  test("counter が増えていれば通る", () => {
    expect(() => assertCounterProgressed(3, 4)).not.toThrow();
  });

  test("counter が両方 0(counter 非対応)は通る", () => {
    expect(() => assertCounterProgressed(0, 0)).not.toThrow();
  });

  test("counter が後退したら throw(クローン疑い)", () => {
    expect(() => assertCounterProgressed(5, 4)).toThrow(/カウンタが後退/);
  });

  test("counter が同値(非増加)でも throw", () => {
    expect(() => assertCounterProgressed(5, 5)).toThrow();
  });
});
