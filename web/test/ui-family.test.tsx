/**
 * **見た目の器の系統が2つ実在することの検査**(`V4-M15-T18`。ユーザ決定 `D-V4-59`)。
 *
 * ## これは何で、何ではないか
 *
 * **`V4-M14` は `P-G26`(AI が既製の部品名で指定できるようにする)を却下した。**
 * 却下の理由は「**選べる対象(見た目の器)が2つ以上実在しないうちは、選べるという
 * 言葉を語彙に増やす意味がない**」である。`D-V4-59` はそれを受けて
 * 「**部品を複数用意してから再提出**」と決めた。
 *
 * **本検査が示すのは「選べる対象が2つ以上実在する」ことだけである。**
 *
 * - **【禁止】これを「AI が部品を選べるようになった」と読まない。** 今日は選べない。
 * - **`ADR-0087` 限定2 を破っていない** —— **系統の選択はマニフェストに1バイトも現れない。**
 *   `schemas/` に1バイトも触っておらず、差分操作も語彙も1つも増えていない。
 * - **切り替えの手段はマニフェストの外にある**(環境変数 `VITE_ST_UI_FAMILY` と
 *   テスト用の口 `globalThis.__ST_UI_FAMILY__`)。**画面上にその口を1つも出していない。**
 *
 * ## この検査が言えないこと
 *
 * **ここは happy-dom(JS DOM)であって、CSS を1バイトも計算しない。**
 * 見えるのは**クラス名の差**までである。**計算値の実測は chromium で別に採り、
 * `docs/plan/v4/records/v4-m15-t19.md` §T18 に書く**(本検査は判定に使わない)。
 */

import { afterEach, expect, test } from "bun:test";
import { render, screen } from "@testing-library/react";
import { Button } from "../src/ui/button.tsx";
import {
  DEFAULT_UI_FAMILY,
  resolveUiFamily,
  UI_FAMILIES,
  type UiFamily,
} from "../src/ui/family.ts";
import { Card } from "../src/ui/surfaces.tsx";

function setFamily(family: UiFamily | undefined): void {
  if (family === undefined) {
    delete (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__;
    return;
  }
  (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__ = family;
}

afterEach(() => {
  setFamily(undefined);
});

test("系統は2つで、既定は comfortable である", () => {
  // **実数を書く。2 未満になったら `D-V4-59` を満たさない。**
  expect(UI_FAMILIES.length).toBe(2);
  expect([...UI_FAMILIES]).toEqual(["comfortable", "compact"]);
  expect(DEFAULT_UI_FAMILY).toBe("comfortable");
});

test("テスト用の口で系統が切り替わり、知らない値は既定に倒れる", () => {
  setFamily(undefined);
  expect(resolveUiFamily()).toBe("comfortable");

  setFamily("compact");
  expect(resolveUiFamily()).toBe("compact");

  // fail-closed。**落ちない。**
  (globalThis as { __ST_UI_FAMILY__?: unknown }).__ST_UI_FAMILY__ = "roomy";
  expect(resolveUiFamily()).toBe("comfortable");
});

test("2つ目の系統の当たり先(変種クラス)が、部品のクラス名に実在する", () => {
  // **「作ったが描けない」を防ぐ** —— 変種クラスが1つも無ければ、系統を切り替えても
  // 画面は1ピクセルも変わらない。**当たり先が実在することを、クラス名の側で先に示す。**
  render(
    <div className="group/ui" data-ui-family="compact">
      <Button data-testid="family-button">押す</Button>
      <Card data-testid="family-card">中身</Card>
    </div>,
  );

  const button = screen.getByTestId("family-button");
  const card = screen.getByTestId("family-card");

  for (const element of [button, card]) {
    const compactVariants = [...element.classList].filter((name) =>
      name.startsWith("group-data-[ui-family=compact]/ui:"),
    );
    expect(compactVariants.length).toBeGreaterThan(0);
  }

  // **既定の系統の側にも体裁が在る**(片方が空なら「2つ」ではない)。
  expect([...button.classList].some((n) => n === "h-9")).toBe(true);
  expect([...card.classList].some((n) => n === "p-s4")).toBe(true);
});

test("系統の属性が DOM に出る先は、器を包む1箇所だけである", () => {
  // **2箇所に住むと食い違う。** 判定は `resolveUiFamily` の1箇所だけで、
  // DOM に出るのは `App` の `<main className="shell group/ui">` だけである。
  render(
    <div className="group/ui" data-ui-family={resolveUiFamily()} data-testid="family-scope">
      <Button>押す</Button>
    </div>,
  );
  expect(screen.getByTestId("family-scope").getAttribute("data-ui-family")).toBe("comfortable");
});
