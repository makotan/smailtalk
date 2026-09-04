/**
 * モック PSP テストハーネス(V2-M5-T03 / EC-G16・門外・カーネル外)。
 *
 * **実 PSP の非同期パターンを模す**: 決済要求を受け(`POST /mock-psp/charges`)、`202 Accepted`
 * を即返し、`mock_delay_ms` 経過後に `mock_outcome` に従って**署名付き Webhook** を
 * `callback_url`(= プラットフォームの受信口 `POST /inbound/<endpoint-id>`)へ POST する
 * (03 §2)。実際の資金移動・カードネットワーク接続はしない(D-3)。
 *
 * ## 厳守する境界(03 §6a / 憲法6)
 * - **カード情報を一切持たない。**要求・Webhook とも `amount` / `currency` / `order` だけを扱い、
 *   PAN・CVV・有効期限などは型のどのフィールドにも現れない(`assertNoCardFields` で機械確認)。
 * - **localhost 固定**(`listen()` は `127.0.0.1` にだけ束ねる。03 §6a)。
 * - **決定論**(乱数・実時刻依存なし)。返す Webhook・event_id・遅延はすべて要求の制御フィールド
 *   (`mock_outcome` / `mock_delay_ms` / `idempotency_key`)だけで決まる。同じ入力なら同じ Webhook が
 *   同じタイミングで返る(03 §2c)。**唯一の例外は Webhook に含めない** —— created_at のような
 *   実時刻由来の値は Webhook に載せず、受信を記録する時刻はプラットフォーム側の `_created_at`
 *   システム列に委ねる(受信テーブルのフィールドを増やさず、body を完全に決定論に保つ)。
 * - **カーネル語彙を1つも触らない**(`scripts/` 側。RESOURCE_KINDS/FIELD_TYPES/DIFF_OPS 不変)。
 *
 * ## 証跡(mcp-trial の attribution と同型)
 * 送った 202 応答・返した Webhook(body・署名・宛先・結果)を `ledger` に機械判定できる形で残す。
 */
import { MOCK_PSP_SIGNATURE_HEADER, signWebhookBody } from "./signer.ts";

/** 決済結果の制御(決定論。実 PSP には無いモック専用フィールド。03 §2c)。 */
export type MockOutcome = "success" | "failure" | "timeout";

/**
 * プラットフォーム → モック PSP の決済要求(03 §2a)。
 * **カード情報は無い。**`amount` / `currency` / `order_id` だけを扱う(PAN/CVV/有効期限は無い)。
 */
export interface ChargeRequest {
  /** 対象注文の id(= 注文レコードの _id。$record._id 由来)。Webhook でそのまま echo する。 */
  order_id: string;
  /** 金額(最小通貨単位=整数。$record.total)。 */
  amount: number;
  /** 通貨(単一通貨。$record.currency)。 */
  currency: string;
  /** 冪等キー(注文ごとに一意。event_id の決定論生成の種)。 */
  idempotency_key: string;
  /** Webhook の返し先(プラットフォームの受信口 URL)。 */
  callback_url: string;
  /** 返す Webhook の種類を強制(決定論)。 */
  mock_outcome: MockOutcome;
  /** Webhook を返すまでの遅延(ms)。0 で(次 tick で)即時。 */
  mock_delay_ms: number;
}

/**
 * モック PSP → プラットフォームの Webhook body(03 §2b)。
 * **受信テーブル(payment_events)のフィールドと1対1**である —— 受信ルートは書込先テーブルに
 * 無いフィールドを 400 で弾く(1行 create 限定・限定5)ので、body のキーは受信テーブルの
 * フィールドと過不足なく一致していなければならない。
 *
 * `order` は要求の `order_id` をそのまま載せる(受信テーブルの reference フィールド `order` に
 * 着地して、EC-G13 target `$record.order` が対応注文を狙えるようにする)。**カード情報は無い。**
 */
export interface WebhookBody {
  /** モック PSP が発行する一意 ID(冪等キー。受信側 unique で重複排除。決定論生成)。 */
  event_id: string;
  /** イベント種別("charge.succeeded" | "charge.failed")。 */
  event_type: "charge.succeeded" | "charge.failed";
  /** 対象注文の参照(= 要求の order_id。受信テーブルの reference フィールド `order` に着地)。 */
  order: string;
  amount: number;
  currency: string;
  /** 決済状態("paid" | "failed")。受信テーブル on_create の when 条件分岐(EC-G5)が読む。 */
  status: "paid" | "failed";
}

/** 送った 202 応答の証跡。 */
export interface ChargeLedgerEntry {
  request: ChargeRequest;
  responseStatus: number;
}

/** 返した Webhook の証跡(body・署名・宛先・配送結果)。 */
export interface DeliveryLedgerEntry {
  callbackUrl: string;
  rawBody: string;
  signatureHeader: string;
  /** 配送 fetch のステータス。配送自体が失敗(接続不能等)したら null。 */
  deliveredStatus: number | null;
}

/**
 * Webhook を配送する関数(注入口)。既定はグローバル `fetch`。
 * **`typeof fetch` を使わない** —— `fetch` 型は `preconnect` プロパティまで要求するため、
 * テストで差し替える素朴な関数が型不一致になる。配送に必要な最小の呼び出し面だけを型にする。
 */
export type WebhookDeliverer = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>;

/** timeout のとき「意図的に Webhook を返さなかった」ことも証跡に残す(黙って消さない。憲法6)。 */
export interface SuppressedLedgerEntry {
  reason: "timeout";
  orderId: string;
}

/** ハーネスの証跡一式(機械判定用)。 */
export interface MockPspLedger {
  charges: ChargeLedgerEntry[];
  deliveries: DeliveryLedgerEntry[];
  suppressed: SuppressedLedgerEntry[];
}

/**
 * 決済要求から発行する event_id を**決定論的に**導く(03 §2c)。乱数を使わない ——
 * 同じ idempotency_key なら必ず同じ event_id になり、受信側の unique による冪等が再現できる。
 * 署名鍵とは無関係の公開ハッシュでよい(秘密ではない。単なる決定論 ID)。
 */
export function deriveEventId(idempotencyKey: string): string {
  // 署名(HMAC)ではなく素の SHA-256。event_id は秘密ではないので鍵を使わない。
  const hex = new Bun.CryptoHasher("sha256").update(idempotencyKey).digest("hex");
  return `evt_${hex.slice(0, 24)}`;
}

/**
 * 決済要求から返すべき Webhook body を決める(決定論)。**timeout は null**(Webhook を返さない
 * = 欠落を再現。03 §2c / D-G4a)。success/failure は event_type / status を対応付ける。
 * card 情報は入力にも出力にも無い。
 */
export function decideWebhook(charge: ChargeRequest): WebhookBody | null {
  if (charge.mock_outcome === "timeout") {
    return null;
  }
  const succeeded = charge.mock_outcome === "success";
  return {
    event_id: deriveEventId(charge.idempotency_key),
    event_type: succeeded ? "charge.succeeded" : "charge.failed",
    order: charge.order_id,
    amount: charge.amount,
    currency: charge.currency,
    status: succeeded ? "paid" : "failed",
  };
}

/** カード情報とみなすキー(これらが payload に現れたら憲法6 違反)。 */
const CARD_FIELD_PATTERN = /(pan|card|cvv|cvc|expiry|exp_month|exp_year|pin|track|magstripe)/i;

/**
 * オブジェクトのキーにカード情報らしきものが**1つも無い**ことを確認する(03 §6a / 憲法6)。
 * ハーネスが要求・Webhook のどちらでもカード情報を運ばないことを機械的に固定する。
 * @throws カード情報らしきキーが見つかったら例外(黙って通さない)。
 */
export function assertNoCardFields(payload: Record<string, unknown>, context: string): void {
  for (const key of Object.keys(payload)) {
    if (CARD_FIELD_PATTERN.test(key)) {
      throw new Error(`モック PSP はカード情報を扱いません(${context} に禁止キー "${key}")。`);
    }
  }
}

/** `charge` が ChargeRequest の必須フィールドを満たすかの最小検査(モック側の入口)。 */
function isChargeRequest(value: unknown): value is ChargeRequest {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const c = value as Record<string, unknown>;
  return (
    typeof c.order_id === "string" &&
    typeof c.amount === "number" &&
    typeof c.currency === "string" &&
    typeof c.idempotency_key === "string" &&
    typeof c.callback_url === "string" &&
    (c.mock_outcome === "success" ||
      c.mock_outcome === "failure" ||
      c.mock_outcome === "timeout") &&
    typeof c.mock_delay_ms === "number"
  );
}

/** `listen()` の戻り値(Bun.serve のハンドル)。 */
export interface MockPspServerHandle {
  /** 決済要求を受ける URL(`http://127.0.0.1:<port>/mock-psp/charges`)。 */
  chargesUrl: string;
  /** 束ねたポート(0 指定で OS が採る)。 */
  port: number;
  /** サーバを停止する。 */
  stop(): void;
}

/**
 * モック PSP ハーネス本体。
 *
 * `deliver`(Webhook を送る fetch)は注入できる —— 既定はグローバル `fetch`(実 HTTP。
 * `listen()` で立てた受信口へ本物のネットワーク越しに POST する)。テストで受信側を
 * Hono の `app.fetch` に差すこともできるが、E2E は既定の実 fetch を使い、本物の署名付き
 * HTTP Webhook を 127.0.0.1 越しに配送する。
 */
export class MockPsp {
  private readonly sharedSecret: string;
  private readonly deliver: WebhookDeliverer;
  readonly ledger: MockPspLedger = { charges: [], deliveries: [], suppressed: [] };
  /** 進行中の Webhook 配送(drain で待つ)。 */
  private readonly pending = new Set<Promise<void>>();

  constructor(opts: { sharedSecret: string; deliver?: WebhookDeliverer }) {
    this.sharedSecret = opts.sharedSecret;
    // 既定は実 fetch(`listen()` で立てた受信口へ本物のネットワーク越しに POST する)。
    this.deliver = opts.deliver ?? ((url, init) => fetch(url, init));
  }

  /**
   * 決済要求を処理する(Bun.serve の fetch ハンドラとしても、直接呼びとしても使える)。
   * `202 Accepted` を即返し、`mock_delay_ms` 後に署名付き Webhook を配送する(timeout は返さない)。
   */
  async handleCharge(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid json" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    if (!isChargeRequest(body)) {
      return new Response(JSON.stringify({ error: "invalid charge request" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    const charge = body;
    // **カード情報を運んでいないことを入口で機械確認**(万一足されたら loud に落ちる)。
    assertNoCardFields(charge as unknown as Record<string, unknown>, "決済要求");

    this.ledger.charges.push({ request: charge, responseStatus: 202 });

    // 非同期で Webhook を配送する(実 PSP と同じく結果は同期応答では返さない)。
    this.scheduleDelivery(charge);

    // 同期応答は 202(受理した、後で Webhook を返す)。決済結果はここでは返さない。
    return new Response(JSON.stringify({ accepted: true }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }

  /** `mock_delay_ms` 後に Webhook を配送する予約を積む。timeout は配送しない(欠落再現)。 */
  private scheduleDelivery(charge: ChargeRequest): void {
    const webhook = decideWebhook(charge);
    if (webhook === null) {
      // timeout: Webhook を返さない。**黙って消さず**証跡に残す(憲法6・D-G4a)。
      this.ledger.suppressed.push({ reason: "timeout", orderId: charge.order_id });
      return;
    }
    const promise = (async () => {
      if (charge.mock_delay_ms > 0) {
        await Bun.sleep(charge.mock_delay_ms);
      } else {
        // 0 でも「非同期で後から返る」ことを保つ(次 tick)。
        await Promise.resolve();
      }
      await this.postWebhook(charge.callback_url, webhook);
    })();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  /** 署名付き Webhook を callback_url へ POST する(生バイト body で署名 = 一致の担保)。 */
  private async postWebhook(callbackUrl: string, webhook: WebhookBody): Promise<void> {
    // **署名対象と送信 body を同一の文字列にする**(再シリアライズしない = 受信側で一致する)。
    assertNoCardFields(webhook as unknown as Record<string, unknown>, "Webhook");
    const rawBody = JSON.stringify(webhook);
    const signatureHeader = signWebhookBody(rawBody, this.sharedSecret);
    let deliveredStatus: number | null = null;
    try {
      const res = await this.deliver(callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [MOCK_PSP_SIGNATURE_HEADER]: signatureHeader,
        },
        body: rawBody,
      });
      deliveredStatus = res.status;
    } catch {
      // 配送自体が失敗(接続不能等)。結果整合(03 §6b-2)—— 補償はしない(D-G4a)。
      deliveredStatus = null;
    }
    this.ledger.deliveries.push({ callbackUrl, rawBody, signatureHeader, deliveredStatus });
  }

  /** 進行中の Webhook 配送をすべて待つ(E2E が「Webhook が着地するまで」を待つための口)。 */
  async drain(): Promise<void> {
    // 配送中にさらに配送が積まれることは無い(1 charge = 1 delivery)が、念のためループする。
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  /**
   * `127.0.0.1` に Bun.serve で束ね、決済要求 URL を返す(実プロセス。03 §6a の localhost 固定)。
   * `/mock-psp/charges` 以外は 404。
   */
  listen(): MockPspServerHandle {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/mock-psp/charges") {
          return this.handleCharge(req);
        }
        return new Response("not found", { status: 404 });
      },
    });
    const boundPort = server.port ?? 0;
    return {
      chargesUrl: `http://127.0.0.1:${boundPort}/mock-psp/charges`,
      port: boundPort,
      stop: () => server.stop(true),
    };
  }
}
