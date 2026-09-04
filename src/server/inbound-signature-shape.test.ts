/**
 * 受信口ごとに宣言した「署名の形」で、**実際に署名付きの HTTP リクエストを投げる**統合テスト
 * (`V5-M15` / `G-G9` / `G-G10` / `ADR-0160`)。
 *
 * **本物の SQLite と本物の Hono アプリを使い、字面の検査で済ませない。**
 * `inbound-route.test.ts` が既定の形1本を固定しているのに対し、ここは **3値 × 3形式 = 9通り**
 * それぞれについて次の2方向を実測する(`ADR-0160` 限定9 の「3×3の組み合わせに増える」):
 *
 *  - **(P) 通る側**: 宣言どおりの形の正しい署名 → **201・1行 create**
 *  - **(N) 落ちる側**: 同じリクエストの署名を1バイト崩す → **401・DB の行が1件も増えない**
 *    (**バリデーション層ではなく実行層で止まっていることを、DB を直接開いて数えて確かめる**)
 *
 * あわせて `ADR-0160` の限定表に1点ずつ当てる:
 *
 *  - (S) **限定5 / `D-V5-85`**: **決済サービス(Stripe)の署名形式は今日も受けられない。**
 *    `t=<ts>,v1=<hex>`(HMAC の入力がタイムスタンプと body の連結)を、**3つのヘッダ名すべての
 *    宣言に対して**投げ、**9通りすべてで 401・書込ゼロ**であることを実測する。
 *    **「できないことをできないと固定する」検査である**(限定5 の「どこで機械的に固定するか」欄の逐語)。
 *  - (X) **限定1**: 宣言できるヘッダは1本だけ。**別のヘッダに正しい署名を付けても通らない。**
 *  - (Y) **限定3**: アルゴリズムを選ぶ場所が無い(SHA-1 / SHA-512 / 公開鍵署名の綴りが実装に無い)。
 *  - (Z) **限定6 / 限定7 / 限定10 / 限定11**: 書込 API が MCP / `apply_diff` に結線されない /
 *    `schemas/` に署名の綴りが無い / `RESOURCE_KINDS` `FIELD_TYPES` `DIFF_OPS` が動いていない /
 *    `src/kernel/` の公開面の増分がスナップショットに名指しで載っている。
 *
 * **測っていないもの(先に書く)**: **GitHub / 決済サービスの実サーバから来た本物の Webhook は
 * 1度も受けていない。** ここで投げているのは、このテストが自分で HMAC を計算して付けた
 * リクエストである。**「実在のサービスから受け取れた」とは書けない**(`ADR-0160` §5 の 2)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboundStore } from "../kernel/inbound-store.ts";
import {
  INBOUND_SIGNATURE_FORMATS,
  INBOUND_SIGNATURE_HEADERS,
  type InboundSignatureFormat,
  type InboundSignatureHeader,
} from "../kernel/inbound-verify.ts";
// 【`V5-M29-T06` / メインの裁定1】**`DIFF_OPS` / `FIELD_TYPES` / `RESOURCE_KINDS` の値 import を
//   消した。** `V5-M29-T05` は「消すと `scripts/kernel-import-snapshot.txt` の行が減り、それを
//   sha で固定している `scripts/industry-neutral-examples.test.ts`(`ADR-0163` 限定3)が
//   赤くなる」ことを理由に残し、`TS6133` と `noUnusedImports` を残した。
//   **メインは消す側を採った。** スナップショットからは本ファイルの3行を含む計9行を消し、
//   `industry-neutral-examples.test.ts` の基準値は同ファイルの作法(旧値を消さずコメントに
//   残す)どおり更新した。
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";

/**
 * 移した公開単位の根(`apps/smailtalk/`)。**`import.meta.dir` から数える** ——
 * cwd 相対で解くと `bun test` を打つ場所で結果が変わる(`src/` はもうルート直下に無い)。
 */
const PRODUCT_ROOT = join(import.meta.dir, "..", "..");

const APP_ID = "notify";
const SIGNING_KEY = "test-inbound-signing-key-shape";
const KEY_ENV_VAR = "ST_TEST_INBOUND_SHAPE_KEY";

/*
 * =====================================================================================
 * **【`V8-M26`。この題材は「最小形」ではなくなった。理由を隠さずに書く】**
 * =====================================================================================
 *
 * **`V8-M26` が面(役割に束ねた権限)の既定を「閉じる」側へ倒した**(ユーザ決定 `D-V8-45` /
 * `D-V8-58` / `D-V8-65`)—— **規則を1本も名指ししていない表への書込は拒否される。**
 * **受信の主体(`system:inbound`)は実効ロール集合を持たないので、面はこれを未ログイン
 * (`anonymous`)として評価する。****`anonymous` の規則に `write` は書けない**
 * (schema が `can` を `["read"]` に閉じている)—— **面から通す道は今日1本も無い。**
 *
 * **唯一残った道が、`src/server/inbound-route.ts` の 403 の hint の逐語
 * 「参加者の表に "system:inbound" の行を1件作ると、この受信口は今までどおり書き込めます」
 * である。****本題材はその手当てを施したものであり、点(行ごとのアクセス権)が
 * `combineRoleAndGrantAccess` の `OR` で面の拒否を越える。**
 *
 * **【`V8-M26` で失われたものを、丸めずに書く】** **本ファイルの主題は署名の形
 * (ヘッダ3種 × 形式3種)であって権限ではない。****それでも `events` 1表だけの
 * 「最小形」では今日 1行も書けない** —— **署名の検査を成立させるためだけに、
 * 参加者の表と付与の表を足している。**
 *
 * =====================================================================================
 * **【`D-V8-67` により作り直した(2026-08-10)。上の節は1バイトも消していない】**
 * =====================================================================================
 *
 * **ユーザ決定 `D-V8-67` の見出しの逐語: 「受信口は「持ち主が書いている」として扱う」。**
 * **受信の主体は今日、面から見て **持ち主(`owner`)** である** —— **上の節の逐語
 * 「面から通す道は今日1本も無い」は今日は偽である。**
 *
 * **点(行ごとのアクセス権)の足場 —— `events` の `access_control` 宣言と
 * `event_member` / `event_grant` の2表と `seedInboundMember()` —— は撤去した。**
 * **代わりに `app.roles` の持ち主に `events` の書込を1本だけ配る** ——
 * **表が3本から1本へ戻り、`createRecord` の層またぎ import も1本消えた**
 * (`scripts/kernel-import-snapshot.txt` に本ファイルの行を足す必要が無くなった)。
 */

/** 受信テーブル(外部サービスからの通知1件をそのまま1行にする最小形)。 */
function inboundManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "通知の受け口",
      tables: [
        {
          id: "events",
          name: "受信イベント",
          fields: [
            { id: "event_id", name: "イベントID", type: "text", required: true, unique: true },
            { id: "event_type", name: "種類", type: "text", required: true },
          ],
          // **【`V8-M26`】ここに `access_control`(点)の宣言を、`event_member` /
          // `event_grant` の2表とともに足していた。**
          // **【`D-V8-67` により撤去した】**(上の節)。
        },
      ],
      views: [],
      // **【`D-V8-67`】受信を通す道はこの1本である** —— **持ち主に `events` の書込を配る。**
      // **署名の形(ヘッダ3種 × 形式3種)の測定を1ミリも変えない。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(類型17 の拡張)。
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "events", can: ["read", "write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-inbound-shape-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "通知の受け口", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, inboundManifest()).valid).toBe(true);
  process.env[KEY_ENV_VAR] = SIGNING_KEY;
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  delete process.env[KEY_ENV_VAR];
  await rm(dataRoot, { recursive: true, force: true });
});

/** 人間 owner が「署名の形」を宣言して受信口を発行する(`ADR-0160` 限定6。AI 経路は通らない)。 */
function issueEndpoint(
  name: string,
  signatureHeader: InboundSignatureHeader,
  signatureFormat: InboundSignatureFormat,
): string {
  const inbound = InboundStore.openForKernel(dataRoot);
  try {
    return inbound.issueInboundEndpoint({
      appId: APP_ID,
      name,
      secretSource: { kind: "env", value: KEY_ENV_VAR },
      targetTable: "events",
      signatureHeader,
      signatureFormat,
    }).id;
  } finally {
    inbound.close();
  }
}

/** 送り手が実際に付ける署名の値を、形式ごとに組み立てる(**生バイト body の HMAC-SHA256**)。 */
function signatureValue(
  rawBody: string,
  format: InboundSignatureFormat,
  key = SIGNING_KEY,
): string {
  const digest = createHmac("sha256", key).update(Buffer.from(rawBody, "utf-8")).digest();
  if (format === "sha256_hex") {
    return `sha256=${digest.toString("hex")}`;
  }
  if (format === "hex") {
    return digest.toString("hex");
  }
  return digest.toString("base64");
}

/** 受信口へ POST する(ヘッダ名は呼び出し側が明示する —— どのヘッダに載せるかがこの検査の主題)。 */
async function postInbound(
  endpointId: string,
  rawBody: string,
  headerName: string | null,
  headerValue: string | null,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (headerName !== null && headerValue !== null) {
    headers[headerName] = headerValue;
  }
  return app.request(
    new Request(`http://localhost/inbound/${endpointId}`, {
      method: "POST",
      headers,
      body: rawBody,
    }),
  );
}

/** `events` の行数を**本物の SQLite を直接開いて**数える(迂回テスト。HTTP を通さない)。 */
function eventRowCount(): number {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readonly: true });
  try {
    return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM "events"`).get()?.n ?? 0;
  } finally {
    db.close();
  }
}

function body(eventId: string): string {
  return JSON.stringify({ event_id: eventId, event_type: "notification" });
}

// --- (P) 通る側: 3値 × 3形式 = 9通りで、宣言どおりの署名が実際に通る -------------------
//
// **9本を1本ずつ名前を持つテストにする**(ループの中で回すと、落ちた1通りがどれか分からない)。

for (const headerName of INBOUND_SIGNATURE_HEADERS) {
  for (const format of INBOUND_SIGNATURE_FORMATS) {
    test(`(P) ${headerName} × ${format}: 宣言どおりの署名付きリクエストが 201 で1行 create される`, async () => {
      const endpointId = issueEndpoint(`p-${headerName}-${format}`, headerName, format);
      const raw = body(`evt-p-${format}`);
      const res = await postInbound(endpointId, raw, headerName, signatureValue(raw, format));
      expect(res.status).toBe(201);
      expect(eventRowCount()).toBe(1);
    });
  }
}

// --- (N) 落ちる側: 同じ9通りで、署名を崩すと 401 かつ **DB の行が1件も増えない** ----------
//
// **`ADR-0160` 限定9 の中心である** —— 「実行層(書込直前)で止まる・1バイトも書かず遮断」が
// **1ミリも緩んでいない**ことを、9通りすべてで DB を直接数えて確かめる。

for (const headerName of INBOUND_SIGNATURE_HEADERS) {
  for (const format of INBOUND_SIGNATURE_FORMATS) {
    test(`(N) ${headerName} × ${format}: 署名不一致は 401 で遮断され、DB に1バイトも書かれない`, async () => {
      const endpointId = issueEndpoint(`n-${headerName}-${format}`, headerName, format);
      const raw = body(`evt-n-${format}`);
      // 別の body で作った正しい形の署名を付ける(形は合っているが値が一致しない)。
      const wrong = signatureValue(body("other-event"), format);
      const res = await postInbound(endpointId, raw, headerName, wrong);
      expect(res.status).toBe(401);
      expect(eventRowCount()).toBe(0);

      // 鍵が違う署名でも同じ(形は合っている・鍵だけ違う)。
      const wrongKey = signatureValue(raw, format, "not-the-signing-key");
      expect((await postInbound(endpointId, raw, headerName, wrongKey)).status).toBe(401);
      expect(eventRowCount()).toBe(0);

      // ヘッダ欠落でも同じ。
      expect((await postInbound(endpointId, raw, null, null)).status).toBe(401);
      expect(eventRowCount()).toBe(0);
    });
  }
}

// --- (N2) 形式違い: 値の書き表し方が宣言と違えば、値そのものが正しくても落ちる ------------

for (const format of INBOUND_SIGNATURE_FORMATS) {
  test(`(N2) ${format} を宣言した受信口に別の形式で書いた署名を送ると 401・書込ゼロ`, async () => {
    const endpointId = issueEndpoint(`n2-${format}`, "X-Hub-Signature-256", format);
    const raw = body(`evt-n2-${format}`);
    for (const other of INBOUND_SIGNATURE_FORMATS.filter((f) => f !== format)) {
      const res = await postInbound(
        endpointId,
        raw,
        "X-Hub-Signature-256",
        signatureValue(raw, other),
      );
      expect(res.status).toBe(401);
      expect(eventRowCount()).toBe(0);
    }
    // 宣言どおりの形式なら同じ受信口が通る(落ちているのが「形式違い」であることの対照)。
    const ok = await postInbound(
      endpointId,
      raw,
      "X-Hub-Signature-256",
      signatureValue(raw, format),
    );
    expect(ok.status).toBe(201);
    expect(eventRowCount()).toBe(1);
  });
}

// --- (S) 【`D-V5-85` / `ADR-0160` 限定5】決済サービスの署名形式は今日も受けられない ---------
//
// **これは「できるようになったこと」ではなく「できないままであること」を固定する検査である。**
// 決済サービス(Stripe)が実際に送るのは `Stripe-Signature: t=<unix秒>,v1=<hex>` で、
// **HMAC の入力が「<t>.<body>」という連結**である。`ADR-0160` 限定5 は HMAC の入力を
// **受信生バイト body に固定**しており、連結を書ける場所を1つも作っていない。
//
// **`Stripe-Signature` というヘッダ名は宣言できてしまう**(限定2 の3値に入っている)。
// **だからこそ、宣言しても受からないことを実測で残す** —— 宣言できることが
// 「受けられる」と誤読されるのを、この検査だけが止めている。

/** 決済サービス(Stripe)が実際に送る形の署名値を作る(タイムスタンプ連結)。 */
function paymentServiceStyleSignature(rawBody: string, timestamp = "1717171717"): string {
  const v1 = createHmac("sha256", SIGNING_KEY)
    .update(Buffer.from(`${timestamp}.${rawBody}`, "utf-8"))
    .digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

for (const headerName of INBOUND_SIGNATURE_HEADERS) {
  test(`(S) ${headerName} を宣言しても、決済サービス形式(t=...,v1=...)は3形式すべてで 401・書込ゼロ`, async () => {
    const raw = body("evt-payment");
    for (const format of INBOUND_SIGNATURE_FORMATS) {
      const endpointId = issueEndpoint(`s-${headerName}-${format}`, headerName, format);
      const res = await postInbound(endpointId, raw, headerName, paymentServiceStyleSignature(raw));
      expect(res.status).toBe(401);
      expect(eventRowCount()).toBe(0);
    }
  });
}

test("(S2) 連結を外して v1 の hex だけを送っても通らない(HMAC の入力が違う)", async () => {
  const endpointId = issueEndpoint("s2", "Stripe-Signature", "hex");
  const raw = body("evt-payment-2");
  const v1 = createHmac("sha256", SIGNING_KEY)
    .update(Buffer.from(`1717171717.${raw}`, "utf-8"))
    .digest("hex");
  const res = await postInbound(endpointId, raw, "Stripe-Signature", v1);
  expect(res.status).toBe(401);
  expect(eventRowCount()).toBe(0);
});

test("(S3) 遮断の応答に署名検証鍵が平文で現れない(どのヘッダ名を宣言しても)", async () => {
  for (const headerName of INBOUND_SIGNATURE_HEADERS) {
    const endpointId = issueEndpoint(`s3-${headerName}`, headerName, "sha256_hex");
    const res = await postInbound(endpointId, body("evt-leak"), headerName, "sha256=deadbeef");
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain(SIGNING_KEY);
    // hint は**宣言したヘッダ名**を案内する(グローバル定数の直書きをやめた分)。
    expect(text).toContain(headerName);
  }
});

// --- (X) 限定1: 宣言できるヘッダは1本だけ ------------------------------------------

test("(X) 限定1: 宣言していないヘッダに正しい署名を付けても 401・書込ゼロ(2本目のヘッダは効かない)", async () => {
  const endpointId = issueEndpoint("x-one-header", "X-Hub-Signature-256", "sha256_hex");
  const raw = body("evt-x");
  // 正しい署名を「別のヘッダ名」に載せる。受信口が読むのは宣言した1本だけである。
  for (const other of INBOUND_SIGNATURE_HEADERS.filter((h) => h !== "X-Hub-Signature-256")) {
    const res = await postInbound(endpointId, raw, other, signatureValue(raw, "sha256_hex"));
    expect(res.status).toBe(401);
    expect(eventRowCount()).toBe(0);
  }
  // 宣言した1本に載せれば通る(落ちているのが「ヘッダ名違い」であることの対照)。
  const ok = await postInbound(
    endpointId,
    raw,
    "X-Hub-Signature-256",
    signatureValue(raw, "sha256_hex"),
  );
  expect(ok.status).toBe(201);
  expect(eventRowCount()).toBe(1);
});

// --- (Y) 限定3: アルゴリズムを選ぶ場所が無い --------------------------------------

test("(Y) 限定3: 実装に SHA-1 / SHA-512 / 公開鍵署名の綴りが1つも無く、HMAC の生成は1箇所だけ", async () => {
  const verify = await Bun.file(join(PRODUCT_ROOT, "src/kernel/inbound-verify.ts")).text();
  const route = await Bun.file(join(PRODUCT_ROOT, "src/server/inbound-route.ts")).text();
  const store = await Bun.file(join(PRODUCT_ROOT, "src/kernel/inbound-store.ts")).text();
  const count = (text: string, needle: string): number => text.split(needle).length - 1;

  // **HMAC を作る箇所は1つだけで、アルゴリズム名は引数ではなくリテラルである。**
  expect(count(verify, "createHmac(")).toBe(1);
  expect(count(verify, 'createHmac("sha256"')).toBe(1);
  expect(count(route, "createHmac")).toBe(0);
  expect(count(store, "createHmac")).toBe(0);

  // 弱いアルゴリズム・別方式の綴りが1つも無い(`ADR-0160` §3a の 1)。
  for (const banned of ["sha1", "sha-1", "sha512", "sha-512", "md5", "ed25519", "createSign"]) {
    expect(verify.toLowerCase()).not.toContain(banned.toLowerCase());
    expect(store.toLowerCase()).not.toContain(banned.toLowerCase());
  }
});

test("(Y2) 限定5: HMAC の入力は生バイト body 1本で、連結・正規化を書く場所が無い", async () => {
  const verify = await Bun.file(join(PRODUCT_ROOT, "src/kernel/inbound-verify.ts")).text();
  const count = (text: string, needle: string): number => text.split(needle).length - 1;
  // `.update(` は1回だけ(2回呼べばタイムスタンプ等を連結できてしまう)。
  expect(count(verify, ".update(")).toBe(1);
  // 更新の対象は body のバイト列だけである。
  expect(verify).toContain(".update(bodyBytes)");
});

// --- (Z) 限定6 / 限定7 / 限定10 / 限定11 ------------------------------------------

test("(Z1) 限定6: 署名の形の書込 API が MCP / apply_diff 経路に1本も結線されていない", async () => {
  const files = [
    "src/mcp/tools/write.ts",
    "src/mcp/tools/read.ts",
    "src/mcp/server.ts",
    "src/kernel/apply-diff.ts",
  ];
  for (const path of files) {
    const text = await Bun.file(join(PRODUCT_ROOT, path)).text();
    expect(text).not.toContain("updateInboundEndpointSignature");
    expect(text).not.toContain("issueInboundEndpoint");
    expect(text).not.toContain("signatureHeader");
    expect(text).not.toContain("signatureFormat");
    expect(text).not.toContain("signature_header");
    expect(text).not.toContain("signature_format");
  }
});

test("(Z2) 限定7: schemas/ に署名の形の綴りが1つも無い(宣言の置き場はマニフェストではない)", async () => {
  const schema = await Bun.file(join(PRODUCT_ROOT, "schemas/manifest.schema.json")).text();
  for (const spelling of [
    "signature",
    "signatureHeader",
    "signature_header",
    "signature_format",
    "X-Hub-Signature-256",
    "Stripe-Signature",
  ]) {
    expect(schema).not.toContain(spelling);
  }
});

// 【`V5-M29-T05` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「(Z3) 限定10: RESOURCE_KINDS / FIELD_TYPES / DIFF_OPS が1つも動いていない」
//   そのブロックが測っていたもの:
//     - `expect(RESOURCE_KINDS.length).toBe(7)`(主張の逐語はテスト名の「RESOURCE_KINDS … が1つも動いていない」)
//     - `expect(FIELD_TYPES.length).toBe(9)`(主張の逐語はテスト名の「FIELD_TYPES … が1つも動いていない」)
//     - `expect(DIFF_OPS.length).toBe(17)`(主張の逐語はテスト名の「DIFF_OPS が1つも動いていない」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `RESOURCE_KINDS:` / `FIELD_TYPES:` / `DIFF_OPS:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

test("(Z4) 限定11: src/kernel/ に増えた公開面が、スナップショットに名指しで載っている", async () => {
  const snapshot = await Bun.file(join(PRODUCT_ROOT, "scripts/kernel-export-snapshot.txt")).text();
  // `V5-M15` が増やした5本(識別子を1つずつ名指しする。件数では見ない)。
  for (const added of [
    "inbound-verify.ts:INBOUND_SIGNATURE_HEADERS",
    "inbound-verify.ts:INBOUND_SIGNATURE_FORMATS",
    "inbound-verify.ts:DEFAULT_INBOUND_SIGNATURE_FORMAT",
    "inbound-verify.ts:InboundSignatureHeader",
    "inbound-verify.ts:InboundSignatureFormat",
  ]) {
    expect(snapshot).toContain(added);
  }
  // 既存の2本は消えていない(1本消して1本足す形の素通りを避ける)。
  expect(snapshot).toContain("inbound-verify.ts:INBOUND_SIGNATURE_HEADER\n");
  expect(snapshot).toContain("inbound-verify.ts:verifyInboundSignature");
});
