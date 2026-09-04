/**
 * プラットフォームが常設する口を、誰に出すか(`V4-M19-T10`)。
 *
 * **門A の判定は「将来送り」であり、本タスクはその送り先の履行である。ADR は無い(台帳1行)。**
 *
 * 対象は3つの口である:
 *
 * 1. **CSV の書き出し**(`web/src/views/ListViewRenderer.tsx` の `CsvCopyCaption` / `CsvCopyBlock`)
 * 2. **要件定義書**(`web/src/AppWorkspace.tsx`)
 * 3. **テーマの持ち出し**(`web/src/AppWorkspace.tsx`)
 *
 * ## 【取り違えないこと】`owner` 限定にしていない
 *
 * `AppWorkspace.tsx` の逐語コメント「**owner 限定にしない。**」(2箇所)は**1バイトも
 * 消していない**。理由(`ADR-0025` §10-2)は「**この画面が叩く API は無認証(ローカル専用)で
 * あり、owner パネルに置くと『UI は owner 限定に見えるが API は誰でも叩ける』という、
 * UI が嘘をつく状態になる**」であり、**その判断は覆っていない** ——
 * **owner / editor / viewer には今日どおり出る。**
 *
 * **足したのは「買い物客(`customer`)と未ログインには出さない」分岐だけである。**
 * **先例はこのリポジトリの中にある** —— `DetailViewRenderer` の「閲覧のみ」の注記が
 * `E-G20` / `V4-M6` で「編集できる想定の人が編集できないときだけ出す」に絞られた
 * (判定は `isWriteAudienceRole`)。**CSV の書き出し・要件定義書・テーマの持ち出しは、
 * まさに管理ツールの口である。**
 *
 * ## このファイルが証明しないこと(先に書く。誇張しない)
 *
 * 1. **遮断を1件も証明しない。** **`customer` が UI を迂回して API を直接叩けば、今日どおり
 *    読める** —— `GET /manifest` / `GET /requirements` は今日も未認証で通り、CSV は
 *    **画面が既に持っている行**を文字列にしているだけである。**UI は担保ではない。**
 * 2. **「アプリが常設の口を選べるようになった」ことを1件も測っていない** —— **選べない**
 *    (`ADR-0007` §1b の Δ4。マニフェストの語彙がプラットフォームの内部機能の名前に依存する)。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ListView, Manifest } from "../../src/kernel/types.ts";
import { App } from "../src/App.tsx";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { ListViewRenderer } from "../src/views/ListViewRenderer.tsx";

const APP_ID = "port-app";
const WEB_SRC = join(import.meta.dir, "..", "src");

/** 運営側のロール(この3つには今日どおり出る)。 */
const ADMIN_ROLES = ["owner", "editor", "viewer"] as const;

/**
 * 買い物客。**定数にしてあるのは、`role` を文字列リテラルで書くと biome の
 * `useValidAriaRole` が ARIA 属性と読んで赤にするためである**(`concurrency.test.tsx` の
 * `WRITE_ROLE` と同じ形)。
 */
const CUSTOMER_ROLE: Role = "customer";

function sampleManifest(): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "サンプル",
      tables: [
        {
          id: "items",
          name: "備品",
          fields: [
            { id: "title", name: "品目", type: "text" },
            // customer から見て「自分の行を持つテーブル」にしておく(画面一覧から消えない)。
            { id: "st_owner", name: "所有者", type: "text" },
          ],
        },
      ],
      views: [{ id: "item-list", type: "list_view", table: "items", columns: ["title"] }],
    },
  } as unknown as Manifest;
}

const ROWS = [{ _id: "r-1", _created_at: "", _updated_at: "", title: "会議テーブル" }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let originalFetch: typeof fetch;
let currentRole: string;

beforeEach(() => {
  currentRole = "owner";
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return jsonResponse({
        user: { id: "u1", username: "alice", displayName: null, role: currentRole },
      });
    }
    if (url.endsWith("/manifest")) {
      return jsonResponse(sampleManifest());
    }
    if (url.includes("/records")) {
      return jsonResponse({ records: ROWS, total: ROWS.length });
    }
    return jsonResponse({ errors: [{ path: "", message: `no stub for ${url}` }] }, 404);
  }) as typeof fetch;
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// (1) CSV の書き出し(一覧の中の口)
// ---------------------------------------------------------------------------

describe("CSV の書き出し(ListViewRenderer)", () => {
  async function renderListAs(role: Role | null): Promise<void> {
    const manifest = sampleManifest();
    const view = manifest.app.views[0] as ListView;
    const list = <ListViewRenderer appId={APP_ID} manifest={manifest} view={view} />;
    render(role === null ? list : <RoleProvider role={role}>{list}</RoleProvider>);
    await waitFor(() => expect(screen.getByTestId("list-table")).toBeDefined());
  }

  for (const role of ADMIN_ROLES) {
    test(`${role} には CSV の書き出しが出る(owner 限定にしていない)`, async () => {
      await renderListAs(role);
      expect(screen.getByTestId("list-csv-copy")).toBeDefined();
    });
  }

  // =====================================================================================
  // **【`V8-M27-T04` / `T-G5`。4本とも期待値を反転させた。旧のテスト名と旧の期待値を
  //   逐語で残す。検査は1本も消していない】**
  //
  // **旧のテスト名と旧の期待値**:
  //   `customer には CSV の書き出しが出ない`
  //       expect(screen.queryByTestId("list-csv-copy")).toBeNull();
  //   `未ログイン(RoleProvider の外)には CSV の書き出しが出ない`
  //       expect(screen.queryByTestId("list-csv-copy")).toBeNull();
  //   `customer の一覧には caption そのものが残らない(空の器を置かない)`
  //       expect(screen.getByTestId("list-table").querySelectorAll("caption")).toHaveLength(0);
  //   `card の器でも同じ判定が当たる(器の形で挙動が割れない)`
  //       expect(screen.queryByTestId("list-csv-copy")).toBeNull();
  //
  // **根拠**: **`V8-M27` / 台帳 `T-G5` / ユーザ決定 `D-V8-38`。**
  // **`isPlatformPortAudience` の中身(`isReservedRole(role)`)は、
  // 「運営の予約3ロールか否か」で出し分ける層の最後の1本だった** —— **層ごと撤去した。**
  //
  // **【正直に書く。これは広がりであって、狭まりではない】**
  // **`V4-M19-T10` が足した「買い物客と未ログインには管理ツールの口を出さない」分岐が
  // 消えた。** **`E-G20` / `V4-M6` の系譜の判断が1つ戻ったことになる。**
  //
  // **なぜ戻したか**: **役割の綴りを使わずに同じ出し分けを書く手だてが、今日の面
  // (`app.roles[].rules`)の語彙に無い** —— **面が名指しできるのは表・画面・ボタン・項目の
  // 4つで、「プラットフォームの常設の口」はそのどれでもない。**
  // **この口を役割で出し分けたいなら、面に5つ目の対象を足す提案として `ADR-0007` の
  // 門A を通すこと。**
  //
  // **【この反転が遮断を1ミリも緩めていないこと(旧 doc の主張は今日も真)】**
  // **CSV は画面が既に持っている行を文字列にしているだけであり、その行はレコードAPI が
  // 返したものである** —— **面が読取を許していない表の行は、そもそも画面に1行も届かない。**
  // **`GET /manifest` / `GET /requirements` が未認証で通ることも、今日どおりである。**
  // =====================================================================================
  test("(反転) customer にも CSV の書き出しが出る(旧: 出なかった)", async () => {
    await renderListAs("customer");
    expect(screen.getByTestId("list-csv-copy")).toBeDefined();
    // 表そのものは今日どおり出る。
    expect(screen.getByTestId("list-table")).toBeDefined();
  });

  test("(反転) 未ログイン(RoleProvider の外)にも CSV の書き出しが出る(旧: 出なかった)", async () => {
    await renderListAs(null);
    expect(screen.getByTestId("list-csv-copy")).toBeDefined();
    expect(screen.getByTestId("list-table")).toBeDefined();
  });

  test("(反転) customer の一覧にも caption が置かれる(旧: 器そのものが残らなかった)", async () => {
    await renderListAs("customer");
    expect(screen.getByTestId("list-table").querySelectorAll("caption")).toHaveLength(1);
  });

  test("(反転) card の器でも同じ判定が当たる(器の形で挙動が割れない)", async () => {
    const manifest = sampleManifest();
    const view = manifest.app.views[0] as ListView;
    view.preset_list_shape = "card";
    render(
      <RoleProvider role={CUSTOMER_ROLE}>
        <ListViewRenderer appId={APP_ID} manifest={manifest} view={view} />
      </RoleProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("list-cards")).toBeDefined());
    // **旧は `toBeNull()` だった。** **器の形で挙動が割れないという主題は1ミリも
    // 変わっておらず、両方の器で「出る」側に揃った。**
    expect(screen.getByTestId("list-csv-copy")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (2)(3) 要件定義書 / テーマの持ち出し(AppWorkspace の通常導線)
// ---------------------------------------------------------------------------

describe("要件定義書とテーマの持ち出し(AppWorkspace)", () => {
  async function renderAppAs(role: string): Promise<void> {
    currentRole = role;
    window.history.replaceState({}, "", `/apps/${APP_ID}`);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("workspace-main")).toBeDefined());
  }

  for (const role of ADMIN_ROLES) {
    test(`${role} には要件定義書とテーマの持ち出しが出る(owner 限定にしていない)`, async () => {
      await renderAppAs(role);
      expect(screen.getByTestId("open-requirements-doc")).toBeDefined();
      expect(screen.getByTestId("open-theme-export")).toBeDefined();
    });
  }

  // **【`V8-M27-T04` / `T-G5`。2本とも期待値を反転させた。旧のテスト名と旧の期待値を残す】**
  // **旧のテスト名と旧の期待値**:
  //   `customer には要件定義書もテーマの持ち出しも出ない`
  //       expect(screen.queryByTestId("open-requirements-doc")).toBeNull();
  //       expect(screen.queryByTestId("open-theme-export")).toBeNull();
  //   `customer には通常導線の器そのものが残らない(空の器を置かない)`
  //       expect(screen.queryByTestId("workspace-links")).toBeNull();
  // **根拠は1つ上の describe と同じである**(`platformPortAudience` の撤去)。
  test("(反転) customer にも要件定義書とテーマの持ち出しが出る(旧: 出なかった)", async () => {
    await renderAppAs("customer");
    expect(screen.getByTestId("open-requirements-doc")).toBeDefined();
    expect(screen.getByTestId("open-theme-export")).toBeDefined();
  });

  test("(反転) customer にも通常導線の器が残る(旧: 器そのものが残らなかった)", async () => {
    await renderAppAs("customer");
    expect(screen.getByTestId("workspace-links")).toBeDefined();
    // 画面の他の部分は今日どおりである。
    expect(screen.getByTestId("view-list")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// (4) 覆していないこと・解けないことがソースに書いてある
// ---------------------------------------------------------------------------

describe("判断の記録(ソースを読む)", () => {
  const workspace = readFileSync(join(WEB_SRC, "AppWorkspace.tsx"), "utf-8");
  const renderer = readFileSync(join(WEB_SRC, "views", "ListViewRenderer.tsx"), "utf-8");

  test("「owner 限定にしない。」の逐語が2箇所とも残っている(1バイトも消していない)", () => {
    expect(workspace.match(/owner 限定にしない。/g)).toHaveLength(2);
  });

  test("覆していないことと、UI が担保でないことが両方のファイルに書いてある", () => {
    for (const [name, source] of [
      ["AppWorkspace.tsx", workspace],
      ["ListViewRenderer.tsx", renderer],
    ] as const) {
      expect(source.includes("UI は担保ではない。"), name).toBe(true);
      expect(source.includes("`ADR-0007` §1b の Δ4"), name).toBe(true);
    }
    expect(workspace).toContain("覆していない");
  });

  test("判定の式が同じ形で、互いを名指ししている(共有関数を作っていない)", () => {
    expect(workspace).toContain("ListViewRenderer.tsx");
    expect(renderer).toContain("AppWorkspace.tsx");
    // **`web/src/auth/authz.tsx` に新しい述語を1つも足していない。**
    const authz = readFileSync(join(WEB_SRC, "auth", "authz.tsx"), "utf-8");
    expect(authz).not.toContain("PlatformPort");
    expect(authz).not.toContain("platformPort");
  });
});
