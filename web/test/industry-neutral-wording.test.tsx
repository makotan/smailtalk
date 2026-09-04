/**
 * `V5-M13`(汎用化の軸・面1): **画面に出る言葉が業種に依存しないこと**の検査。
 *
 * 上位: `docs/plan/v5/04-generalization-baseline.md` §4-1(`G-G1`〜`G-G4`)/
 *       `docs/plan/v5/records/v5-m12.md` §3-1(門A本審査 = **門外(`Δ7`)・`(記録)`・実施する**)/
 *       `docs/plan/v5/records/v5-m13.md`(本タスクの実施記録)。
 *
 * ## この検査が測っているもの・測っていないもの(**先に書く。誇張しない**)
 *
 * - **測っているのは「あらかじめ決めた業種依存語(`INDUSTRY_WORDS`)が、対象の画面要素の
 *   文字列に1件も現れないこと」だけである。**
 * - **これは「業種に依存しない」ことの証明ではない。** 字面を避けて書かれた業種前提は
 *   1件も拾えない(04 §4-1 末尾が同じ限界を先に申告している)。**代理である。**
 * - **対象は 04 §4-1 が名指しした4ファイルが描く要素だけである。** `web/` の全画面を
 *   走査していない。**「画面から EC 特化が消えた」とは書けない**(04 §9 の 2 の禁止)。
 * - **アプリが宣言した文字列(アプリ名・テーブル名・ビュー名)は対象外である** ——
 *   そこに何を書くかはアプリの自由であって、プラットフォームの文言ではない。
 *   したがって検査は**要素を名指しして**当てる(ページ全体には当てない)。
 *
 * ## ロールの表示名について(`G-G4`)
 *
 * **変えるのは値(表示名の文字列)だけで、キー4値を1つも変えない。** キーが動いていない
 * ことを同じファイルで固定する(`ADR-0070` 限定2 の検査欄が指す「4値」は動かない)。
 * **`V5-M17` はここを2度目に触る**(`v5-m12.md` §2-3)—— そのとき本ファイルの
 * 「キーは4値のまま」の検査は作り替えの対象になる。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { FACE1_INDUSTRY_WORDS, findIndustryWords } from "../../scripts/industry-words.ts";
import type { Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import { AccountPanel } from "../src/auth/AccountPanel.tsx";
import { DEFAULT_USER_KIND_LABEL, roleLabels } from "../src/auth/authz.tsx";
import { LoginPage } from "../src/auth/LoginPage.tsx";
import { grantRules, viewRead } from "./role-rules.ts";

const APP_ID = "shop-app";

/**
 * **業種依存語の一覧は `scripts/industry-words.ts` へ切り出した**(`V5-M14-T02`)。
 *
 * **10語は1語も減っていない**(`scripts/industry-words.test.ts` が `toEqual` で固定)。
 * **変わったのは照合器だけである** —— 本ファイルが着手時に持っていた素の `includes` は
 * 「エンドポイント」に含まれる「ポイント」へ誤って当たっていた(`v5-m13.md` §9 の 2 の
 * 自己申告)。**面1 の画面文字列では判定に影響しなかったが、同じ代理をコメントや説明文へ
 * 使う面5(`V5-M14`)では実際に当たる。** 直したので、面1 もその照合器を使う。
 */
function industryWordsIn(text: string): string[] {
  return findIndustryWords(text, FACE1_INDUSTRY_WORDS);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  window.history.replaceState({}, "", "/");
});

// ---------------------------------------------------------------------------
// `G-G1` 登録の導線(`web/src/auth/LoginPage.tsx`)
// ---------------------------------------------------------------------------

describe("G-G1: 登録の導線の文言", () => {
  /** ログイン画面のうち、**プラットフォームが書いた文字列**を持つ要素だけを集める。 */
  function platformTextOfLoginPage(): string {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const ids = [
      "customer-signup",
      "customer-signup-note",
      "customer-passkey-register",
      "customer-password-register",
      "admin-signup-note",
      "passkey-register",
      "password-register",
    ];
    return ids.map((id) => screen.getByTestId(id).textContent ?? "").join("\n");
  }

  test("登録の導線に業種依存語が1件も現れない", () => {
    expect(industryWordsIn(platformTextOfLoginPage())).toEqual([]);
  });

  test("どちらの登録が何になるかは、業種に依存しない言い方で今日も読める", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    const customerNote = screen.getByTestId("customer-signup-note").textContent ?? "";
    const adminNote = screen.getByTestId("admin-signup-note").textContent ?? "";
    // 一般利用者側: 常にその種類になり、運営の画面は開けない(`CUSTOMER_SIGNUP` の resolveRole)。
    expect(customerNote).toContain("一般利用者");
    expect(customerNote).toContain("運営の画面は開けません");
    // 運営側: 最初の1人がオーナー、以降は閲覧者(`ADMIN_SIGNUP` の resolveRole)。
    expect(adminNote).toContain("運営");
    expect(adminNote).toContain("オーナー");
    expect(adminNote).toContain("閲覧者");
  });

  test("登録ボタンの文言が、利用者の種類の表示名と同じ言葉になっている", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    for (const id of ["customer-passkey-register", "customer-password-register"]) {
      expect(screen.getByTestId(id).textContent, id).toContain(DEFAULT_USER_KIND_LABEL);
    }
  });

  test("`data-testid` は6つのまま増減していない(着手前の規律を弱めない)", () => {
    render(<LoginPage appId={APP_ID} onAuthenticated={() => {}} />);
    for (const id of [
      "passkey-login",
      "password-login",
      "customer-passkey-register",
      "customer-password-register",
      "passkey-register",
      "password-register",
    ]) {
      expect(screen.getByTestId(id), id).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// `G-G2` 登録直後の案内(`web/src/AppWorkspace.tsx`)
// ---------------------------------------------------------------------------

/**
 * `st_owner` つきテーブルの form を1本持つアプリ(案内の出る条件を満たす最小形)。
 *
 * **【`V8-M26`。ユーザ決定 `D-V8-45` / `D-V8-65`】面の既定が「閉じる」側へ倒れたので、
 * 規則を1本も持たない題材では `canUseView` が偽になり、案内(`customer-signup-next`)が
 * 1つも描かれない。** **本ファイルの主題は「文言に業種依存語が1件も出ないこと」であって
 * 権限ではないので、題材の側に規則を足して主題を保つ。** **期待値は1文字も変えていない。**
 *
 * **足すのは `member-form` × 読取の1本だけであり、宛先は `customer` 1役割である**
 * (登録の応答が返すロール)。**規則の値は識別子(`member-form`)だけで、検査対象の
 * 文字列に業種依存語を1文字も持ち込まない。**
 */
function manifestWithMemberForm(): Manifest {
  const built: Manifest = {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "member",
          name: "利用者情報",
          fields: [
            { id: "display_name", name: "表示名", type: "text", required: true },
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
      ],
      views: [
        {
          id: "member-form",
          name: "利用者情報の登録",
          type: "form",
          table: "member",
          fields: ["display_name"],
        },
      ],
    },
  };
  return grantRules(built, ["customer"], [viewRead("member-form")]);
}

function anonymousStub(manifest: Manifest): void {
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input).split("?")[0] ?? String(input);
    if (url === `/api/apps/${APP_ID}/auth/me`) {
      return Promise.resolve(
        jsonResponse({ errors: [{ path: "", message: "認証されていません。" }] }, 401),
      );
    }
    if (url === `/api/apps/${APP_ID}/manifest`) return Promise.resolve(jsonResponse(manifest));
    if (url === `/api/apps/${APP_ID}/auth/signup/password/register`) {
      return Promise.resolve(
        jsonResponse({ user: { id: "u-1", username: "riyousha", role: "customer" } }),
      );
    }
    if (url.startsWith(`/api/apps/${APP_ID}/tables/`)) {
      return Promise.resolve(jsonResponse({ records: [], total: 0 }));
    }
    return Promise.resolve(jsonResponse({ errors: [{ path: "", message: url }] }, 404));
  }) as typeof fetch;
}

describe("G-G2: 登録直後の案内", () => {
  test("案内の本文に業種依存語が1件も現れない", async () => {
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    anonymousStub(manifestWithMemberForm());
    render(<App />);
    await screen.findByTestId("customer-password-register");

    fireEvent.change(screen.getByTestId("auth-username"), { target: { value: "riyousha" } });
    fireEvent.change(screen.getByTestId("auth-password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByTestId("customer-password-register"));

    const notice = await screen.findByTestId("customer-signup-next");
    // アプリが宣言したビュー名(「利用者情報の登録」)もこの中に入るが、
    // **業種依存語を含まないアプリ宣言を使っているので、当たったら文言の側である。**
    expect(industryWordsIn(notice.textContent ?? "")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `G-G3` 退会の説明(`web/src/auth/AccountPanel.tsx`)
// ---------------------------------------------------------------------------

describe("G-G3: 退会の説明", () => {
  test("退会の説明に業種依存語が1件も現れない", () => {
    globalThis.fetch = ((_input: RequestInfo | URL) =>
      Promise.resolve(jsonResponse({ ok: true }))) as typeof fetch;
    render(
      <AccountPanel appId={APP_ID} username="alice" onWithdrawn={() => {}} onClose={() => {}} />,
    );
    const note = screen.getByTestId("account-withdraw-note").textContent ?? "";
    expect(industryWordsIn(note)).toEqual([]);
    // **弱めない** —— 「退会すれば個人情報が消える」と読ませないための一文は今日も要る。
    expect(note).toContain("消えません");
  });

  test("退会で何が消えないかを書いた根拠のコメントにも業種依存語が現れない", () => {
    // **画面の文言と同じことをコメントにも書く**というのが `AccountPanel.tsx` の規律
    // (`:17`-`:23`)。**コメントだけ EC のままだと、画面と根拠が食い違う。**
    const source = readFileSync(
      new URL("../src/auth/AccountPanel.tsx", import.meta.url),
      "utf8",
    ).split("\n");
    // モジュールヘッダ(先頭の JSDoc)だけを見る。実装本文のコメントは対象外。
    const headerEnd = source.findIndex((line) => line.trimStart().startsWith("*/"));
    expect(headerEnd).toBeGreaterThan(0);
    const header = source.slice(0, headerEnd + 1).join("\n");
    expect(industryWordsIn(header)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// `G-G4` 利用者の種類の表示名(`web/src/auth/authz.tsx`)
// ---------------------------------------------------------------------------

describe("G-G4: 利用者の種類の表示名", () => {
  test("表示名に業種依存語が1件も現れない", () => {
    for (const [role, label] of Object.entries(roleLabels())) {
      expect(industryWordsIn(label), role).toEqual([]);
    }
  });

  /**
   * **【`V5-M17-T08` で置き換えた。旧テスト名を先に書く】**
   *
   * **旧テスト名**: 「キーは4値のままである(値だけを変えた。`ADR-0070` 限定2 の検査は動かない)」。
   * **旧本体**: `expect(Object.keys(ROLE_LABELS).sort()).toEqual(["customer","editor","owner","viewer"])`。
   *
   * **`v5-m13.md` §7 の 5 はこの検査を「`V5-M17` のところで赤くなる**意図した歯止め**」と
   * 名指ししていた。** **予告どおり赤くなった。**
   * **`ADR-0159` 限定5 の逐語**(「`ROLE_LABELS` の4値と一致」を「`ROLE_VALUES` の運営3値 +
   * 宣言された種類の集合と一致」に置き換える。**検査を削除しない**)**に従って置き換えた。**
   */
  test("キーは「運営3値 + そのアプリの非運営の種類」と一致する(`ADR-0159` 限定5)", () => {
    // **宣言が無いアプリでは、着手前と1つも変わらない4値である。**
    expect(Object.keys(roleLabels()).sort()).toEqual(["customer", "editor", "owner", "viewer"]);
    // **宣言があるアプリでは、`customer` の代わりに宣言された種類が並ぶ。**
    // **【2026-08-11。`V8-M29` 第2波。台帳 `T-G9a`】旧の期待値(逐語)**:
    //     .toEqual(["editor", "member", "owner", "supplier", "viewer"]);
    // **直前の1文(「`customer` の代わりに」)は今日は偽である。1バイトも消していない。**
    // **今日は `customer` が**並んだうえで**宣言された役割が足される。**
    // **【根拠を名指しで書く(メインの裁定3)】**
    // **値域を狭めていたのは `app.user_kinds` の宣言そのものである** ——
    // **`src/server/auth-routes.ts` の旧 `roleValuesForKinds` の逐語**:
    //     return [...RESERVED_ROLES, ...(kinds.length === 0 ? [DEFAULT_USER_KIND] : kinds)];
    // **`kinds` が空でないとき(= 立場を宣言したとき)、`DEFAULT_USER_KIND`(= `customer`)は
    // 戻りに1度も入らなかった。** **その `kinds` の唯一の出所は
    // `src/server/owner-scope.ts` の `effectiveUserKindIds`(= `app.user_kinds` を読む)であり、
    // `V8-M29` 第2波が `app.user_kinds` ごと廃止した。**
    // **代わりに立った `app.roles` は「既定に足す」ことしかできず、既定から引き算する
    // 書き方を1つも持たない**(台帳 `J-G2` の限定「アプリの作者は既定に足すことしか
    // できず、引き算(拒否)を1つも書けない」)。
    // **したがって、宣言の側から値域を狭める手段は今日1つも無い。担い手は無い**
    // (`ADR-0301` 限定6 の ④)。
    // **【禁止の履行】これを「影響は無い」と書かない** —— **実挙動が1つ変わった。**

    expect(
      Object.keys(
        roleLabels([
          { id: "member", name: "会員" },
          { id: "supplier", name: "取引先" },
        ]),
      ).sort(),
    ).toEqual(["customer", "editor", "member", "owner", "supplier", "viewer"]);
    // **運営3ロールは宣言で消せない**(`ADR-0158` 限定1)。
    for (const reserved of ["owner", "editor", "viewer"]) {
      expect(Object.keys(roleLabels([{ id: "member", name: "会員" }]))).toContain(reserved);
    }
  });

  test("宣言が無いときの4つとも空でない表示名を持つ", () => {
    for (const [role, label] of Object.entries(roleLabels())) {
      expect(label.length, role).toBeGreaterThan(0);
    }
  });
});
