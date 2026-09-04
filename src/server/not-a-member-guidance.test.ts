/**
 * **`V8-M41` / 台帳 `F-G12`**: **断りの文面と手引き。**
 *
 * **正は `docs/plan/v8/records/v8-m35.md` §5-1 の `F-G12` の行の限定(逐語)である**:
 * 「**断りの文面と手引きだけ。** **持ち主の特別扱いを戻さない。自動メンバー登録もしない**」。
 *
 * ## **なぜ「文面と手引き」で塞ぐと決まったか(**やり直さない**)**
 *
 * **`v8-m35.md` §4-2 が3つの独立な裏づけで確かめた** —— **「利用者の表に**利用者ID**で
 * 1行入れれば、その後は行を作れる」は真である。** **`V8-M41` はそれを実 HTTP でも
 * 確かめた**(本物のサーバ + 本物の SQLite。`(A-3)` / `(A-4)` が同じ形をこの検査でも固定する)。
 * **したがって `v8-m33.md` §1-A の `A-1`(「持ち主でも1行も作れない」)は実装の欠陥ではない** ——
 * **`A-1` の実測は「利用者の表が空の台」で取られたものである**(同 §1-A の `A-2` の逐語:
 * 「**1件も入れていない。** **`ticket_member` への `POST` を1度も撃っていない**」)。
 * **【禁止】「持ち主でも作れない」を、実測の条件を外して一般化しない。**
 *
 * ## 測るもの
 *
 * - **(A)** **利用者の表に行が無い相手の作成は今日も 400 である**(**応答コードを変えていない**)。
 * - **(A-2)** **その文面が「次に何をすればよいか」を持っている** ——
 *   **登録の**行き先**(利用者の表)/ **誰が足せるか**(運営者)/ **何を書くか**(ログイン名では
 *   なく利用者ID)の3つ。
 * - **(A-3)** **利用者の表に**ログイン名**を入れても、同じ 400 のままである**
 *   (`cp-v8-unify.md` §20-D の 3 の読みの裏取り)。
 * - **(A-4)** **利用者の表に**利用者ID**を入れると 201 になり、作成者への付与が1件立つ。**
 * - **(B)** **文面に内部記号が1文字も無い**(`src/server/app.ts` の doc が課している作法)。
 * - **(C)** **`ValidationError` は今日も4キーのままである**(5キー目を足していない)。
 * - **(D)** **手引きが恒久の文書に1本在る**(`docs/manual.md`)。
 *   **【`V9-M11-T02` / `X-G28`】この1本(`(D-1)`)は
 *   `tools/docs/not-a-member-guidance-docs.test.ts` へ切り出した** ——
 *   **公開単位(`apps/smailtalk/`)の中の検査が `docs/` を読まないようにするためである。**
 *   **検査は1本も減っていない。**
 *
 * ## **この検査が固定していないもの(誇張しない)**
 *
 * - **`F-G12` は文面だけで自己完結しない**(`v8-m35.md` §4-2 の末尾が明記した)——
 *   **利用者IDをどこで確かめるか、どの表が「利用者の表」なのかは、文面には書けない**
 *   (**表IDは内部記号であり、文面に出さない作法がある**)。**そこは (D) の手引きが持つ。**
 * - **AI(MCP)経路の文面はこの検査の対象外である** —— **`src/mcp/tools/write.ts` は同じ
 *   文面の**写し**を別に持っており、本 MS は MCP を1バイトも触っていない**(計画 §5-3)。
 *   **【禁止】「AI 経由も直った」と書かない。**
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
// **【`V9-M11-T02` / `X-G28`】`readFileSync` の import を落とした** ——
// **唯一の使い手だった `(D-1)`(`docs/manual.md` を読む test)を
// `tools/docs/not-a-member-guidance-docs.test.ts` へ切り出したためである。**
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appDbPath,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
} from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "member-desk";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "keeper", name: "全部できる", read: true, write: true, delete: true },
] as const;

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "利用者の表の台帳",
      tables: [
        {
          id: "tickets",
          name: "受付票",
          fields: [{ id: "title", name: "題", type: "text", required: true }],
          access_control: {
            enabled: true,
            permissions: [...PERMISSIONS],
            creator_permission: "keeper",
            grant: {
              table: "ticket_grant",
              target: "ticket",
              member: "member",
              permission: "permission",
            },
            members: { table: "ticket_member", account: "account" },
          },
        },
        {
          id: "ticket_member",
          name: "利用者",
          fields: [{ id: "account", name: "口座", type: "text" }],
        },
        {
          id: "ticket_grant",
          name: "付与",
          fields: [
            { id: "ticket", name: "受付票", type: "reference", reference_table: "tickets" },
            { id: "member", name: "相手", type: "reference", reference_table: "ticket_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "keeper"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

let dataRoot = "";
let app: ReturnType<typeof createServerApp>;
let owner: ReturnType<typeof seedSession>;

function withDb<T>(run: (db: Database) => T): T {
  const db = new Database(appDbPath(dataRoot, APP_ID), { readwrite: true, create: false });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

async function post(
  path: string,
  cookie: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const response = await app.request(`http://localhost${path}`, {
    method: "POST",
    headers: { cookie, origin: TEST_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.text() };
}

const createTicket = async (title: string): Promise<{ status: number; body: string }> =>
  await post(`/api/apps/${APP_ID}/tables/tickets/records`, owner.cookie, { title });

const addMemberRow = async (account: string): Promise<{ status: number; body: string }> =>
  await post(`/api/apps/${APP_ID}/tables/ticket_member/records`, owner.cookie, { account });

function countRows(tableId: string): number {
  return withDb(
    (db) => (db.query(`SELECT COUNT(*) AS n FROM "${tableId}"`).get() as { n: number }).n,
  );
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-member-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "利用者の表の台帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, withDefaultRoleRules(manifest())).valid).toBe(true);
  app = createServerApp({ dataRoot });
  owner = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-owner" });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) 断りと、その先にある道
// ---------------------------------------------------------------------------

describe("V8-M41 (A): 断りの文面が「次に何をすればよいか」を持つ", () => {
  test("(A-1) 利用者の表に行が無い相手の作成は、今日も 400 である(応答コードを変えていない)", async () => {
    const response = await createTicket("最初の1件");
    expect(response.status).toBe(400);
    expect(countRows("tickets")).toBe(0);
  });

  test("(A-2) 文面が、行き先・足せる人・書く値の3つを持つ", async () => {
    const response = await createTicket("最初の1件");
    const errors = (JSON.parse(response.body) as { errors: { message: string; hint?: string }[] })
      .errors;
    const text = `${errors[0]?.message ?? ""}\n${errors[0]?.hint ?? ""}`;
    // **行き先**(どこに1行足すのか)。
    expect(text).toContain("利用者の表");
    // **誰が足せるか**(運営者。**自分が運営者なら自分で足せることまで書く** ——
    // **`A-1` を踏むのは持ち主自身であることが多い**)。
    expect(text).toContain("運営者");
    expect(text).toContain("自分で足せます");
    // **何を書くか**(ログイン名ではなく利用者ID。**ここを外すと同じ 400 に戻る**)。
    expect(text).toContain("ログイン名ではなく利用者ID");
  });

  test("(A-3) 利用者の表に **ログイン名** を入れても、同じ 400 のままである", async () => {
    expect((await addMemberRow(owner.username)).status).toBe(201);
    const response = await createTicket("ログイン名だけの1件");
    expect(response.status).toBe(400);
    expect(countRows("tickets")).toBe(0);
  });

  test("(A-4) 利用者の表に **利用者ID** を入れると 201 になり、作成者への付与が1件立つ", async () => {
    expect((await addMemberRow(owner.userId)).status).toBe(201);
    const response = await createTicket("利用者IDを入れたあとの1件");
    expect(response.status, response.body).toBe(201);
    expect({ tickets: countRows("tickets"), grants: countRows("ticket_grant") }).toEqual({
      tickets: 1,
      grants: 1,
    });
  });

  test("(A-5) まとめ書込(バッチ)の断りも同じ文面である(同じ1本の関数を通る)", async () => {
    const single = await createTicket("単件");
    const batch = await post(`/api/apps/${APP_ID}/batch`, owner.cookie, {
      ops: [{ op: "create", table: "tickets", values: { title: "バッチ" } }],
    });
    expect(batch.status).toBe(400);
    expect(batch.body).toBe(single.body);
  });
});

// ---------------------------------------------------------------------------
// (B)(C) 文面の作法
// ---------------------------------------------------------------------------

describe("V8-M41 (B)(C): 文面の作法を1つも破っていない", () => {
  test("(B-1) 内部記号(宣言のキー名・表ID・述語名・審査単位の記号)が1文字も無い", async () => {
    const response = await createTicket("最初の1件");
    for (const symbol of [
      "access_control",
      "members",
      "account",
      "creator_permission",
      "creatorGrantPlan",
      "judgeRecordAccess",
      "ticket_member",
      "ticket_grant",
      "tickets",
      "F-G",
      "Z-G",
    ]) {
      expect({ symbol, leaked: response.body.includes(symbol) }).toEqual({ symbol, leaked: false });
    }
  });

  test("(C-1) `ValidationError` のキーは今日も4キーの範囲内である(5キー目を足していない)", async () => {
    const response = await createTicket("最初の1件");
    const errors = (JSON.parse(response.body) as { errors: Record<string, unknown>[] }).errors;
    for (const error of errors) {
      for (const key of Object.keys(error)) {
        expect(["path", "message", "hint", "allowed_values"]).toContain(key);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// (D) 手引き(**文面だけでは自己完結しないので、恒久の文書に1本置く**)
// ---------------------------------------------------------------------------
//
// **【`V9-M11-T02` / 台帳 `X-G28` / `D-V9-21`】(D-1) はここから
// `tools/docs/not-a-member-guidance-docs.test.ts` へ切り出した。**
//
// **理由**: **公開単位(`apps/smailtalk/`)の中の検査は、公開単位の外(正本のルート直下の
// `docs/`)を1バイトも読まない。** (D-1) はこのファイルで唯一 `docs/manual.md` を fs で
// 読んでいた test である。**`docs/` を公開単位へ複製する道は `D-V9-21` が逐語で禁じている**
// (「複製もしない」)ので、読む側を外へ出した。
//
// **丸ごと移していない。****切り出した。** 残る 7 本(`(A-1)`〜`(A-5)` / `(B-1)` / `(C-1)`)は
// 本物の SQLite と本物のサーバを立てて HTTP を撃つ製品側の検査であり、`docs/` を1バイトも
// 読まない —— 丸ごと移すと、その 7 本が公開単位から消える。
// (加えてその 7 本は `../kernel/index.ts` を**値として** import しており、`tools/` へ運ぶと
//  `tools/tools-scope.test.ts` の `(tools1)` が赤くなる。)
//
// **(D) の観点そのものは1本も減っていない。** 置き場が変わっただけである。
