/**
 * 署名検証(HMAC-SHA256)実行層関数(V2-M5-T02 / ADR-0041 §3 限定2)。
 *
 * **これは受信の「書込直前・実行層」の関門である**(ADR-0020 が送信の fetch 直前で grant を
 * 検査するのと対称。03 §3c)。受信 HTTP ルート(`src/server/inbound-route.ts`)が、鍵を
 * use-time に `resolveSecret` で解決した**直後・create する直前**にこの関数を呼び、false なら
 * アプリ内テーブルへ**1バイトも書かずに**遮断する。バリデーション層・説明文で検証したことに
 * しない(ADR-0020 §8c-5 と同型。迂回テストで実証する)。
 *
 * 検証するのは **HMAC-SHA256(受信生バイト body, 鍵)** の一致である。**署名がどのヘッダに載り、
 * どう書き表されているかは受信口ごとの宣言による**(`V5-M15` / `G-G9` / `G-G10` / `ADR-0160`)——
 * ヘッダ名は `INBOUND_SIGNATURE_HEADERS` の3値、値の形式は `INBOUND_SIGNATURE_FORMATS` の3値で、
 * **宣言が無い受信口は今日どおり `X-Mock-PSP-Signature: sha256=<hex>` である**(限定8)。
 * **【できないことを先に書く】** **HMAC の入力は受信生バイト body に固定であり、タイムスタンプを
 * 連結する形式(実在する決済サービスに多い形)は今日も1つも受けられない**(`ADR-0160` 限定5 /
 * `D-V5-85`)。**受信した生バイト body で HMAC を
 * 計算する** —— JSON をパースして再シリアライズした body ではなく、受信したそのままのバイト列で
 * 計算しなければ署名は一致しない(空白・キー順・数値表現の差で HMAC が変わるため)。呼び出し側は
 * `c.req.arrayBuffer()` の生バイトをここへ渡す。
 *
 * 比較は**定数時間**(`crypto.timingSafeEqual`)で行い、署名の先頭一致でリークするタイミング
 * 差を作らない。署名不一致・ヘッダ欠落・鍵未解決(空文字)・不正な hex はすべて false を返す
 * (例外は投げない —— 呼び出し側は真偽値だけで遮断を決められる)。
 *
 * **鍵値をこの関数から出さない**(戻り値は真偽値のみ。ログも出さない。secret-resolver.ts と同じ
 * 規律で、鍵がエラー・ログ・戻り値のどこにも平文で現れない)。
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * **受信口ごとに宣言できる署名ヘッダ名の値域**(`V5-M15` / `G-G9` / `ADR-0160` 限定2)。
 *
 * **有限3値の列挙で閉じている。自由文字列は書けない。4値目には門A の新規審査が要る**
 * (`ADR-0160` §3a の 2)。**先頭が既定である**(宣言が無い受信口は今日どおり。限定8)。
 *
 * **【`D-V5-85`。誤読を招く1件を名指しで書く】** **`Stripe-Signature` はここに在るが、
 * 決済サービス(Stripe)が実際に送る値の形式(`t=<ts>,v1=<hex>`。HMAC の入力がタイムスタンプと
 * body の連結)は `INBOUND_SIGNATURE_FORMATS` の3値のどれとも一致しない** ——
 * **このヘッダ名を宣言しても、その送り手からの通知の署名検証は必ず落ちる。**
 * **受けられるようになったのは GitHub 形式(`X-Hub-Signature-256: sha256=<hex>`)までである。**
 * 固定している検査: `src/server/inbound-signature-shape.test.ts` の (S)。
 */
export const INBOUND_SIGNATURE_HEADERS = [
  "X-Mock-PSP-Signature",
  "Stripe-Signature",
  "X-Hub-Signature-256",
] as const;

/** 宣言できる署名ヘッダ名(`INBOUND_SIGNATURE_HEADERS` の3値のいずれか)。 */
export type InboundSignatureHeader = (typeof INBOUND_SIGNATURE_HEADERS)[number];

/**
 * 署名ヘッダの名前の**既定値**(宣言が無い受信口は今日どおり。`ADR-0160` 限定8)。
 * モック PSP が付ける名前でもある(03 §2b)。
 */
export const INBOUND_SIGNATURE_HEADER: InboundSignatureHeader = INBOUND_SIGNATURE_HEADERS[0];

/**
 * **受信口ごとに宣言できる署名の値の形式の値域**(`V5-M15` / `G-G10` / `ADR-0160` 限定4)。
 *
 * **有限3値の列挙で閉じている。4値目には門A の新規審査が要る。**
 * **アルゴリズムは HMAC-SHA256 の1種のままで、選べるようにしていない**(限定3)——
 * ここに在るのは**同じ 32 バイトのダイジェストの書き表し方**の違いだけである。
 *
 * - `sha256_hex`: `sha256=<hex>`(今日。既定)
 * - `hex`: `<hex>`(プレフィクス無し)
 * - `base64`: `<base64>`
 *
 * **タイムスタンプの連結・正規化・複数署名の並記は1つも書けない**(限定5)——
 * それを足すことは `ADR-0160` §3a の 3 が名指しで禁じている。
 */
export const INBOUND_SIGNATURE_FORMATS = ["sha256_hex", "hex", "base64"] as const;

/** 宣言できる署名の値の形式(`INBOUND_SIGNATURE_FORMATS` の3値のいずれか)。 */
export type InboundSignatureFormat = (typeof INBOUND_SIGNATURE_FORMATS)[number];

/** 署名の値の形式の**既定値**(宣言が無い受信口は今日どおり。`ADR-0160` 限定8)。 */
export const DEFAULT_INBOUND_SIGNATURE_FORMAT: InboundSignatureFormat =
  INBOUND_SIGNATURE_FORMATS[0];

/** `sha256=<hex>` のプレフィクス。 */
const SIGNATURE_PREFIX = "sha256=";

/**
 * 受信した署名ヘッダの値を、形式に従って**32 バイトのダイジェスト**へ戻す。
 * 形式に合わない値・壊れた値は `null`(例外を投げない —— 呼び出し側は真偽値だけで遮断を決める)。
 *
 * **ここで行うのは書き表し方の解釈だけである** —— 計算方法(HMAC-SHA256・生バイト body)は
 * 形式によって1ミリも変わらない(`ADR-0160` 限定3 / 限定5)。
 */
function decodeSignatureValue(value: string, format: InboundSignatureFormat): Buffer | null {
  if (format === "sha256_hex") {
    if (!value.startsWith(SIGNATURE_PREFIX)) {
      return null;
    }
    const hex = value.slice(SIGNATURE_PREFIX.length).trim();
    return hex.length === 0 ? null : Buffer.from(hex, "hex");
  }
  if (format === "hex") {
    const hex = value.trim();
    // `sha256=` 付きの値を「裸 hex」として受け取らない(形式が違えば落とす)。
    if (hex.length === 0 || hex.startsWith(SIGNATURE_PREFIX)) {
      return null;
    }
    return Buffer.from(hex, "hex");
  }
  const b64 = value.trim();
  if (b64.length === 0 || b64.startsWith(SIGNATURE_PREFIX)) {
    return null;
  }
  return Buffer.from(b64, "base64");
}

/**
 * 受信 Webhook の署名を検証する。
 *
 * **この関数はヘッダの「名前」を1つも読まない** —— どのヘッダから値を取るかは実行層
 * (`src/server/inbound-route.ts`)が受信口の宣言に従って決める。ここが受け取るのは値だけである。
 *
 * @param rawBody 受信した**生バイト** body(パース前)。文字列でも Uint8Array でもよい。
 * @param signatureHeader 署名ヘッダの値(欠落なら undefined / null)。
 * @param secret use-time に解決した署名検証鍵。未解決・空なら false。
 * @param format 値の形式(`ADR-0160` 限定4 の3値)。**省略すると今日どおり `sha256=<hex>`**(限定8)。
 * @returns 署名が一致すれば true。不一致・ヘッダ欠落・鍵未解決・形式違い・壊れた値は false。
 */
export function verifyInboundSignature(
  rawBody: Uint8Array | string,
  signatureHeader: string | undefined | null,
  secret: string,
  format: InboundSignatureFormat = DEFAULT_INBOUND_SIGNATURE_FORMAT,
): boolean {
  // 鍵未解決(空)・ヘッダ欠落は、比較する前に false(1バイトも通さない)。
  if (secret === "") {
    return false;
  }
  if (signatureHeader === undefined || signatureHeader === null || signatureHeader === "") {
    return false;
  }
  const provided = decodeSignatureValue(signatureHeader, format);
  if (provided === null) {
    return false;
  }

  // **生バイトで HMAC を計算する**(再シリアライズしない)。文字列は UTF-8 バイト列にする。
  // **アルゴリズムはここ1箇所の "sha256" だけで、選べるようにしていない**(ADR-0160 限定3)。
  const bodyBytes =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf-8") : Buffer.from(rawBody);
  const expected = createHmac("sha256", secret).update(bodyBytes).digest(); // 32 バイトの Buffer

  // 長さが揃わない(不正 hex/base64・別方式)なら timingSafeEqual は例外になるので、先に長さで弾く。
  // 長さは秘密ではないので、ここで早期 return してもタイミングリークにはならない。
  if (provided.length !== expected.length) {
    return false;
  }
  // 定数時間比較(先頭一致でリークするタイミング差を作らない)。
  return timingSafeEqual(provided, expected);
}
