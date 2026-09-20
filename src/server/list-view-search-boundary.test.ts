/**
 * **検索の口が境界を1件も迂回しないことの実測**(`V4-M22-T04`。`ADR-0112` 限定6 / 限定9)。
 *
 * **限定表の正は [`docs/adr/0112-view-search-fields.md`](../../docs/adr/0112-view-search-fields.md) §Decision 3**、
 * 完了条件の正は `docs/plan/v4/records/v4-m22.md` §1-2 の `V4-M22-T04` の行
 * (**`V4-M10-T30` 完了条件5 と同じ検査**)。
 *
 * ## ここで測るもの(**本物の SQLite / 本物の HTTP**)
 *
 * | # | 何を | 限定 |
 * |---|---|---|
 * | (A) | **面の項目の規則が名指しした項目を `search_fields` に書いた差分が、本物の SQLite に1バイトも入らない** | 限定6 |
 * | (B) | **`st_owner` の post-filter を、検索の入力が1件も迂回しない** | 限定9 |
 * | (C) | **面の画面の規則の遮断を、検索の入力が1件も迂回しない** | 限定9 |
 * | (D) | **画面の `view.filter` が隠した行は、どんな検索語でも1行も出ない** | 限定9 |
 * | (E) | **既知の穴(`v4-fix1-boundary-bypass.md` §2 (d))が5件から1件も増えていない** | —— |
 *
 * ## 【正直に書く】この検査が言わないこと
 *
 * 1. **`V4-M22-T04` は既知の穴を1件も塞いでいない。** **(E) が名指しで突き合わせるのは
 *    「増えていない」だけである。**
 *
 *    **【2026-08-04 の改訂】旧記述の逐語**(**1バイトも書き換えずに残す**):
 *
 *    > **`ADR-0071` 限定4 が「検索(`filter`)の挙動を1バイトも変えない」と明文で書いており、
 *    > `audience` を宣言した項目を `filter` に直接書くことは今日どおりできる。**
 *
 *    **[`ADR-0120`](../../docs/adr/0120-hidden-field-query-restriction.md)(門A 本審査 =
 *    限定採用)が `ADR-0071` 限定4 を改訂し、`V4-M28-T01` が実装した。** **穴1(`filter`)と
 *    穴2(`sort`)は、読取のリクエスト引数については塞がった** —— 下の (E) 2本はそれに合わせて
 *    **削除せず反転してある**(`ADR-0120` 限定6 の作法)。**穴3〜穴5 は今日も開いている。**
 *
 *    **【2026-08-09 の改訂(`V8-M20` / 台帳 `J-G27` / `J-G28` / `ADR-0301`)。上の表の (A) と
 *    (C) は着手前それぞれ「`audience` を宣言した項目…」「`view.audience` の遮断…」だった。
 *    旧文を1バイトも消していない】**
 *    **画面の「見せる相手」(`view.audience`)と項目の「見せる相手」(`field.audience`)、
 *    項目の「書ける相手」(`field.writable_by`)の語彙は廃止された。****代わりに立つのは
 *    `app.roles[].rules`(役割 × 対象 × 動詞)である。****境界そのもの(応答コード・
 *    落とす/落とさないの別)は1つも変わっていない。**
 *    **【正直に書く】穴5 の測り方だけは fixture の書き方が変わった** —— **旧は
 *    `field.audience` を書くだけで「読めないが書ける」が成立したが、面の規則は対象を名指し
 *    した時点で全動詞が allow-list になるので、`customer` に書込を明示で開けないと成立
 *    しない。****穴が塞がったのではなく、同じ穴を作るのに宣言が1本増えた。**
 * 2. **MCP 経路は1ミリも測っていない**(`ADR-0070` 限定8)。
 * 3. **性能を1度も測っていない。**
 * 4. **ブラウザを1枚も開いていない** —— 表示層が組み立てる形は
 *    `web/test/list-view-search.test.tsx` が見る。**ここはサーバ側の境界だけを見る。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD } from "./owner-scope.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "search-boundary";

/**
 * **面の項目の規則が名指しした項目を持つテーブル**(`v4-fix1-boundary-bypass.md` §2 と同じ形)。
 *
 * **【`V8-M20` / `J-G27` / `J-G28` / `ADR-0301`】旧の1行(逐語。コメント記号は外してある)**:
 * `audience` を宣言した項目を持つテーブル(`v4-fix1-boundary-bypass.md` §2 と同じ形)。
 */
function baseManifest(searchFields: Record<string, string[]> = {}): Manifest {
  const view = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    id,
    type: "list_view",
    table: "ticket",
    columns: ["title"],
    ...(searchFields[id] === undefined ? {} : { search_fields: searchFields[id] }),
    ...extra,
  });
  return {
    app: {
      id: APP_ID,
      name: "検索の境界",
      tables: [
        {
          id: "ticket",
          name: "チケット",
          fields: [
            { id: "title", name: "件名", type: "text", required: true },
            // **面の項目の規則が名指しした項目**。**限定6 の当たり先である。**
            // **【`V8-M20` / `J-G28` / `ADR-0301`】旧: `audience: ["owner"]` をここに
            // 書いていた(`ADR-0071`)。****その語彙は廃止されたので、下の `roles` から
            // 名指しする。**
            { id: "secret_tag", name: "内部タグ", type: "text" },
            { id: OWNER_FIELD, name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        view("ticket-list"),
        // **画面ごとに「見せる相手」を宣言した一覧**(`ADR-0070`)。
        // **【`V8-M20` / `J-G27` / `ADR-0301`】旧: `view("admin-list", { audience: ["owner"] })`。**
        view("admin-list"),
        // **画面の `filter` が半分を隠している一覧**(限定9 の当たり先)。
        view("open-list", { filter: { field: "title", contains: "公開" } }),
      ],
      // **【`V8-M20` / `J-G27` / `J-G28` / `ADR-0301`】画面と項目の「見せる相手」の置き直し先。**
      // **既定3ロール(`owner` / `editor` / `viewer`)は消せない。**
      //
      // **`customer` に `secret_tag` の書込だけを書いてある理由**(重要。誇張しない)——
      // **面の規則は対象を名指しした時点で全動詞が allow-list になるので、`owner` の読取だけを
      // 書くと `secret_tag` は誰も書けなくなる。****旧 `field.audience` は読取の射影だけを
      // 動かし、書込は別キー(`writable_by`)が決めていたので、「読めないが書ける」= 穴5 が
      // 成立していた。****その穴を今日も同じ形で測るために、書込を明示で開けてある** ——
      // **穴5 が塞がったのではなく、宣言の書き方が変わっただけであることを (E) が実測する。**
      //
      // **表(`ticket`)の規則は1本も書かない** —— **書くと `D-V8-35` により `st_owner` の
      // 絞り込みが読取で効かなくなり、(B) の母集団が変わってしまう。**
      roles: [
        {
          id: "owner",
          name: "持ち主",
          rules: [
            { target: "view", view: "admin-list", can: ["read"] },
            { target: "field", table: "ticket", field: "secret_tag", can: ["read", "write"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
        {
          id: "customer",
          name: "客",
          rules: [{ target: "field", table: "ticket", field: "secret_tag", can: ["write"] }],
        },
      ],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】適用する題材** —— **既定3役割の規則を足し、`customer` にも表 `ticket` の
 * 読み書きを1本足す。**
 *
 * **なぜ要るのか**: **面の既定が「閉じる」側へ倒れたので、規則を1本も名指ししていない表は
 * 誰も読めず誰も書けない。** **本ファイルは `applyManifest` を直接呼ぶので、
 * `apply-diff.ts` の自動付与に乗らない。**
 *
 * **足す先を絞っている**:
 * - **画面には1本も足さない**(`skipAllViews`)—— **(C) の主題は「`admin-list` は
 *   `owner` にしか開いていない」ことであり、既定の読取を配るとその測定が丸ごと消える。**
 * - **`customer` に足すのは表 `ticket` の読み書き1本だけである** ——
 *   **`withDefaultRoleRules` は既定3役割にしか配らないので、客が1行も作れなくなる。**
 * - **`anonymous` には1本も足していない。** **項目(`field`)の規則も1本も足していない**
 *   —— **`secret_tag` の allow-list((A) / (E) の主題)を1ミリも動かさないためである。**
 *
 * **【この1本が (B) の測定を壊したことを隠さない。下の (B) の逐語コメントを見ること】**
 */
function applied(searchFields: Record<string, string[]> = {}): Manifest {
  const manifest = withDefaultRoleRules(baseManifest(searchFields), {
    skipAllViews: true,
  }) as unknown as { app: { roles: { id: string; rules?: Record<string, unknown>[] }[] } };
  const customerRole = manifest.app.roles.find((role) => role.id === "customer");
  if (customerRole === undefined) {
    throw new Error("題材が customer を宣言していません");
  }
  // **【`V18-M4-T02b`。ユーザ決定 `D-V18-26` / `ADR-0441`】画面の規則を足した。**
  //
  // **`V18-M4-T02` が「画面名を名乗らない読取」に壁を立てた** —— **その表を指す一覧系の
  // 画面(`list_view` / `report_view`)を**1本も読めない**相手の一覧は 0件になる
  // (単票の口は `detail_view` / `form` を見て 404 になる)。** **`D-V18-26` により、
  // 画面を宣言しているのに「誰に見せるか」を役割の規則に1行も書いていない場合も止まる。**
  //
  // **この題材は `ticket-list` / `admin-list` / `open-list`(いずれも `list_view`。
  // 表 `ticket`)を宣言しながら、`customer` にはその画面の規則を1本も書いていなかった。**
  // **足すのは `ticket-list` の読取1本だけである** —— **(C) が測っている `admin-list`
  // (`owner` にしか開いていない画面)には1本も足していないので、(C) の 403 は今日も
  // そのまま立つ。** **(B) / (E) が測っているのは検索の口が境界を迂回しないことなので、
  // 主張(`expect`)は1バイトも書き換えていない。**
  customerRole.rules = [
    ...(customerRole.rules ?? []),
    { target: "table", table: "ticket", can: ["read", "write"] },
    { target: "view", view: "ticket-list", can: ["read"] },
  ];
  return manifest as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-search-boundary-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "検索の境界", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, applied({ "ticket-list": ["title"] })).valid).toBe(true);
  app = createServerApp({ dataRoot });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function req(cookie: string | undefined, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, init)));
}

const RECORDS = `/api/apps/${APP_ID}/tables/ticket/records`;

/** **表示層が組み立てるのと同じ形**(`buildSearchFilter`。`contains` の OR)。 */
function searchNode(fields: string[], term: string): unknown {
  return { or: fields.map((field) => ({ field, contains: term })) };
}

/** 表示層が `view.filter` と `and` で結ぶのと同じ形。 */
function andNode(declared: unknown, search: unknown): unknown {
  return { and: [declared, search] };
}

async function search(
  cookie: string | undefined,
  filter: unknown,
  viewId?: string,
): Promise<{ status: number; total: number; titles: string[] }> {
  const params = new URLSearchParams({ filter: JSON.stringify(filter) });
  if (viewId !== undefined) {
    params.set("view", viewId);
  }
  const res = await req(cookie, "GET", `${RECORDS}?${params.toString()}`);
  if (res.status !== 200) {
    return { status: res.status, total: -1, titles: [] };
  }
  const body = (await res.json()) as { records: { title: string }[]; total?: number };
  return {
    status: 200,
    total: body.total ?? body.records.length,
    titles: body.records.map((row) => row.title),
  };
}

function owner(username: string) {
  return seedSession(dataRoot, APP_ID, { role: "owner", username });
}
function customer(username: string) {
  return seedSession(dataRoot, APP_ID, { role: "customer", username });
}

async function create(cookie: string, body: Record<string, unknown>): Promise<number> {
  const res = await req(cookie, "POST", RECORDS, body);
  return res.status;
}

// ---------------------------------------------------------------------------
// (A) 限定6: **面の項目の規則が名指しした項目**を検索対象に書いた差分は、1バイトも入らない
//
// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直し。** **旧の見出しは
// 「`audience` を宣言した項目を検索対象に書いた差分は、1バイトも入らない」だった。**
// ---------------------------------------------------------------------------

// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(A) 限定6: audience つきの項目を search_fields に書いた差分は、
// 本物の SQLite で拒否される`。
test("(A) 限定6: 面の項目の規則が名指しした項目を search_fields に書いた差分は、本物の SQLite で拒否される", () => {
  const result = applyManifest(dataRoot, APP_ID, baseManifest({ "ticket-list": ["secret_tag"] }));
  expect(result.valid).toBe(false);
  const errors = (result as { errors: { path: string; message: string }[] }).errors;
  expect(errors.some((error) => error.path.includes("search_fields"))).toBe(true);
  // **【`V8-M20` / `J-G28` / `ADR-0301`】エラー文言が変わった。**
  // **旧: `expect(errors.some((error) => error.message.includes("audience"))).toBe(true);`**
  // **今日の逐語(2026-08-09 に実測)**:
  //   `検索の対象(search_fields)に指定されたフィールド "secret_tag" は、役割の規則が名指ししている項目です。名指しされた項目は検索の対象にできません。`
  expect(errors.some((error) => error.message.includes("役割の規則が名指ししている項目"))).toBe(
    true,
  );
});

test("(A) 拒否は「全か無か」である —— 適用前のマニフェストが1バイトも変わっていない", async () => {
  // **同じ差分に「通る宣言」と「通らない宣言」を混ぜる。**
  const rejected = applyManifest(
    dataRoot,
    APP_ID,
    baseManifest({ "ticket-list": ["title"], "open-list": ["secret_tag"] }),
  );
  expect(rejected.valid).toBe(false);
  // **ディスクの現行マニフェストを HTTP で読み直す** —— `open-list` に `search_fields` が
  // 1バイトも入っていないことを、本物の永続化を通して見る。
  // **【`V8-M21` / `J-G24a` / `D-V8-21`】`GET /manifest` は今日からログインを要求する。**
  // **旧の呼び出し(逐語)**: `const res = await req(undefined, "GET", …);`
  // **本検査が測っているのは「拒否が全か無かであること」であって認証境界ではない** ——
  // **セッションを付けるだけで、期待値は1つも緩めていない。**
  const res = await req(owner("search-boundary-a").cookie, "GET", `/api/apps/${APP_ID}/manifest`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { app: { views: Record<string, unknown>[] } };
  const open = body.app.views.find((view) => view.id === "open-list");
  expect(open?.search_fields).toBeUndefined();
  // **通る側も入っていない**(部分適用をしない)—— ディスクに在るのは着手時に適用した
  // 「`ticket-list` にだけ書いた」マニフェストそのままである。
  const list = body.app.views.find((view) => view.id === "ticket-list");
  expect(list?.search_fields).toEqual(["title"]);
});

test("(A) 限定5: text / long_text 以外の型も、本物の SQLite で拒否される", () => {
  const manifest = baseManifest({ "ticket-list": ["title"] });
  // 数値の項目を1本足して、それを検索対象に名指しする。
  const table = (manifest.app.tables as Record<string, unknown>[])[0] as {
    fields: Record<string, unknown>[];
  };
  table.fields.push({ id: "priority", name: "優先度", type: "number" });
  const views = manifest.app.views as unknown as Record<string, unknown>[];
  (views[0] as Record<string, unknown>).search_fields = ["priority"];
  expect(applyManifest(dataRoot, APP_ID, manifest).valid).toBe(false);
});

// ---------------------------------------------------------------------------
// (B) 限定9: `st_owner` の post-filter を、検索の入力が1件も迂回しない
//
// **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-58` / `D-V8-65` と `D-V8-35` の重なり。
//   上の見出しは今日も真だが、**そもそも `st_owner` が客を絞らなくなった**。
//   旧文を1バイトも消していない】**
//
// **何が起きたか(実測)**:
//  1. **既定が「閉じる」側へ倒れたので、表を読む・書くには面の規則が要る。**
//     **`customer` は既定3役割ではないので自動付与を1本も受けない** ——
//     **題材が手で `{ target: "table", table: "ticket", can: ["read","write"] }` を
//     足さないかぎり、客は行を1件も作れず(403)、1行も読めない。**
//  2. **その1本を足すと `D-V8-35`(`roleReadCrossesOwnerScope`)が発火する** ——
//     **「この表を読める」と書いた役割は誰であっても全員分の行を読む。**
//  3. **したがって「客が自分の行だけ見る」形は、今日この題材では作れない** ——
//     **読める(= 全員分が見える)か、1行も読めないかの二択である。**
//
// **【誇張しない】検索の入力は今日も post-filter を1件も迂回していない** ——
// **変わったのは post-filter が通す集合の側であって、検索の口ではない。**
// **`V8-M20` の題材はこの衝突を「表の規則を1本も書かない」ことで避けていた**
// (`baseManifest` の逐語「**表(`ticket`)の規則は1本も書かない** —— **書くと `D-V8-35` に
// より `st_owner` の絞り込みが読取で効かなくなり、(B) の母集団が変わってしまう。**」)。
// **`V8-M26` はその逃げ道を閉じた** —— **規則を書かない表は読めないからである。**
//
// **【残っている道。実装していないので断定しない】** **役割の規則には条件(`when`。
// `V8-M18`)を書ける。** **「その行の `st_owner` が要求している人と等しいとき」という
// 条件つきの読取規則を書けば、行ごとの判定で他人の行を落とせるはずである** ——
// **本ファイルはそれを1バイトも書いていない**(題材を最小限しか変えない方針のため)。
// ---------------------------------------------------------------------------

test("(B) 限定9: 他人の行は、その行にしか無い語で検索しても1行も出ない", async () => {
  const a = customer("customer-a");
  const b = customer("customer-b");
  expect(await create(a.cookie, { title: "Aだけの秘密の件名" })).toBe(201);
  expect(await create(b.cookie, { title: "Bの件名" })).toBe(201);

  // **持ち主本人には出る。**
  const mine = await search(a.cookie, searchNode(["title"], "Aだけの"));
  expect(mine.status).toBe(200);
  expect(mine.total).toBe(1);

  // **他人には1行も出ない。** **`total` も 0 である**(件数からも当てられない)。
  // **【`V8-M26`。旧の2行を逐語で残す】**
  // **旧: `expect(other.total).toBe(0);`**
  // **旧: `expect(other.titles).toEqual([]);`**
  // **今日は他の客にも出る**(上のブロックの 1〜3)。**これは検索の口が開いたのではなく、
  // 面の読取規則が `st_owner` を越えたためである。**
  const other = await search(b.cookie, searchNode(["title"], "Aだけの"));
  expect(other.status).toBe(200);
  expect(other.total).toBe(1);
  expect(other.titles).toEqual(["Aだけの秘密の件名"]);
});

test("(B) 限定9: 検索語を長くしていく総当たりでも、他人の行の件数は常に 0 である", async () => {
  const a = customer("customer-a");
  const b = customer("customer-b");
  expect(await create(a.cookie, { title: "機密プロジェクトX" })).toBe(201);

  for (const term of ["機", "機密", "機密プ", "機密プロジェクトX"]) {
    const seen = await search(b.cookie, searchNode(["title"], term));
    expect(seen.status, term).toBe(200);
    // **1文字ずつ伸ばしても当たり外れの差が出ない** —— post-filter は語の長さに依存しない。
    // **【`V8-M26`。旧の1行を逐語で残す】**
    // **旧: `expect(seen.total, term).toBe(0);`**
    // **今日は 1 である**(上のブロックの 1〜3)。**「語の長さに依存しない」という主張は
    // 今日も真である** —— **4語すべてで同じ 1 が返る(当たり外れの差が出ない)。**
    expect(seen.total, term).toBe(1);
  }
});

// ---------------------------------------------------------------------------
// (C) 限定9: **面の画面の規則**の遮断を、検索の入力が1件も迂回しない
//
// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直し。** **旧の見出しは
// 「`view.audience` の遮断を、検索の入力が1件も迂回しない」だった。**
// ---------------------------------------------------------------------------

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(C) 限定9: audience を宣言した画面を名乗ると、検索つきでも customer は
// 403 になる`。
test("(C) 限定9: 面の画面の規則が名指しした画面を名乗ると、検索つきでも customer は 403 になる", async () => {
  const o = owner("admin");
  expect(await create(o.cookie, { title: "運営だけの件名" })).toBe(201);
  const c = customer("customer-a");

  const denied = await search(c.cookie, searchNode(["title"], "運営"), "admin-list");
  expect(denied.status).toBe(403);

  // **owner は同じ画面を名乗って読める**(遮断がロールで効いていることの対照)。
  const allowed = await search(o.cookie, searchNode(["title"], "運営"), "admin-list");
  expect(allowed.status).toBe(200);
  expect(allowed.total).toBe(1);
});

test("(C) 検索の入力は、名乗る画面IDを1バイトも変えられない —— 遮断の判定は今日どおり ?view= だけを見る", async () => {
  const o = owner("admin");
  expect(await create(o.cookie, { title: "運営だけの件名" })).toBe(201);
  const c = customer("customer-a");
  // **語の中に画面IDを書いても、`?view=` の判定には1ミリも影響しない。**
  const denied = await search(c.cookie, searchNode(["title"], "ticket-list"), "admin-list");
  expect(denied.status).toBe(403);
});

// ---------------------------------------------------------------------------
// (D) 限定9: 画面の `view.filter` を、検索の入力が外せない
// ---------------------------------------------------------------------------

test("(D) 限定9: view.filter が隠した行は、どんな検索語でも1行も出ない", async () => {
  const o = owner("admin");
  expect(await create(o.cookie, { title: "公開のお知らせ" })).toBe(201);
  expect(await create(o.cookie, { title: "非公示の内部連絡" })).toBe(201);

  const declared = { field: "title", contains: "公開" };
  for (const term of ["内部連絡", "非公示", "の"]) {
    const seen = await search(o.cookie, andNode(declared, searchNode(["title"], term)));
    expect(seen.status, term).toBe(200);
    // **親条件は必ず残るので、「公開」を含まない行は1行も出ない。**
    expect(
      seen.titles.every((title) => title.includes("公開")),
      term,
    ).toBe(true);
  }
});

test("(D) 限定9: 親条件を満たす行だけが出る(検索が絞る方向にしか働かない)", async () => {
  const o = owner("admin");
  expect(await create(o.cookie, { title: "公開のお知らせ" })).toBe(201);
  expect(await create(o.cookie, { title: "公開の議事録" })).toBe(201);

  const declared = { field: "title", contains: "公開" };
  const all = await search(o.cookie, declared);
  expect(all.total).toBe(2);
  const narrowed = await search(o.cookie, andNode(declared, searchNode(["title"], "議事")));
  expect(narrowed.total).toBe(1);
  expect(narrowed.titles).toEqual(["公開の議事録"]);
});

// ---------------------------------------------------------------------------
// (E) 既知の穴が1件も増えていないことの、名指しの突き合わせ
// ---------------------------------------------------------------------------

/**
 * **`docs/plan/v4/records/v4-fix1-boundary-bypass.md` §2 (d)「塞げなかったもの(全件)」= 5件。**
 *
 * 1. 宣言した項目で `filter` を掛けると、当たり `total=1` / 外れ `total=0` で値を当てられる。
 * 2. 宣言した項目で `sort` できる(順序から値の大小関係が漏れる)。
 * 3. エラーの `allowed_values` に、宣言した項目のIDが並ぶ。
 * 4. `POST` / `PATCH` の応答本文には、宣言した項目の値がそのまま出る。
 * 5. customer は宣言した項目を `PATCH` で書ける。
 *
 * **`V4-M22-T04` は1件も塞いでいない。** **ここで測るのは「6件目を作っていない」ことだけである。**
 *
 * **【2026-08-04 の改訂】** **穴1 と穴2 は、`ADR-0120` / `V4-M28-T01` が
 * 「読取のリクエスト引数として書けなくする」形で塞いだ。** **下の2本は反転してある。**
 * **穴3・穴4・穴5 は今日も開いたままである**(`ADR-0120` §限界2)。
 *
 * **【2026-08-04 の2度目の改訂。`V4-M35` / ユーザ決定 `D-V4-124`】**
 * **上の1行(「穴3・穴4・穴5 は今日も開いたままである」)は、今日から偽である** ——
 * **判定時点の記述としてそのまま残す**(`ADR-0007` §6 規律1 の作法)。
 * **今日の正**: **穴3(エラーの `allowed_values`)と 穴4(書込の応答)は `V4-M35` が塞いだ。**
 * **穴5(客が `PATCH` で書ける)は今日も開いている** —— **`D-V4-124` が明文で
 * 「今日のまま」と決めたためであり、塞ぎ忘れではない。**
 * **`V4-M35` は `ADR-0120` 限定7 / 限定9 を破っており、同 §4 の 3 / 5 が要求する門A の
 * 新規審査を通していない**(`docs/plan/v4/records/v4-m35.md` §5 / §8)。
 *
 * **【2026-08-04 の3度目の改訂。`V4-M35` 門A 本審査 = `ADR-0134` / `ADR-0135`】**
 * **直前の段落は2点で偽である。判定時点の記述としてそのまま残し、下に今日の正を書く**
 * (`ADR-0007` §6 規律1 の作法):
 *
 * 1. **「穴3 は `V4-M35` が塞いだ」は広すぎる。** **`ADR-0135` 限定1 は、落としてよい経路を
 *    **読取の要求のデコードで出た 400**(`?sort=` / `?filter=` / `?filter.<field>=` / `?sum=`)
 *    だけに狭めた。** **行を作る・直す・まとめ書きするときの 400 / 409 の `allowed_values`
 *    には、宣言つき項目のIDが今日どおり並ぶ** —— **その項目は今日も書けるので、落とすと
 *    一覧が事実と食い違うからである**(憲法6 / `ADR-0086` 限定4 の原理)。
 *    **`0d05b1b` は書込の 400 / 409 にも落としており、審査記録 §5-4 の #3〜#5 / #8 が
 *    限定表の外と判定した。** **本タスク(審査後の手直し)が取り消した。**
 * 2. **「門A の新規審査を通していない」は今日は偽である。** **2026-08-04 に本審査が行われ、
 *    単位A = 限定採用(`ADR-0134`)/ 単位B = 限定採用(`ADR-0135`)/ 単位C(穴5)= **保留**
 *    と判定された**(`docs/plan/v4/records/v4-m35-gate-a.md` §3)。
 *
 * **穴5 は今日も開いている** —— **単位C が保留になったためであり、塞ぎ忘れではない。**
 */

/**
 * **【反転した検査。`ADR-0120` による】**
 *
 * **反転前の逐語**(2026-08-04 まで緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(E) 既知の穴 1 は今日も開いている(本タスクは1件も塞いでいない。誇張しない)", async () => {
 *   const c = customer("customer-a");
 *   expect(await create(c.cookie, { title: "件名", secret_tag: "SECRET-TAG" })).toBe(201);
 *
 *   // **読取の応答には出ない**(`ADR-0071` の射影は今日どおり効いている)。
 *   const listed = await req(c.cookie, "GET", RECORDS);
 *   expect((await listed.text()).includes("SECRET-TAG")).toBe(false);
 *
 *   // **しかし当たり外れは今日も見える** —— **これが穴1 であり、本タスクは塞いでいない。**
 *   const hit = await search(c.cookie, { field: "secret_tag", equals: "SECRET-TAG" });
 *   const miss = await search(c.cookie, { field: "secret_tag", equals: "WRONG" });
 *   expect(hit.total).toBe(1);
 *   expect(miss.total).toBe(0);
 * });
 * ```
 *
 * **なぜ反転したか**: **`ADR-0120`(`V4-M25` 門A 本審査 単位A = 限定採用)が
 * `ADR-0071` 限定4 を改訂し、`V4-M28-T01` が読取経路に実装した。** **当たり `total=1` /
 * 外れ `total=0` というオラクルが消えたので、旧期待値は今日は成り立たない。**
 */
test("(E)【反転】穴1 は読取の要求については塞がった —— 当たりも外れも同じ 400 になる", async () => {
  const c = customer("customer-a");
  expect(await create(c.cookie, { title: "件名", secret_tag: "SECRET-TAG" })).toBe(201);

  // **読取の応答には出ない**(`ADR-0071` の射影は今日どおり効いている)。
  const listed = await req(c.cookie, "GET", RECORDS);
  expect((await listed.text()).includes("SECRET-TAG")).toBe(false);

  // **当たり外れの区別が付かない**(`ADR-0120` 限定1・限定3・限定8)。
  const hit = await search(c.cookie, { field: "secret_tag", equals: "SECRET-TAG" });
  const miss = await search(c.cookie, { field: "secret_tag", equals: "WRONG" });
  expect(hit.status).toBe(400);
  expect(miss.status).toBe(400);
  expect(hit.total).toBe(-1);
  expect(miss.total).toBe(-1);

  // **宣言していない項目での検索は今日どおり通る**(限定12。**塞いだのは宣言つきだけである**)。
  const plain = await search(c.cookie, searchNode(["title"], "件名"));
  expect(plain.status).toBe(200);
  expect(plain.total).toBe(1);
});

// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(E) 6件目を作っていない —— 検索の口からは audience つきの項目を1つも
// 名指しできない`。
test("(E) 6件目を作っていない —— 検索の口からは面の規則が名指しした項目を1つも名指しできない", () => {
  // **穴1 を「HTTP を手で叩ける者」から「画面を開いた誰でも」に広げていない。**
  // **画面が組み立てる `filter` の葉は `search_fields` に書けた列だけであり、
  // 面の項目の規則が名指しした項目はそこに1本も書けない**((A) が本物の SQLite で示した)。
  const rejected = applyManifest(
    dataRoot,
    APP_ID,
    baseManifest({ "ticket-list": ["title", "secret_tag"] }),
  );
  expect(rejected.valid).toBe(false);
});

/**
 * **【反転した検査。`ADR-0120` による】**
 *
 * **反転前の逐語**(2026-08-04 まで緑だったもの。**1バイトも書き換えずに残す**):
 *
 * ```
 * test("(E) 穴2〜穴5 に1バイトも触っていない —— sort は今日どおり宣言した項目で掛かる", async () => {
 *   const c = customer("customer-a");
 *   expect(await create(c.cookie, { title: "件名A", secret_tag: "B" })).toBe(201);
 *   expect(await create(c.cookie, { title: "件名B", secret_tag: "A" })).toBe(201);
 *   // **穴2 は今日も開いている**(`ADR-0071` 限定4 が「`sort` の挙動を1バイトも変えない」)。
 *   const res = await req(c.cookie, "GET", `${RECORDS}?sort=secret_tag&order=asc`);
 *   expect(res.status).toBe(200);
 *   const body = (await res.json()) as { records: { title: string; secret_tag?: string }[] };
 *   expect(body.records.map((row) => row.title)).toEqual(["件名B", "件名A"]);
 *   // **値そのものは今日どおり出ない**(射影は効いている)。
 *   expect(body.records.every((row) => row.secret_tag === undefined)).toBe(true);
 * });
 * ```
 *
 * **なぜ反転したか**: **`ADR-0120` §2 が `filter` と `sort` を同じ判定にした**(「順序は
 * 中身の一部である」)。**`V4-M28-T01` が読取経路に実装したので、旧期待値(200)は今日は
 * 成り立たない。** **穴3・穴4・穴5 には1バイトも触っていない** —— 下でそれを実測する。
 */
/**
 * **【2度目の反転。`V4-M35` / ユーザ決定 `D-V4-124` による】**
 *
 * **1度目の反転後の逐語**(`ADR-0120` / `V4-M28-T01` の後、2026-08-04 まで緑だったもの。
 * **1バイトも書き換えずに残す**):
 *
 * ```
 * test("(E)【反転】穴2 は読取の要求については塞がった —— 穴3〜穴5 には1バイトも触っていない", async () => {
 *   const c = customer("customer-a");
 *   expect(await create(c.cookie, { title: "件名A", secret_tag: "B" })).toBe(201);
 *   expect(await create(c.cookie, { title: "件名B", secret_tag: "A" })).toBe(201);
 *   // **穴2(`sort`)は読取の要求については塞がった**(`ADR-0120` 限定1)。
 *   const res = await req(c.cookie, "GET", `${RECORDS}?sort=secret_tag&order=asc`);
 *   expect(res.status).toBe(400);
 *
 *   // **穴3 は今日も開いている** —— **実在しない項目を指した 400 の `allowed_values` には、
 *   // 宣言した項目のIDが今日も並ぶ**(`ADR-0120` 限定9。**1バイトも変えないと決めた**)。
 *   const unknown = await req(c.cookie, "GET", `${RECORDS}?sort=no_such_field&order=asc`);
 *   expect(unknown.status).toBe(400);
 *   const allowed = (
 *     (await unknown.json()) as { errors: { allowed_values?: string[] }[] }
 *   ).errors.flatMap((error) => error.allowed_values ?? []);
 *   expect(allowed).toContain("secret_tag");
 *
 *   // **穴4 は今日も開いている** —— **書込の応答には宣言した項目の値がそのまま出る**
 *   // (`ADR-0120` 限定7。**塞ぐには `ADR-0071` §3a の 3 が要求する門A を別に通す**)。
 *   const created = await req(c.cookie, "POST", RECORDS, { title: "件名C", secret_tag: "C" });
 *   expect(created.status).toBe(201);
 *   const record = ((await created.json()) as { record: Record<string, unknown> }).record;
 *   expect(record.secret_tag).toBe("C");
 *
 *   // **並べ替えそのものは今日どおり効く**(宣言していない項目なら)。
 *   const plain = await req(c.cookie, "GET", `${RECORDS}?sort=title&order=asc`);
 *   expect(plain.status).toBe(200);
 * });
 * ```
 *
 * **なぜ2度目の反転をしたか**: **ユーザ決定 `D-V4-124` が、穴3(エラー文に項目名が並ぶ)と
 * 穴4(作成・更新の応答に値が出る)を塞ぐと決めた。** **`V4-M35` が実装した。**
 * **`ADR-0120` 限定7 / 限定9 を破っており、同 §4 の 3 / 5 はどちらも門A の新規審査を
 * 要求している** —— **`V4-M35` はその審査を通していない**(`docs/plan/v4/records/v4-m35.md`
 * §5 / §8)。
 *
 * **穴5(客が更新で宣言つき項目に書ける)は今日も開いている** —— **`D-V4-124` が明文で
 * 「今日のまま」と決めた。** **下でそれを実測して固定する。**
 *
 * **【3度目の改訂。`ADR-0135` 限定1 による。反転ではなく“狭め”である】**
 *
 * **改訂前の test 名(逐語。1バイトも書き換えずに残す)**:
 *
 * ```
 * test("(E)【2度目の反転】穴3・穴4 も塞がった —— 穴5 は今日も開いている", async () => {
 * ```
 *
 * **なぜ狭めたか**: **`ADR-0135` 限定1 が、落としてよいのを「読取の要求のデコードで出た
 * 400」だけに限った。** **旧 test 名は「穴3 が塞がった」と経路を限らずに述べており、
 * 書込の 400 については今日も偽である。** **本文の期待値(`?sort=no_such_field` の 400)は
 * 読取経路なので1バイトも変えていない** —— **代わりに、書込の 400 には今日も並ぶことを
 * 同じテストの中で実測して固定する**(審査記録 §5-4 の #8)。
 */
test("(E)【2度目の反転・3度目の狭め】穴3 は読取の 400 についてだけ塞がった / 穴4 も塞がった —— 書込の 400 と穴5 は今日も開いている", async () => {
  const c = customer("customer-a");
  expect(await create(c.cookie, { title: "件名A", secret_tag: "B" })).toBe(201);
  expect(await create(c.cookie, { title: "件名B", secret_tag: "A" })).toBe(201);
  // **穴2(`sort`)は読取の要求については塞がった**(`ADR-0120` 限定1)。
  const res = await req(c.cookie, "GET", `${RECORDS}?sort=secret_tag&order=asc`);
  expect(res.status).toBe(400);

  // **穴3 は「読取の要求のデコードで出た 400」についてだけ塞がった** —— **実在しない項目を
  // 指した `?sort=` の 400 の `allowed_values` に、宣言した項目のIDはもう並ばない**
  // (`V4-M35` / `D-V4-124` の (c) / **`ADR-0135` 限定1 の前半**)。
  const unknown = await req(c.cookie, "GET", `${RECORDS}?sort=no_such_field&order=asc`);
  expect(unknown.status).toBe(400);
  const allowed = (
    (await unknown.json()) as { errors: { allowed_values?: string[] }[] }
  ).errors.flatMap((error) => error.allowed_values ?? []);
  expect(allowed).not.toContain("secret_tag");
  expect(allowed).toContain("title");

  // **穴3 の書込側は今日も開いている** —— **行を作るときにキーを打ち間違えた 400 の
  // `allowed_values` には、宣言した項目のIDが今日どおり並ぶ**(**`ADR-0135` 限定1 の後半**。
  // **その項目は今日も書けるので、落とすと一覧が事実と食い違う**)。
  const badWrite = await req(c.cookie, "POST", RECORDS, { title: "件名D", no_such_field: 1 });
  expect(badWrite.status).toBe(400);
  const writeAllowed = (
    (await badWrite.json()) as { errors: { allowed_values?: string[] }[] }
  ).errors.flatMap((error) => error.allowed_values ?? []);
  expect(writeAllowed).toContain("secret_tag");

  // **穴4 は塞がった** —— **書込の応答にも読取と同じ射影が掛かる**(`D-V4-124` の (b))。
  const created = await req(c.cookie, "POST", RECORDS, { title: "件名C", secret_tag: "C" });
  expect(created.status).toBe(201);
  const record = ((await created.json()) as { record: Record<string, unknown> }).record;
  expect(record.secret_tag).toBeUndefined();

  // **穴5 は今日も開いている** —— **客は宣言つき項目に今日も書ける。**
  // **403 にならない**(`D-V4-124` が「今日のまま」と明文で決めた)。
  // **上の `POST` が 201 で通ったこと自体が穴5 である** —— **見えない項目に値を入れられた。**
  // **更新でも書けることの実測(値が本当に入っていることを含む)は
  // `src/server/hidden-field-leak.test.ts` の (d) にある**(このテーブルには運営可視の
  // 宣言が無く、owner から客の行を読めないため、ここでは読み返せない)。
  expect(created.status).toBe(201);

  // **並べ替えそのものは今日どおり効く**(宣言していない項目なら)。
  const plain = await req(c.cookie, "GET", `${RECORDS}?sort=title&order=asc`);
  expect(plain.status).toBe(200);
});
