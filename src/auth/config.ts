/**
 * 認証設定(env)+ fail-fast(V1-M3-T01 / 計画 §4)。
 *
 * env の読み取り(`loadAuthConfig`)と妥当性検証(`validateAuthConfig`)を分ける。
 * どちらも純関数でテスト可能にしてあり、起動時は `index.ts`(次フェーズ)が
 * `loadAuthConfig(process.env)` → `validateAuthConfig()` の順で呼び、不整合なら
 * `process.exit(1)` する(既存の ST_TIMEZONE 検証と同じ fail-fast 作法)。
 *
 * **なぜ rpID×origin を検証するのか**: WebAuthn は rpID がブラウザの origin の
 * 登録可能なサフィックス(同一ホストか親ドメイン)でないと儀式が失敗する。
 * 設定ミスは「ログインが常に失敗する」という分かりにくい形で現れるので、
 * 起動時に落として原因を明示する(憲法6)。
 */

/** 認証設定。すべて解決済み(既定値適用済み)の値を持つ。 */
export type AuthConfig = {
  /** WebAuthn の Relying Party ID(ホスト名。ポート/スキームを含まない)。 */
  rpID: string;
  /** ユーザに見える RP 名。 */
  rpName: string;
  /** 許可する origin 群(儀式の検証と CSRF の Origin 検査に使う)。 */
  expectedOrigins: string[];
  /** cookie に Secure 属性を付けるか(本番は true、dev は false)。 */
  cookieSecure: boolean;
  /** セッション TTL(秒)。 */
  sessionTtlSec: number;
  /** チャレンジ TTL(秒)。 */
  challengeTtlSec: number;
  /** 新規ユーザ登録を許可するか。 */
  allowRegistration: boolean;
};

const DEFAULTS = {
  rpID: "localhost",
  rpName: "SmAIltalk",
  expectedOrigin: "http://localhost:5173",
  cookieSecure: false,
  sessionTtlSec: 604800,
  challengeTtlSec: 300,
  allowRegistration: true,
} as const;

/** "true"/"1" を真、"false"/"0" を偽として読む。未設定・不明値は既定にフォールバックする。 */
function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  return fallback;
}

/** 秒数を読む。未設定は既定、設定済みなら数値として解釈する(妥当性は validate で検査)。 */
function parseSeconds(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  return Number(value);
}

/**
 * env から `AuthConfig` を組み立てる(既定値適用のみ。意味的検証はしない)。
 * `env` は `process.env` 相当(テストからは任意のオブジェクトを渡せる)。
 */
export function loadAuthConfig(env: Record<string, string | undefined>): AuthConfig {
  const originsRaw = env.ST_AUTH_EXPECTED_ORIGIN ?? DEFAULTS.expectedOrigin;
  const expectedOrigins = originsRaw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  return {
    rpID: env.ST_AUTH_RP_ID ?? DEFAULTS.rpID,
    rpName: env.ST_AUTH_RP_NAME ?? DEFAULTS.rpName,
    expectedOrigins,
    cookieSecure: parseBool(env.ST_AUTH_COOKIE_SECURE, DEFAULTS.cookieSecure),
    sessionTtlSec: parseSeconds(env.ST_AUTH_SESSION_TTL_SEC, DEFAULTS.sessionTtlSec),
    challengeTtlSec: parseSeconds(env.ST_AUTH_CHALLENGE_TTL_SEC, DEFAULTS.challengeTtlSec),
    allowRegistration: parseBool(env.ST_AUTH_ALLOW_REGISTRATION, DEFAULTS.allowRegistration),
  };
}

/** IPv4 ドット十進表記か。rpID に IP を使うのは WebAuthn 上不正(dev は localhost 必須)。 */
function isIpv4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return false;
  }
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * `rpID` が `originHost` の登録可能なサフィックスか。
 * 同一ホスト(`localhost` と `localhost`)か、親ドメイン(`example.com` と
 * `app.example.com`)であれば真。`evil.test` に対する `example.com` は偽。
 */
function isRegistrableSuffix(rpID: string, originHost: string): boolean {
  return originHost === rpID || originHost.endsWith(`.${rpID}`);
}

/** 正の整数か。TTL の妥当性検査に使う。 */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/**
 * `AuthConfig` の意味的妥当性を検証する。不整合は Error を投げる(呼び出し側が fail-fast する)。
 *
 * 検証内容:
 * - rpID が空でない / スキーム・パス・ポートを含まない / IP アドレスでない
 * - expectedOrigins が1つ以上あり、すべてが URL としてパースでき、
 *   それぞれのホストに対して rpID が登録可能なサフィックスである
 * - TTL(session/challenge)が正の整数である
 */
export function validateAuthConfig(config: AuthConfig): void {
  const { rpID } = config;
  if (rpID === "") {
    throw new Error(
      "ST_AUTH_RP_ID が空です。WebAuthn の Relying Party ID(ホスト名)を指定してください。",
    );
  }
  if (rpID.includes("://") || rpID.includes("/")) {
    throw new Error(
      `ST_AUTH_RP_ID "${rpID}" にスキームやパスが含まれています。rpID はホスト名のみ(例: "localhost")です。`,
    );
  }
  if (rpID.includes(":")) {
    throw new Error(
      `ST_AUTH_RP_ID "${rpID}" にポートが含まれています。rpID はポートを含まないホスト名のみです。`,
    );
  }
  if (isIpv4(rpID)) {
    throw new Error(
      `ST_AUTH_RP_ID "${rpID}" は IP アドレスです。WebAuthn は rpID に IP を許しません。dev はブラウザから "localhost" で接続してください。`,
    );
  }

  if (config.expectedOrigins.length === 0) {
    throw new Error(
      "ST_AUTH_EXPECTED_ORIGIN が空です。少なくとも1つの origin を指定してください。",
    );
  }
  for (const origin of config.expectedOrigins) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(
        `ST_AUTH_EXPECTED_ORIGIN の "${origin}" は URL として解釈できません(例: "http://localhost:5173")。`,
      );
    }
    if (!isRegistrableSuffix(rpID, url.hostname)) {
      throw new Error(
        `ST_AUTH_RP_ID "${rpID}" は origin "${origin}"(ホスト "${url.hostname}")の登録可能なサフィックスではありません。rpID を同一ホストか親ドメインにしてください。`,
      );
    }
  }

  if (!isPositiveInteger(config.sessionTtlSec)) {
    throw new Error(`ST_AUTH_SESSION_TTL_SEC "${config.sessionTtlSec}" が正の整数ではありません。`);
  }
  if (!isPositiveInteger(config.challengeTtlSec)) {
    throw new Error(
      `ST_AUTH_CHALLENGE_TTL_SEC "${config.challengeTtlSec}" が正の整数ではありません。`,
    );
  }
}
