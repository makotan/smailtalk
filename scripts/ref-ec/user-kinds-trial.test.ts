/**
 * **`user_kinds`(利用者の種類の宣言)を、参照 EC に実際に当ててみる**(`V5-M26-T09`)。
 *
 * ## なぜこのファイルが在るのか
 *
 * **`v5-m18.md` §5-1 は「`user_kinds` を使えなかった」と3つの理由を書いた。**
 * **そのうち2つは 2026-08-05 の今日、既に成り立たない**:
 *
 *   1. 「**この宣言を書き込む差分操作が1つも存在しない**」…… **`V5-M17b` / `ADR-0248` が
 *      `set_user_kinds` を足した**(`DIFF_OPS` は 16 → **17**)。
 *   2. 「**`App` 型に `user_kinds` が無い**」…… **`src/kernel/types.ts` の `App` に
 *      `user_kinds?: UserKindDeclaration[]` が生えている**(同じ `ADR-0248`)。
 *
 * **残る3つ目だけが、当たるか外れるか分からない予測である。逐語**:
 *
 * > **宣言すると `customer` が黙って消える。** 宣言のあるアプリでは、書ける `audience` は
 * > 宣言した種類だけになる(`src/kernel/referential-integrity.ts` の `allowedAudience`)。
 * > **参照 EC は今回 `audience: ["customer"]` を3本書いたので、`user_kinds` を宣言した
 * > 瞬間にそれが 422 になる。**
 *
 * **本ファイルはこの予測を実測する。** **予測を確かめるだけであり、参照 EC の宣言を
 * 1バイトも変えていない**(`scripts/ref-ec/manifest.ts` に差分は出していない)。
 *
 * ## 測っていないこと(誇張しない)
 *
 * - **ブラウザを1度も開いていない。** 宣言した種類が画面でどう効くかを1件も見ていない。
 * - **MCP の口(`apply_diff`)を1度も叩いていない。** 呼んでいるのは `applyDiff` である。
 * - **`applyDiff` は 422 という数を1つも返さない。** 返すのは `{ valid: false, errors }` で
 *   あり、**422 に変えるのは HTTP 層(`POST /diffs`)である。** **本ファイルは HTTP 層を
 *   通していない** —— **したがって「422 になる」の「422」だけは実測していない**
 *   (拒否されること自体は実測した)。
 *
 * ---
 *
 * ## 【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G11` / `T-G12`。判定値 = 廃止】
 *
 * **上のドキュメントは1バイトも消していない。** **2026-08-05 時点の事実であって、
 * 今日の正ではない** —— **上の 1. と 2. は今日どちらも成り立たない。**
 * **`set_user_kinds` は `DIFF_OPS` から消え(18 → 17)、`App` 型からも `user_kinds` が
 * 消えた。**
 *
 * ### このファイルが何を測っていたか(着手前)
 *
 * **参照 EC(`scripts/ref-ec/manifest.ts`)という実物のアプリに `set_user_kinds` を
 * 実際に当てて、宣言が入ること・入れた宣言が役割の宣言と噛み合うことを実測していた。**
 * **5本のうち4本が `set_user_kinds` を含む差分を投げていた。**
 *
 * ### 今日は何を測るか
 *
 * **同じ5本を、参照 EC という実物の上で「廃止されたこと」と「代わりが立っていること」を
 * 固定する形に入れ替えた。** **1本も消していないし、`skip` もしていない。**
 *
 * 1. **`set_user_kinds` は `DIFF_OPS` に無い**(17。末尾は `set_roles`)。
 * 2. **参照 EC に `set_user_kinds` を当てると `/operations/0/op` で拒否され、
 *    ディスク上のマニフェストが1バイトも変わらない。**
 * 3. **宣言の中身(`customer` を含む / 含まない)で結果が1文字も変わらない。**
 * 4. **代わりに立つ `set_roles` は、参照 EC の上で今日も通る**(`ADR-0301` 限定2)。
 * 5. **「そのアプリで受理するロールの一覧」を組むのは、今日 `app.roles[].id` である。**
 *
 * ### 担い手が無いもの(**このファイルで今日1バイトも測れなくなったもの。名指しで書く**)
 *
 * - **`roleValuesForKinds(kinds)` そのもの** …… **関数ごと消え、引数を落とした
 *   `baseRoleValues()` に改名された。** **「宣言した種類を渡すと値域が変わる」という
 *   性質は今日1バイトも測れない。担い手は無い。**
 * - **宣言した種類が値域に入ると `customer` が外れること**(旧 (U-5) の3本目)……
 *   **今日は外れない。** **`customer` は常に入る。担い手は無い。**
 * - **参照 EC に立場の一覧を宣言してみること**(このファイルの元の目的そのもの)……
 *   **器が消えたので、実物に当てる対象が1つも無い。担い手は無い。**
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESERVED_ROLES } from "../../src/auth/types.ts";
import { applyDiff } from "../../src/kernel/apply-diff.ts";
import { applyManifest } from "../../src/kernel/apply-manifest.ts";
import { createApp } from "../../src/kernel/create-app.ts";
import { KernelMetaStore } from "../../src/kernel/meta-store.ts";
import { DIFF_OPS } from "../../src/kernel/types.ts";
// **【`V8-M29` 第2波】旧(逐語)**: `import { roleValuesForKinds } from "../../src/server/auth-routes.ts";`
// **`roleValuesForKinds` は関数ごと消え、引数を落とした `baseRoleValues` に改名された。**
import { assignableRoleValues, baseRoleValues } from "../../src/server/auth-routes.ts";
import { REF_EC_APP_ID, referenceEcManifest } from "./manifest.ts";

let dataRoot: string;
let store: KernelMetaStore;
let diffSeq = 0;

/** `validateDiff` は `diff_id` と `intent` を必須にしている(操作だけでは通らない)。 */
function diff(operations: unknown[]): unknown {
  diffSeq += 1;
  return { diff_id: `v5-m26-uk-${diffSeq}`, intent: "利用者の種類の実地確認", operations };
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-ref-ec-user-kinds-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照EC", { app_id: REF_EC_APP_ID });
  const installed = applyManifest(dataRoot, REF_EC_APP_ID, referenceEcManifest());
  if (!installed.valid) {
    throw new Error(`参照 EC の投入に失敗: ${JSON.stringify(installed.errors)}`);
  }
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

/** ディスク上のマニフェスト(**拒否された差分が1バイトも触っていないことを測る**)。 */
function onDiskRoleIds(): string[] {
  const raw = readFileSync(join(dataRoot, "apps", REF_EC_APP_ID, "manifest.json"), "utf8");
  const parsed = JSON.parse(raw) as { app: { roles?: { id: string }[]; user_kinds?: unknown } };
  expect(parsed.app.user_kinds).toBeUndefined();
  return (parsed.app.roles ?? []).map((role) => role.id);
}

/** 参照 EC に `set_user_kinds` を当てて、拒否の `path` を返す。 */
function applyKinds(kinds: unknown): string | undefined {
  const result = applyDiff(
    dataRoot,
    REF_EC_APP_ID,
    diff([{ op: "set_user_kinds", user_kinds: kinds }]),
  );
  return result.valid === false ? result.errors[0]?.path : undefined;
}

/** `v5-m18.md` §5-1 の 1 が言った「差分操作が1つも存在しない」は今日は成り立たない。 */
// **【`V8-M16` / `J-G1b` / `D-V8-31`】期待値を 17 → 18 に、テスト名を実体に合わせて
// 書き換えた。****旧テスト名の逐語は「(U-1) `set_user_kinds` は今日 `DIFF_OPS` に在る(16 → 17)」、
// 旧行の逐語は `expect(DIFF_OPS).toHaveLength(17);` である。****書き換えた理由**: この検査が
// 見ているのは `set_user_kinds` の実在であり、本数は `V8-M16` が18種目 `set_roles` を足したこと
// で動いた(この検査の主題とは別の決定である)。**検査は消していない。**
//
// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】向きを反転させた。**
// **旧テスト名の逐語**: 「(U-1) `set_user_kinds` は今日 `DIFF_OPS` に在る(16 → 17 → 18)」。
// **旧行の逐語**:
//   `expect(DIFF_OPS).toHaveLength(18);`
//   `expect(DIFF_OPS as readonly string[]).toContain("set_user_kinds");`
// **`v5-m18.md` §5-1 の 1 が言った「差分操作が1つも存在しない」は、今日ふたたび成り立つ** ——
// **ただし理由は「まだ無い」ではなく「廃止した」である。****同じことだと書かない。**
test("(U-1) `set_user_kinds` は今日 `DIFF_OPS` に無い(18 → 17。末尾は `set_roles`)", () => {
  expect(DIFF_OPS).toHaveLength(17);
  expect(DIFF_OPS as readonly string[]).not.toContain("set_user_kinds");
  expect(DIFF_OPS[16]).toBe("set_roles");
});

/**
 * **`v5-m18.md` §5-1 の 3 の予測の検証 —— 当たった。**
 *
 * **【`V8-M20` / 台帳 `J-G29` / `ADR-0301`。検査は消していない。当て先を面へ移した】**
 *
 * **旧テスト名の逐語**:
 * 「(U-2) `customer` を含まない `user_kinds` を宣言すると、既存の `audience: ["customer"]` が
 * 3本とも拒否される」。
 * **旧の期待値の逐語**(1バイトも書き換えずに残す):
 * ```
 * expect(errors.every((error) => error.path.includes("/audience/"))).toBe(true);
 * expect(errors).toHaveLength(3);
 * expect(errors.map((error) => error.path)).toEqual([
 *   "/app/views/0/actions/0/audience/0",
 *   "/app/views/5/actions/0/audience/0",
 *   "/app/views/5/actions/1/audience/0",
 * ]);
 * ```
 *
 * **予測が言っていたのは「`customer` を書いた既存の宣言が、宣言の値域から `customer` が
 * 消えた瞬間に拒否される」ことである。** **参照 EC が `customer` と書いている場所は、今日は
 * 操作起点の `audience` ではなく `app.roles[].id`(1本)である。**
 *
 * **【実測。予測は今日は外れる。隠さない】** **同じ差分は今日 valid になる** ——
 * **`app.roles[].id` の値域を検査する箇所が、スキーマにも適用時検査にも1つも無いからである。**
 * **`referential-integrity.ts` の類型13(`allowedAudience` / `checkAudienceList`)は
 * `V8-M20` が撤去し、同ファイルの逐語が「**同じ値域を `app.roles[].id` について検査する箇所は
 * 今日1つも無い**」「**この穴は `V8-M16` が開けて自ら申告したものである**」と書いている。**
 *
 * **したがってこの検査は「拒否されること」から「拒否されないこと(= 穴が開いていること)」へ
 * 向きが変わった。** **誰かがその値域を閉じたら、この検査が赤くなって気づける。**
 * **【禁止の履行】これを「同じことを測り続けている」とは書かない** ——
 * **測っている向きが反対である。**
 *
 * ---
 *
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】もう一度向きが変わった。**
 * **旧テスト名の逐語**: 「(U-2) `customer` を含まない `user_kinds` を宣言しても、既存の
 * 役割 `customer` は今日1件も拒否されない(穴)」。
 * **旧の期待値の逐語**:
 * ```
 * expect(result.valid).toBe(true);
 * expect((applied?.app.user_kinds ?? []).map((kind) => kind.id)).toEqual(["buyer", "supplier"]);
 * expect((applied?.app.roles ?? []).map((role) => role.id)).toEqual([
 *   "owner",
 *   "editor",
 *   "viewer",
 *   "customer",
 *   "anonymous",
 * ]);
 * ```
 * **今日は差分そのものが `op` の値域で拒否されるので、`app.roles[].id` の穴を
 * この経路からは1件も観測できない**(穴そのものは
 * `src/server/declared-user-kind-scope.test.ts` の (4-a) / (4-e) が今日も測る)。
 * **参照 EC の5役割が1つも動かないことは、ディスク上の実物で測る。**
 */
test("(U-2) 参照 EC に `set_user_kinds` を当てると拒否され、5役割が1つも動かない", () => {
  expect(
    applyKinds([
      { id: "buyer", name: "購入する人" },
      { id: "supplier", name: "納品する人" },
    ]),
  ).toBe("/operations/0/op");
  // **参照 EC は今日も5役割を宣言したままである**(拒否された差分は1バイトも書いていない)。
  expect(onDiskRoleIds()).toEqual(["owner", "editor", "viewer", "customer", "anonymous"]);
});

/**
 * **予測の裏側**: **宣言に `customer` を残せば、同じ差分が通る。**
 *
 * **これは「`user_kinds` を書けるようになった」ことの実測であって、
 * 「参照 EC が `user_kinds` を使っている」ことではない**(参照 EC の宣言は1バイトも変えていない)。
 *
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】向きを反転させた。**
 * **旧テスト名の逐語**: 「(U-3) `customer` を含めて宣言すれば、同じ差分が通る」。
 * **旧の期待値の逐語**:
 * ```
 * expect(result.valid).toBe(true);
 * expect(applied?.app.user_kinds).toEqual([
 *   { id: "customer", name: "お買い物をする人" },
 *   { id: "supplier", name: "納品する人" },
 * ]);
 * ```
 * **【担い手が無いもの】** **宣言の中身が結果を1文字も変えない今日、この「裏側」は
 * 1バイトも測れない** —— **`customer` を含めても含めなくても、まったく同じ `path` で
 * 拒否される。**
 */
test("(U-3) `customer` を含めて宣言しても、まったく同じ理由で拒否される(中身は結果を変えない)", () => {
  const withCustomer = applyKinds([
    { id: "customer", name: "お買い物をする人" },
    { id: "supplier", name: "納品する人" },
  ]);
  const withoutCustomer = applyKinds([{ id: "supplier", name: "納品する人" }]);
  expect(withCustomer).toBe("/operations/0/op");
  expect(withCustomer).toBe(withoutCustomer);
});

/**
 * **宣言した種類を、権限の宣言に実際に書ける。**
 *
 * **`v5-m18.md` §4 の表は `user_kinds` を「使わなかった」と書いた。** **今日は書ける。**
 *
 * **【`V8-M20` / 台帳 `J-G29` / `ADR-0301`。検査は消していない。当て先を面へ移した】**
 * **旧テスト名の逐語**: 「(U-4) 宣言した種類を、一覧の操作起点の `audience` に書ける」。
 * **旧本体は `update_view` の `changes.actions` に3本の起点を並べ、それぞれに
 * `audience: ["customer"] / ["owner"] / ["supplier"]` を書いていた。**
 * **今日その3本を書く場所は `set_roles` の `app.roles[].rules` である** ——
 * **問いは1ミリも変えていない(「宣言した種類を、権限を書く場所に書けるか」)。**
 *
 * ---
 *
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G11`。判定値 = 廃止】前段の1差分を落とした。**
 * **旧の本体は、この `set_roles` の前に `set_user_kinds` の差分を1本当てて `valid` を
 * 確かめていた。旧の逐語**:
 * ```
 * expect(
 *   applyDiff(
 *     dataRoot,
 *     REF_EC_APP_ID,
 *     diff([
 *       {
 *         op: "set_user_kinds",
 *         user_kinds: [
 *           { id: "customer", name: "お買い物をする人" },
 *           { id: "supplier", name: "納品する人" },
 *         ],
 *       },
 *     ]),
 *   ).valid,
 * ).toBe(true);
 * ```
 * **今日その1本は拒否されるので落とした。****落としても後段は1バイトも変わらない** ——
 * **`set_roles` は `app.user_kinds` を1バイトも読まないからである**
 * (`ADR-0301` 限定2 の「代わりに何が担うか」を、実物の参照 EC の上で示す1本)。
 */
test("(U-4) 立場を役割の宣言(`set_roles`)に書ける —— 前段の `set_user_kinds` は今日要らない", () => {
  const result = applyDiff(
    dataRoot,
    REF_EC_APP_ID,
    diff([
      {
        op: "set_roles",
        roles: [
          {
            id: "owner",
            name: "運営",
            rules: [
              // **【`V8-M28` / `T-G16a`】持ち主からこの2行は抜けない** ——
              // **抜いた `set_roles` は適用時検査(類型17 の拡張)が拒否する。**
              { target: "app", can: ["write"] },
              { target: "role", can: ["write"] },
              { target: "table", table: "order", can: ["read", "write", "delete"] },
              {
                target: "action",
                view: "catalog-list",
                action: "archive-product",
                can: ["read"],
              },
            ],
          },
          // **既定の3役割(`owner` / `editor` / `viewer`)は `set_roles` の全体差し替えでも
          // 消せない** —— **消すと「既定の役割が宣言から消えています」で拒否される
          // (実測)。** **規則を持たない2本もここに書く必要がある。**
          { id: "editor", name: "編集者" },
          { id: "viewer", name: "閲覧者" },
          {
            id: "customer",
            name: "購入者",
            rules: [
              { target: "action", view: "catalog-list", action: "add-to-cart", can: ["read"] },
            ],
          },
          // **立場(`supplier`)を役割として書き、規則まで持たせられる。**
          // **`user_kinds` に1度も宣言していないが、今日はそれで足りる**(前段が要らない)。
          {
            id: "supplier",
            name: "納品する人",
            rules: [{ target: "table", table: "product", can: ["read"] }],
          },
        ],
      },
    ]),
  );

  expect(result.valid).toBe(true);
  const applied = result.valid ? result.manifest : undefined;
  expect((applied?.app.roles ?? []).map((role) => role.id)).toEqual([
    "owner",
    "editor",
    "viewer",
    "customer",
    "supplier",
  ]);
});

/**
 * **宣言した種類は、そのアプリのロール語彙にも入る。**
 *
 * **`v5-m26.md` を書く時点で、こちらは予測を持たずに測った。** 結果は
 * **「入る」**である —— `roleValuesForKinds` は予約3ロールに宣言した種類を並べて返し、
 * `PATCH /api/apps/:app_id/auth/users/:user_id` の `isRole` がこれを使う。
 *
 * **【誇張しない】** **ここで測ったのは純関数の返り値だけである。** **`supplier` の
 * アカウントを実際に作ってログインし、画面でボタンが出るところまでは測っていない。**
 *
 * ---
 *
 * **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G12`。判定値 = 廃止】測る関数を
 * 入れ替えた。**
 * **旧テスト名の逐語**: 「(U-5) 宣言した種類は、そのアプリで受理するロールの一覧に入る」。
 * **旧の期待値の逐語**(1バイトも書き換えずに残す):
 * ```
 * expect(roleValuesForKinds([])).toEqual([...RESERVED_ROLES, "customer"]);
 * expect(roleValuesForKinds(["customer", "supplier"])).toEqual([
 *   ...RESERVED_ROLES,
 *   "customer",
 *   "supplier",
 * ]);
 * // **予約3ロールは宣言で消せない**(`ADR-0158` 限定1)。
 * expect(roleValuesForKinds(["supplier"])).toEqual([...RESERVED_ROLES, "supplier"]);
 * ```
 * **`roleValuesForKinds` は関数ごと消えた。** **一覧を組むのは今日
 * `baseRoleValues()`(宣言に依らない土台)と `assignableRoleValues(roleIds)`
 * (`app.roles[].id` を足す側)の2本である。**
 *
 * **【担い手が無いもの。名指しで書く】** **旧の3本目が測っていた「宣言した種類だけを
 * 渡すと `customer` が一覧から外れる」は、今日1バイトも再現できない** ——
 * **`customer` は常に入る**(`ADR-0301` 限定6 の ④)。
 */
// ---------------------------------------------------------------------------------------
// **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用(門外 `Δ7`)】期待値を入れ替えた。**
//
// **旧テスト名の逐語**: 「(U-5) 立場は、そのアプリで受理するロールの一覧に入る(出所は
// `app.roles[].id`)」。
// **旧の本体(逐語。上の doc は1バイトも書き換えていない)**:
//
//     // **宣言に依らない土台は、旧 `roleValuesForKinds([])` と1文字も変わらない。**
//     expect(baseRoleValues()).toEqual([...RESERVED_ROLES, "customer"]);
//     // **旧 `roleValuesForKinds(["customer", "supplier"])` と同じ答えを、`app.roles[].id` から作る。**
//     expect(assignableRoleValues(["owner", "editor", "viewer", "customer", "supplier"])).toEqual([
//       ...RESERVED_ROLES,
//       "customer",
//       "supplier",
//     ]);
//     // **予約3ロールは宣言で消せない**(`ADR-0158` 限定1)。
//     // **【今日は `customer` も消せない。旧はここで消えていた】**
//     expect(assignableRoleValues(["owner", "editor", "viewer", "supplier"])).toEqual([
//       ...RESERVED_ROLES,
//       "customer",
//       "supplier",
//     ]);
//
// **`baseRoleValues()` が `customer` を無条件に足すのをやめた。**
// **直上の doc の「【担い手が無いもの。名指しで書く】… 今日1バイトも再現できない ――
// `customer` は常に入る」は、今日から偽である**(旧文を1バイトも消していない)。
// **`V8-M38` が担い手になった。** **旧の3本目が測っていた「宣言に書かないと `customer` が
// 一覧から外れる」は、今日ふたたび再現する。**
// ---------------------------------------------------------------------------------------
test("(U-5) 立場は、そのアプリで受理するロールの一覧に入る(出所は `app.roles[].id`。`customer` にも宣言が要る)", () => {
  // **宣言に依らない土台は、今日は予約3ロールだけである。**
  expect(baseRoleValues()).toEqual([...RESERVED_ROLES]);
  // **旧 `roleValuesForKinds(["customer", "supplier"])` と同じ答えを、`app.roles[].id` から作る。**
  expect(assignableRoleValues(["owner", "editor", "viewer", "customer", "supplier"])).toEqual([
    ...RESERVED_ROLES,
    "customer",
    "supplier",
  ]);
  // **予約3ロールは宣言で消せない**(`ADR-0158` 限定1)。
  // **【`V8-M38` / `F-G9`】`customer` は宣言しなければ入らない。**
  expect(assignableRoleValues(["owner", "editor", "viewer", "supplier"])).toEqual([
    ...RESERVED_ROLES,
    "supplier",
  ]);
});
