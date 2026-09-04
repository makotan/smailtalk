/**
 * WebAuthn 儀式(ceremony)の薄いラッパ(V1-M3-T01 / ADR-0014 §1)。
 *
 * `@simplewebauthn/browser` v13 は引数を `{ optionsJSON }` の形で取る。ここではその
 * 呼び出し規約を1箇所に閉じ込めるだけで、options の生成も response の解釈もしない
 * (生成はサーバ、検証もサーバ。フロントは「ブラウザの資格情報 API を叩いて戻りを
 * そのまま verify に渡す」以上のことをしない)。
 *
 * 実際の儀式は `navigator.credentials` に依存するため happy-dom では動かない。
 * 単体・コンポーネントテストではこのモジュール(または呼び出し元)をモックし、
 * 実儀式の検証は E2E(仮想オーセンティケータ)に委ねる。
 */

import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/browser";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

/** 登録儀式。サーバの CreationOptionsJSON を渡し、verify に送る response を得る。 */
export function runPasskeyRegistration(
  optionsJSON: PublicKeyCredentialCreationOptionsJSON,
): Promise<RegistrationResponseJSON> {
  return startRegistration({ optionsJSON });
}

/** ログイン儀式。サーバの RequestOptionsJSON を渡し、verify に送る response を得る。 */
export function runPasskeyLogin(
  optionsJSON: PublicKeyCredentialRequestOptionsJSON,
): Promise<AuthenticationResponseJSON> {
  return startAuthentication({ optionsJSON });
}
