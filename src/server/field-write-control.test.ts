/**
 * 項目ごとに「誰が書けるか」を宣言する —— `$defs/field` の9キー目(`writable_by`)の検査
 * (`V4-M10-T01` / `T02` / `T03`。**`ADR-0076` = `V4-M7` 単位1 の限定採用。限定表11点**)。
 *
 * **この検査が固定するのは限定表の内側だけである**(`docs/adr/0076-field-write-control.md` §3):
 *
 * | 限定 | ここで固定するもの |
 * |---|---|
 * | 1 | 足すキーは `$defs/field` に1本だけ(8 → 9) |
 * | 2 | 値域は既存4ロールの列挙。**匿名を含めない**。`$defs` は 28 のまま |
 * | 3 | **`ADR-0071` 限定4 を1バイトも破らない**(読取の射影を1ミリも変えない) |
 * | 4 | 効くのは `POST` / `PATCH` / `/batch` の3経路だけ。**`DELETE` を1バイトも変えない** |
 * | 5 | **既定は「今日どおり書ける」** |
 * | 8 | 予約規約フィールドを1本も足さない(`ADR-0076` の増分は0本) |
 * | 9 | `diff.schema.json` の `field_changes` にも同じキーを足す(7 → 8) |
 * | 10 | **MCP / 受信 / 島 / ワークフローの経路は1バイトも守らない** |
 *
 * ## この検査が言わないこと(誇張しない)
 *
 * - **状態遷移の順序検査(`E-G46`)は1ミリも解けない**(限定11)。ここでは1件も測らない。
 * - **拒否の形は「403 で要求全体を拒む」に決めた**(`V4-M10-T02` 完了条件2)。
 *   **値を黙って捨てる形は採らない** —— `ADR-0010` 限定7(拒否のみ。`null` 化・デフォルト値は
 *   実装しない)と同じ側に倒した。
 *
 * ---
 *
 * ## **【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】今日の正はここから下である**
 *
 * **上の表を1バイトも書き換えていない。** **食い違っているのは1点、しかし根本である** ——
 * **`$defs/field` のキー `writable_by` と `diff.schema.json` の `field_changes.writable_by` は
 * 廃止された。** **項目の「書ける相手」を言う場所は、面(`app.roles[].rules` の
 * `{ target: "field", table, field, can: ["write"] }`)へ移った。**
 *
 * **本ファイルは「何が起きるか」を面の側で測り直している**(`ADR-0301` 限定6)。
 *
 * **【置き直しで意味が変わった点。誇張しないために先に書く】**
 *
 * 1. **限定3(「読取の射影を1ミリも変えない」)は、そのままでは成り立たない。**
 *    **面の規則は対象を名指しした時点で全動詞が allow-list になる** —— **`can: ["write"]`
 *    だけを書くと、その項目は**誰の読取応答からも落ちる**。**「書込だけを絞る」を1本の
 *    規則で書くことは今日できない。** **下の fixture は読める役割の全部に `read` を
 *    明示的に書いて、着手前の読取を保っている**(そう書かなければ保てない、ということである)。
 * 2. **未ログイン(`anonymous`)には項目の規則を1本も書けない**(`J-G11` の非対称)——
 *    **したがって「面が名指しした項目は、未ログインの読取から必ず落ちる」。**
 *    **着手前は `writable_by` を書いても読取は1ミリも変わらなかった。** **ここは塞いだ穴
 *    ではなく、置き直しに伴って変わった挙動である。**
 * 3. **拒否の応答の形が変わった。** **旧 `judgeFieldWrite` の 403 は `path` に
 *    `/<フィールドID>` を書いていたが、面の 403(`forbiddenRoleAccessError`)は
 *    `path: ""` で、止まった項目名は `message` の中に並ぶ。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDiff,
  applyManifest,
  createApp,
  createRecord,
  KernelMetaStore,
  type Manifest,
  updateRecord,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { judgeRoleFieldWrite, OWNER_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const MANIFEST_SCHEMA_FILE = join(import.meta.dir, "..", "..", "schemas", "manifest.schema.json");
const DIFF_SCHEMA_FILE = join(import.meta.dir, "..", "..", "schemas", "diff.schema.json");

function readSchema(file: string): {
  $defs: Record<string, { properties?: Record<string, unknown> }>;
} {
  return JSON.parse(readFileSync(file, "utf-8")) as {
    $defs: Record<string, { properties?: Record<string, unknown> }>;
  };
}

const manifestSchema = () => readSchema(MANIFEST_SCHEMA_FILE);
const diffSchema = () => readSchema(DIFF_SCHEMA_FILE);

// --- (a) 増分の総量(限定1 / 限定2 / 限定9)------------------------------------------

test("限定1【反転】$defs/field.properties から writable_by が消えた(V8-M20 / J-G28)", () => {
  // **【V4-M10-T46 / `E-G14` / `ADR-0086` 限定1 による更新】** **10キー目(`unit`)が
  // 門A(再審査 C5。`F-9` の4回目)を通って加わったので件数を 9 → 10 にした。**
  // **`ADR-0076` の増分が1キー(`writable_by`)であることは1ミリも変わっていない** ——
  // 順序で見る(9キー目である)。
  // **【V4-M16-T10 / `P-G28` + `P-G22` / `ADR-0090` 限定1 による更新】** **11キー目
  // (`emphasis`)が門A(`V4-M14` 本審査② の単位3)を通って加わったので件数を
  // 10 → 11 にした。** **`ADR-0076` の増分が1キーであることは今日も1ミリも
  // 変わっていない** —— 見ているのは順序(9キー目)であり、そこは動いていない。
  // **【V4-M19-T07 / ADR-0119 限定1 で 11 → 12 に更新した】** 12キー目 `hide_when_empty`
  // (値が無いとき行ごと出さない)が門A を通って増えた(V4-M19 単位E-a。2回目の審査。
  // 判定 = 限定採用)。**8型すべてに書けるキーである。****本 ADR の増分ではない。**
  // **`ADR-0076` の増分が1キーであることは今日も1ミリも変わっていない** —— 見ているのは
  // 順序(9キー目)であり、そこは動いていない。
  // **【V6-M1-T01 / K-G1 / ADR-0288 限定1 で 12 → 13 に更新した】** 13キー目 `reference_picker`
  // (他のテーブルから選ぶ項目の選び方)が門A を通って増えた(V6-M0 単位A。判定 = 限定採用)。
  // **reference 型にだけ書けるキーである。****本 ADR の増分ではない。**
  const keys = Object.keys(manifestSchema().$defs.field?.properties ?? {});
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定1 で 13 → 14 に更新した】** 14キー目 `reference_search_fields`
  // (参照候補の「探せる項目」の、項目ごとの上書き)が門A を通って増えた(`V6-M0` 単位B。判定 = 限定採用)。
  // **`reference` 型にだけ書けるキーである。****本 ADR の増分ではない。**
  //
  // **【`V8-M20` / 台帳 `J-G28` / `ADR-0301` による反転。旧値をここに残す】**
  // **旧: `expect(keys).toHaveLength(14);` / `expect(keys[8]).toBe("writable_by");` /
  // `expect(keys).toContain("writable_by");`**
  // **本 ADR が足した1キー(`writable_by`)は廃止され、14 → 12 になった**
  // (もう1キーは `audience`。`J-G28` は2つを同じ行で廃止した)。
  expect(keys).toHaveLength(12);
  expect(keys).not.toContain("writable_by");
});

// 【`V5-M29-T05` / `ADR-0250` 限定10 + 限定11】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定2: $defs の本数は 28 のまま(新しい $defs を1つも作らない)」
//   そのブロックが測っていたもの:
//     - `expect(Object.keys(manifestSchema().$defs)).toHaveLength(28)`(主張の逐語はテスト名の「$defs の本数は 28 のまま(新しい $defs を1つも作らない)」)
//   移し先は `scripts/vocabulary-drift.test.ts`(一覧の `manifest.$defs:` で始まる行)。
//   **`expect()` が1つも残らないので空の test を残さなかった**(空の test は緑を返し、
//   検出力0のまま `Ran` を水増しする)。
//   **テスト名が持っていた日本語の宣言は、ここでリポジトリから消える**(`ADR-0250` §Decision 5 の (4))。

// 【`V8-M20` / 台帳 `J-G28` / `ADR-0301`】ここにあった test を、ブロックごと消した。
//   消したテスト名(逐語): 「限定2: 値域の定義を二重に持たない($defs/view/properties/audience をそのまま指す)」
//   そのブロックが測っていたもの:
//     - `expect((manifestSchema().$defs.field?.properties?.writable_by as { $ref?: string })?.$ref)
//        .toBe("#/$defs/view/properties/audience")`
//   **消した理由**: **指す側(`$defs/field.properties.writable_by`)と指される側
//   (`$defs/view.properties.audience`)の**両方**が廃止された。** **面の規則の値域は
//   `app.roles[].rules` にインラインで書かれており、指し先そのものが存在しない** ——
//   **「面の側で同じことが言える検査」ではない。**
//   **`expect()` が1つも残らないので空の test を残さなかった。**

test("限定9【反転】diff.schema.json の field_changes から writable_by が消えた(V8-M20 / J-G28)", () => {
  // **【V4-M10-T46 / `E-G14` / `ADR-0086` 限定8 による更新】** **9キー目(`unit`)が
  // 加わったので件数を 8 → 9 にした。****`ADR-0076` の増分は今日も1キーである。**
  // **【V4-M16-T10 / `P-G28` + `P-G22` / `ADR-0090` による更新】** **10キー目
  // (`emphasis`)が加わったので件数を 9 → 10 にした。** **`ADR-0076` の増分は
  // 今日も1キーである** —— 見ているのは順序(8キー目)であり、そこは動いていない。
  // **【V4-M19-T07 / ADR-0119 限定1 で 10 → 11 に更新した】** 11キー目 `hide_when_empty`
  // (定義は manifest 側の `$ref`)が加わった。**`ADR-0076` の増分は今日も1キーである**
  // —— 見ているのは順序(8キー目)であり、そこは動いていない。**本 ADR の増分ではない。**
  // **【V6-M1-T02 / K-G4 / ADR-0288 限定10 で 11 → 12 に更新した】** 12個目のキー
  // `reference_picker`(定義は manifest 側の `$ref`)が加わった。**本 ADR の増分ではない。**
  const keys = Object.keys(diffSchema().$defs.field_changes?.properties ?? {});
  // **【`V6-M3-T02` / `K-G7` / `ADR-0290` 限定11 で 12 → 13 に更新した】** 13個目のキー
  // `reference_search_fields`(定義は manifest 側の `$ref`)が加わった。**本 ADR の増分ではない。**
  //
  // **【`V8-M20` / 台帳 `J-G28` / `ADR-0301` による反転。旧値をここに残す】**
  // **旧: `expect(keys).toHaveLength(13);` / `expect(keys[7]).toBe("writable_by");` /
  // `expect(keys).toContain("writable_by");`**
  // **差分の側の1キーも廃止され、13 → 12 になった。** **面の規則を書き込む差分操作は
  // `change_field` ではなく `set_roles`(全体差し替え)である。**
  expect(keys).toHaveLength(12);
  expect(keys).not.toContain("writable_by");
});

// --- (b) 値域(限定2)---------------------------------------------------------------

const APP_ID = "fwc-shop";

/**
 * **面の規則で「運営だけが書ける項目」を作る**(`V8-M20` の置き直し)。
 *
 * **【置き直し前の形。1バイトも書き換えずに残す】** ——
 * `{ id: "total", name: "金額", type: "number", writable_by: ["owner"] }` /
 * `{ id: "st_undeletable", name: "削除不可", type: "boolean", writable_by: ["owner"] }`。
 *
 * **`read` を全部の役割に明示的に書いているのは、着手前の読取を保つためである** ——
 * **書かないと「書込だけを絞る」つもりの規則が読取まで閉じる**(上のヘッダの 1)。
 * **`anonymous` にだけは書けないので、未ログインの読取からは落ちる**(同 2)。
 */
const WRITE_CONTROLLED_FIELDS = ["total", "st_undeletable"] as const;

const readRules = WRITE_CONTROLLED_FIELDS.map((field) => ({
  target: "field",
  table: "orders",
  field,
  can: ["read"],
}));

const readWriteRules = WRITE_CONTROLLED_FIELDS.map((field) => ({
  target: "field",
  table: "orders",
  field,
  can: ["read", "write"],
}));

/** 既定の役割定義3本は消せない(`set_roles` は全体差し替えなので必ず全部書く)。 */
const ROLES = [
  // **運営だけが書ける**(`D-V4-19` の「金額や数量は触れない」の形)。
  { id: "owner", name: "持ち主", rules: readWriteRules },
  { id: "editor", name: "編集者", rules: readRules },
  { id: "viewer", name: "閲覧者", rules: readRules },
  { id: "customer", name: "お客様", rules: readRules },
];

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "書込宣言テスト",
      tables: [
        {
          // 宣言つき × 顧客スコープ。
          id: "orders",
          name: "注文",
          fields: [
            { id: "item", name: "品目", type: "text", required: true },
            { id: "total", name: "金額", type: "number" },
            { id: "memo", name: "備考", type: "text" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
            { id: "st_undeletable", name: "削除不可", type: "boolean" },
          ],
        },
        {
          // **宣言なし**(既定 = 今日どおり書ける)。
          id: "memos",
          name: "メモ",
          fields: [
            { id: "body", name: "本文", type: "text", required: true },
            { id: "amount", name: "金額", type: "number" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
      ],
      views: [{ id: "order-list", type: "list_view", table: "orders", columns: ["item"] }],
      roles: ROLES,
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】適用する題材**(`beforeEach` が `applyManifest` に渡すもの)。
 *
 * **既定が閉じた**(`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`)—— **規則を1本も
 * 名指ししていない表・画面・ボタンは拒否される。****本ファイルの主題は項目(`field`)の
 * 書込制御であり、項目の層は今日も閉じていない**(台帳 `T-G1b` = 却下)。**したがって
 * 表を開けても、どの項目が書けるかは1ミリも動かない。**
 *
 * - `withDefaultRoleRules` が既定3役割へ入れるのは `apply-diff.ts` の自動付与と同じ規則だけ
 *   である(**項目の規則は1本も足さない**)。
 * - **`customer`** には表 `orders` / `memos` の読取・書込・削除を足す —— **本ファイルの
 *   主役は「金額を触れない購入者」であり、行そのものを作れなければ主題が測れない。**
 * - **`anonymous` には1本も足していない**(`D-V8-45` / 台帳 `T-G26a`)。
 */
function seededManifest(): Manifest {
  const m = structuredClone(manifest()) as unknown as {
    app: { roles: { id: string; name: string; rules?: unknown[] }[] };
  };
  const customer = m.app.roles.find((role) => role.id === "customer") as { rules: unknown[] };
  // **条件(`when`)を付けているのは、`D-V8-35` により面が表の**読取**を許すと
  // `st_owner`(個人スコープ)を読取について越えてしまうからである** ——
  // **素で書くと購入者に全員分の注文が見える。**
  customer.rules = [
    ...customer.rules,
    {
      target: "table",
      table: "orders",
      can: ["read", "write", "delete"],
      when: { field: OWNER_FIELD, equals_current_user: true },
    },
    {
      target: "table",
      table: "memos",
      can: ["read", "write", "delete"],
      when: { field: OWNER_FIELD, equals_current_user: true },
    },
  ];
  return withDefaultRoleRules(m) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-fwc-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "書込宣言テスト", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, seededManifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  if (ifMatch !== undefined) {
    headers["if-match"] = ifMatch;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const R = (table: string, id?: string) =>
  `/api/apps/${APP_ID}/tables/${table}/records${id === undefined ? "" : `/${id}`}`;

const customer = (username: string) =>
  seedSession(dataRoot, APP_ID, { role: "customer", username });
const owner = (username: string) => seedSession(dataRoot, APP_ID, { role: "owner", username });

/** 述語に渡す表(`orders`)。**マニフェストの定義をそのまま使う。** */
function ordersTable(): Parameters<typeof judgeRoleFieldWrite>[0]["table"] {
  return (manifest().app.tables ?? [])[0] as Parameters<typeof judgeRoleFieldWrite>[0]["table"];
}

test("限定2【置き直し】述語は「入力にそのキーが在るか」だけを見て、書けない役割の項目を名指しで返す", () => {
  // **【置き直し前の逐語。1バイトも書き換えずに残す】**
  //   test("限定2: 述語は宣言を4ロールの列挙として読み、書いていない項目には undefined を返す", () => {
  //     expect(fieldWriters({ id: "total", writable_by: ["owner"] })).toEqual(["owner"]);
  //     expect(fieldWriters({ id: "memo" })).toBeUndefined();
  //     // **匿名は値域に無い** —— 混ざって書かれても落とす(`ADR-0074` §3a-4 と同じ線)。
  //     expect(fieldWriters({ id: "x", writable_by: ["anonymous", "owner"] })).toEqual(["owner"]);
  //   });
  // **`fieldWriters`(項目1本の宣言を読む述語)は撤去された。** **面では「その入力を
  // その相手が書けるか」を1本の判定(`judgeRoleFieldWrite`)に問う** —— **規則を書くのは
  // 項目ではなく役割の側だからである。**
  const table = ordersTable();
  const m = manifest();
  // **書ける役割(owner)は通る。**
  expect(judgeRoleFieldWrite({ manifest: m, table, values: { total: 1 }, roles: "owner" })).toEqual(
    {
      kind: "allowed",
    },
  );
  // **書けない役割(customer)は、止まった項目を名指しで返す。**
  expect(
    judgeRoleFieldWrite({ manifest: m, table, values: { total: 1 }, roles: "customer" }),
  ).toEqual({ kind: "denied", fields: ["total"] });
  // **面が名指ししていない項目は誰でも今日どおり書ける**(既定 = 管轄外)。
  expect(
    judgeRoleFieldWrite({ manifest: m, table, values: { memo: "急ぎ" }, roles: "customer" }),
  ).toEqual({ kind: "allowed" });
  // **未ログイン(`roles: null`)は書けない** —— **項目の規則を1本も持てない**(`J-G11`)。
  expect(judgeRoleFieldWrite({ manifest: m, table, values: { total: 1 }, roles: null })).toEqual({
    kind: "denied",
    fields: ["total"],
  });
  // **見るのは「入力にそのキーが在るか」だけである**(値も現在値も見ない)。
  expect(
    judgeRoleFieldWrite({ manifest: m, table, values: { total: undefined }, roles: "customer" }),
  ).toEqual({ kind: "denied", fields: ["total"] });
});

// --- (c) 3経路の拒否(限定4。`V4-M10-T02` 完了条件1)-----------------------------------

test("限定4: POST —— 書けない役割が面の名指しした項目を書くと 403(要求全体を拒む)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("orders"), { item: "本", total: 0 });
  expect(res.status).toBe(403);
  const body = (await res.json()) as { errors: { path: string; message: string }[] };
  // **【`V8-M20` / `J-G28` による書き換え。旧値をここに残す】**
  // **旧: `expect(body.errors[0]?.path).toBe("/total");`**
  // **面の 403(`forbiddenRoleAccessError`)は `path` を空にし、止まった項目名を
  // `message` に並べる。** **止まった項目が分かることは1ミリも失っていない。**
  expect(body.errors[0]?.path).toBe("");
  expect(body.errors[0]?.message).toContain('"total"');
  // **要求全体が拒まれる** —— 行は1件も作られていない。
  const list = await req(c.cookie, "GET", R("orders"));
  expect(((await list.json()) as { records: unknown[] }).records).toHaveLength(0);
});

test("限定4: PATCH —— 書けない役割が面の名指しした項目を書くと 403", async () => {
  const c = customer("c1");
  const created = await req(c.cookie, "POST", R("orders"), { item: "本" });
  expect(created.status).toBe(201);
  const row = ((await created.json()) as { record: Record<string, unknown> }).record;
  const res = await req(
    c.cookie,
    "PATCH",
    R("orders", row._id as string),
    { total: 999 },
    row._updated_at as string,
  );
  expect(res.status).toBe(403);
});

test("限定4: /batch —— 書けない役割が面の名指しした項目を書くと 403", async () => {
  // **バッチ経路は今日 editor / owner にしか開いていない**(`app.ts` の `batchAuthMiddleware`)。
  // **customer で叩くと `ADR-0076` とは別の理由で 403 になるので、`editor` で叩く** ——
  // **`total` の規則は `owner` にだけ `write` を書いてあるので、editor は書けない側である。**
  const e = seedSession(dataRoot, APP_ID, { role: "editor", username: "e1" });
  const denied = await req(e.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: "orders", values: { item: "本", total: 1 } }],
  });
  expect(denied.status).toBe(403);
  const body = (await denied.json()) as { errors: { path: string; message: string }[] };
  // **【`V8-M20` による書き換え。旧: `expect(body.errors[0]?.path).toBe("/total");`】**
  expect(body.errors[0]?.path).toBe("");
  expect(body.errors[0]?.message).toContain('"total"');
  // **同じ経路・同じロールでも、面が名指ししていない項目だけなら今日どおり通る**(限定5)。
  const allowed = await req(e.cookie, "POST", `/api/apps/${APP_ID}/batch`, {
    ops: [{ op: "create", table: "orders", values: { item: "本", memo: "急ぎ" } }],
  });
  expect(allowed.status).toBe(200);
});

test("限定4: 規則に write を書いた役割(owner)は今日どおり書ける", async () => {
  const o = owner("o1");
  const res = await req(o.cookie, "POST", R("orders"), { item: "本", total: 1200 });
  expect(res.status).toBe(201);
});

// --- (d) 既定(限定5)----------------------------------------------------------------

test("限定5: 面が名指ししていない項目は今日どおり書ける(同じ表の中でも)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("orders"), { item: "本", memo: "急ぎ" });
  expect(res.status).toBe(201);
});

// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`。旧文を1バイトも消していない】**
//
// **旧テスト名**: 「限定5: 規則を1本も書いていない表は1ミリも変わらない」。
// **旧の期待値は今日も同じ**(`expect(res.status).toBe(201);`)—— **書き換えたのは名前と
// 題材だけである。**
//
// **既定が閉じたので、規則を文字どおり1本も持たない表は今日 403 になる**(その向きは
// `role-default-closed.test.ts` が測る)。**そこで題材の `memos` には**表**の規則だけを
// 足した** —— **`ADR-0076` 限定5 が言っているのは「**項目**の規則を書いていない項目は
// 今日どおり書ける」であり、その主題は表の規則を足しても1ミリも動かない。**
test("限定5: 項目の規則を1本も書いていない表は1ミリも変わらない(表の規則は V8-M26 で要るようになった)", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("memos"), { body: "覚え書き", amount: 100 });
  expect(res.status).toBe(201);
});

// --- (e) 読取を1ミリも変えない(限定3)------------------------------------------------

test("限定3: 書込を絞った項目は、read を書いた役割の読取応答に今日どおり出る", async () => {
  const o = owner("o1");
  const created = await req(o.cookie, "POST", R("orders"), { item: "本", total: 1200 });
  const row = ((await created.json()) as { record: Record<string, unknown> }).record;
  const res = await req(o.cookie, "GET", R("orders", row._id as string));
  const read = ((await res.json()) as { record: Record<string, unknown> }).record;
  expect(read.total).toBe(1200);
  // **【`V8-M20` の代償を隠さない】** **`read` を書いた役割にしか出ない** ——
  // **`can: ["write"]` だけを書くと、その項目は書いた本人の応答からも落ちる。**
  // **着手前の `writable_by` は読取を1ミリも変えなかった**(`ADR-0076` 限定3)。
  const c = customer("c2");
  const own = await req(c.cookie, "POST", R("orders"), { item: "紙" });
  const ownRow = ((await own.json()) as { record: Record<string, unknown> }).record;
  const readByCustomer = await req(c.cookie, "GET", R("orders", ownRow._id as string));
  expect(Object.keys(((await readByCustomer.json()) as { record: object }).record)).toContain(
    "total",
  );
});

// --- (f) DELETE を1バイトも変えない(限定4)-------------------------------------------

test("限定4: DELETE は1ミリも変わらない(面が名指しした項目を持つ表でも消せる)", async () => {
  const c = customer("c1");
  const created = await req(c.cookie, "POST", R("orders"), { item: "本" });
  const row = ((await created.json()) as { record: Record<string, unknown> }).record;
  const res = await req(
    c.cookie,
    "DELETE",
    R("orders", row._id as string),
    undefined,
    row._updated_at as string,
  );
  expect(res.status).toBe(204);
});

// --- (g) `V4-M10-T03`: `st_undeletable` の自己解除を宣言で塞げる -------------------------

test("T03: 面が名指しした表では、持ち主は自分の行の st_undeletable を PATCH で下ろせない", async () => {
  // **`src/server/row-delete-protection.test.ts:341` の `(穴)` 検査は消していない** ——
  // あちらは規則を1本も書かない表で「今日どおり下ろせる」ことを固定したままである
  // (`V4-M10-T03` 完了条件1)。ここでは**規則を書いた表**で下ろせなくなることを固定する。
  const c = customer("c1");
  const created = await req(c.cookie, "POST", R("orders"), { item: "本" });
  const row = ((await created.json()) as { record: Record<string, unknown> }).record;
  const lowered = await req(
    c.cookie,
    "PATCH",
    R("orders", row._id as string),
    { st_undeletable: false },
    row._updated_at as string,
  );
  expect(lowered.status).toBe(403);
});

test("T03: 面が名指しした表では、持ち主は作成時にも st_undeletable を立てられない", async () => {
  const c = customer("c1");
  const res = await req(c.cookie, "POST", R("orders"), { item: "本", st_undeletable: true });
  expect(res.status).toBe(403);
});

// --- (i) 限定10: ワークフロー / 島 / MCP の経路は1ミリも守られない -----------------------

test("限定10 / T02 完了条件6: カーネル経路(ワークフロー・島)の書込は1ミリも止まらない", () => {
  // **ワークフロー / 島は actor を持たない経路であり、規則の対象ではない。** それらは
  // `src/kernel/` の `createRecord` / `updateRecord` / `writeRecords` を呼ぶだけで、
  // **【`V8-M20`】旧 `judgeFieldWrite` も新しい `judgeRoleFieldWrite` も1度も通らない。**
  // **本物の SQLite で、面が名指しした項目に書けることを固定する。**
  const loaded = manifest();
  const db = new Database(join(dataRoot, "apps", APP_ID, "app.sqlite"));
  try {
    const created = createRecord(db, loaded, "orders", { item: "本", total: 9999 });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.total).toBe(9999);
      const updated = updateRecord(db, loaded, "orders", created.value._id as string, {
        st_undeletable: true,
      });
      expect(updated.ok).toBe(true);
    }
  } finally {
    db.close();
  }
});

// --- (j) (穴)`change_field` では後から付けられない ------------------------------------

/**
 * **【反転した検査。`V8-M20` / 台帳 `J-G28` / `ADR-0301` による】**
 *
 * **反転前の逐語**(2026-08-09 まで緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(穴)change_field で writable_by を後から付けても、宣言が残らない", () => {
 *   // **`ADR-0076` 限定9 は `field_changes` にキーを足すことを求め、限定7 は `src/kernel/` に
 *   // 1バイトの差分も出さないことを求めている。** **`src/kernel/apply-diff.ts` の
 *   // `buildChangedField` が `writable_by` を運ばないので、キーは受理されるが値は残らない。**
 *   // **`V4-M10` は限定7 に従って `src/kernel/` を1バイトも触っていないため、これを直せなかった。**
 *   // **塞いでいないので、検査で固定して残す**(`row-delete-protection.test.ts` の `(穴)` と同じ作法)。
 *   const applied = applyDiff(dataRoot, APP_ID, { … changes: { writable_by: ["owner"] } … });
 *   // 適用そのものは通る(diff schema がキーを受け付ける)。
 *   expect(applied.valid).toBe(true);
 *   // **しかし宣言は残らない。**
 *   expect(amount?.writable_by).toBeUndefined();
 * });
 * ```
 *
 * **なぜ反転したか**: **語彙そのものが廃止された。** **`field_changes` から
 * `writable_by` が消えたので、キーは受理されなくなった** —— **「受理されるのに残らない」
 * という穴は、塞いだのではなく**言えなくなった**のである。**
 *
 * **【誇張しない】** **面の側に同じ形の穴が無いことは、ここでは1件も測っていない** ——
 * **面の規則を書き込む差分操作は `set_roles`(全体差し替え)であり、その往復の検査は
 * `role-rules-enforcement.test.ts` の担当である。**
 */
test("(穴)【反転】change_field の changes に writable_by はもう書けない(V8-M20 / J-G28)", () => {
  const applied = applyDiff(dataRoot, APP_ID, {
    diff_id: "fwc-hole-1",
    intent: "既存フィールドに writable_by を後から付けようとする",
    operations: [
      {
        op: "change_field",
        table: "memos",
        field: "amount",
        changes: { writable_by: ["owner"] },
      },
    ],
  } as never);
  expect(applied.valid).toBe(false);
  // **宣言はどこにも残らない**(受理されないので、1バイトも書かれていない)。
  const stored = JSON.parse(
    readFileSync(join(dataRoot, "apps", APP_ID, "manifest.json"), "utf-8"),
  ) as { app: { tables: { id: string; fields: Record<string, unknown>[] }[] } };
  const amount = stored.app.tables
    .find((t) => t.id === "memos")
    ?.fields.find((f) => f.id === "amount");
  expect(amount?.writable_by).toBeUndefined();
});

// --- (h) 限定8: 予約規約フィールドを1本も足さない ---------------------------------------

test("限定8: 本 ADR の増分として予約規約フィールドを1本も足していない", () => {
  const source = readFileSync(join(import.meta.dir, "owner-scope.ts"), "utf-8");
  const declared = source.match(/^export const [A-Z_]+_FIELD = /gm) ?? [];
  // **`ADR-0077`(単位2)が5本目を採る。** ここでは「`writable_by` の実装が新しい
  // `st_*` を1本も持ち込んでいない」ことだけを見る。
  expect(source).not.toContain("WRITABLE_BY_FIELD");
  // **【`V8-M20` / 台帳 `J-G30` / `ADR-0301` による更新。旧値をここに残す】**
  // **旧: `expect(declared.length).toBeLessThanOrEqual(5);`(`st_admin_readable` を含んでいた)。**
  // **予約規約フィールドは 5本 → 4本になった**(`st_admin_readable` の1本だけが廃止)。
  expect(declared.length).toBeLessThanOrEqual(4);
});
