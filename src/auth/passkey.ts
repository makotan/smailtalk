/**
 * WebAuthn(パスキー)サーバ検証(V1-M3-T01 / 計画 §5)。SimpleWebAuthn v13。
 *
 * このモジュールは SimpleWebAuthn の薄いラッパで、`AuthConfig` から rpID / rpName /
 * expectedOrigins を供給し、儀式オプション生成と検証を行う。DB 操作は持たず(呼び出し側が
 * `AuthStore` を使う)、純粋に「儀式の入出力変換 + counter 後退検査」に責務を絞る。
 *
 * v13 の型に注意:
 * - `generate*Options` は Promise を返す(await が要る)
 * - クレデンシャルは `{ id, publicKey(Uint8Array), counter, transports }`(WebAuthnCredential)
 * - `verifyRegistrationResponse` は verified 時 `registrationInfo.credential` を返す
 * - `verifyAuthenticationResponse` は verified 時 `authenticationInfo.newCounter` を返す
 *
 * 実 assertion の検証はブラウザのオーセンティケータが要るため、単体テストでは
 * options 生成と counter 後退ロジックまでを検査し、実検証は E2E(仮想オーセンティケータ)で行う。
 */
import {
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthConfig } from "./config.ts";
import type { User, WebAuthnCredentialRecord } from "./types.ts";

/** クレデンシャル記述子(exclude/allow Credentials 用)。undefined を明示代入しない。 */
type CredentialDescriptor = { id: string; transports?: AuthenticatorTransportFuture[] };

/**
 * DB のクレデンシャルを SimpleWebAuthn の記述子に写す。
 * `exactOptionalPropertyTypes` の下では `transports: undefined` を持たせられないため、
 * 値があるときだけプロパティを付ける。
 */
function toCredentialDescriptor(credential: WebAuthnCredentialRecord): CredentialDescriptor {
  const descriptor: CredentialDescriptor = { id: credential.id };
  if (credential.transports !== undefined) {
    descriptor.transports = credential.transports as AuthenticatorTransportFuture[];
  }
  return descriptor;
}

/**
 * 登録儀式のオプションを生成する。`excludeCredentials` で同一クレデンシャルの二重登録を防ぐ。
 *
 * チャレンジは SimpleWebAuthn が生成する。呼び出し側は返り値の `options.challenge`
 * (base64url)を `store.savePendingChallenge` に保存し、verify 時にそれを
 * `expectedChallenge` として渡す(自前で base64url を作って注入すると二重エンコードで
 * ずれるため、必ず生成された `options.challenge` を保存すること)。
 */
export function buildRegistrationOptions(input: {
  config: AuthConfig;
  user: User;
  existingCredentials: WebAuthnCredentialRecord[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { config, user, existingCredentials } = input;
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpID,
    userName: user.username,
    // WebAuthn userID は不透明なバイト列。ユーザの opaque id をそのまま使う。
    userID: new TextEncoder().encode(user.id),
    userDisplayName: user.displayName ?? user.username,
    excludeCredentials: existingCredentials.map(toCredentialDescriptor),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
  });
}

/** 登録検証の結果(verified のとき保存すべきクレデンシャル情報を返す)。 */
export type RegistrationVerification =
  | { verified: false }
  | {
      verified: true;
      credential: {
        id: string;
        publicKey: Uint8Array;
        counter: number;
        transports?: AuthenticatorTransportFuture[];
      };
      deviceType: string;
      backedUp: boolean;
    };

/** 登録レスポンスを検証する。verified なら保存用のクレデンシャル情報を返す。 */
export async function verifyRegistration(input: {
  config: AuthConfig;
  response: RegistrationResponseJSON;
  expectedChallenge: string;
}): Promise<RegistrationVerification> {
  const { config, response, expectedChallenge } = input;
  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpID,
  });
  if (!verification.verified) {
    return { verified: false };
  }
  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const credentialOut: {
    id: string;
    publicKey: Uint8Array;
    counter: number;
    transports?: AuthenticatorTransportFuture[];
  } = {
    id: credential.id,
    publicKey: credential.publicKey,
    counter: credential.counter,
  };
  if (credential.transports !== undefined) {
    credentialOut.transports = credential.transports;
  }
  return {
    verified: true,
    credential: credentialOut,
    deviceType: credentialDeviceType,
    backedUp: credentialBackedUp,
  };
}

/**
 * 認証儀式のオプションを生成する。`allowCredentials` を渡すと候補を限定する。
 * チャレンジは SimpleWebAuthn が生成する。呼び出し側は `options.challenge` を保存すること
 * (`buildRegistrationOptions` と同じ理由で自前注入はしない)。
 */
export function buildAuthenticationOptions(input: {
  config: AuthConfig;
  allowCredentials?: WebAuthnCredentialRecord[];
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { config, allowCredentials } = input;
  const options: {
    rpID: string;
    userVerification: "preferred";
    allowCredentials?: CredentialDescriptor[];
  } = {
    rpID: config.rpID,
    userVerification: "preferred",
  };
  if (allowCredentials !== undefined) {
    options.allowCredentials = allowCredentials.map(toCredentialDescriptor);
  }
  return generateAuthenticationOptions(options);
}

/**
 * counter の前進を検査する(クローン検出。中8)。
 *
 * WebAuthn の署名 counter は認証のたびに単調増加する。保存済み counter 以下の値が
 * 返ってきたら、同じクレデンシャルの複製(クローン)が使われた疑いがあるため拒否する。
 * ただし counter を持たないオーセンティケータは常に 0 を返すため、
 * `stored === 0 && next === 0` の場合だけは正常として通す。
 *
 * @throws 後退(または非増加)を検出したとき
 */
export function assertCounterProgressed(storedCounter: number, newCounter: number): void {
  if (storedCounter === 0 && newCounter === 0) {
    return;
  }
  if (newCounter <= storedCounter) {
    throw new Error(
      `認証器の署名カウンタが後退しました(保存 ${storedCounter} → 提示 ${newCounter})。クレデンシャルのクローンが疑われるため認証を拒否します。`,
    );
  }
}

/** 認証検証の結果(verified のとき新しい counter を返す)。 */
export type AuthenticationVerification =
  | { verified: false }
  | { verified: true; newCounter: number };

/**
 * 認証レスポンスを検証する。verified なら counter 後退検査を行い、新しい counter を返す。
 * 呼び出し側はこの `newCounter` で `updateCredentialCounter` する。
 * @throws counter が後退していた場合(クローン疑い)
 */
export async function verifyAuthentication(input: {
  config: AuthConfig;
  response: AuthenticationResponseJSON;
  expectedChallenge: string;
  credential: WebAuthnCredentialRecord;
}): Promise<AuthenticationVerification> {
  const { config, response, expectedChallenge, credential } = input;
  // publicKey は ArrayBuffer 裏付けの Uint8Array に写す(SimpleWebAuthn の型に合わせる)。
  const webauthnCredential: {
    id: string;
    publicKey: Uint8Array<ArrayBuffer>;
    counter: number;
    transports?: AuthenticatorTransportFuture[];
  } = {
    id: credential.id,
    publicKey: new Uint8Array(credential.publicKey),
    counter: credential.counter,
  };
  if (credential.transports !== undefined) {
    webauthnCredential.transports = credential.transports as AuthenticatorTransportFuture[];
  }
  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: config.expectedOrigins,
    expectedRPID: config.rpID,
    credential: webauthnCredential,
  });
  if (!verification.verified) {
    return { verified: false };
  }
  const { newCounter } = verification.authenticationInfo;
  assertCounterProgressed(credential.counter, newCounter);
  return { verified: true, newCounter };
}
