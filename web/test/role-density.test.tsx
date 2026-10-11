/**
 * **役割ごとの詰め具合を画面の器に当てる**(`V20-M11-T03`。`ADR-0464` 限定5。
 * ユーザ決定 `D-V20-34`「画面の指定が勝つ」/ `D-V20-35`「詰め具合だけ」)。
 *
 * ## この検査が測るもの(**先に書く**)
 *
 * 1. **役割に `density: "compact"` を書いたアプリで、詰め具合を書いていない画面を
 *    その役割の人が開くと、画面の作用域が `compact` で立つこと。**
 * 2. **画面に `preset_density: "comfortable"` を書いた画面では、役割が `compact` でも
 *    `comfortable` のままであること**(`D-V20-34`)。
 * 3. **役割に詰め具合を書いていない(または宣言の無い役割 / 未ログインの)人には、
 *    作用域が1つも出ず、DOM が今日と1バイトも変わらないこと**(`ADR-0118` 限定8)。
 * 4. **集計表(`report_view`)は今日どおり作用域の外であること。**
 * 5. **判定は `resolveUiFamily` の1箇所で、読む順は 画面の宣言 → 役割の宣言 → テスト用の口 →
 *    環境変数 → 既定 であること。**
 * 6. **役割の見せ方を導く関数(接頭辞 `resolveRoleDisplay`)は `web/src` と `src` を通して
 *    1本ちょうどであること**(`ADR-0464` 限定5。常設の見張り)。
 *
 * ## この検査が言えないこと(**憲法6**)
 *
 * 1. **happy-dom は CSS を1バイトも計算しない。** **計算値(ボタンの高さ・色が変わらないこと)は
 *    chromium の担当である。**
 * 2. **画面が見る役割は `useRole()` の1つ(アカウントの役割)だけである。** **付与表だけで持つ
 *    2本目以降の役割は見ない。**
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { AppThemeScope } from "../src/AppWorkspace.tsx";
import { RoleProvider } from "../src/auth/authz.tsx";
import { resolveRoleDisplayDensity, resolveUiFamily } from "../src/ui/family.ts";
import { ViewHost } from "../src/views/ViewHost.tsx";

const WEB_ROOT = dirname(import.meta.dir);
const APP_ROOT = dirname(WEB_ROOT);

afterEach(() => {
  cleanup();
  delete (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__;
});

function manifestWithRoles(roles: unknown[] | undefined): Manifest {
  return {
    app: {
      id: "shop",
      name: "店",
      tables: [
        { id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] },
      ],
      views: [],
      ...(roles === undefined ? {} : { roles }),
    },
  } as unknown as Manifest;
}

const ROLES = [
  { id: "owner" },
  { id: "editor", density: "compact" },
  { id: "customer", name: "お客様" },
];

function detailView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-detail",
    type: "detail_view",
    table: "orders",
    name: "注文",
    ...overrides,
  } as unknown as View;
}

function renderAs(role: string | null, manifest: Manifest, view: View): void {
  const host = (
    <AppThemeScope>
      <ViewHost appId="shop" manifest={manifest} view={view} />
    </AppThemeScope>
  );
  render(role === null ? host : <RoleProvider role={role}>{host}</RoleProvider>);
}

function densityScope(): Element | null {
  return document.querySelector('[data-testid="view-density-scope"]');
}

// --- (a) 役割の宣言が、宣言の無い画面に当たる ----------------------------------------------

describe("(R-1) 役割の詰め具合は、詰め具合を書いていない画面に当たる", () => {
  test("役割 compact の人が宣言の無い画面を開くと、作用域が compact で立つ", () => {
    renderAs("editor", manifestWithRoles(ROLES), detailView());
    const scope = densityScope();
    expect(scope).not.toBeNull();
    expect(scope?.getAttribute("data-ui-family")).toBe("compact");
    expect(scope?.className.split(/\s+/)).toContain("group/ui");
    expect(scope?.querySelector('[data-testid="view-title"]')).not.toBeNull();
  });

  test("画面に comfortable と書いた画面では、役割が compact でも comfortable である(画面の指定が勝つ)", () => {
    renderAs("editor", manifestWithRoles(ROLES), detailView({ preset_density: "comfortable" }));
    expect(densityScope()?.getAttribute("data-ui-family")).toBe("comfortable");
  });

  test("画面に compact と書いた画面は、役割に宣言の無い人でも今日どおり compact である", () => {
    renderAs("customer", manifestWithRoles(ROLES), detailView({ preset_density: "compact" }));
    expect(densityScope()?.getAttribute("data-ui-family")).toBe("compact");
  });
});

// --- (b) 宣言の無い人には今日と1バイトも変わらない -----------------------------------------

describe("(R-2) 役割に詰め具合が無ければ DOM は今日と1バイトも変わらない", () => {
  test("役割に density を書いていない人には作用域が1つも出ず、HTML が役割の一覧の無いアプリと完全一致する", () => {
    renderAs("customer", manifestWithRoles(undefined), detailView());
    const withoutRoles = document.body.innerHTML;
    expect(densityScope()).toBeNull();
    cleanup();
    renderAs("customer", manifestWithRoles(ROLES), detailView());
    expect(densityScope()).toBeNull();
    expect(document.querySelectorAll("[data-ui-family]")).toHaveLength(0);
    expect(document.body.innerHTML).toBe(withoutRoles);
  });

  test("役割の一覧に無い役割の人(未知の役割)には作用域が出ない", () => {
    renderAs("staff", manifestWithRoles(ROLES), detailView());
    expect(densityScope()).toBeNull();
  });

  test("未ログイン(役割が null)には作用域が出ない", () => {
    renderAs(null, manifestWithRoles(ROLES), detailView());
    expect(densityScope()).toBeNull();
  });

  test("値域の外の値が役割に入っていても作用域は出ない(落ちない)", () => {
    renderAs("editor", manifestWithRoles([{ id: "editor", density: "cozy" }]), detailView());
    expect(densityScope()).toBeNull();
  });

  test("集計表(report_view)は役割が compact でも作用域の外である", () => {
    renderAs("editor", manifestWithRoles(ROLES), {
      id: "sales",
      type: "report_view",
      table: "orders",
      name: "売上",
      report: { group_by: [{ field: "memo" }], aggregates: [{ type: "count" }] },
    } as unknown as View);
    expect(densityScope()).toBeNull();
  });
});

// --- (c) 判定は1箇所で、読む順が決まっている ---------------------------------------------

describe("(R-3) 判定は resolveUiFamily の1箇所である", () => {
  test("読む順は 画面の宣言 → 役割の宣言 → テスト用の口 → 既定", () => {
    expect(resolveUiFamily(undefined, "compact")).toBe("compact");
    expect(resolveUiFamily("comfortable", "compact")).toBe("comfortable");
    expect(resolveUiFamily("compact", "comfortable")).toBe("compact");
    (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__ = "compact";
    // **役割の宣言はテスト用の口より強い。**
    expect(resolveUiFamily(undefined, "comfortable")).toBe("comfortable");
    // **役割の値が値域の外なら、テスト用の口へ落ちる。**
    expect(resolveUiFamily(undefined, "cozy")).toBe("compact");
    expect(resolveUiFamily()).toBe("compact");
  });

  test("resolveRoleDisplayDensity は役割 id が一致する要素の density を返すだけである", () => {
    expect(resolveRoleDisplayDensity(ROLES, "editor")).toBe("compact");
    expect(resolveRoleDisplayDensity(ROLES, "customer")).toBeUndefined();
    expect(resolveRoleDisplayDensity(ROLES, "staff")).toBeUndefined();
    expect(resolveRoleDisplayDensity(ROLES, null)).toBeUndefined();
    expect(resolveRoleDisplayDensity(undefined, "editor")).toBeUndefined();
    expect(resolveRoleDisplayDensity([{ id: "editor", density: "4px" }], "editor")).toBeUndefined();
    expect(resolveRoleDisplayDensity([{ id: "editor", density: "comfortable" }], "editor")).toBe(
      "comfortable",
    );
  });
});

// --- (d) 常設の見張り(`ADR-0464` 限定5)-------------------------------------------------

function sourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      out.push(path);
    }
  }
  return out;
}

describe("(R-4) 見せ方を導く箇所は1本ちょうど", () => {
  test("接頭辞 resolveRoleDisplay で始まる関数(function と const/let/var)は web/src と src で1本ちょうどである", () => {
    // **`ADR-0464` 限定5 の式5 と同じ正規表現**(注釈の中も数える)。
    const pattern = /(?:function|const|let|var)\s+(resolveRoleDisplay[A-Za-z0-9_]*)/g;
    const found: string[] = [];
    for (const root of [join(APP_ROOT, "src"), join(WEB_ROOT, "src")]) {
      for (const file of sourceFiles(root)) {
        for (const match of readFileSync(file, "utf8").matchAll(pattern)) {
          found.push(`${file.slice(APP_ROOT.length + 1)}:${match[1]}`);
        }
      }
    }
    expect(found).toEqual(["web/src/ui/family.ts:resolveRoleDisplayDensity"]);
  });

  test("data-ui-family を DOM に出す箇所は web/src 全体で3つのままである", () => {
    const emitting: string[] = [];
    for (const file of sourceFiles(join(WEB_ROOT, "src"))) {
      const count = readFileSync(file, "utf8").split("data-ui-family={").length - 1;
      for (let i = 0; i < count; i += 1) {
        emitting.push(file.slice(WEB_ROOT.length + 1));
      }
    }
    expect(emitting.sort()).toEqual([
      "src/App.tsx",
      "src/runner-app.tsx",
      "src/views/ViewHost.tsx",
    ]);
  });
});

// --- (R-5) V20-M11 の点検の処置(中3 / 軽5)の常設の見張り -----------------------------------

describe("(R-5) 役割を読む口と説明書の density の説明", () => {
  /**
   * **中3(条件10)**: `useRole()` を呼ぶファイル(定義の `authz.tsx:179` の `function useRole()` を除く。
   * 注釈の行 = 先頭が `*` / `//` / `/*` の行を除く)は `web/src` で6つちょうど。
   * **この見張りは呼ぶファイルの集合だけを見る** —— 同じ働きを別の綴りで写したもの
   * (インラインの写し・スプレッドで出す属性)は捕まえない(穴として `unfixed-holes.md` に記した)。
   */
  test("useRole() を呼ぶファイルは web/src で6つちょうどである(定義と注釈を除く)", () => {
    const callers = new Set<string>();
    for (const file of sourceFiles(join(WEB_ROOT, "src"))) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) {
          continue;
        }
        if (/function\s+useRole\s*\(/.test(line)) {
          continue;
        }
        if (/\buseRole\(\)/.test(line)) {
          callers.add(file.slice(WEB_ROOT.length + 1));
        }
      }
    }
    expect([...callers].sort()).toEqual([
      "src/CommentPanel.tsx",
      "src/auth/authz.tsx",
      "src/views/DetailViewRenderer.tsx",
      "src/views/FormRenderer.tsx",
      "src/views/ListViewRenderer.tsx",
      "src/views/ViewHost.tsx",
    ]);
  });

  /**
   * **軽5**: 説明書の一覧に `density` の名前が残っていても、説明の文を消すと気づかなかった。
   * 説明の要の文を逐語で見張る(効かない先の1文を含む)。
   */
  test("view-shape の説明書が役割の density を説明する文を持つ", () => {
    const skill = readFileSync(
      join(APP_ROOT, "plugins", "smailtalk", "skills", "view-shape", "SKILL.md"),
      "utf8",
    );
    for (const phrase of [
      "**`density` は、その役割の人が開く画面の詰め具合である。**",
      "書ける値は `comfortable`(ゆったり)と `compact`(詰めて)の2つだけ",
      "**画面に `preset_density` を書いた画面では、画面の側が勝つ**",
      "**未ログイン(`anonymous`)には書けない。**",
      "**変わるのは詰め具合だけで、色は1つも変わらない。**",
      "**集計表の画面と、上端の帯やメニューには効かない。効くのはその人のアカウントの役割1つである**",
    ]) {
      expect(skill, phrase).toContain(phrase);
    }
  });
});
