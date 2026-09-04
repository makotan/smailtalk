import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  DEFAULT_INBOUND_SIGNATURE_FORMAT,
  INBOUND_SIGNATURE_FORMATS,
  INBOUND_SIGNATURE_HEADER,
  INBOUND_SIGNATURE_HEADERS,
  verifyInboundSignature,
} from "./inbound-verify.ts";

/**
 * 署名検証(HMAC-SHA256)実行層関数の単体テスト(V2-M5-T02 / ADR-0041 §3 限定2)。
 *
 * `X-Mock-PSP-Signature: sha256=<hex(HMAC-SHA256(rawBody, secret))>` を検証する。
 * **受信した生バイト body で HMAC を計算する**(パース→再シリアライズ後でなく生バイト。
 * 署名一致のため。03 §3a)。不一致・ヘッダ欠落・鍵未解決(空)は false を返し、
 * 呼び出し側が書込前に遮断する(署名検証は書込直前・実行層。ADR-0041 限定2)。
 */
describe("verifyInboundSignature", () => {
  const secret = "test-shared-secret-abc123";
  const body = JSON.stringify({ event_id: "evt_1", type: "charge.succeeded", amount: 12345 });

  /** テスト用に正しい署名ヘッダを作る(モック PSP と同じ計算)。 */
  function sign(rawBody: string, key: string): string {
    return `sha256=${createHmac("sha256", key).update(Buffer.from(rawBody, "utf-8")).digest("hex")}`;
  }

  test("正しい署名 → true(文字列 body)", () => {
    expect(verifyInboundSignature(body, sign(body, secret), secret)).toBe(true);
  });

  test("正しい署名 → true(Uint8Array の生バイト body)", () => {
    const bytes = new TextEncoder().encode(body);
    expect(verifyInboundSignature(bytes, sign(body, secret), secret)).toBe(true);
  });

  test("改竄 body → false(生バイトが変わると HMAC が一致しない)", () => {
    const tampered = body.replace("12345", "99999");
    // 署名は元の body で作り、検証は改竄 body で行う。
    expect(verifyInboundSignature(tampered, sign(body, secret), secret)).toBe(false);
  });

  test("誤った鍵で作った署名 → false", () => {
    expect(verifyInboundSignature(body, sign(body, "wrong-key"), secret)).toBe(false);
  });

  test("検証側の鍵が違う → false", () => {
    expect(verifyInboundSignature(body, sign(body, secret), "another-secret")).toBe(false);
  });

  test("署名ヘッダ欠落(undefined / null / 空)→ false", () => {
    expect(verifyInboundSignature(body, undefined, secret)).toBe(false);
    expect(verifyInboundSignature(body, null, secret)).toBe(false);
    expect(verifyInboundSignature(body, "", secret)).toBe(false);
  });

  test("sha256= プレフィクスが無い → false", () => {
    const bare = createHmac("sha256", secret).update(Buffer.from(body, "utf-8")).digest("hex");
    expect(verifyInboundSignature(body, bare, secret)).toBe(false);
  });

  test("鍵が空(未解決)→ false(1バイトも通さない)", () => {
    expect(verifyInboundSignature(body, sign(body, secret), "")).toBe(false);
  });

  test("hex でない署名 / 長さ違い → false(例外を投げず false)", () => {
    expect(verifyInboundSignature(body, "sha256=not-hex-value", secret)).toBe(false);
    expect(verifyInboundSignature(body, "sha256=abcd", secret)).toBe(false);
    expect(verifyInboundSignature(body, "sha256=", secret)).toBe(false);
  });

  test("定数時間比較を使う(長さの合う誤署名でも false・例外なし)", () => {
    // 正しい署名と同じ長さ(64 hex 文字)の別値。timingSafeEqual は同長でのみ比較でき、
    // 長さが揃っていても内容が違えば false になる(例外を投げない)。
    const wrong = `sha256=${"0".repeat(64)}`;
    expect(verifyInboundSignature(body, wrong, secret)).toBe(false);
  });

  test("空 body でも署名が一致すれば true", () => {
    expect(verifyInboundSignature("", sign("", secret), secret)).toBe(true);
  });
});

// --- V5-M15(`G-G9` / `G-G10` / `ADR-0160`)------------------------------------------
//
// **署名の「ヘッダ名」と「値の形式」を受信口ごとに宣言できるようにする。**
// このファイルが持つのは**値域**(有限3値 × 有限3値)と、**形式ごとの照合**である。
// **どのヘッダを実際に読むかは実行層(`src/server/inbound-route.ts`)の仕事**であり、
// ここは「その名前が値域に在るか」しか知らない(この関数はヘッダ名を1つも読まない)。
//
// **`ADR-0160` 限定3 により、アルゴリズムは HMAC-SHA256 の1種のままである** ——
// 本ファイルに選択肢は1つも増えていない(`createHmac("sha256", ...)` が1箇所)。
// **`ADR-0160` 限定5 により、HMAC の入力は受信生バイト body に固定である** ——
// タイムスタンプの連結・正規化・複数署名の並記を書ける場所は1つも無い
// (**したがって決済サービス(Stripe)の署名形式は今日も受けられない**。`D-V5-85`)。

describe("ADR-0160: 署名の値域(ヘッダ名3値 / 値の形式3値)", () => {
  test("限定2: ヘッダ名の値域はちょうど3値である(4値目は門A の新規審査が要る)", () => {
    expect(INBOUND_SIGNATURE_HEADERS.length).toBe(3);
    expect([...INBOUND_SIGNATURE_HEADERS]).toEqual([
      "X-Mock-PSP-Signature",
      "Stripe-Signature",
      "X-Hub-Signature-256",
    ]);
  });

  test("限定8: 既定のヘッダ名は今日どおり(値域の先頭)", () => {
    expect(INBOUND_SIGNATURE_HEADER).toBe("X-Mock-PSP-Signature");
    expect(INBOUND_SIGNATURE_HEADER).toBe(INBOUND_SIGNATURE_HEADERS[0]);
  });

  test("限定4: 値の形式の値域はちょうど3値である(4値目は門A の新規審査が要る)", () => {
    expect(INBOUND_SIGNATURE_FORMATS.length).toBe(3);
    expect([...INBOUND_SIGNATURE_FORMATS]).toEqual(["sha256_hex", "hex", "base64"]);
  });

  test("限定8: 既定の値の形式は今日どおり(`sha256=<hex>`)", () => {
    expect(DEFAULT_INBOUND_SIGNATURE_FORMAT).toBe("sha256_hex");
    expect(DEFAULT_INBOUND_SIGNATURE_FORMAT).toBe(INBOUND_SIGNATURE_FORMATS[0]);
  });

  test("限定3: 選べるアルゴリズムは1つも無い(値域に SHA-1 / SHA-512 / 公開鍵署名が1件も無い)", () => {
    const formats = [...INBOUND_SIGNATURE_FORMATS].join(" ").toLowerCase();
    for (const banned of ["sha1", "sha-1", "sha512", "sha-512", "ed25519", "rsa", "md5"]) {
      expect(formats).not.toContain(banned);
    }
  });
});

describe("ADR-0160: 形式ごとの照合(HMAC-SHA256 は1種のまま)", () => {
  const secret = "test-shared-secret-abc123";
  const body = JSON.stringify({ event_id: "evt_2", type: "issues.opened" });
  const digest = createHmac("sha256", secret).update(Buffer.from(body, "utf-8")).digest();

  test("sha256_hex: `sha256=<hex>` が一致すれば true・裸 hex は false", () => {
    const hex = digest.toString("hex");
    expect(verifyInboundSignature(body, `sha256=${hex}`, secret, "sha256_hex")).toBe(true);
    expect(verifyInboundSignature(body, hex, secret, "sha256_hex")).toBe(false);
  });

  test("hex: 裸 hex が一致すれば true・`sha256=` 付きは false(形式が違う)", () => {
    const hex = digest.toString("hex");
    expect(verifyInboundSignature(body, hex, secret, "hex")).toBe(true);
    expect(verifyInboundSignature(body, `sha256=${hex}`, secret, "hex")).toBe(false);
  });

  test("base64: base64 が一致すれば true・hex は false(形式が違う)", () => {
    const b64 = digest.toString("base64");
    expect(verifyInboundSignature(body, b64, secret, "base64")).toBe(true);
    expect(verifyInboundSignature(body, digest.toString("hex"), secret, "base64")).toBe(false);
  });

  test("形式を省略すると今日どおり `sha256=<hex>` で照合する(限定8)", () => {
    const hex = digest.toString("hex");
    expect(verifyInboundSignature(body, `sha256=${hex}`, secret)).toBe(true);
    expect(verifyInboundSignature(body, hex, secret)).toBe(false);
  });

  test("どの形式でも、鍵が違えば false / 鍵が空(未解決)なら false", () => {
    for (const format of INBOUND_SIGNATURE_FORMATS) {
      const value =
        format === "sha256_hex"
          ? `sha256=${digest.toString("hex")}`
          : format === "hex"
            ? digest.toString("hex")
            : digest.toString("base64");
      expect(verifyInboundSignature(body, value, "another-secret", format)).toBe(false);
      expect(verifyInboundSignature(body, value, "", format)).toBe(false);
      expect(verifyInboundSignature(body, undefined, secret, format)).toBe(false);
      expect(verifyInboundSignature(body, "", secret, format)).toBe(false);
    }
  });

  test("どの形式でも、body が1バイト変われば false(生バイトで計算している)", () => {
    const tampered = `${body} `;
    for (const format of INBOUND_SIGNATURE_FORMATS) {
      const value =
        format === "sha256_hex"
          ? `sha256=${digest.toString("hex")}`
          : format === "hex"
            ? digest.toString("hex")
            : digest.toString("base64");
      expect(verifyInboundSignature(tampered, value, secret, format)).toBe(false);
    }
  });

  test("どの形式でも、壊れた値は例外を投げず false(長さ違い・不正文字)", () => {
    for (const format of INBOUND_SIGNATURE_FORMATS) {
      expect(verifyInboundSignature(body, "!!!not-a-signature!!!", secret, format)).toBe(false);
      expect(verifyInboundSignature(body, "abcd", secret, format)).toBe(false);
    }
  });

  test("【`D-V5-85` / 限定5】決済サービス(Stripe)の署名形式は3形式のどれでも false", () => {
    // Stripe が実際に送る形: `t=<unix秒>,v1=<hex(HMAC-SHA256("<t>.<body>", secret))>`。
    // **HMAC の入力がタイムスタンプと body の連結である**ため、生バイト body で計算する
    // 本関数とは原理的に一致しない(`ADR-0160` 限定5 が連結を禁じている)。
    const t = "1717171717";
    const stripeDigest = createHmac("sha256", secret)
      .update(Buffer.from(`${t}.${body}`, "utf-8"))
      .digest("hex");
    const stripeValue = `t=${t},v1=${stripeDigest}`;
    for (const format of INBOUND_SIGNATURE_FORMATS) {
      expect(verifyInboundSignature(body, stripeValue, secret, format)).toBe(false);
    }
    // 連結を外した「v1 の hex だけ」でも一致しない(入力が違うので当然だが、明示的に固定する)。
    for (const format of INBOUND_SIGNATURE_FORMATS) {
      expect(verifyInboundSignature(body, stripeDigest, secret, format)).toBe(false);
    }
  });
});
