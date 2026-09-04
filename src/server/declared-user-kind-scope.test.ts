/**
 * **アプリが宣言した利用者の種類が、`customer` とまったく同じ扱いを受けることの実測**
 * (`V5-M17-T04` / `T05` / `T07`。`G-G5` / `G-G6` / `G-G7` / `G-G8`。
 * [`ADR-0158`](../../docs/adr/0158-declared-user-kinds.md) 限定2・限定9 /
 * [`ADR-0159`](../../docs/adr/0159-audience-declared-kinds.md) 限定2・限定3・限定4)。
 *
 * **本物の HTTP(`createServerApp`)と本物の SQLite で測る。**
 *
 * ## 測るもの
 *
 * 1. **セルフサインアップの経路に種類の名前が焼き込まれていない**(`G-G6`)——
 *    パスは `/auth/signup/...` で、種類は**本文**から受け取る。
 * 2. **受け取れるのは宣言された非運営の種類だけである**(`ADR-0158` 限定9)——
 *    運営ロールは 422、未宣言の種類名も 422、省略時は1本目。
 * 3. **宣言された種類の認可規則は `customer` と同一である**(限定2)——
 *    自分の `st_owner` 行と `st_public` の公開行だけ、運営テーブルは 403。
 * 4. **`audience` に宣言された種類を書ける**(`ADR-0159` 限定2)——
 *    未宣言の種類名は適用時に拒否、`anonymous` は今日どおり書ける(限定3)。
 *
 *    **【2026-08-09 の改訂(`V8-M20` / 台帳 `J-G27`〜`J-G29` / `ADR-0301`)。上の1項は
 *    今日は偽である。1バイトも消していない】** **`view.audience` / `field.audience` /
 *    `field.writable_by` / `view_action.audience` の4キーは廃止され、schema から綴りごと
 *    消えている。****値域を問う先は今日 `app.roles[].id` 1本であり、そこは
 *    `^[a-z0-9_]{1,32}$` のパターンしか持たない** —— **未宣言の種類名は今日は拒否されない。**
 *    **これは `V8-M16` が申告済みの穴であり、`V8-M20` は1バイトも塞いでいない。**
 * 5. **既存3ロールの規律が1ミリも変わらない**(`ADR-0158` 限定11)。
 *
 * ## 測らないもの(**誇張しない**)
 *
 * - **種類ごとに違う規則を書ける手段が無いこと**は、schema の側
 *   (`src/kernel/declared-user-kinds.test.ts` の T02-5)が測る。**ここでは測らない。**
 * - **passkey の経路は1度も踏んでいない**(パスワード経路だけを踏む)。
 *   **`options` と `verify` で違う種類を送れることの帰結**は
 *   `src/server/auth-routes.ts` の `resolveRequestedUserKind` の注が書いている。
 * - **ブラウザで画面を1枚も開いていない。**
 *
 * ---
 *
 * ## 【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11` / `T-G12`。判定値 = 廃止】
 *
 * **上のドキュメントは1バイトも消していない。** **`ADR-0158` / `ADR-0159` 制定時の事実で
 * あって、今日の正ではない。**
 *
 * ### このファイルが何を測っていたか(着手前)
 *
 * **`app.user_kinds` に宣言した種類が、本物の HTTP と本物の SQLite の上で `customer` と
 * まったく同じ扱いを受けること。** **20本すべてが、`app.user_kinds` を書いた
 * マニフェストを投入するところから始まっていた。**
 *
 * ### 今日は何を測るか
 *
 * **`app.user_kinds` の器が消えたので、`applyManifest` に渡す題材から `user_kinds` を
 * 落とした。** **20本は1本も消していないし、`skip` もしていない** ——
 * **「アプリが宣言した立場」の出所が `app.user_kinds` から `app.roles[].id` へ移った、
 * という1点だけを反映した。**
 *
 * **【正直に書く。ここが最大の変化である】** **(2-e) が反転した。**
 * **着手前は「宣言があるアプリでは `customer` も 422」だった** ——
 * **`user_kinds` を宣言したアプリでは、値域から `customer` が黙って外れていたからである。**
 * **今日は外れない**(`signupKindValues` が `customer` を常に末尾に残す)——
 * **`customer` で登録できる。** **担い手は無い**(`ADR-0301` 限定6 の ④)。
 *
 * ### 担い手が無いもの(**このファイルで今日1バイトも測れなくなったもの。名指しで書く**)
 *
 * - **「宣言があるアプリ」と「宣言が無いアプリ」の区別**……
 *   **`app.user_kinds` が無いので、この2つは今日まったく同じアプリである。**
 *   **(4-b) が2回に分けて測っていた区別は、今日1バイトも測れない。**
 * - **宣言したアプリで `customer` が値域から外れること**…… **上記のとおり反転した。**
 * - **`user_kinds` の値域(予約語・上限8種・識別子の形)**…… **`src/kernel/` 側の
 *   `declared-user-kinds.test.ts` が名指しで記録している。ここでは元々測っていない。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyManifest, createApp, KernelMetaStore, type Manifest } from "../kernel/index.ts";
import { validateManifestFull } from "../kernel/validate.ts";
import { createServerApp } from "./app.ts";
import { OWNER_FIELD, PUBLIC_FIELD } from "./owner-scope.ts";
import { TEST_ORIGIN, withDefaultRoleRules } from "./test-helpers.ts";

const APP_ID = "clinic";

/**
 * **利用者の種類を2つ宣言した**マニフェスト(EC の語を1つも使わない)。
 *
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】引数を落とした。**
 * **旧(逐語)**:
 * ```
 * function manifest(userKinds?: unknown): Manifest {
 *   const app: Record<string, unknown> = { … };
 *   if (userKinds !== undefined) {
 *     app.user_kinds = userKinds;
 *   }
 *   return { app } as unknown as Manifest;
 * }
 * ```
 * **`app.user_kinds` を書いたマニフェストは今日 `/app` で拒否されるので、この引数が
 * 効く経路は1つも残っていない。****表・画面の中身は1バイトも変えていない。**
 */
function manifest(): Manifest {
  const app: Record<string, unknown> = {
    id: APP_ID,
    name: "診療所",
    tables: [
      {
        id: "visits", // 個人スコープ(st_owner text 非required)
        name: "受診記録",
        fields: [
          { id: "memo", name: "メモ", type: "text", required: true },
          { id: OWNER_FIELD, name: "所有者", type: "text" },
        ],
      },
      {
        id: "notices", // 公開(st_public boolean 非required)
        name: "お知らせ",
        fields: [
          { id: "title", name: "題", type: "text", required: true },
          { id: PUBLIC_FIELD, name: "公開", type: "boolean" },
        ],
      },
      {
        id: "staff_notes", // 運営テーブル
        name: "職員メモ",
        fields: [{ id: "memo", name: "メモ", type: "text", required: true }],
      },
    ],
    views: [{ id: "visit-list", type: "list_view", table: "visits", columns: ["memo"] }],
  };
  return { app } as unknown as Manifest;
}

/**
 * **【`V8-M29` 第2波】この2つは今日「宣言された利用者の種類」ではなく
 * 「アプリが宣言した役割」である**(出所が `app.user_kinds` から `app.roles[].id` へ移った)。
 * **綴りも並びも1バイトも変えていない** —— **`patient` が今日も1本目である。**
 */
const KINDS = [
  { id: "patient", name: "受診者" },
  { id: "supplier", name: "取引先" },
];

/**
 * **【`V8-M26`】`beforeEach` が `applyManifest` に渡す題材。**
 *
 * **既定が閉じた**(`V8-M26` / ユーザ決定 `D-V8-45` / `D-V8-65`)—— **規則を1本も
 * 名指ししていない表・画面・ボタンは拒否される。****本ファイルの (3) の主題は「宣言された
 * 種類の認可規則が `customer` と同一であること」であり、その種類が自分の行を作れなければ
 * 1件も測れない。**
 *
 * **【`manifest()` そのものは1バイトも変えていない】** —— **(4-g) が
 * `manifest(KINDS).app.roles` が `undefined` であることを検査しているためである。**
 * **役割を足すのは、HTTP 経路が使うこの題材だけである。**
 *
 * **【2026-08-11。`V8-M29` 第2波。上の1文は今日は偽である。1バイトも消していない】**
 * **`manifest()` からは引数 `userKinds` を落とした**(`app.user_kinds` が器ごと消えたため)。
 * **表・画面・フィールドの中身は1バイトも変えていない。**
 * **(4-g) が `app.roles` の `undefined` を検査していることは今日も変わらない。**
 *
 * - **`patient` / `supplier`** … `visits` の読取・書込・削除と、`notices` の読取。
 *   **`visits` の規則には条件(`when`)を付けている** —— **`D-V8-35` により、面が表の
 *   **読取**を許すとその役割は `st_owner`(個人スコープ)を読取について越えるので、
 *   素で書くと (3-c) / (3-d) が測っている「互いの行が見えない」が消える。**
 * - **運営テーブル(`staff_notes`)には1本も足していない** —— **(3-a) の 403 を
 *   出しているのは今日も予約規約の層である。**
 * - **`anonymous` には1本も足していない**(`D-V8-45` / 台帳 `T-G26a`)。
 */
function seededManifest(): Manifest {
  // **【`V8-M29` 第2波】旧(逐語)**: `const m = manifest(KINDS) as unknown as { … };`
  // **`app.user_kinds` を書く引数が消えたので、素の題材を取る。**
  // **`app.roles` を足す下の行は1バイトも変えていない** —— **今日はこれが唯一の出所である。**
  const m = manifest() as unknown as { app: Record<string, unknown> };
  m.app.roles = KINDS.map((kind) => ({
    id: kind.id,
    name: kind.name,
    rules: [
      {
        target: "table",
        table: "visits",
        can: ["read", "write", "delete"],
        when: { field: OWNER_FIELD, equals_current_user: true },
      },
      { target: "table", table: "notices", can: ["read"] },
    ],
  }));
  return withDefaultRoleRules(m) as unknown as Manifest;
}

let dataRoot: string;
let app: ReturnType<typeof createServerApp>;

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-kinds-"));
  const store = KernelMetaStore.open(dataRoot);
  try {
    createApp(store, "診療所", { app_id: APP_ID });
  } finally {
    store.close();
  }
  expect(applyManifest(dataRoot, APP_ID, seededManifest()).valid).toBe(true);
  app = createServerApp({ dataRoot });
  // **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。題材だけを直した】**
  // **旧(逐語)**: この行は無く、各検査のセルフサインアップがそのアプリの**最初の1人**だった。
  // **`D-V8-82` により、自己登録でも最初の1人は持ち主になる** —— **したがって
  // 「名乗った種類がそのまま列に入る」を測るには、先に誰か1人が居る必要がある。**
  // **測っている中身(宣言された種類の値域と認可規則)は1ミリも変えていない。**
  // **最初の1人が持ち主になること自体は `src/server/first-user-owner.test.ts` が測る。**
  expect(
    (
      await post(`/api/apps/${APP_ID}/auth/password/register`, {
        username: "seed-owner",
        password: "pw-123456",
      })
    ).status,
  ).toBe(200);
});

afterEach(async () => {
  await rm(dataRoot, { recursive: true, force: true });
});

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {
    origin: TEST_ORIGIN,
    "content-type": "application/json",
  };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(
    app.request(
      new Request(`http://localhost${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
    ),
  );
}

function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { origin: TEST_ORIGIN };
  if (cookie !== undefined) {
    headers.cookie = cookie;
  }
  return Promise.resolve(app.request(new Request(`http://localhost${path}`, { headers })));
}

const SIGNUP = `/api/apps/${APP_ID}/auth/signup/password/register`;
const R = (table: string) => `/api/apps/${APP_ID}/tables/${table}/records`;

/** セルフサインアップして cookie とロールを返す。 */
async function signup(
  username: string,
  userKind?: string,
): Promise<{ status: number; cookie: string; role?: string }> {
  const body: Record<string, unknown> = { username, password: "pw-123456" };
  if (userKind !== undefined) {
    body.user_kind = userKind;
  }
  const res = await post(SIGNUP, body);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  if (res.status !== 200) {
    return { status: res.status, cookie: "" };
  }
  const parsed = (await res.json()) as { user: { role: string } };
  return { status: res.status, cookie, role: parsed.user.role };
}

// --- (1) 経路に種類の名前が焼き込まれていない(`G-G6`)-------------------------------

test("(1) セルフサインアップのパスに `customer` が1文字も入っていない", async () => {
  const res = await post(SIGNUP, { username: "a-patient", password: "pw-123456" });
  expect(res.status).toBe(200);
  // **着手前のパスは今日は存在しない。**
  const old = await post(`/api/apps/${APP_ID}/auth/customer/password/register`, {
    username: "b",
    password: "pw-123456",
  });
  expect(old.status).toBe(404);
});

// --- (2) 本文から受け取れるのは宣言された非運営の種類だけ(`ADR-0158` 限定9)-----------

test("(2-a) 宣言した種類を本文に書くと、その種類で登録される", async () => {
  expect((await signup("p1", "patient")).role).toBe("patient");
  expect((await signup("s1", "supplier")).role).toBe("supplier");
});

test("(2-b) 種類を書かなければ、宣言の1本目になる", async () => {
  expect((await signup("p2")).role).toBe("patient");
});

test("(2-c) 運営ロールを本文に書いたら 422(昇格しない)", async () => {
  for (const role of ["owner", "editor", "viewer"]) {
    const res = await post(SIGNUP, {
      username: `x-${role}`,
      password: "pw-123456",
      user_kind: role,
    });
    expect(res.status, role).toBe(422);
  }
});

test("(2-d) 宣言していない種類名は 422", async () => {
  const res = await post(SIGNUP, {
    username: "ghost",
    password: "pw-123456",
    user_kind: "shopkeeper",
  });
  expect(res.status).toBe(422);
});

// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G12`。判定値 = 廃止。ここが本波の唯一の
// 値域の変化であり、このファイルで唯一反転した検査である】**
// **旧テスト名の逐語**: 「(2-e) 宣言があるアプリでは `customer` も 422(宣言に無いため)」。
// **旧の期待値の逐語**: `expect(res.status).toBe(422);`
// **旧の理由**: **`user_kinds` を宣言したアプリでは、登録で名乗れる値が宣言した種類だけに
// なり、既定の `customer` が値域から**黙って外れて**いた**(`effectiveUserKindIds`)。
// **今日**: **`signupKindValues` は `customer` を常に末尾に残す** —— **`customer` は
// どのアプリでも名乗れる。**
// **【担い手が無いもの】** **「宣言したら `customer` が外れる」を再現する手段は今日1つも無い**
// (`ADR-0301` 限定6 の ④)。**役割の宣言から `customer` を外しても、値域からは外れない。**
test("(2-e) `customer` は今日 200 で登録できる(旧: 422。値域から外れなくなった)", async () => {
  const res = await post(SIGNUP, {
    username: "legacy",
    password: "pw-123456",
    user_kind: "customer",
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user: { role: string } }).user.role).toBe("customer");
});

// **【`V8-M30` 第2波(2026-08-11)。ユーザ決定 `D-V8-82`。期待値を反転させた。**
//   **旧のテスト名と旧の期待値を逐語で残す】**
// **旧のテスト名**: `(2-f) 初回ユーザでも owner にならない(\`ADR-0033\` 限定2 のこの点は生きている)`
// **旧の本文(逐語)**:
//     // **このアプリにはまだ誰も居ない。**
//     const first = await signup("first-ever");
//     expect(first.role).toBe("patient");
// **根拠**: **ユーザ決定 `D-V8-82`(2026-08-11)。選ばれた見出し「最初の1人は必ず持ち主」。**
// **説明文の逐語**: 「自分で登録した場合でも、そのアプリの最初の1人は持ち主になります。
//   名乗った役割はそれに足されます。**公開の購入サイトでは、最初に買った客が運営者に
//   なってしまいます。**」
// **`ADR-0033` 限定2 のこの点(初回でも owner にしない)は、今日**成り立たない**。**
// **【禁止】これを「安全になった」と書かない** —— **塞いだのは「持ち主0人」であって、
//   「持ち主でない人が持ち主になる」ことではない。**
test("(2-f の反転) 誰も居ないアプリの自己登録は持ち主になる(`D-V8-82`)。2人目以降は今日どおり", async () => {
  // **上の `beforeEach` が `seed-owner` を1人置いているので、ここは初回ではない。**
  const notFirst = await signup("second-ever");
  expect(notFirst.role).toBe("patient");

  // **誰も居ないアプリを別に1本立てて、初回の挙動そのものを測る。**
  const fresh = "clinic-empty";
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "診療所2", { app_id: fresh });
  } finally {
    meta.close();
  }
  expect(
    applyManifest(dataRoot, fresh, {
      ...seededManifest(),
      app: { ...seededManifest().app, id: fresh },
    } as never).valid,
  ).toBe(true);
  const res = await post(`/api/apps/${fresh}/auth/signup/password/register`, {
    username: "first-ever",
    password: "pw-123456",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { role: string; roles: string[] } };
  expect(body.user.role).toBe("owner");
  // **名乗った(既定に落ちた)種類は消えていない。**
  expect([...body.user.roles].sort()).toEqual(["owner", "patient"]);
});

// --- (3) 宣言された種類の認可規則は `customer` と同一(`ADR-0158` 限定2)---------------

// **【`V8-M27-T04` / `T-G5`。期待値を反転させた。旧のテスト名と旧の期待値を逐語で残す】**
// **旧: `test("(3-a) 宣言された種類は運営テーブルを GET できない(403)")` /
//       `expect(res.status).toBe(403);`**
// **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
// **読取は今日 403 で断らない**(`ADR-0305` 限定11)—— **一覧は 200 で、応答から落ちる。**
// **この (3) 群の主題(「宣言された種類の認可規則は `customer` と同一」)は
// 1ミリも変わっていない** —— **同じ扱いを受けることを測り続ける。**
test("(3-a の反転) 宣言された種類が規則を持たない表は 200 + 0件(旧: 403)", async () => {
  const patient = await signup("p3", "patient");
  const res = await get(R("staff_notes"), patient.cookie);
  expect(res.status).toBe(200);
  expect(((await res.json()) as { records: unknown[] }).records).toEqual([]);
});

test("(3-b) 宣言された種類は公開テーブルを GET できるが書込は 403", async () => {
  const supplier = await signup("s3", "supplier");
  expect((await get(R("notices"), supplier.cookie)).status).toBe(200);
  expect((await post(R("notices"), { title: "x" }, supplier.cookie)).status).toBe(403);
});

test("(3-c) 宣言された2種類は、自分の行だけが見える(互いの行が見えない)", async () => {
  const patient = await signup("p4", "patient");
  const supplier = await signup("s4", "supplier");
  expect((await post(R("visits"), { memo: "受診者の行" }, patient.cookie)).status).toBe(201);
  expect((await post(R("visits"), { memo: "取引先の行" }, supplier.cookie)).status).toBe(201);

  const readMemos = async (cookie: string): Promise<string[]> => {
    const res = await get(R("visits"), cookie);
    const body = (await res.json()) as { records: { memo: string }[] };
    return body.records.map((r) => r.memo);
  };
  expect(await readMemos(patient.cookie)).toEqual(["受診者の行"]);
  expect(await readMemos(supplier.cookie)).toEqual(["取引先の行"]);
});

test("(3-d) 【隠さない】種類が違っても規則は同じである —— 分離しているのは種類ではなく行の持ち主である", async () => {
  // **同じ種類の2人も、互いの行が見えない。** **`st_owner` は「誰の行か」であって
  // 「どの種類か」ではない。****宣言された種類はスコープを1ミリも分けない。**
  const a = await signup("p5", "patient");
  const b = await signup("p6", "patient");
  expect((await post(R("visits"), { memo: "Aの行" }, a.cookie)).status).toBe(201);
  const res = await get(R("visits"), b.cookie);
  const body = (await res.json()) as { records: unknown[] };
  expect(body.records).toHaveLength(0);
});

// --- (4) **役割の識別子(`app.roles[].id`)の値域**(`ADR-0159` → `V8-M20` / `ADR-0301`)---
//
// **【`V8-M20` / 台帳 `J-G27` / `J-G28` / `J-G29` / `ADR-0301`】置き直した節。**
// **旧の見出しは「(4) `audience` の値域(`ADR-0159`)」だった。**
// **画面の「見せる相手」(`view.audience`)・項目の「見せる相手」(`field.audience`)・
// 項目の「書ける相手」(`field.writable_by`)・ボタンの「見せる相手」
// (`view_action.audience`)の4つは廃止され、`schemas/manifest.schema.json` から綴りごと
// 消えている。** **`ADR-0159` が広げたのはその4キーの値域だったので、「値域」を問う先は
// 今日は `app.roles[].id` 1本である。**
//
// **【正直に書く。ここが最大の変化である】** **旧 `audience` の値域は
// 「予約4語 ∪ `user_kinds[].id`」に閉じており、宣言していない名前は適用時に拒否されていた。**
// **`roles[].id` は `^[a-z0-9_]{1,32}$` のパターン1本しか持たない** ——
// **`V8-M16` が schema で閉じておらず、その記録が「今日は通る」と申告済みの穴である。**
// **`V8-M20` はその穴を1バイトも塞いでいないし、広げてもいない。**
// **下の (4-a) / (4-b) / (4-e) は、その穴を実測して固定する形に反転してある。**

/** 既定3ロール。**`app.roles` を書くときは必ず含める**(欠けると `applyManifest` が invalid)。 */
const DEFAULT_ROLES = [
  {
    id: "owner",
    name: "持ち主",
    rules: [
      // **【`V8-M28` / `T-G16a`】持ち主にはこの2行が必ず要る**(適用時検査 = 類型17 の拡張)。
      { target: "app", can: ["write"] },
      { target: "role", can: ["write"] },
    ],
  },
  { id: "editor", name: "編集者" },
  { id: "viewer", name: "閲覧者" },
];

/**
 * `user_kinds` を宣言したマニフェストに、役割の宣言を載せて返す。
 *
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】第2引数を落とした。**
 * **旧(逐語)**:
 * ```
 * function withRoles(roles: unknown[], userKinds: unknown = KINDS): unknown {
 *   const m = manifest(userKinds) as unknown as { app: Record<string, unknown> };
 *   m.app.roles = roles;
 *   return m;
 * }
 * ```
 * **【担い手が無いもの】** **第2引数は「宣言があるアプリ / 無いアプリ」を作り分けるために
 * 在った。****`app.user_kinds` が消えた今日、その2つはまったく同じアプリである** ——
 * **作り分ける手段が1つも無い。**
 */
function withRoles(roles: unknown[]): unknown {
  const m = manifest() as unknown as { app: Record<string, unknown> };
  m.app.roles = roles;
  return m;
}

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(4-a) 宣言した種類を `view.audience` に書けるが、宣言していない名前は
// 拒否される`。**旧の本体(逐語)**:
//   `withDeclared.app.views[0].audience = ["patient", "owner"];`
//   `expect(validateManifestFull(withDeclared).valid).toBe(true);`
//   `withUndeclared.app.views[0].audience = ["shopkeeper"];`
//   `expect(result.valid).toBe(false);`
//   `expect(result.valid === false && result.errors[0]?.path).toBe("/app/views/0/audience/0");`
// **旧値 → 新値**: **未宣言の名前は `false`(`/app/views/0/audience/0` で拒否)だったが、
// 今日は `true`(1件も拒否されない)。**
test("(4-a) 宣言した種類を `roles[].id` に書ける ——【隠さない】宣言していない名前も今日は通る", () => {
  const viewRule = { target: "view", view: "visit-list", can: ["read"] };
  expect(
    validateManifestFull(
      withRoles([...DEFAULT_ROLES, { id: "patient", name: "受診者", rules: [viewRule] }]) as never,
    ).valid,
  ).toBe(true);

  // **【穴。`V8-M16` が申告済み。`V8-M20` は1バイトも塞いでいない】**
  // **旧 `audience` なら `/app/views/0/audience/0` で拒否されていた名前が、今日は通る。**
  expect(
    validateManifestFull(
      withRoles([...DEFAULT_ROLES, { id: "shopkeeper", rules: [viewRule] }]) as never,
    ).valid,
  ).toBe(true);
});

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(4-b) 宣言が無いアプリでは `customer` が書け、宣言があるアプリでは書けない`。
// **旧値 → 新値**: **宣言があるアプリでの `customer` は `false` だったが、今日は `true`。**
//
// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`。判定値 = 廃止】2回の呼び分けを1回にした。**
// **旧テスト名の逐語**: 「(4-b) `customer` は、宣言があるアプリでも `roles[].id` に書ける(同じ穴)」。
// **旧の本体の逐語**(2回に分けて呼んでいた):
//   `withRoles([...DEFAULT_ROLES, { id: "customer", rules: [viewRule] }], undefined)` … 宣言が無いアプリ
//   `withRoles([...DEFAULT_ROLES, { id: "customer", rules: [viewRule] }])` … 宣言があるアプリ
// **【担い手が無いもの。名指しで書く】** **「宣言があるアプリ」と「宣言が無いアプリ」を
// 作り分ける手段が今日1つも無い** —— **`app.user_kinds` が器ごと消えたためである。**
// **同じ引数で2度呼ぶだけになるので、呼び出しを1回に畳んだ。****測っている穴
// (`roles[].id` の値域が1つも検査されていない)は1ミリも変わっていない。**
test("(4-b) `customer` は `roles[].id` に書ける ——【隠さない】宣言の有無という区別は今日1つも無い", () => {
  const viewRule = { target: "view", view: "visit-list", can: ["read"] };
  expect(
    validateManifestFull(
      withRoles([...DEFAULT_ROLES, { id: "customer", rules: [viewRule] }]) as never,
    ).valid,
  ).toBe(true);
});

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(4-c) `anonymous` は今日どおり画面単位に書ける(`ADR-0159` 限定3 /
// メインの裁定3)`。**趣旨(未ログインは画面単位でだけ名指しできる)は今日も生きている。**
test("(4-c) `anonymous` は今日どおり画面単位に書ける(`ADR-0159` 限定3 / `J-G11`)", () => {
  expect(
    validateManifestFull(
      withRoles([
        ...DEFAULT_ROLES,
        {
          id: "anonymous",
          name: "未ログイン",
          rules: [{ target: "view", view: "visit-list", can: ["read"] }],
        },
        {
          id: "patient",
          name: "受診者",
          rules: [{ target: "view", view: "visit-list", can: ["read"] }],
        },
      ]) as never,
    ).valid,
  ).toBe(true);
});

// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(4-d) `anonymous` は今日も項目単位には書けない(`ADR-0074` §3a-4 を
// 1ミリも動かしていない)`。**旧の本体**: `m.app.tables[0].fields[0].audience = ["anonymous"];`
// **非対称は今日も schema に在る** —— **`J-G11` の分岐が `anonymous` の規則から
// `target: "field"` を除いている**(`schemas/manifest.schema.json` の
// `$defs/app/properties/roles/items/allOf`)。
test("(4-d) `anonymous` は今日も項目単位には書けない(`ADR-0074` §3a-4 / `J-G11` の非対称)", () => {
  const result = validateManifestFull(
    withRoles([
      ...DEFAULT_ROLES,
      {
        id: "anonymous",
        rules: [{ target: "field", table: "visits", field: "memo", can: ["read"] }],
      },
    ]) as never,
  );
  expect(result.valid).toBe(false);
  // **拒否は「対象の値域」で出る**(2026-08-09 に実測した逐語)——
  //   `target の値 "field" は語彙にありません。`
  expect(result.valid === false && result.errors[0]?.path).toBe("/app/roles/3/rules/0/target");
});

// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(4-e) 項目単位にも宣言した種類を書ける / 未宣言は拒否される`。
// **旧値 → 新値**: **未宣言(`shopkeeper`)は `false` だったが、今日は `true`。**
test("(4-e) 項目の規則にも宣言した種類を書ける ——【隠さない】未宣言も今日は通る", () => {
  const fieldRule = { target: "field", table: "visits", field: "memo", can: ["read"] };
  expect(
    validateManifestFull(
      withRoles([...DEFAULT_ROLES, { id: "patient", name: "受診者", rules: [fieldRule] }]) as never,
    ).valid,
  ).toBe(true);
  expect(
    validateManifestFull(
      withRoles([...DEFAULT_ROLES, { id: "shopkeeper", rules: [fieldRule] }]) as never,
    ).valid,
  ).toBe(true);
});

// **【`V8-M20` / `J-G28` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(4-f) 【限定を超えた点。隠さない】`field.writable_by` の値域も一緒に
// 広がっている`。**旧の本体は `field.writable_by = ["patient"]` / `["shopkeeper"]` を
// 書いて `true` / `false` を見ていた。**
// **`field.writable_by` と `view_action.audience` は `V8-M20` がキーごと廃止したので、
// 「4キーが1つの `$ref` を共有していた」という `ADR-0159` 限定1 超過の点は今日は消えている**
// (**それを「直した」とは書かない** —— **キーが無くなった結果であって、値域を閉じ直した
// わけではない**)。
// **項目の書込は今日 `{ target: "field", …, can: ["write"] }` で表す。**
test('(4-f) 項目の書込は面の `can: ["write"]` で表す —— `anonymous` には今日も書けない', () => {
  // **宣言した種類には書ける**(旧 `writable_by: ["patient"]` に当たる)。
  expect(
    validateManifestFull(
      withRoles([
        ...DEFAULT_ROLES,
        {
          id: "patient",
          name: "受診者",
          rules: [{ target: "field", table: "visits", field: "memo", can: ["write"] }],
        },
      ]) as never,
    ).valid,
  ).toBe(true);
  // **未ログインには書けない**(`J-G11`。**動詞が `read` に絞られている**)。
  expect(
    validateManifestFull(
      withRoles([
        ...DEFAULT_ROLES,
        { id: "anonymous", rules: [{ target: "table", table: "visits", can: ["write"] }] },
      ]) as never,
    ).valid,
  ).toBe(false);
});

// **【`V8-M20` / `J-G27` / `ADR-0301`】置き直した検査。**
// **旧テスト名**: `(4-g) `audience` を書かない画面は今日どおり全員に出る(`ADR-0159` 限定4)`。
// **旧の本体**: `expect(view.audience).toBeUndefined();`
test("(4-g) 規則を1本も書かない画面は今日どおり全員に出る(管轄外。`ADR-0159` 限定4)", () => {
  // **【`V8-M29` 第2波】旧(逐語)**: `validateManifestFull(manifest(KINDS))` /
  // `(manifest(KINDS) as unknown as { app: { roles?: unknown } }).app.roles`
  // **引数が消えただけで、測っている中身は1ミリも変えていない。**
  expect(validateManifestFull(manifest()).valid).toBe(true);
  // **役割を1つも宣言していない**(`app.roles` が無い)—— **面は何も絞らない。**
  expect((manifest() as unknown as { app: { roles?: unknown } }).app.roles).toBeUndefined();
  // **役割を宣言しても、その画面を名指しした規則が1本も無ければ管轄外のままである。**
  const withUnrelatedRule = withRoles([
    ...DEFAULT_ROLES,
    {
      id: "patient",
      name: "受診者",
      rules: [{ target: "field", table: "visits", field: "memo", can: ["read"] }],
    },
  ]) as { app: { roles: { rules?: { view?: string }[] }[] } };
  expect(validateManifestFull(withUnrelatedRule as never).valid).toBe(true);
  expect(
    withUnrelatedRule.app.roles
      .flatMap((role) => role.rules ?? [])
      .some((rule) => rule.view !== undefined),
  ).toBe(false);
});

// --- (5) 既存3ロールの規律(`ADR-0158` 限定11)----------------------------------------

test("(5) 宣言があっても、運営ロールは管理経路でしか出ない(顧客経路は1度も発行しない)", async () => {
  // **【`V8-M30` 第2波(2026-08-11)。`D-V8-82`。題材だけを直した。旧の本文を逐語で残す】**
  // **旧(逐語)**:
  //     // **管理経路の初回ユーザは今日どおり owner。**
  //     const res = await post(`/api/apps/${APP_ID}/auth/password/register`, {
  //       username: "admin",
  //       password: "pw-123456",
  //     });
  //     expect(res.status).toBe(200);
  //     expect(((await res.json()) as { user: { role: string } }).user.role).toBe("owner");
  // **`beforeEach` が `seed-owner` を管理経路で1人置くようになったので、ここで登録する
  // `admin` は初回ではない**(今日どおり `viewer` になる)。**測っている中身
  // (「顧客経路は運営ロールを1度も発行しない」)は1ミリも変えていない。**
  // **管理経路の初回ユーザが今日も `owner` であることは、`beforeEach` の 200 と
  // `src/server/first-user-owner.test.ts` の (4) が押さえている。**
  const res = await post(`/api/apps/${APP_ID}/auth/password/register`, {
    username: "admin",
    password: "pw-123456",
  });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { user: { role: string } }).user.role).toBe("viewer");
  // **セルフサインアップ経路は、この後も運営ロールを1度も発行しない。**
  expect((await signup("p9")).role).toBe("patient");
});

// --- (6) 等値比較が実装に1件も残っていない(`ADR-0158` 限定2 の構造での担保)-----------

test('(6) 実装(非テスト)に `role === "customer"` の等値比較が1件も無い', async () => {
  // **`ADR-0158` §1 (d) の逐語**: 「**認可判定の入口が1段増える。** … **1箇所でも書き漏らすと
  // 運営データが非運営に開く。**」 **本タスクはその6箇所を `isReservedRole` の否定に
  // 置き換えた。****置き換え漏れを機械で見張る。**
  //
  // **【この検査の限界。隠さない】** **走査するのは名指しした6ファイルだけである** ——
  // **別のファイルに同じ等値比較が書かれても、本検査は緑のままである**
  // (`scripts/audience-role-sync.test.ts` §限界 と同型の弱さ)。
  // **`!==` の形も同時に見る**(`role !== "customer"` は同じ書き漏らしを作る)。
  const { readFile } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  const repo = joinPath(import.meta.dir, "..", "..");
  const targets = [
    "src/server/app.ts",
    "src/server/owner-scope.ts",
    "src/server/auth-routes.ts",
    "web/src/AppWorkspace.tsx",
    "web/src/auth/authz.tsx",
    "web/src/views/ListViewRenderer.tsx",
  ];
  for (const target of targets) {
    const source = await readFile(joinPath(repo, target), "utf-8");
    // **コメントの中の引用は許す**(旧文を1バイトも消さない作法と両立させるため)——
    // 判定は「行が `//` や `*` で始まらないこと」で行う。**雑な判定であることを認める。**
    const offenders = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"))
      .filter((line) => /(?:role|kind)\s*[!=]==\s*"customer"/.test(line));
    expect(offenders, `${target} に customer の等値比較が残っている`).toEqual([]);
  }
});
