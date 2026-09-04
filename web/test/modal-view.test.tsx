/**
 * **宣言を器に当てる**(`V4-M18-T04`。`ADR-0095` 限定3 / 限定8 / 限定9)。
 *
 * ## これは何で、何ではないか
 *
 * - **`ADR-0086` 限定4(「書けるが効かない」を1つも作らない)の履行がここである。**
 *   **`T03` が通した宣言(`modal`)に、`T01` が作った器(`OverlayDialog`)を当てる。**
 * - **【禁止】「重ねて出す画面を自由に作れる」と読まない** —— **`type` が `form` で
 *   `menu_listed` を偽にした画面だけである**(`ADR-0095` 限定4 / 限定5。機械的に止めるのは
 *   `schemas/` 側で、実測は `src/kernel/modal-view.test.ts` が持つ)。
 * - **【禁止】「大きさや位置を選べる」と読まない** —— **選べない**(限定2)。
 *
 * ## この検査が言えないこと(**先に書く。憲法6**)
 *
 * 1. **ここは happy-dom であって CSS を1バイトも計算していない。** **「実際に今の画面の上に
 *    重なって見えるか」は測っていない** —— chromium の実測は `web/e2e/overlay.e2e.ts` が採る。
 * 2. **閉じたあとどこへ戻るかは、履歴に依存する。** **履歴が無い状態(URL を直接開いた場合)で
 *    閉じると、この製品は1ミリも動かない**(下の (T04-5))。**それを「戻れる」と書かない。**
 */

import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Manifest, View } from "../../src/kernel/types.ts";
import { AppThemeScope } from "../src/AppWorkspace.tsx";
import { ViewHost } from "../src/views/ViewHost.tsx";

afterEach(() => {
  cleanup();
});

const MANIFEST = {
  app: {
    id: "shop",
    name: "店",
    tables: [{ id: "orders", name: "注文", fields: [{ id: "memo", name: "メモ", type: "text" }] }],
    views: [],
  },
} as unknown as Manifest;

function formView(overrides: Record<string, unknown> = {}): View {
  return {
    id: "order-form",
    type: "form",
    table: "orders",
    fields: ["memo"],
    name: "注文する",
    ...overrides,
  } as unknown as View;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

/**
 * **アプリ単位テーマのスコープごと描く**(`V4-M18-T04`)。
 *
 * **これが製品の実際の形である** —— `AppWorkspace` は `AppThemeScope`(`.app-theme`)の
 * 内側に `ViewHost` を置く。**器の差し込み先はその要素であって `document.body` ではない**
 * (`document.body` へ差すとアプリのテーマも逃げ道 CSS も1つも届かない。chromium で実測)。
 */
function renderInScope(view: View): void {
  render(
    <AppThemeScope>
      <ViewHost appId="shop" manifest={MANIFEST} view={view} />
    </AppThemeScope>,
  );
}

test("(T04-1) 宣言を持つ form は role=dialog の器の中に描かれる", async () => {
  renderInScope(formView({ modal: true, menu_listed: false }));
  await settle();
  const popup = document.querySelector('[data-slot="overlay-dialog"]');
  expect(popup).not.toBeNull();
  expect(popup?.getAttribute("role")).toBe("dialog");
  expect(popup?.getAttribute("aria-modal")).toBe("true");
  // **画面の中身が器の中に居る**(器だけ出て中身が外に残る、を作らない)。
  expect(popup?.querySelector('[data-testid="view-title"]')).not.toBeNull();
});

test("(T04-2) 宣言を持たない画面は今日と1バイトも変わらない(限定3)", async () => {
  renderInScope(formView());
  await settle();
  expect(document.querySelector('[data-slot="overlay-dialog"]')).toBeNull();
  expect(screen.getByTestId("view-title").textContent).toBe("注文する");
});

test("(T04-3) modal: false と明示した画面も今日と1バイトも変わらない(既定を反転させていない)", async () => {
  renderInScope(formView({ modal: false }));
  await settle();
  expect(document.querySelector('[data-slot="overlay-dialog"]')).toBeNull();
});

test("(T04-4) 一覧・詳細は宣言を持てないので、器に入る経路が無い", async () => {
  // **schema が止めるので、ここへは到達しない。** それでも表示層が種別で分岐していることを
  // 直接示す(**表示層が「form 以外でも重ねる」実装になっていないこと**の実測)。
  renderInScope({
    id: "order-list",
    type: "list_view",
    table: "orders",
    columns: ["memo"],
    modal: true,
  } as unknown as View);
  await settle();
  expect(document.querySelector('[data-slot="overlay-dialog"]')).toBeNull();
});

test("(T04-5) 器を閉じると、履歴を1つ戻る", async () => {
  const calls: number[] = [];
  const original = window.history.back;
  (window.history as { back: () => void }).back = () => {
    calls.push(1);
  };
  try {
    renderInScope(formView({ modal: true, menu_listed: false }));
    await settle();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await settle();
    expect(calls).toHaveLength(1);
  } finally {
    (window.history as { back: () => void }).back = original;
  }
});

test("(T04-6) マニフェストの値からクラス名を生やしていない(限定8)", () => {
  // **レンダラーは真偽値を分岐してリテラルの器を選ぶ。**
  // マニフェストの値を文字列連結してクラス名にする形が1つも無いことを、ソースで見る。
  const source = require("node:fs").readFileSync(
    require("node:path").join(import.meta.dir, "..", "src", "views", "ViewHost.tsx"),
    "utf8",
  ) as string;
  expect(/className={`[^`]*\$\{/.test(source)).toBe(false);
  expect(source.includes("modal")).toBe(true);
});

test("(T04-7) 器はアプリ単位テーマのスコープの内側に差さる", async () => {
  // **`document.body` の直下へ差すと、アプリのテーマ(25スロットは inline style で
  // `.app-theme` に立つ)も、逃げ道 CSS(`.app-theme { … }` の入れ子で配る)も、
  // 器には1つも届かない。****chromium で `popupInsideScope: false` を実測して直した。**
  renderInScope(formView({ modal: true, menu_listed: false }));
  await settle();
  const scope = document.querySelector(".app-theme");
  const popup = document.querySelector('[data-slot="overlay-dialog"]');
  expect(scope).not.toBeNull();
  expect(popup).not.toBeNull();
  expect(scope?.contains(popup ?? null)).toBe(true);
});

test("(T04-8) スコープが無い場所でも器は必ず出る(黙って消えない)", async () => {
  // **fail-open。**器を出さないことは「宣言は書けるのに画面が1ピクセルも変わらない」
  // = `ADR-0086` 限定4 が禁じた「書けるが効かない」そのものになる。
  // **倒れた先ではアプリのテーマが届かない。それは隠さない。**
  render(
    <ViewHost
      appId="shop"
      manifest={MANIFEST}
      view={formView({ modal: true, menu_listed: false })}
    />,
  );
  await settle();
  expect(document.querySelector('[data-slot="overlay-dialog"]')).not.toBeNull();
  expect(document.querySelector(".app-theme")).toBeNull();
});
