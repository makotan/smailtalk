import { describe, expect, test } from "bun:test";
import { type AuthConfig, loadAuthConfig, validateAuthConfig } from "./config.ts";

/** テスト用に妥当な既定 config を作る(個別テストで一部だけ上書きする)。 */
function baseConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    rpID: "localhost",
    rpName: "SmAIltalk",
    expectedOrigins: ["http://localhost:5173"],
    cookieSecure: false,
    sessionTtlSec: 604800,
    challengeTtlSec: 300,
    allowRegistration: true,
    ...overrides,
  };
}

describe("loadAuthConfig", () => {
  test("空 env では既定値を返す", () => {
    const config = loadAuthConfig({});
    expect(config.rpID).toBe("localhost");
    expect(config.rpName).toBe("SmAIltalk");
    expect(config.expectedOrigins).toEqual(["http://localhost:5173"]);
    expect(config.cookieSecure).toBe(false);
    expect(config.sessionTtlSec).toBe(604800);
    expect(config.challengeTtlSec).toBe(300);
    expect(config.allowRegistration).toBe(true);
  });

  test("env の値で上書きできる", () => {
    const config = loadAuthConfig({
      ST_AUTH_RP_ID: "example.com",
      ST_AUTH_RP_NAME: "My App",
      ST_AUTH_COOKIE_SECURE: "true",
      ST_AUTH_SESSION_TTL_SEC: "3600",
      ST_AUTH_CHALLENGE_TTL_SEC: "120",
      ST_AUTH_ALLOW_REGISTRATION: "false",
      ST_AUTH_EXPECTED_ORIGIN: "https://example.com",
    });
    expect(config.rpID).toBe("example.com");
    expect(config.rpName).toBe("My App");
    expect(config.cookieSecure).toBe(true);
    expect(config.sessionTtlSec).toBe(3600);
    expect(config.challengeTtlSec).toBe(120);
    expect(config.allowRegistration).toBe(false);
    expect(config.expectedOrigins).toEqual(["https://example.com"]);
  });

  test("EXPECTED_ORIGIN はカンマ区切りで複数パースし、空白を除去する", () => {
    const config = loadAuthConfig({
      ST_AUTH_EXPECTED_ORIGIN: "http://localhost:5173, http://localhost:4173 ,",
    });
    expect(config.expectedOrigins).toEqual(["http://localhost:5173", "http://localhost:4173"]);
  });

  test("COOKIE_SECURE は 1/0 も真偽として読む", () => {
    expect(loadAuthConfig({ ST_AUTH_COOKIE_SECURE: "1" }).cookieSecure).toBe(true);
    expect(loadAuthConfig({ ST_AUTH_COOKIE_SECURE: "0" }).cookieSecure).toBe(false);
  });
});

describe("validateAuthConfig", () => {
  test("妥当な config(localhost)は通る", () => {
    expect(() => validateAuthConfig(baseConfig())).not.toThrow();
  });

  test("rpID が origin のホストと一致すれば通る", () => {
    expect(() =>
      validateAuthConfig(
        baseConfig({ rpID: "example.com", expectedOrigins: ["https://example.com"] }),
      ),
    ).not.toThrow();
  });

  test("rpID が origin の登録可能なサフィックス(サブドメイン)なら通る", () => {
    expect(() =>
      validateAuthConfig(
        baseConfig({ rpID: "example.com", expectedOrigins: ["https://app.example.com"] }),
      ),
    ).not.toThrow();
  });

  test("複数 origin のすべてが rpID のサフィックスであること", () => {
    expect(() =>
      validateAuthConfig(
        baseConfig({
          rpID: "example.com",
          expectedOrigins: ["https://example.com", "https://app.example.com"],
        }),
      ),
    ).not.toThrow();
  });

  test("rpID が origin のサフィックスでないと throw", () => {
    expect(() =>
      validateAuthConfig(
        baseConfig({ rpID: "example.com", expectedOrigins: ["https://evil.test"] }),
      ),
    ).toThrow();
  });

  test("rpID にポートを含むと throw", () => {
    expect(() =>
      validateAuthConfig(
        baseConfig({ rpID: "localhost:5173", expectedOrigins: ["http://localhost:5173"] }),
      ),
    ).toThrow();
  });

  test("rpID にスキームを含むと throw", () => {
    expect(() =>
      validateAuthConfig(
        baseConfig({ rpID: "http://localhost", expectedOrigins: ["http://localhost:5173"] }),
      ),
    ).toThrow();
  });

  test("rpID が IPv4 アドレスだと throw(dev はブラウザから localhost 必須)", () => {
    expect(() =>
      validateAuthConfig(
        baseConfig({ rpID: "127.0.0.1", expectedOrigins: ["http://127.0.0.1:5173"] }),
      ),
    ).toThrow();
  });

  test("expectedOrigins が空だと throw", () => {
    expect(() => validateAuthConfig(baseConfig({ expectedOrigins: [] }))).toThrow();
  });

  test("origin が URL として不正だと throw", () => {
    expect(() => validateAuthConfig(baseConfig({ expectedOrigins: ["not a url"] }))).toThrow();
  });

  test("TTL が正の整数でないと throw", () => {
    expect(() => validateAuthConfig(baseConfig({ sessionTtlSec: 0 }))).toThrow();
    expect(() => validateAuthConfig(baseConfig({ challengeTtlSec: -1 }))).toThrow();
  });
});
