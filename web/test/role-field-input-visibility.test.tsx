/**
 * **画面の先回りが、サーバの判断とずれないこと**(`V8-M22` / 台帳 `J-G38`。**門外(Δ7)・却下**)。
 *
 * 台帳(`docs/adr/0007-vocabulary-governance.md:1298`)の限定の逐語:
 *
 * > 今日の機構で満たせる —— 表示層 `web/` が、サーバの述語をそのまま import する形
 * > (`web/src/auth/authz.tsx:70` / `:86`。実在)。**失うもの = 操作起点だけ表示層に再実装が残る。**
 * > **実装時に `src/kernel/` へ型を1本でも足したら門Aへ差し戻す**
 *
 * ## このファイルが固定する2つのずれ(**着手前に実測した。先行の記録の言うとおりであった**)
 *
 * | # | ずれ | 着手前の実測 | 出典 |
 * |---|---|---|---|
 * | **1** | **面が「書けない」と決めた項目の入力欄が、`form` に今日も描かれる。** 送るとサーバが 403 を返す(`src/server/app.ts:3974` / `:4196` の `judgeRoleFieldWrite`)—— **入力欄が1つでも混じると保存**全体**が落ちる**(`FormRenderer` は `fields` を全部 `toRecordInput` に渡すため) | **描かれていた** | `docs/plan/v8/records/v8-m17.md:817` |
 * | **2** | **面のボタンの規則が立てた壁(`isRoleActionWriteAllowed`)を表示層が1バイトも知らない。** その表への作成/更新が壁で止まる相手にも「保存」ボタンが出て、押すと必ず 403(`src/server/app.ts:3947` / `:4164`) | **出ていた** | 本タスクが実測(先行の記録は名指ししていない) |
 *
 * ## 判定を表示層に**再実装していない**
 *
 * **どちらも `src/server/owner-scope.ts` の述語をそのまま呼ぶ**(`judgeRoleAccess` /
 * `isRoleActionWriteAllowed`)。**`web/` に規則の読み方を1文字も書いていない** ——
 * `web/src/navigation.tsx:99`〜`:100` が「同じ判定が2箇所」を名指しで禁じた形を作らない。
 * **`src/server/owner-scope.ts` は1バイトも変えていない**(`web/test/shell-navigation-boundary.test.ts`
 * の (c) が sha256 で固定しており、触れば必ず赤くなる)。**`src/kernel/` に型を1本も足していない。**
 *
 * ## このファイルが証明しないこと(**先に書く。誇張しない**)
 *
 * - **【画面に出ないことを防御の根拠にしない】**(`ADR-0176` 限定5 の逐語:「権限判定はサーバで
 *   行う。UI の出し分けを根拠にしない。**先回りガードは防御ではない。入口が最終防衛線である**」)。
 *   **本タスクはサーバ側の判定を1バイトも弱めていない** —— **消しているのは「押しても必ず
 *   403 になる導線」だけである。**
 * - **`canUseView` は今日も面と点の `OR` を1バイトも知らない**(`v8-m19.md:953` の穴6)。
 *   **「点(行ごとの付与)だけで見える画面」という概念は今日も無い** ——
 *   **点は行にしか無く、画面を名指しできる付与の語彙が1つも無いためである**
 *   (同記録 §15 の 3 が「語彙の形であり、穴ではない」と書いている側)。**本タスクは
 *   これを塞いでいない。**
 * - **項目の「読取」の側は測っていない。** **`can: ["write"]` だけを書いた項目は、
 *   サーバが読取応答から値を落とし(`projectForRoleFields`)、それでも入力欄は出る** ——
 *   **空欄で上書きできてしまう形が残る。**
 * - **削除は測っていない**(`isRoleActionWriteAllowed` の種類は `create` / `update` の
 *   2つだけであり、`DELETE` に壁が無い)。
 */
import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FormView, Manifest } from "../../src/kernel/types.ts";
import { isRoleActionWriteAllowed, judgeRoleFieldWrite } from "../../src/server/owner-scope.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

const APP_ID = "role-field-shop";

/** **面の規則を書かれる側の立場。** 文字列リテラルを JSX の `role=` に直接書かない(a11y 規則)。 */
const EDITOR_ROLE: Role = "editor";

/**
 * 題材。**`items` は3項目**(`name` / `note` / `secret`)。
 *
 * @param roles アプリが宣言する役割(面)。**省略すると面は管轄外(全許可)である**(裁定 `R-4`)。
 *
 * **【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`。上の1行は今日から
 * **項目についてだけ**真である。1バイトも消していない】**
 * **`judgeRoleAccess` の既定が閉じる側へ倒れ、`table` / `view` / `action` は規則が1本も
 * 無ければ拒否される**(`field` だけが今日どおり全許可。台帳 `T-G1b` = 却下)。
 * **役割を1つも宣言していないアプリも閉じる。** **本ファイルは項目(1)とボタンの壁(2)を
 * 測るので、(1) 側の既定は動いておらず、(2) 側の既定だけが反転した**
 * (**(2a) の3本目の期待値を反転させ、旧の逐語をその場に残した**)。
 */
function manifest(roles?: Manifest["app"]["roles"]): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "面の項目",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "name", name: "備品名", type: "text", required: true },
            { id: "note", name: "備考", type: "long_text" },
            { id: "secret", name: "原価", type: "number" },
          ],
        },
      ],
      views: [
        {
          id: "item-list",
          type: "list_view",
          table: "items",
          columns: ["name"],
          actions: [
            { id: "new-item", name: "新規作成", form: "item-form", prefill: { field: "name" } },
          ],
        },
        { id: "item-form", type: "form", table: "items", fields: ["name", "note", "secret"] },
      ],
      ...(roles === undefined ? {} : { roles }),
    },
  };
}

function formView(source: Manifest): FormView {
  const view = source.app.views.find((candidate) => candidate.id === "item-form");
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken: form view がない");
  }
  return view;
}

function renderForm(source: Manifest, role: Role) {
  return render(
    <RoleProvider role={role}>
      <FormRenderer appId={APP_ID} manifest={source} view={formView(source)} />
    </RoleProvider>,
  );
}

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// (1) 面が「書けない」と決めた項目の入力欄
// ---------------------------------------------------------------------------

/**
 * **`editor` は `secret` を読めるが書けない。** 規則が名指しした項目は allow-list になり、
 * `can` に書かれていない動詞は許されない(`J-G2` = 引き算の値域は1つも無い)。
 */
function fieldRuleManifest(): Manifest {
  return manifest([
    {
      id: "editor",
      name: "編集者",
      rules: [
        { target: "field", table: "items", field: "secret", can: ["read"] },
        // **【`V8-M26`(2026-08-10)。ユーザ決定 `D-V8-45` / `D-V8-65`】この1本を足した。**
        // **`judgeRoleAccess` の既定が閉じる側へ倒れたので、`item-list` のボタン
        // `new-item`(書き先 = `items` への作成)を誰も名指ししていないと、
        // `isRoleActionWriteAllowed` の壁が `editor` を止め、`form` が「閲覧のみ」に落ちる。**
        // **それでは (1b) の主題(**項目**の入力欄が減ること)を測る前に保存ボタンの側で
        // 落ちてしまう** —— **足すのはこのボタン1本 × 読取だけであり、`secret` の
        // 書込を許す規則は1本も足していない**(そこが主題である)。
        { target: "action", view: "item-list", action: "new-item", can: ["read"] },
      ],
    },
  ]);
}

test("(1a) サーバは editor の secret への書込を拒む(表示層が一致させるべき判断)", () => {
  const source = fieldRuleManifest();
  const table = source.app.tables[0];
  expect(
    judgeRoleFieldWrite({
      manifest: source,
      table,
      values: { name: "机", secret: 1000 },
      roles: EDITOR_ROLE,
    }),
  ).toEqual({ kind: "denied", fields: ["secret"] });
  // **書ける項目だけなら通る** —— 壁が項目単位であることの裏取り。
  expect(
    judgeRoleFieldWrite({
      manifest: source,
      table,
      values: { name: "机" },
      roles: EDITOR_ROLE,
    }),
  ).toEqual({ kind: "allowed" });
});

test("(1b) form に、面が書込を許していない項目の入力欄を描かない", async () => {
  renderForm(fieldRuleManifest(), EDITOR_ROLE);
  await waitFor(() => {
    expect(screen.getByTestId("field-label-name")).toBeDefined();
  });
  expect(screen.getByTestId("field-label-note")).toBeDefined();
  // **着手前はここが描かれており、保存すると要求全体が 403 になっていた。**
  // **要素そのものを `toBeNull()` に渡さない** —— 赤のときに DOM ノード全体が出力へ展開され、
  // 出力が数十MBになって `bun test` が終わらなくなる(実測した)。**件数で見る。**
  expect(screen.queryAllByTestId("field-label-secret").length).toBe(0);
  // **保存ボタンは消えない** —— 書ける項目が残っているので、保存そのものは通る。
  expect(screen.queryAllByTestId("form-read-only").length).toBe(0);
});

test("(1c) 面の規則を1本も書いていないアプリの form は1項目も減らない(既定を動かしていない)", async () => {
  renderForm(manifest(), EDITOR_ROLE);
  await waitFor(() => {
    expect(screen.getByTestId("field-label-name")).toBeDefined();
  });
  expect(screen.getByTestId("field-label-note")).toBeDefined();
  expect(screen.getByTestId("field-label-secret")).toBeDefined();
});

// ---------------------------------------------------------------------------
// (2) 面のボタンの規則が立てた「表 × 書込の種類」の壁
// ---------------------------------------------------------------------------

/**
 * **`viewer` だけがボタン `new-item` を名指しされている。**
 * そのボタンの書き先は `item-form` の表 `items`・種類は作成なので、
 * **`items` への作成は「そのボタンを読める相手」だけに許される**(`J-G9`)。
 */
function actionRuleManifest(): Manifest {
  return manifest([
    {
      id: "viewer",
      name: "閲覧者",
      rules: [{ target: "action", view: "item-list", action: "new-item", can: ["read"] }],
    },
  ]);
}

test("(2a) サーバは editor の items への作成を壁で止める(表示層が一致させるべき判断)", () => {
  const source = actionRuleManifest();
  expect(isRoleActionWriteAllowed(source, "items", "create", EDITOR_ROLE)).toBe(false);
  // **名指しされた相手は通る。** **壁が「相手ごと」であることの裏取り。**
  expect(isRoleActionWriteAllowed(source, "items", "create", "viewer")).toBe(true);
  // **規則を1本も書いていないアプリでは壁が立たない**(裁定 `R-4`)。
  //
  // **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65` で期待値を反転させた。
  //   上の1行を1バイトも消していない】**
  // **旧の期待値(逐語)**:
  //   `expect(isRoleActionWriteAllowed(manifest(), "items", "create", EDITOR_ROLE)).toBe(true);`
  // **今日**: **`isRoleActionWriteAllowed` は `judgeRoleAccess(...).governed` を見て壁を
  // 立てるかどうかを決める**(`src/server/owner-scope.ts:3454`)。
  // **`V8-M26-T03` が既定を閉じる側へ倒し、`target: "action"` は規則が1本も無くても
  // `governed: true`(閉じる側の管轄内)で返るようになったので、
  // **識別子つきの操作起点があるだけで壁が立ち、名指しされていない相手は止まる。**
  // **役割を1つも宣言していないアプリも同じである**(`D-V8-65`)。
  // **【禁止の履行】これを「同じ挙動を保った」と書かない。裁定 `R-4` の向きは反転した。**
  // **【誇張しない】識別子(`view_action.id`)を持たない起点は今日も壁の材料にならない** ——
  // **閉じたのは「名指しできるのに名指しされていない」ボタンだけである。**
  expect(isRoleActionWriteAllowed(manifest(), "items", "create", EDITOR_ROLE)).toBe(false);
});

test("(2b) 壁で止まる相手に保存ボタンを出さない(押せば必ず 403 になる導線を消す)", async () => {
  renderForm(actionRuleManifest(), EDITOR_ROLE);
  await waitFor(() => {
    expect(screen.getByTestId("field-label-name")).toBeDefined();
  });
  // **着手前はここに保存ボタンが出ており、押すと必ず 403 だった。**
  expect(screen.queryAllByText("保存").length).toBe(0);
  expect(screen.getByTestId("form-read-only")).toBeDefined();
});

test("(2c) 壁を通る相手には今日どおり保存ボタンが出る", async () => {
  const viewerRole: Role = "viewer";
  renderForm(actionRuleManifest(), viewerRole);
  await waitFor(() => {
    expect(screen.getByTestId("field-label-name")).toBeDefined();
  });
  // **`viewer` はボタンの規則を通るが、固定ロールの層(`canWriteRole`)が今日どおり書込を止める**
  // —— **面は「足すことしかできない」ので、`viewer` の書込不可は1ミリも解けていない**(`J-G2`)。
  // **ここで測っているのは「面の壁で消えたのではない」ことである。**
  expect(screen.getByTestId("form-read-only")).toBeDefined();
});
