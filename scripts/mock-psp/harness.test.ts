/**
 * モック PSP ハーネスの単体テスト(V2-M5-T03 / EC-G16・門外)。
 *
 * 固定するのは(タスク完了条件):
 *  - success / failure / timeout の3経路が**決定論**(同じ入力 → 同じ Webhook / 同じ有無)
 *  - 署名が正しく付く(受信側 `verifyInboundSignature` が独立実装で一致する)
 *  - カード情報が要求・Webhook のどちらの payload にも現れない
 *  - timeout は Webhook を返さない(欠落再現)が、黙って消さず証跡に残す(憲法6)
 */
import { describe, expect, test } from "bun:test";
// **受信側の検証器**を import して、独立実装のモック署名が受信側で一致することを実証する
// (取り決め = HMAC-SHA256(生バイト, 鍵) の相互運用性。コードは共有していない)。
import { verifyInboundSignature } from "../../src/kernel/inbound-verify.ts";
import {
  assertNoCardFields,
  type ChargeRequest,
  decideWebhook,
  deriveEventId,
  MockPsp,
} from "./harness.ts";
import { MOCK_PSP_SIGNATURE_HEADER, signWebhookBody } from "./signer.ts";

const SECRET = "shared-signing-secret-for-mock-psp";

function charge(overrides: Partial<ChargeRequest> = {}): ChargeRequest {
  return {
    order_id: "order-abc",
    amount: 12345,
    currency: "JPY",
    idempotency_key: "order-abc",
    callback_url: "http://127.0.0.1:9/inbound/ep-1",
    mock_outcome: "success",
    mock_delay_ms: 0,
    ...overrides,
  };
}

// --- 決定論 --------------------------------------------------------------------

describe("決定論(同じ入力 → 同じ出力)", () => {
  test("event_id は idempotency_key から決定論的に導かれる(乱数なし)", () => {
    const a = deriveEventId("order-abc");
    const b = deriveEventId("order-abc");
    expect(a).toBe(b);
    expect(a.startsWith("evt_")).toBe(true);
    expect(deriveEventId("order-xyz")).not.toBe(a);
  });

  test("success → charge.succeeded / paid(同じ入力で同じ Webhook)", () => {
    const w1 = decideWebhook(charge({ mock_outcome: "success" }));
    const w2 = decideWebhook(charge({ mock_outcome: "success" }));
    expect(w1).toEqual(w2);
    expect(w1?.event_type).toBe("charge.succeeded");
    expect(w1?.status).toBe("paid");
    expect(w1?.order).toBe("order-abc");
    expect(w1?.amount).toBe(12345);
    expect(w1?.currency).toBe("JPY");
  });

  test("failure → charge.failed / failed", () => {
    const w = decideWebhook(charge({ mock_outcome: "failure" }));
    expect(w?.event_type).toBe("charge.failed");
    expect(w?.status).toBe("failed");
  });

  test("timeout → Webhook を返さない(null)", () => {
    expect(decideWebhook(charge({ mock_outcome: "timeout" }))).toBeNull();
  });
});

// --- 署名(独立実装が受信側で一致)------------------------------------------------

describe("署名(HMAC-SHA256 / 受信側と相互運用)", () => {
  test("モックが付けた署名を受信側の verifyInboundSignature が受理する", () => {
    const w = decideWebhook(charge());
    const rawBody = JSON.stringify(w);
    const header = signWebhookBody(rawBody, SECRET);
    expect(header.startsWith("sha256=")).toBe(true);
    // **受信側の独立実装が一致する**(生バイト body・同じ鍵)。
    expect(verifyInboundSignature(rawBody, header, SECRET)).toBe(true);
  });

  test("鍵が違えば受信側は拒否する(改竄・誤鍵の検出)", () => {
    const rawBody = JSON.stringify(decideWebhook(charge()));
    const header = signWebhookBody(rawBody, SECRET);
    expect(verifyInboundSignature(rawBody, header, "wrong-secret")).toBe(false);
  });

  test("body が1バイトでも違えば受信側は拒否する", () => {
    const rawBody = JSON.stringify(decideWebhook(charge()));
    const header = signWebhookBody(rawBody, SECRET);
    expect(verifyInboundSignature(`${rawBody} `, header, SECRET)).toBe(false);
  });
});

// --- カード情報を持たない ----------------------------------------------------------

describe("カード情報を一切持たない(03 §6a / 憲法6)", () => {
  test("決済要求の payload に PAN/CVV 等のキーが無い", () => {
    const c = charge();
    // 例外を投げなければキーに card 系が無い。
    expect(() =>
      assertNoCardFields(c as unknown as Record<string, unknown>, "決済要求"),
    ).not.toThrow();
    // 明示的に禁止キーが無いことも確認。
    const keys = Object.keys(c);
    for (const forbidden of ["pan", "cvv", "card_number", "expiry"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test("Webhook body の payload にカード情報のキーが無い", () => {
    const w = decideWebhook(charge());
    expect(() =>
      assertNoCardFields(w as unknown as Record<string, unknown>, "Webhook"),
    ).not.toThrow();
    expect(Object.keys(w ?? {})).toEqual([
      "event_id",
      "event_type",
      "order",
      "amount",
      "currency",
      "status",
    ]);
  });

  test("assertNoCardFields はカード情報らしきキーで loud に落ちる", () => {
    expect(() => assertNoCardFields({ pan: "4242" }, "決済要求")).toThrow();
    expect(() => assertNoCardFields({ card_cvv: "123" }, "決済要求")).toThrow();
  });
});

// --- handleCharge / 配送 / drain(注入 deliver で受信側に着地させる)---------------------

describe("handleCharge → 署名付き Webhook 配送(deliver 注入)", () => {
  /** deliver を注入して、モックが送る署名付き Request を捕捉する。 */
  function capturingPsp() {
    const captured: { url: string; signature: string; body: string; status: number }[] = [];
    const psp = new MockPsp({
      sharedSecret: SECRET,
      deliver: async (input, init) => {
        const url = typeof input === "string" ? input : String(input);
        const headers = new Headers(init?.headers);
        captured.push({
          url,
          signature: headers.get(MOCK_PSP_SIGNATURE_HEADER) ?? "",
          body: String(init?.body ?? ""),
          status: 201,
        });
        return new Response(null, { status: 201 });
      },
    });
    return { psp, captured };
  }

  test("success: 202 を返し、後から署名付き Webhook を1本配送する", async () => {
    const { psp, captured } = capturingPsp();
    const res = await psp.handleCharge(
      new Request("http://127.0.0.1/mock-psp/charges", {
        method: "POST",
        body: JSON.stringify(charge({ mock_outcome: "success" })),
      }),
    );
    expect(res.status).toBe(202);
    await psp.drain();
    expect(captured).toHaveLength(1);
    // 送った body は受信側検証を通る署名が付いている。
    const sent = captured[0];
    if (sent === undefined) throw new Error("配送が捕捉できませんでした");
    expect(verifyInboundSignature(sent.body, sent.signature, SECRET)).toBe(true);
    expect(psp.ledger.charges).toHaveLength(1);
    expect(psp.ledger.deliveries).toHaveLength(1);
  });

  test("timeout: 202 を返すが Webhook は1本も配送しない(欠落再現・証跡に残す)", async () => {
    const { psp, captured } = capturingPsp();
    const res = await psp.handleCharge(
      new Request("http://127.0.0.1/mock-psp/charges", {
        method: "POST",
        body: JSON.stringify(charge({ mock_outcome: "timeout" })),
      }),
    );
    expect(res.status).toBe(202);
    await psp.drain();
    expect(captured).toHaveLength(0);
    // 黙って消さず、抑止した事実を証跡に残す(憲法6)。
    expect(psp.ledger.suppressed).toHaveLength(1);
    expect(psp.ledger.suppressed[0]?.reason).toBe("timeout");
  });

  test("不正な charge(必須欠落)→ 400・配送しない", async () => {
    const { psp } = capturingPsp();
    const res = await psp.handleCharge(
      new Request("http://127.0.0.1/mock-psp/charges", {
        method: "POST",
        body: JSON.stringify({ order_id: "x" }),
      }),
    );
    expect(res.status).toBe(400);
    await psp.drain();
    expect(psp.ledger.deliveries).toHaveLength(0);
  });
});
