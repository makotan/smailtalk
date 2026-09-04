/**
 * ロール変更 UI の選択肢(`ROLE_ORDER`)とサーバのロール語彙(`ROLE_VALUES`)の同期検査
 * (V3-M3-T03 / D-G12a)。
 *
 * ## なぜ web 側に置くのか
 *
 * 先例は `src/auth/role-vocabulary-sync.test.ts`(Role 型 / CHECK 制約 / `ROLE_VALUES` の
 * 3箇所同期)である。**作法はそれを真似るが、置き場所だけは違う** —— D-G12a は門外(Δ7)で
 * 通っており、**`src/` に1バイトも差分を出せない**(`docs/plan/v3/records/v3-m3.md` §2 の
 * T03 完了条件6 / 審査記録 `v3-m3-gate-a-navigation.md` §2 S6-2)。したがって同期の歯止めは
 * `web/test/` に置く。V3-M1-T05 と同じ制約である。
 *
 * ## 何を守るのか
 *
 * `web/src/auth/UserAdmin.tsx` の `ROLE_ORDER` は `<select>` の `<option>` を生む唯一の
 * 出所であり、サーバの `ROLE_VALUES`(`src/server/auth-routes.ts`)は `PATCH /auth/users/:id`
 * の `allowed_values` を生む唯一の出所である。**片方だけにロールが増えると**、
 *
 *   - サーバにだけ足す → HTTP API は受理するのに画面から選べない(D-G12a 以前の状態)
 *   - 画面にだけ足す → 選べるのに 400(`role の値が不正です。`)で必ず失敗する
 *
 * という食い違いが静かに入る。**ここが赤くなる**ことでそれを止める。
 *
 * ## 守らないこと(先に書く)
 *
 * 本ファイルは**語彙集合の一致だけ**を見る。「そのロールに変更してよいか」(降格の是非)は
 * 見ていない —— それはサーバの 409(最後の owner)と UI の警告(D-M3-3)の担当である。
 * **UI の警告は構造的な禁止ではない**ので、本検査が緑であることは「事故が起きない」ことを
 * 1ミリも意味しない。
 */
import { describe, expect, test } from "bun:test";
// **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`】旧(逐語)**:
//     import { assignableRoleValues, roleValuesForKinds } from "../../src/server/auth-routes.ts";
// **`roleValuesForKinds(kinds)` は引数の唯一の出所(`user_kinds`)ごと廃止され、
// 引数を持たない `baseRoleValues()` に置き換わった。****戻りは着手前に `kinds` が
// 空だったときとまったく同じ4値である。**
import { assignableRoleValues, baseRoleValues } from "../../src/server/auth-routes.ts";
import type { Role } from "../src/api.ts";
import { roleLabel, roleLabels } from "../src/auth/authz.tsx";
import { ROLE_ORDER, roleOrder } from "../src/auth/UserAdmin.tsx";

/** `B` が `A` に代入可能(B ⊆ A)なときだけ型チェックが通る補助(先例と同じ形)。 */
type AssertExtends<A, B extends A> = B;

/** それぞれの配列の要素として観測される文字列リテラル union。 */
/**
 * **【`V5-M17-T03` / `ADR-0158`】`ROLE_VALUES` は定数ではなくなった。**
 * **「宣言が無いアプリ」のロール語彙(= 着手前の `ROLE_VALUES` と1文字も同じ4値)を
 * ここで作り、同期の検査はそれに対して行う。** **宣言があるアプリの同期は下の describe で
 * 別に測る**(そちらは `roleOrder` / `roleValuesForKinds` の両方に同じ宣言を渡す)。
 */
// **【`V8-M29` 第2波】旧(逐語)**: `const ROLE_VALUES = roleValuesForKinds([]) as readonly [...];`
// **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用】旧(逐語)**:
//     const ROLE_VALUES = baseRoleValues() as readonly ["owner", "editor", "viewer", "customer"];
// **`baseRoleValues()` が `customer` を無条件に足すのをやめたので、4値目が消えた。**
// **上の doc の「着手前の `ROLE_VALUES` と1文字も同じ4値」は今日から偽である**
// (旧文を1バイトも消していない)。
const ROLE_VALUES = baseRoleValues() as readonly ["owner", "editor", "viewer"];
type RoleValuesElement = (typeof ROLE_VALUES)[number];
type RoleOrderElement = (typeof ROLE_ORDER)[number];

// --- コンパイル時: ROLE_ORDER の要素 union ⟺ ROLE_VALUES の要素 union が双方向一致する ---
// (a) ROLE_VALUES ⊆ ROLE_ORDER: サーバが受理するロールがすべて画面の選択肢にある。
type _ValuesCoveredByOrder = AssertExtends<RoleOrderElement, RoleValuesElement>;
// (b) ROLE_ORDER ⊆ ROLE_VALUES: 画面の選択肢にサーバが知らないロールが混じらない。
type _OrderCoveredByValues = AssertExtends<RoleValuesElement, RoleOrderElement>;
// 型を実際に使って未使用エラーを避けつつ、代入可能性を固定する。
// **【2026-08-13。`V8-M38`。台帳 `F-G9`】旧(逐語)**:
//     const _valuesCovered: _ValuesCoveredByOrder = "customer";
//     const _orderCovered: _OrderCoveredByValues = "customer";
// **両側の語彙から `customer` が消えたので、両側に在る値へ差し替えた。**
const _valuesCovered: _ValuesCoveredByOrder = "viewer";
const _orderCovered: _OrderCoveredByValues = "viewer";

describe("ロール変更 UI とサーバのロール語彙の同期(ROLE_ORDER / ROLE_VALUES)", () => {
  test("集合として完全一致する(片方だけ増えたらここが落ちる)", () => {
    expect(new Set(ROLE_ORDER)).toEqual(new Set(ROLE_VALUES));
    // 件数も見る(集合比較は重複を吸収してしまうため)。
    expect(ROLE_ORDER.length).toBe(ROLE_VALUES.length);
    expect(new Set(ROLE_ORDER).size).toBe(ROLE_ORDER.length);
  });

  // ---------------------------------------------------------------------------------
  // **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用】テスト名と本体を入れ替えた。**
  //
  // **旧テスト名の逐語**: 「customer が両側に載っている(D-G12a が足した4値目を名指しで固定する)」。
  // **旧の本体(逐語)**:
  //
  //     expect(ROLE_ORDER).toContain("customer");
  //     expect(ROLE_VALUES as readonly string[]).toContain("customer");
  //
  // **`D-G12a`(2026-07-26)が足した4値目は、`F-G9` が落とした。**
  // **落とした理由**: **アプリが `customer` を1度も宣言していなくても人に付けられ、
  // `V8-M26` が既定を閉じた今日は「どの規則にも当たらない役割」が付いてしまうため。**
  // **検査は消していない** —— **「両側から消えたこと」を同じ位置で固定する。**
  // **宣言したアプリで両側に載ることは、下の describe(宣言があるアプリ)が測る。**
  // ---------------------------------------------------------------------------------
  test("customer は両側から消えた(`F-G9`。宣言していないアプリの選択肢に出さない)", () => {
    expect(ROLE_ORDER as readonly string[]).not.toContain("customer");
    expect(ROLE_VALUES as readonly string[]).not.toContain("customer");
    // **予約3ロールは両側に今日どおり載る**(射程は `customer` の1語だけである)。
    for (const reserved of ["owner", "editor", "viewer"]) {
      expect(ROLE_ORDER as readonly string[], reserved).toContain(reserved);
      expect(ROLE_VALUES as readonly string[], reserved).toContain(reserved);
    }
  });

  test("画面の選択肢はすべて表示名を持つ(option のラベルが空にならない)", () => {
    const labels = roleLabels();
    for (const role of ROLE_ORDER) {
      expect(labels[role as Role]).toBeTruthy();
    }
  });

  test("コンパイル時アサーションに使った値が両側の語彙に属する(実行時の裏取り)", () => {
    expect(ROLE_ORDER as readonly string[]).toContain(_valuesCovered);
    expect(ROLE_VALUES as readonly string[]).toContain(_orderCovered);
  });
});

/**
 * **【`V5-M17-T08` / `G-G5` / `ADR-0158` / `ADR-0159` 限定5】宣言があるアプリでの同期。**
 *
 * **上の describe は「宣言が無いアプリ」= 着手前と1文字も同じ4値を測っている。**
 * **こちらは「宣言があるアプリ」を測る** —— **画面の選択肢とサーバの受理語彙が、
 * 宣言に対して同じ集合になること。**
 */
describe("宣言があるアプリでのロール語彙の同期(`roleOrder` / `assignableRoleValues`)", () => {
  // ---------------------------------------------------------------------------------
  // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a` / `T-G12`。判定値 = 廃止】**
  //
  // **旧の describe 名の逐語**:
  // 「宣言があるアプリでのロール語彙の同期(`roleOrder` / `roleValuesForKinds`)」。
  // **旧の題材(逐語)**:
  //
  //     const kinds = [
  //       { id: "member", name: "会員" },
  //       { id: "supplier", name: "取引先" },
  //     ];
  //
  // **「宣言」の出所が `app.user_kinds` から `app.roles` に移った。**
  // **3本の検査は1本も消していない。題材と期待値だけを入れ替えた。**
  // ---------------------------------------------------------------------------------
  /** **宣言された役割の識別子**(`app.roles[].id`)。 */
  const roleIds = ["owner", "editor", "viewer", "member", "supplier"];
  /** **表示名を持つ役割**(`app.roles[].name`)。 */
  const named = [
    { id: "member", name: "会員" },
    { id: "supplier", name: "取引先" },
  ];

  test("集合として完全一致する(片方だけ増えたらここが落ちる)", () => {
    // **旧(逐語)**:
    //     expect(new Set(roleOrder(kinds))).toEqual(new Set(roleValuesForKinds(kinds.map((k) => k.id))));
    //     expect(roleOrder(kinds).length).toBe(roleValuesForKinds(kinds.map((k) => k.id)).length);
    expect(new Set(roleOrder(roleIds))).toEqual(new Set(assignableRoleValues(roleIds)));
    expect(roleOrder(roleIds).length).toBe(assignableRoleValues(roleIds).length);
  });

  // ---------------------------------------------------------------------------------
  // **【2026-08-13。`V8-M38`。台帳 `F-G9`。判定値 = 限定採用】テスト名と期待値を入れ替えた。**
  //
  // **旧テスト名の逐語**: 「宣言した役割が両側に載る(`customer` は今日どちらにも載る)」。
  // **旧の期待値(逐語。中のコメントは下にそのまま残してある)**:
  //
  //     expect(roleOrder(roleIds)).toEqual([
  //       "owner",
  //       "editor",
  //       "viewer",
  //       "customer",
  //       "member",
  //       "supplier",
  //     ]);
  //     expect(roleOrder(roleIds) as readonly string[]).toContain("customer");
  //     expect(assignableRoleValues(roleIds) as readonly string[]).toContain("customer");
  //
  // **`customer` を宣言していない `roleIds` から `customer` が消えた。**
  // **直下の旧文「今日は外れない ―― `customer` は常に入る」「外す手段は今日1つも
  // 無く、担い手も無い」は、今日から偽である**(旧文を1バイトも消していない)。
  // **外す手段は `V8-M38` が作った** —— **既定から落とし、宣言した側だけを入れる。**
  // **宣言すれば両側に載ることは、この検査の末尾が同じ位置で測る。**
  // ---------------------------------------------------------------------------------
  test("宣言した役割が両側に載る(`customer` は宣言したときだけ載る)", () => {
    // **旧テスト名の逐語**: 「宣言した種類が両側に載り、`customer` はどちらにも載らない」。
    // **旧の期待値(逐語)**:
    //     expect(roleOrder(kinds)).toEqual(["owner", "editor", "viewer", "member", "supplier"]);
    //     expect(roleOrder(kinds) as readonly string[]).not.toContain("customer");
    //     expect(roleValuesForKinds(["member", "supplier"]) as readonly string[]).not.toContain("customer");
    //
    // **【値域の変化。丸めない】** **着手前は `user_kinds` を宣言すると `customer` が
    // 値域から**外れた**。** **今日は外れない** —— **`customer` は常に入る。**
    // **外す手段は今日1つも無く、担い手も無い**(`ADR-0301` 限定6 の ④)。
    expect(roleOrder(roleIds)).toEqual(["owner", "editor", "viewer", "member", "supplier"]);
    expect(roleOrder(roleIds) as readonly string[]).not.toContain("customer");
    expect(assignableRoleValues(roleIds) as readonly string[]).not.toContain("customer");
    // **宣言すれば両側に載る**(`F-G9` は `customer` を書けなくしたのではない)。
    const declared = [...roleIds, "customer"];
    expect(roleOrder(declared) as readonly string[]).toContain("customer");
    expect(assignableRoleValues(declared) as readonly string[]).toContain("customer");
    expect(new Set(roleOrder(declared))).toEqual(new Set(assignableRoleValues(declared)));
  });

  test("宣言した役割はすべて表示名を持つ(`app.roles[].name` から引く)", () => {
    // **旧テスト名の逐語**: 「宣言した種類はすべて表示名を持つ(`user_kinds` の `name` から引く)」。
    // **【この入れ替えで失われたもの】** **`roles[].name` は今日も任意である**
    // (ユーザ決定 `D-V8-79`)ので、**「宣言した役割はすべて表示名を持つ」は
    // 一般には成り立たない** —— **この検査は「名前を書いた役割は表示名を持つ」しか測れない。**
    const labels = roleLabels(named);
    for (const role of named) {
      expect(labels[role.id as Role]).toBeTruthy();
    }
    expect(labels.member).toBe("会員");
    expect(labels.supplier).toBe("取引先");
  });
});

// =====================================================================================
// **【`V8-M29` 第1波(2026-08-11)。台帳 `T-G10` / ユーザ決定 `D-V8-79`】**
// **役割の表示名と、画面とサーバのずれ**
// =====================================================================================
//
// **上の検査を1本も消していない。1バイトも書き換えていない。**
//
// **本ファイル冒頭の「何を守るのか」は、役割(`app.roles`)を宣言したアプリでは
// 今日から成り立たない** —— **サーバの値域は `app.roles[].id` も引くようになったが、
// 画面の選択肢(`roleOrder`)は今日も `user_kinds` だけを見る。**
// **冒頭の文章は1バイトも書き換えていない**(この作法を守るため)。**代わりに、
// そのずれを下の検査が機械で固定する。**

describe("役割の表示名(`D-V8-79` = 表示名は任意のまま)", () => {
  // **【`V8-M29` 第2波】`roleLabels` / `roleLabel` の第1引数(`user_kinds` 側)を落とした。**
  // **旧の呼び出しは `roleLabels([], [...])` / `roleLabel(role, [], [...])` である。**
  test("`app.roles[].name` を書いた役割は、その表示名が出る", () => {
    const labels = roleLabels([{ id: "reception", name: "受付係" }]);
    expect(labels.reception).toBe("受付係");
  });

  test("表示名を書かなかった役割は、識別子が生で出る", () => {
    // **`D-V8-79` の説明文の逐語**: 「**表示名を書かなければ、利用者管理の画面に英字の
    // 識別子(reception など)がそのまま出ます。**」
    // **`declaredRoleKinds` は `name` を持たない宣言を落とすので、対応表に1度も載らない。**
    // **旧(逐語)**: `roleLabel("backoffice" as Role, [], [{ id: "reception", name: "受付係" }])`
    expect(roleLabel("backoffice" as Role, [{ id: "reception", name: "受付係" }])).toBe(
      "backoffice",
    );
  });

  test("予約3ロールの表示名は、役割の宣言に名前を書いても今日どおりである", () => {
    // **`V8-M29` は運営3語の表示を1文字も動かさない**(見る順の2段目が固定文字列)。
    // **旧(逐語)**: `roleLabels([], [{ id: "owner", name: "持ち主" }])`
    const labels = roleLabels([{ id: "owner", name: "持ち主" }]);
    expect(labels.owner).toBe("オーナー");
  });

  test("`customer` の表示名は、役割の宣言に名前を書けば置き換わる", () => {
    // **【2026-08-11。`V8-M29` 第2波】旧テスト名の逐語**:
    // 「`user_kinds` の表示名が最優先である(今日の表示を1文字も変えない)」。
    // **旧の本体(逐語)**:
    //     const labels = roleLabels([{ id: "member", name: "会員" }], [{ id: "member", name: "常連" }]);
    //     expect(labels.member).toBe("会員");
    //
    // **第1引数(`user_kinds` 側)が消えたので、「どちらが勝つか」を測る対象が無くなった。**
    // **代わりに、既定の `customer`(「一般利用者」)を役割の宣言が上書きできることを測る**
    // —— **着手前に `user_kinds` に `{"id":"customer","name":"…"}` と書いたときの
    // ふるまいと同じである。**
    expect(roleLabels().customer).toBe("一般利用者");
    expect(roleLabels([{ id: "customer", name: "購入者" }]).customer).toBe("購入者");
    // **予約3ロールだけは、役割の宣言でも置き換わらない**(すぐ上の検査と同じ線)。
    expect(roleLabels([{ id: "owner", name: "持ち主" }]).owner).toBe("オーナー");
  });
});

describe("【今日のずれ】画面の選択肢とサーバの値域(`V8-M29` 第1波の限界)", () => {
  test("役割だけを宣言したアプリでは、サーバは受理するのに画面のセレクトに出ない", () => {
    // **冒頭の「守らないこと」に無い、新しいずれである。誇張せず、隠さず固定する。**
    // **これは `V8-M29` 第1波が塞がなかった穴であり、次の波以降の担当である。**
    // **【2026-08-11。`V8-M29` 第2波。このずれは塞がれた】旧の本体(逐語)**:
    //     expect(assignableRoleValues(["reception"], []) as readonly string[]).toContain("reception");
    //     expect(roleOrder([]) as readonly string[]).not.toContain("reception");
    // **旧テスト名の逐語**:
    // 「役割だけを宣言したアプリでは、サーバは受理するのに画面のセレクトに出ない」。
    // **今日は画面のセレクトにも出る**(`roleOrder` の引数が `app.roles[].id` になった)。
    expect(assignableRoleValues(["reception"]) as readonly string[]).toContain("reception");
    expect(roleOrder(["reception"]) as readonly string[]).toContain("reception");
  });

  test("`anonymous` はどちらにも載らない(人に付けられない値である)", () => {
    // **旧テスト名の逐語**: 「立場の一覧だけを宣言したアプリでは、今日も両者が一致する」。
    // **旧の本体(逐語)**:
    //     const kinds = [{ id: "member", name: "会員" }];
    //     expect(new Set(roleOrder(kinds))).toEqual(
    //       new Set(assignableRoleValues([], ["member"]) as readonly string[]),
    //     );
    // **題材(立場の一覧)が廃止されたので、測る対象を `anonymous` の締め出しに入れ替えた**
    // (ユーザ決定 `D-V8-80`)。**サーバと画面が同じ落とし方をしていることを測る。**
    const declared = ["owner", "editor", "viewer", "anonymous", "member"];
    expect(assignableRoleValues(declared) as readonly string[]).not.toContain("anonymous");
    expect(roleOrder(declared) as readonly string[]).not.toContain("anonymous");
    expect(new Set(roleOrder(declared))).toEqual(new Set(assignableRoleValues(declared)));
  });
});
