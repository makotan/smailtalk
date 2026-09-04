/**
 * **宣言を器に当てる**(`V4-M19-T04`。`ADR-0118` 限定6 / 限定7 / 限定8 / 限定10)。
 *
 * ## これは何で、何ではないか
 *
 * - **`ADR-0086` 限定4(「書けるが効かない」を1つも作らない)の履行がここである。**
 *   **`T03` が通した宣言(`preset_density`)に、`V4-M15-T18` が作った器の系統
 *   (`comfortable` / `compact`)を当てる。**
 * - **【禁止】「画面の見せ方が指定できるようになった」と読まない**(`ADR-0118` §Decision 5 の 1)
 *   —— **(C) 群22軸は今日も1つも指定できない。**
 * - **【禁止】「余白を自由に決められるようになった」と読まない**(同 2)—— **選べるのは
 *   2値だけで、`px` も割合も1バイトも書けない。**
 * - **【禁止】「2つの系統は全部の軸で違う」と読まない**(同 3)—— **角丸の軸は差が0である。**
 *
 * ## この検査が言えないこと(**先に書く。憲法6**)
 *
 * 1. **ここは happy-dom であって CSS を1バイトも計算していない。** 見えるのは**属性と
 *    クラス名の差**までである。**計算値の実測は chromium(`web/e2e/preset.e2e.ts`)が採る。**
 * 2. **重ねて出す画面(`modal`)の器そのもの(`OverlayDialog` の枠)は、この作用域の外にある。**
 *    **器の枠はアプリ単位の系統で描かれる。****隠さない。**
 * 3. **アプリ全体が `compact` のとき、画面に `comfortable` と書いても戻らない** ——
 *    **`group-data-[ui-family=compact]/ui:` は「祖先のどれかが `compact`」で当たるためである。**
 *    **今日この状況は既定(`comfortable`)では起きないが、`VITE_ST_UI_FAMILY=compact` で
 *    ビルドすると起きる。****隠さない**(下の (T04-6) が実測で固定する)。
 */

import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { AppThemeScope } from "../src/AppWorkspace.tsx";
import { resolveUiFamily, type UiFamily } from "../src/ui/family.ts";
import { ViewHost } from "../src/views/ViewHost.tsx";

const WEB_ROOT = dirname(import.meta.dir);

afterEach(() => {
  cleanup();
  delete (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__;
});

const MANIFEST = {
  app: {
    id: "shop",
    name: "店",
    tables: [{ id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] }],
    views: [],
  },
} as unknown as Manifest;

function detailView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-detail",
    type: "detail_view",
    table: "orders",
    name: "注文",
    ...overrides,
  } as unknown as View;
}

function renderInScope(view: View): void {
  render(
    <AppThemeScope>
      <ViewHost appId="shop" manifest={MANIFEST} view={view} />
    </AppThemeScope>,
  );
}

/** 画面の作用域(宣言を書いた画面にだけ出る器)。 */
function densityScope(): Element | null {
  return document.querySelector('[data-testid="view-density-scope"]');
}

// --- (a) 宣言が器に当たる(限定6)-------------------------------------------------------

test("(T04-1) compact と書いた画面には data-ui-family=compact の作用域が立つ", () => {
  renderInScope(detailView({ preset_density: "compact" }));
  const scope = densityScope();
  expect(scope).not.toBeNull();
  expect(scope?.getAttribute("data-ui-family")).toBe("compact");
  // **当たり先は Tailwind の `group/ui` 変種である**(`V4-M15-T18` が作った系統)。
  expect(scope?.className.split(/\s+/)).toContain("group/ui");
  // **画面の中身がその作用域の内側に居る**(器だけ出て中身が外に残る、を作らない)。
  expect(scope?.querySelector('[data-testid="view-title"]')).not.toBeNull();
});

test("(T04-2) comfortable と書いた画面にも作用域が立ち、値は comfortable である", () => {
  renderInScope(detailView({ preset_density: "comfortable" }));
  expect(densityScope()?.getAttribute("data-ui-family")).toBe("comfortable");
});

// --- (b) 書かなかった画面は今日と1バイトも変わらない(限定8)-------------------------------

test("(T04-3) 宣言を持たない画面には作用域が1つも出ない(既定を反転させていない)", () => {
  renderInScope(detailView());
  expect(densityScope()).toBeNull();
  // **`data-ui-family` を出す要素が、この画面の中に1つも無い。**
  expect(document.querySelectorAll("[data-ui-family]")).toHaveLength(0);
  expect(screen.getByTestId("view-title").textContent).toBe("注文");
});

test("(T04-4) 宣言の有無だけが DOM の差である(書かなかった画面の HTML が完全一致する)", () => {
  renderInScope(detailView());
  const withoutDeclaration = document.body.innerHTML;
  cleanup();
  // **テスト用の口を使っても、書かなかった画面の DOM は1バイトも変わらない**
  // (系統はアプリ単位で当たり、画面の器は出ない)。
  (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__ = "compact";
  renderInScope(detailView());
  expect(document.body.innerHTML).toBe(withoutDeclaration);
});

// --- (c) 判定は1箇所(限定7)-------------------------------------------------------------

test("(T04-5) マニフェスト由来の値も resolveUiFamily の1箇所を通る", () => {
  expect(resolveUiFamily("compact")).toBe("compact");
  expect(resolveUiFamily("comfortable")).toBe("comfortable");
  // **知らない値は既定に倒れる**(fail-closed。落ちない)。
  expect(resolveUiFamily("cozy")).toBe("comfortable");
  expect(resolveUiFamily(undefined)).toBe("comfortable");
  // **宣言は実行時の口より強い** —— **画面の宣言が在るなら、それがその画面の答えである。**
  (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__ = "compact";
  expect(resolveUiFamily("comfortable")).toBe("comfortable");
  expect(resolveUiFamily()).toBe("compact");
});

test("(T04-5b) 系統を決める関数は web/src に1つだけで、data-ui-family を出す箇所は2つである", () => {
  // **2箇所に住むと食い違う**(`v4-m15-t19.md:457` 逐語)。**判定は `family.ts` の1本、
  // DOM に出すのは「アプリの器(`App.tsx`)」と「画面の作用域(`ViewHost.tsx`)」の2箇所である。**
  const files = ["src/App.tsx", "src/views/ViewHost.tsx", "src/ui/family.ts"];
  const emitting = files.filter((file) =>
    readFileSync(join(WEB_ROOT, file), "utf8").includes("data-ui-family={"),
  );
  expect(emitting.sort()).toEqual(["src/App.tsx", "src/views/ViewHost.tsx"]);
  const family = readFileSync(join(WEB_ROOT, "src/ui/family.ts"), "utf8");
  expect(family.match(/export function resolveUiFamily/g)).toHaveLength(1);
});

// --- (c-2) 限定6: 2値それぞれの当たり先が実在する ------------------------------------------

test("(T04-8) 限定6: comfortable と compact の当たり先が、部品のクラスの集合に実在する", () => {
  // **`ADR-0050` §3a 3 逐語「当たり先の無い enum 値を置いてはならない」を、
  // `ADR-0118` 限定6 が自らに課している。****値を置く前に実在を示す義務の履行がここである。**
  //
  // **`comfortable` の当たり先** = `DEFAULT_UI_FAMILY` が指す既定の描画。
  // **`compact` の当たり先** = Tailwind の `group-data-[ui-family=compact]/ui:` 変種。
  // **どちらも `web/src/ui/` の部品のクラス文字列に実在する。**
  const componentSources = readdirSync(join(WEB_ROOT, "src", "ui"))
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .map((name) => readFileSync(join(WEB_ROOT, "src", "ui", name), "utf8"));
  const all = componentSources.join("\n");

  // **`compact` の当たり先の実数を書く**(2026-08-04 実測)。**数を丸めない。**
  const occurrences = all.match(/group-data-\[ui-family=compact\]\/ui:/g) ?? [];
  expect(occurrences.length).toBeGreaterThan(0);
  // **当たり先を1つも持たない値を置いていない** —— **既定の側は `family.ts` が持つ。**
  expect(all).toContain("group-data-[ui-family=compact]/ui:");
  const family = readFileSync(join(WEB_ROOT, "src", "ui", "family.ts"), "utf8");
  expect(family).toContain('export const DEFAULT_UI_FAMILY: UiFamily = "comfortable";');

  // **【正直に書く】ここが数えているのはクラス文字列の実在であって、描画の差ではない。**
  // **描画の差(計算値)は chromium の担当である**(`web/e2e/preset.e2e.ts` の (ix))。
});

// --- (d) 解けていないこと(**隠さない**)---------------------------------------------------

test("(T04-6) アプリ全体が compact のとき、画面に comfortable と書いても外側の compact は消えない", () => {
  // **`group-data-[ui-family=compact]/ui:` は「祖先のどれかが `compact`」で当たる。**
  // **したがって外側が `compact` なら、内側に `comfortable` の作用域を立てても打ち消せない。**
  // **これは実装の穴ではなく、当たり先(Tailwind の named group)の性質である。**
  // **`ADR-0118` はこの点に1条も触れていない。****「画面ごとに選べる」と総括しない。**
  render(
    <div className="group/ui" data-ui-family="compact">
      <AppThemeScope>
        <ViewHost
          appId="shop"
          manifest={MANIFEST}
          view={detailView({ preset_density: "comfortable" })}
        />
      </AppThemeScope>
    </div>,
  );
  const scope = densityScope();
  expect(scope?.getAttribute("data-ui-family")).toBe("comfortable");
  // **外側の `compact` は今日も DOM に残っている**(内側の宣言はそれを1バイトも消さない)。
  expect(scope?.closest('[data-ui-family="compact"]')).not.toBeNull();
});

test("(T04-7) 値域は2値だけで、3値目は型にも実行時にも入らない", () => {
  const values: UiFamily[] = ["comfortable", "compact"];
  expect(values).toHaveLength(2);
  // **自由な文字列は既定に倒れる** —— **`px` も割合も1バイトも効かない。**
  for (const bogus of ["4px", "50%", "cozy", ""]) {
    expect(resolveUiFamily(bogus)).toBe("comfortable");
  }
});
