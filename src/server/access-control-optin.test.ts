/**
 * **`V7-M5-T06`(計画外タスク)/ `Z-G20`**: **アクセス権管理を使っていない表が、
 * 今までどおりのままであることを、機械的な検査として置く。**
 *
 * ## **この検査が守っているもの(1行で)**
 *
 * > **この検査が赤くなったら、アクセス権管理を使っていない既存アプリのふるまいが
 * > 変わったということである。**
 *
 * ## **この検査が「していない」こと(先に書く)**
 *
 * - **この検査は着手前 sha(`7058683dbd975a9c0bc1683ac1c8f88c09a4b117` / v7 の着手前は
 *   `32de65eac51f14b34b5bff77dcdff32625c34ba8`)との比較を1件もしていない。**
 *   ここで突き合わせているのは **「今日の同じ版の中で、宣言していない表と `enabled: false`
 *   の表が同じ応答を返すか」** だけである。**過去の版の応答を1バイトも読んでいない。**
 * - **`V7-M1-T06` と `V7-M5-T03` が、実際のリクエストと応答(`curl -i` の生出力)で
 *   着手前と突き合わせた結果は、この検査ではなく記録とエビデンスに在る**
 *   (`docs/plan/v7/records/v7-m1.md` の `V7-M1-T06` / `docs/plan/v7/records/v7-m5.md` の
 *   `V7-M5-T03`)。**この2本の実測をこのファイルは1バイトも再現していない。**
 * - **したがって「既存アプリは壊れない」とは書けない。** `v7-m0.md` §6-3 `Z-G20` の
 *   「誇張しない」の逐語 —— 「**標本は1件である。**『既存アプリは壊れない』ではなく
 *   『**実測した1件と、合成した検査の範囲では変わらなかった**』までしか書けない。」
 *
 * ## **なぜ計画外タスクとして足したか**
 *
 * `v7-m0.md` §6-3 `Z-G20` の `S2` は変更予定ファイルに **新設
 * `src/server/access-control-optin.test.ts`**(本ファイル)を名指ししているが、
 * **`V7-M5-T03` の完了時点でリポジトリに1本も存在しなかった。** `S3` の3が
 * 「**検査が消えれば黙って壊れる。**」と自認しているとおり、実測だけを記録に残すと
 * 「オプトインが壊れたら赤くなる」機械的検査が1本も無い状態になる。**それを埋める。**
 * **`ADR-0007` の歯止め4(計画外タスクも宣言する)に従い、計画外であることを明示する。**
 *
 * ## **測るもの(1〜8)。すべて HTTP の応答で測る(内部関数の戻り値で代用しない)**
 *
 * `Z-G20` の限定(3)の逐語「**測るのは HTTP の応答である**(内部関数の戻り値ではない)」。
 * 本ファイルは `owner-scope.ts` の述語も `judgeRecordAccess` も1つも import していない。
 *
 * 1. **7本の行操作の応答が本文単位で一致する**(一覧 GET(0件)/ POST 作成 /
 *    一覧 GET(1件)/ 単件 GET / PATCH / DELETE / 削除後の単件 GET)。
 * 2. **未認証でも一致する**(一覧 GET / 単件 GET)。
 * 3. **運営ロール(`owner`)でも一致する**(7本すべて)。
 * 4. **`enabled: false` の表には「取り残し一覧」の口が無い**(404)。
 *    **`enabled: true` の表では 200 になる**(拒否側だけを測ると全部拒否しても緑になる)。
 * 5. **`enabled: false` の表では、付与表に行を作っても判定に1ミリも効かない。**
 * 6. **`enabled: false` → `enabled: true` に変えるとふるまいが変わる**
 *    (`change_table` の差分を **HTTP から** 投げて切り替える)。
 * 7. 本コメント冒頭の宣言そのもの。
 * 8. **(1)〜(3) の突き合わせ自体が効いていること**(**足したのは発注書の出口の外である**)
 *    —— **同じ7本を `enabled: true` の表に打つと割れる。** **(1) と (3) は「一致すること」
 *    だけを測るので、判定が丸ごと無効になっても緑になる。それを1本で塞ぐ。**
 *
 * ## **一致の対象から外した欄(伏せ字にした欄の一覧。逐語で全件)**
 *
 * **原理的に一致し得ない欄だけを伏せ字にした。それ以外は1バイトも触っていない。**
 *
 *  - **`_id`** —— 行のID。**表ごとに別の行なので必ず違う。** 本文中のどこに現れても
 *    (`records[]._id` / 単件応答 / 404 のエラー文面 / `hint`)`<ID>` に置き換える。
 *  - **`_created_at`** —— 作成時刻。**作った瞬間が違う。**`<TIME>` に置き換える。
 *  - **`_updated_at`** —— 更新時刻(= 版。`If-Match` に使う値)。同上、`<TIME>`。
 *  - **表のID**(`plain_notes` / `paused_notes` / `armed_notes`)—— **URL に書いた値が
 *    エラー本文の `path` / `message` / `hint` にそのまま出る。**`<TABLE>` に置き換える。
 *  - **セッション**(`st_session` cookie の値・`_auth_*` のユーザID)—— **応答本文には
 *    現れないが、リクエストには載る。** 相手をそろえるため、**同じ1人のセッションで
 *    両方の表を叩いている**(伏せ字ではなく、そもそも同一にしてある)。
 *
 * **伏せ字にしていない欄の例**(= 違えば赤くなる): `status` / `records` の並び /
 * `total` / `title` / `memo` / `errors[].code` / `errors[].message` / `errors[].hint` /
 * `errors[].path`(表IDを除く)。
 *
 * ## **正直に残る限界**
 *
 *  - **合成した1アプリしか測っていない。** 実在のアプリ(`wadashi-store`)は1件も叩いて
 *    いない(`Z-G20` `S3` の4 が「対象アプリは1件しか無い」と書いているのはそちらの話)。
 *  - **測ったのは行の操作の口だけである。** ビュー・バッチ・ファイル・受信口・
 *    ワークフローの口は1本も叩いていない。
 *  - **`enabled: false` と「宣言していない」が同じであることを示しても、
 *    「着手前と同じ」ことにはならない** —— **両方が同時に同じだけ壊れたら、この検査は
 *    緑のままである。**(着手前との比較は上記のとおり記録の側に在る。)
 *
 * ## **【`V8-M26` で、この検査が測る中身が2箇所変わった。隠さずに書く】**
 *
 * **`V8-M26` が面(役割に束ねた権限)の既定を「閉じる」側へ倒し、その埋め合わせとして
 * 表を作るたびに既定3役割の規則が入るようになった。** **その結果、本ファイルは
 * 「宣言していない表と `enabled: false` の表が同じ」という主題は保ったまま、
 * **次の2つを逆向きに固定し直している**(いずれも当該行に旧の期待値を逐語で残した):
 *
 *  1. **(1) の6本目・7本目** —— **`editor` は規則を1本も書いていない表の行を消せなくなった**
 *     (`204` → `403`。既定の自動付与が `editor` に `delete` を配らない = `D-V8-61`)。
 *     **`owner` は今日も消せるので、(3) は `204` のままである。**
 *  2. **(6) の切り替え後** —— **`enabled: true` にしても、`editor` からは同じ行が今日も見える**
 *     (`404` → `200`。面と点が `OR` で重なり、面の側が通す = `D-V8-23`)。
 *     **変わるのは「取り残し一覧」の口が開くこと(404 → 200)だけになった。**
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { createServerApp } from "./app.ts";
import { seedSession, TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "optin-desk";

/** **宣言を1文字も書いていない表。** */
const PLAIN = "plain_notes";
/** **同じ内容の表に宣言を書き、`enabled: false` にしたもの。** */
const PAUSED = "paused_notes";
/** **同じ内容の表に宣言を書き、`enabled: true` にしたもの**((4) の 200 側)。 */
const ARMED = "armed_notes";

const PERMISSIONS = [
  { id: "reader", name: "参照のみ", read: true, write: false, delete: false },
  { id: "writer", name: "編集できる", read: true, write: true, delete: false },
] as const;

/** `paused_notes` に書く宣言。**`enabled` 以外は `armed_notes` と同じ形。** */
function pausedDeclaration(enabled: boolean): Record<string, unknown> {
  return {
    enabled,
    permissions: PERMISSIONS.map((permission) => ({ ...permission })),
    creator_permission: "writer",
    grant: {
      table: "paused_grant",
      target: "note",
      member: "member",
      permission: "permission",
    },
    members: { table: "note_member", account: "account" },
  };
}

/**
 * **`plain_notes` / `paused_notes` / `armed_notes` は項目まで同一である** ——
 * 違うのは `access_control` を書いたかどうかと `enabled` の値だけ。
 */
function notesFields() {
  return [
    { id: "title", name: "題", type: "text", required: true },
    { id: "memo", name: "メモ", type: "long_text" },
  ];
}

function manifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "オプトインの台帳",
      tables: [
        { id: PLAIN, name: "ふつうのメモ", fields: notesFields() },
        {
          id: PAUSED,
          name: "止めてあるメモ",
          fields: notesFields(),
          access_control: pausedDeclaration(false),
        },
        {
          id: ARMED,
          name: "使っているメモ",
          fields: notesFields(),
          access_control: {
            enabled: true,
            permissions: PERMISSIONS.map((permission) => ({ ...permission })),
            creator_permission: "writer",
            // **【`V18-M5-T02b` / `PM-G2` / `ADR-0442`】題材に1行足した(主張は1バイトも
            // 書き換えていない)。** **根の表に「行を作れる立場」を一行も書かないときの
            // 既定が「誰も作れない」へ反転したので**(`ADR-0432` §Decision)、
            // **(8) が測っている「作成で割れること」の中身が、名簿の断り(400)から
            // 立場の断り(403)へすり替わっていた。** **測りたいのは名簿の側なので、
            // この関門は素通りさせる。**
            creatable_by_roles: ["owner", "editor"],
            grant: {
              table: "armed_grant",
              target: "note",
              member: "member",
              permission: "permission",
            },
            members: { table: "note_member", account: "account" },
          },
        },
        {
          id: "note_member",
          name: "利用者",
          fields: [{ id: "account", name: "ログイン", type: "text" }],
        },
        {
          id: "paused_grant",
          name: "止めてあるメモの付与",
          fields: [
            { id: "note", name: "メモ", type: "reference", reference_table: PAUSED },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
        {
          id: "armed_grant",
          name: "使っているメモの付与",
          fields: [
            { id: "note", name: "メモ", type: "reference", reference_table: ARMED },
            { id: "member", name: "相手", type: "reference", reference_table: "note_member" },
            { id: "permission", name: "権限", type: "select", options: ["reader", "writer"] },
          ],
        },
      ],
      views: [],
    },
  } as unknown as Manifest;
}

/**
 * **【`V8-M26`】面(役割に束ねた権限)の規則を足した題材**(適用に渡すのはこちら)。
 *
 * **`V8-M26` が面の既定を「閉じる」側へ倒した** —— **規則を1本も名指ししていない
 * `table` / `view` / `action` は拒否される**(ユーザ決定 `D-V8-45` / `D-V8-65`)。
 * **実アプリでは差分の畳み込み(`src/kernel/apply-diff.ts`)が `add_table` のたびに既定3役割
 * (`owner` / `editor` / `viewer`)へ規則を1本ずつ足すが、本検査は `applyManifest` を直接
 * 呼ぶのでその経路を1度も通らない。** **そのぶんだけを `withDefaultRoleRules` で埋める**
 * (`src/server/owner-scope.ts` は1バイトも触っていない。変えたのは題材の側だけである)。
 *
 * **開ける表と外す表を、理由つきで名指しする**:
 *
 *  - **`plain_notes`(宣言していない表)/ `paused_notes`(`enabled: false`)は開ける。**
 *    **この2つは本ファイルの主題そのもの(「同じであること」)であり、片方だけを開けると
 *    比べる意味が無くなる。** **どちらも点(行ごとの付与)は管轄外なので、面の規則を
 *    足しても点の測定を1ミリも無効にしない。**
 *  - **補助表(`note_member` / `paused_grant` / `armed_grant`)も開ける** ——
 *    **`access_control` を1つも宣言していない普通の表であり、(5) はそこへ行を作る。**
 *  - **`armed_notes`(`enabled: true`)だけを `skipTables` で外す** ——
 *    **点が管轄内の唯一の表であり、面の規則を1本でも足すと面と点が `OR` で重なって
 *    全員が通り、(4) と (8) が測っている点の判定が丸ごと無効になる。**
 *
 * **【正直に書く】この「開ける/外す」の線引きは、実アプリの姿と1箇所ずれる** ——
 * **`apply-diff.ts` の自動付与は `access_control` の有無を1バイトも見ないので、
 * 実アプリでは `armed_notes` にも既定3役割の規則が入る。** **その結果がどうなるかは
 * (6) が実測して固定している(下の `V8-M26` の注記)。**
 */
function manifestWithRoles(): Manifest {
  return withDefaultRoleRules(manifest(), { skipTables: [ARMED] });
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;
let ownerSession: ReturnType<typeof seedSession>;
let editorSession: ReturnType<typeof seedSession>;

const recordsPath = (tableId: string): string => `/api/apps/${APP_ID}/tables/${tableId}/records`;
const singlePath = (tableId: string, recordId: string): string =>
  `${recordsPath(tableId)}/${recordId}`;
const doorPath = (tableId: string): string =>
  `/api/apps/${APP_ID}/tables/${tableId}/unreachable-records`;

type RawResponse = { status: number; body: string };

/**
 * **HTTP を1本打って、ステータスと本文を文字列のまま返す。**
 * `cookie` が `undefined` なら Cookie を1バイトも送らない(= 未認証)。
 */
async function hit(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: { cookie?: string; body?: unknown; ifMatch?: string } = {},
): Promise<RawResponse> {
  const headers = new Headers();
  if (options.cookie !== undefined) {
    headers.set("cookie", options.cookie);
  }
  if (method !== "GET") {
    headers.set("origin", TEST_ORIGIN);
  }
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }
  if (options.ifMatch !== undefined) {
    headers.set("if-match", options.ifMatch);
  }
  const init: RequestInit = { method, headers };
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body);
  }
  const response = await app.request(`http://localhost${path}`, init);
  return { status: response.status, body: await response.text() };
}

/**
 * **一致の対象から外す欄を伏せ字にする**(ファイル冒頭の一覧と1件も違わない)。
 *
 * **表IDは呼び出し側が渡す** —— **URL に書いた値がエラー本文にそのまま出るためである。**
 * **行のIDは、その回の応答で実際に使ったものを渡す**(応答から拾えない 404 の文面にも
 * 出るため、文字列として置き換える)。
 */
function redact(body: string, tableId: string, recordIds: string[]): string {
  let out = body;
  out = out.replaceAll(tableId, "<TABLE>");
  for (const id of recordIds) {
    if (id !== "") {
      out = out.replaceAll(id, "<ID>");
    }
  }
  // `_created_at` / `_updated_at` の値(ISO 8601)。**キー名は残し、値だけ伏せる。**
  out = out.replace(/"(_created_at|_updated_at)":"[^"]*"/g, '"$1":"<TIME>"');
  return out;
}

type Step = { label: string; status: number; body: string };

/**
 * **`Z-G20` が名指しした7本を、同じ順で1つの表に打つ。**
 * **戻り値は伏せ字済みである**(表IDと行IDは、この関数の中で実際に使った値だけを伏せる)。
 */
async function sevenSteps(tableId: string, cookie: string): Promise<Step[]> {
  const steps: Step[] = [];
  const ids: string[] = [];
  const push = (label: string, raw: RawResponse): void => {
    steps.push({ label, status: raw.status, body: redact(raw.body, tableId, ids) });
  };

  // 1本目: 一覧 GET(0件)
  push("1 一覧GET(0件)", await hit("GET", recordsPath(tableId), { cookie }));

  // 2本目: POST 作成
  const created = await hit("POST", recordsPath(tableId), {
    cookie,
    body: { title: "同じ題", memo: "同じメモ" },
  });
  const createdRow = JSON.parse(created.body) as { record?: Record<string, unknown> };
  const recordId = String(createdRow.record?._id ?? "");
  const version = String(createdRow.record?._updated_at ?? "");
  ids.push(recordId);
  push("2 POST作成", created);

  // 3本目: 一覧 GET(1件)
  push("3 一覧GET(1件)", await hit("GET", recordsPath(tableId), { cookie }));

  // 4本目: 単件 GET
  push("4 単件GET", await hit("GET", singlePath(tableId, recordId), { cookie }));

  // 5本目: PATCH(`If-Match` は必須。**版はその表の行から取る**)
  const patched = await hit("PATCH", singlePath(tableId, recordId), {
    cookie,
    ifMatch: version,
    body: { memo: "書き換えたメモ" },
  });
  const patchedRow = JSON.parse(patched.body || "{}") as { record?: Record<string, unknown> };
  const nextVersion = String(patchedRow.record?._updated_at ?? version);
  push("5 PATCH", patched);

  // 6本目: DELETE
  push(
    "6 DELETE",
    await hit("DELETE", singlePath(tableId, recordId), { cookie, ifMatch: nextVersion }),
  );

  // 7本目: 削除後の単件 GET
  push("7 削除後の単件GET", await hit("GET", singlePath(tableId, recordId), { cookie }));

  return steps;
}

/** **本文を1件でも作っておく** —— 未認証の単件 GET に実在の行IDを渡すため。 */
async function seedRow(tableId: string, cookie: string): Promise<string> {
  const created = await hit("POST", recordsPath(tableId), {
    cookie,
    body: { title: "同じ題", memo: "同じメモ" },
  });
  expect(created.status).toBe(201);
  return String((JSON.parse(created.body) as { record: { _id: string } }).record._id);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-optin-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "オプトインの台帳", { app_id: APP_ID });
  } finally {
    store.close();
  }
  const applied = applyManifest(dataRoot, APP_ID, manifestWithRoles());
  expect(applied.valid, JSON.stringify(applied)).toBe(true);
  app = createServerApp({ dataRoot });
  ownerSession = seedSession(dataRoot, APP_ID, { role: "owner", username: "u-owner" });
  editorSession = seedSession(dataRoot, APP_ID, { role: "editor", username: "u-editor" });
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V7-M5-T06 / Z-G20: 宣言していない表と `enabled: false` の表が同じであること", () => {
  test("(1) 7本の行操作の応答が、本文単位で一致する(`editor`)", async () => {
    const plain = await sevenSteps(PLAIN, editorSession.cookie);
    const paused = await sevenSteps(PAUSED, editorSession.cookie);

    expect(plain.map((step) => step.label)).toEqual(paused.map((step) => step.label));
    expect(plain).toHaveLength(7);
    // **1本ずつ突き合わせる**(まとめて比べると、どの操作で割れたかが読めない)。
    for (let index = 0; index < plain.length; index += 1) {
      expect(
        { table: "<TABLE>", ...paused[index] },
        `${plain[index]?.label}: 宣言していない表と enabled: false の表で応答が違う`,
      ).toEqual({ table: "<TABLE>", ...plain[index] });
    }
    // **期待した形になっていることも固定する**(両方が同時に壊れて緑になるのを減らす)。
    //
    // **【`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-61` / `D-V8-65`。旧の1行を逐語で残す】**
    // **旧: expect(plain.map((step) => step.status)).toEqual([200, 201, 200, 200, 200, 204, 404]);**
    //
    // **6本目(`DELETE`)が `204` から `403` に、7本目(削除後の単件 `GET`)が `404` から
    // `200` に変わった** —— **行が消えていないので、その後の `GET` は今日も見える。**
    // **理由は「面の既定が閉じた」ことではなく、その埋め合わせとして配られる既定の規則が
    // `editor` に `delete` を配らないことである**(`D-V8-61`: 編集者は 見る + 書く)。
    // **`V8-M26` より前は、規則を1本も書いていない表の行を `editor` が消せていた。**
    // **今日は消せない。** **これは既定が閉じたことで実際に失われたふるまいである。**
    //
    // **`owner` は今日も消せる**(`D-V8-62`: 持ち主は3つとも)—— **(3) が同じ7本を
    // `owner` で打ち、`[200, 201, 200, 200, 200, 204, 404]` のまま固定している。**
    // **つまりこの差は「全部拒否になった」ではなく「役割で割れるようになった」である。**
    expect(plain.map((step) => step.status)).toEqual([200, 201, 200, 200, 200, 403, 200]);
    expect(plain[0]?.body).toBe('{"records":[],"total":0}');
  });

  test("(2) 未認証でも、一覧 GET と単件 GET の応答が一致する", async () => {
    const plainRow = await seedRow(PLAIN, editorSession.cookie);
    const pausedRow = await seedRow(PAUSED, editorSession.cookie);

    const plainList = await hit("GET", recordsPath(PLAIN));
    const pausedList = await hit("GET", recordsPath(PAUSED));
    expect({
      status: pausedList.status,
      body: redact(pausedList.body, PAUSED, [pausedRow]),
    }).toEqual({ status: plainList.status, body: redact(plainList.body, PLAIN, [plainRow]) });

    const plainSingle = await hit("GET", singlePath(PLAIN, plainRow));
    const pausedSingle = await hit("GET", singlePath(PAUSED, pausedRow));
    expect({
      status: pausedSingle.status,
      body: redact(pausedSingle.body, PAUSED, [pausedRow]),
    }).toEqual({ status: plainSingle.status, body: redact(plainSingle.body, PLAIN, [plainRow]) });

    // **未認証がどこで止まるかも固定する**(認証の壁は判定より手前に立つ)。
    expect(plainList.status).toBe(401);
    expect(plainSingle.status).toBe(401);
  });

  test("(3) 運営ロール(`owner`)でも、7本の応答が一致する", async () => {
    const plain = await sevenSteps(PLAIN, ownerSession.cookie);
    const paused = await sevenSteps(PAUSED, ownerSession.cookie);
    for (let index = 0; index < plain.length; index += 1) {
      expect(
        { table: "<TABLE>", ...paused[index] },
        `${plain[index]?.label}: owner で応答が違う`,
      ).toEqual({ table: "<TABLE>", ...plain[index] });
    }
    expect(plain.map((step) => step.status)).toEqual([200, 201, 200, 200, 200, 204, 404]);
  });

  // **【`V8-M41` / 台帳 `F-G13`。2026-08-13。旧の名前と期待値を1バイトも消していない】**
  //
  // **旧のテストの名前**: 「**(4) `enabled: false` の表には取り残し一覧の口が無い(404)。
  // `enabled: true` の表では 200 になる**」。
  // **旧の期待値**: `expect(paused.status).toBe(404);`。
  //
  // **`D-13` を塞いだので、宣言していない表と `enabled: false` の表でもこの口は 200 を返す**
  // (**面の判定で「誰にも届かない行」を拾う**)。 **本ファイルの題材では `PLAIN` / `PAUSED` に
  // 既定3役割の規則が入っている**(`manifestWithRoles` が外しているのは `ARMED` だけ)——
  // **したがって並ぶ行は0件である。**
  //
  // **`Z-G20`(宣言していない表と `enabled: false` の表が同じであること)は1ミリも
  // 破れていない** —— **本文単位の一致を測る下の1行は、期待値も測り方も1バイトも
  // 変えていない**(404 どうしの一致から 200 どうしの一致になった)。
  test("(4) `enabled: false` の表の取り残し一覧は、宣言していない表と同じ 200 である。`enabled: true` の表でも 200", async () => {
    const paused = await hit("GET", doorPath(PAUSED), { cookie: ownerSession.cookie });
    const plainDoor = await hit("GET", doorPath(PLAIN), { cookie: ownerSession.cookie });
    expect(paused.status).toBe(200);
    // **宣言していない表とも本文単位で一致する。**
    expect(redact(paused.body, PAUSED, [])).toBe(redact(plainDoor.body, PLAIN, []));

    // **拒否側だけを測ると全部拒否しても緑になるので、開く側も同じテストの中で測る。**
    const armed = await hit("GET", doorPath(ARMED), { cookie: ownerSession.cookie });
    expect(armed.status).toBe(200);
    expect(JSON.parse(armed.body)).toMatchObject({ records: [], total: 0 });
  });

  test("(5) `enabled: false` の表では、付与表に行を作っても判定に1ミリも効かない", async () => {
    // **付与が「効いていたら」応答が変わるはずの形で仕込む** ——
    // **運営(`owner`)の相手行だけを作り、`editor` には1件も付与しない。**
    const member = await hit("POST", recordsPath("note_member"), {
      cookie: ownerSession.cookie,
      body: { account: ownerSession.userId },
    });
    expect(member.status).toBe(201);
    const memberId = (JSON.parse(member.body) as { record: { _id: string } }).record._id;

    const pausedRow = await seedRow(PAUSED, editorSession.cookie);
    const grant = await hit("POST", recordsPath("paused_grant"), {
      cookie: ownerSession.cookie,
      body: { note: pausedRow, member: memberId, permission: "reader" },
    });
    expect(grant.status).toBe(201);

    // **付与を作ったあとでも、宣言していない表と同じである**(相手・権限を1つも見ていない)。
    const plainRow = await seedRow(PLAIN, editorSession.cookie);
    for (const session of [editorSession, ownerSession]) {
      const plainList = await hit("GET", recordsPath(PLAIN), { cookie: session.cookie });
      const pausedList = await hit("GET", recordsPath(PAUSED), { cookie: session.cookie });
      expect({
        status: pausedList.status,
        body: redact(pausedList.body, PAUSED, [pausedRow]),
      }).toEqual({ status: plainList.status, body: redact(plainList.body, PLAIN, [plainRow]) });

      const plainSingle = await hit("GET", singlePath(PLAIN, plainRow), { cookie: session.cookie });
      const pausedSingle = await hit("GET", singlePath(PAUSED, pausedRow), {
        cookie: session.cookie,
      });
      expect({
        status: pausedSingle.status,
        body: redact(pausedSingle.body, PAUSED, [pausedRow]),
      }).toEqual({ status: plainSingle.status, body: redact(plainSingle.body, PLAIN, [plainRow]) });
      expect(pausedSingle.status).toBe(200);
    }
  });

  test("(6) `enabled: false` を `enabled: true` に変えると、同じ表のふるまいが変わる(`change_table` を HTTP から)", async () => {
    const pausedRow = await seedRow(PAUSED, editorSession.cookie);

    // **切り替える前**: 付与が1件も無いのに `editor` から見える(= 宣言していない表と同じ)。
    const before = await hit("GET", singlePath(PAUSED, pausedRow), {
      cookie: editorSession.cookie,
    });
    expect(before.status).toBe(200);
    const beforeList = await hit("GET", recordsPath(PAUSED), { cookie: editorSession.cookie });
    expect((JSON.parse(beforeList.body) as { total: number }).total).toBe(1);
    // **【`V8-M41` / 台帳 `F-G13`。2026-08-13。旧の1行を逐語で残す】**
    // **旧: `expect(beforeDoor.status).toBe(404);`**
    // **切り替える前でも、この口は 200 を返すようになった**(**面の判定で拾う。並ぶ行は
    // 0件である** —— **`PAUSED` には既定3役割の規則が入っているため**)。
    // **切り替えの前後で変わるものは消えていない** —— **下の `afterDoor` では、同じ口が
    // その行を1件並べる**(0件 → 1件)。
    const beforeDoor = await hit("GET", doorPath(PAUSED), { cookie: ownerSession.cookie });
    expect(beforeDoor.status).toBe(200);
    expect(JSON.parse(beforeDoor.body)).toMatchObject({ records: [], total: 0 });

    // **切り替え**: `change_table` の差分を **HTTP から** 投げる(`POST /diffs` は owner 必須)。
    const applied = await hit("POST", `/api/apps/${APP_ID}/diffs`, {
      cookie: ownerSession.cookie,
      body: {
        diff_id: "d-optin-on",
        intent: "止めてあったアクセス権管理を有効にする",
        operations: [
          {
            op: "change_table",
            table: PAUSED,
            changes: { access_control: pausedDeclaration(true) },
          },
        ],
      },
    });
    expect(applied.status, applied.body).toBe(201);

    // **切り替えた後**: 取り残しの口が開く。
    //
    // **【`V8-M26` / ユーザ決定 `D-V8-23`(面と点は `OR`)/ `D-V8-45` / `D-V8-56`。
    //   旧の2行を逐語で残す】**
    //
    // **旧: expect(after.status).toBe(404);**
    // **旧: expect((JSON.parse(afterList.body) as { total: number }).total).toBe(0);**
    // **旧の見出しは「切り替えた後: 同じ行が同じ相手から見えなくなり、取り残しの口が開く。」**
    //
    // **`enabled: true` にしても、この `editor` からは同じ行が今日も見える。**
    // **`V8-M26` が面の既定を閉じ、その埋め合わせとして表に既定3役割の規則が入るように
    // なった結果、面(`editor` は `paused_notes` を読める)と点(付与が1件も無いので
    // 読めない)が `OR` で重なり、面の側が通すからである**(`combineRoleAndGrantAccess`。
    // **`OR` は見える側に倒れる**)。
    //
    // **【この差は題材の都合ではない】** —— **`src/kernel/apply-diff.ts` の自動付与は
    // `access_control` の有無を1バイトも見ない。** **したがって実アプリでも、差分で作った
    // 表に `access_control` を後から有効にしただけでは、`owner` / `editor` / `viewer` から
    // 見えなくならない。** **見えなくするには `set_roles` でその表の規則を外す必要がある。**
    //
    // **変わるものが1つも無くなったわけではない** —— **下の「取り残し一覧」の口が
    // 404 から 200 に変わる。** **ここが (6) の主題として残った部分である。**
    //
    // =====================================================================================
    // **【2026-09-11 追記(`V18-M2-T04`。`PM-G8` / `ADR-0437` / ユーザ決定 `D-V18-18`)。
    // 直上の説明は今日から偽である。旧文を1バイトも消していない】**
    //
    // **打ち直した2つの期待値(旧 → 新。逐語)**:
    //
    //     旧: expect(after.status).toBe(200);
    //     新: expect(after.status).toBe(404);
    //     旧: expect((JSON.parse(afterList.body) as { total: number }).total).toBe(1);
    //     新: expect((JSON.parse(afterList.body) as { total: number }).total).toBe(0);
    //
    // **なぜ期待値の側が今日の正でなくなったか** —— **この2行が緑であること自体が、
    // 直上の説明が名指ししている穴(自動付与で入った**条件なしの読取**が、行ごとに配った
    // 設定を丸ごと無効にする)の実測だったからである。** **`V18-M2` はその穴を塞ぐ側の
    // 段であり、「見えたまま」を守ることが今日の正ではない。**
    // **この2行は `V8-M26` が 404 / 0 から書き換えたものであり、今日その2値へ戻った**
    // (直上の「旧: …404」「旧: …0」の逐語と同じ値である)。
    // **【1ビットも変えていない側】** **`editorSession` は運営者(`owner`)ではない** ——
    // **運営者は `D-V18-18` により今日どおり見える。** **【禁止】「塞いだ」と一般化しない。**
    const after = await hit("GET", singlePath(PAUSED, pausedRow), { cookie: editorSession.cookie });
    expect(after.status).toBe(404);
    const afterList = await hit("GET", recordsPath(PAUSED), { cookie: editorSession.cookie });
    expect((JSON.parse(afterList.body) as { total: number }).total).toBe(0);
    const afterDoor = await hit("GET", doorPath(PAUSED), { cookie: ownerSession.cookie });
    expect(afterDoor.status).toBe(200);
    expect((JSON.parse(afterDoor.body) as { records: { _id: string }[] }).records[0]?._id).toBe(
      pausedRow,
    );

    // **宣言していない表は、この差分で1ミリも動いていない。**
    const plainRow = await seedRow(PLAIN, editorSession.cookie);
    const plainAfter = await hit("GET", singlePath(PLAIN, plainRow), {
      cookie: editorSession.cookie,
    });
    expect(plainAfter.status).toBe(200);
  });

  test("(7) この検査が守っているものが、ファイル冒頭に逐語で書いてある", async () => {
    const source = await Bun.file(new URL(import.meta.url)).text();
    expect(source).toContain(
      "この検査が赤くなったら、アクセス権管理を使っていない既存アプリのふるまいが",
    );
    expect(source).toContain("変わったということである。");
    // **着手前 sha との比較を1件もしていないことを、ファイル自身が申告している。**
    expect(source).toContain("この検査は着手前 sha");
    expect(source).toContain("との比較を1件もしていない");
    // **実測が在る場所を名指ししている。**
    expect(source).toContain("V7-M1-T06");
    expect(source).toContain("V7-M5-T03");
  });

  test("(8) この突き合わせ自体が効いていること —— `enabled: true` の表を相手にすると、同じ7本が割れる", async () => {
    // **(1) と (3) は「一致すること」だけを測る** —— **判定が丸ごと無効になっても緑になる。**
    // **そこで、同じ突き合わせを `enabled: true` の表に対して打ち、割れることを固定する。**
    // **これが赤くなったら、突き合わせが何も見ていない**(または宣言した表の判定が消えた)。
    const plain = await sevenSteps(PLAIN, editorSession.cookie);
    const armed = await sevenSteps(ARMED, editorSession.cookie);
    const differing = plain.filter(
      (step, index) => step.status !== armed[index]?.status || step.body !== armed[index]?.body,
    );
    expect(differing.length).toBeGreaterThan(0);
    // **【`V14-M1-T01`(台帳 `RB-G1` / `RB-G2`)。2026-09-05。期待値を入れ替えた。
    //   旧の2行を逐語で残す】**
    // **旧**:
    //   `// **最初に割れるのは「作成」である**(実測。**メンバー表に登録されていない相手は作れない**)。`
    //   `expect(differing[0]?.label).toBe("2 POST作成");`
    // **宣言つきの表の一覧応答に `access`(行ごとの判定)が載るようになったので、
    // 割れるのは**1本目**(一覧 GET)からである。** **宣言していない表(`PLAIN`)の
    // 応答は着手前と1バイトも同じであり、だからこそここで割れる。**
    // **測っているもの(「作成でも割れること」)は1ミリも弱めていない** ——
    // **位置ではなく集合で見る1行を下に足した。**
    expect(differing[0]?.label).toBe("1 一覧GET(0件)");
    expect(differing.map((step) => step.label)).toContain("2 POST作成");
    expect(armed[1]?.status).toBe(400);
    // **【`V8-M41` / 台帳 `F-G12`。2026-08-13。期待値を入れ替えた。旧の1行を逐語で残す】**
    // **旧: `expect(armed[1]?.body).toContain("メンバー表に登録されていない");`**
    // **断りの文面が「次に何をすればよいか」を持つ形に差し替わった**(`v8-m35.md` §5-1 の
    // `F-G12` の限定)。**このテストが測っているのは「作成で割れること」であり、
    // 文面の綴りそのものではない** —— **差し替わった側の綴りで同じことを測る。**
    expect(armed[1]?.body).toContain("利用者の表に登録されている人だけです");
  });
});
