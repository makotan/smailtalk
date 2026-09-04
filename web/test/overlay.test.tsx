/**
 * **重ねて出す器3つの検査**(`V4-M18-T01`。`ADR-0094` 限定2 / 限定4 / 限定5 / 限定7 / 限定8 / 限定10)。
 *
 * ## これは何で、何ではないか
 *
 * - **器を作るだけである。** **AI が書く語彙は1つも増えない**(`ADR-0094` 限定1)。
 *   **どの画面を重ねて出すかを宣言するのは `ADR-0095` であり、実装は `T03` / `T04` である。**
 * - **【禁止】「AI が部品を選べるようになった」と読まない。** **`P-G26` は 2026-08-03 に
 *   4回目の却下である**(`ADR-0096`)。
 * - **【禁止】「9プロパティの禁止を守ったまま器を作った」と読まない**(`ADR-0087` §3 総括の禁止7)。
 *   **禁止が及ぶのは手で書く CSS だけであり、器の実装は座標系プロパティを使う。**
 *
 * ## **アクセシビリティの実測**(`ADR-0094` 限定8。**本ファイルがその実測そのものである**)
 *
 * **`ADR-0094` §6 の 3 と `ADR-0095` §4 の 2 は「`@base-ui-components/react/dialog` を
 * 1度も import していない。備えていなければ本判定は差し戻しである」と自認していた。**
 * **`V4-M18-T01` は実際に import して測った。結果は `docs/plan/v4/records/v4-m18-impl.md`
 * §A に全件書いた。要点は2つで、どちらも隠さない**:
 *
 * 1. **`aria-modal="true"` は `@base-ui-components/react/dialog` の既定では出ない。**
 *    素の `Dialog.Popup` が持つのは `role="dialog"` だけで、外側は
 *    `data-base-ui-inert` + `aria-hidden="true"` で隠す作りである。
 *    **したがって `aria-modal="true"` は本製品の側で明示的に書いている。**
 * 2. **`role="status"` は `@base-ui-components/react/toast` の既定では出ない。**
 *    素の `Toast.Root` は `role="dialog" aria-modal="false"` を出す(囲みの
 *    `Toast.Viewport` が `role="region" aria-live="polite"` を持つ)。
 *    **したがって `role="status"` は本製品の側で明示的に上書きしている。**
 *
 * **差し戻しは要らない** —— **限定8 が求める8点は、既定 + 明示の2つで全部満たせた。**
 * **【禁止】「Base UI がアクセシブルだった」と書かない。** **2点は自分で書いた。**
 *
 * ## この検査が言えないこと(**先に書く。憲法6**)
 *
 * 1. **ここは happy-dom であって、`Tab` キーの巡回を1度も実行していない。**
 *    **フォーカスの閉じ込めについて言えるのは「番人の要素(`data-base-ui-focus-guard`)が
 *    実在し、外側が `aria-hidden="true"` で隠れ、開いた直後のフォーカスが小窓の中へ移る」
 *    ことまでである。** **巡回が本当に閉じているかは chromium(`web/e2e/overlay.e2e.ts`)で測る。**
 * 2. **読み上げソフトを1度も動かしていない。** 見ているのは属性だけである。
 * 3. **CSS を1バイトも計算していない。** どちらの段が上に描かれるかは見ていない。
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as overlay from "../src/ui/overlay.tsx";
import {
  OVERLAY_CONTAINERS,
  OverlayDialog,
  OverlayMenu,
  OverlayNotice,
} from "../src/ui/overlay.tsx";

const WEB_SRC = join(dirname(import.meta.dir), "src");

// **1本ごとに DOM を畳む。** 器はポータルへ差すので、畳まないと前の小窓が開いたまま
// 次の検査に残り、「開く」が2つ見つかる(全ファイルを1プロセスで走らせる `bun test` で実測した)。
afterEach(() => {
  cleanup();
});

/** 器が描かれるのを待つ(Base UI はポータルへ非同期に差す)。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

// ---------------------------------------------------------------------------
// (T01-1) 器は3つだけ(ADR-0094 限定2)
// ---------------------------------------------------------------------------

test("(T01-1) 重ねて出す器はちょうど3つで、4つ目が無い", () => {
  expect([...OVERLAY_CONTAINERS]).toEqual(["OverlayDialog", "OverlayMenu", "OverlayNotice"]);
  // **モジュールの export のうち、大文字始まりの関数(= 器)を数える。**
  // **4つ目を足したら赤になる。**
  const exported = Object.entries(overlay)
    .filter(([name, value]) => typeof value === "function" && /^[A-Z]/.test(name))
    .map(([name]) => name)
    .sort();
  expect(exported).toEqual([...OVERLAY_CONTAINERS].sort());
});

test("(T01-1b) 4つ目の器の名前がソースに1つも無い", () => {
  const body = readFileSync(join(WEB_SRC, "ui", "overlay.tsx"), "utf8");
  // **`ADR-0094` 限定2 が名指しで禁じた4つ目の候補**(タブ / ポップオーバー /
  // ツールチップ / サイドシート / コマンドパレット)を、import 元としても持たない。
  for (const forbidden of ["/tabs", "/popover", "/tooltip", "/preview-card", "/navigation-menu"]) {
    expect(body.includes(forbidden), forbidden).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// (T01-2) 重ねて出す小窓 —— 限定8 の5点(ADR-0094 限定8)
// ---------------------------------------------------------------------------

test("(T01-2) 小窓は role=dialog と aria-modal=true を持つ", async () => {
  render(
    <OverlayDialog title="本当に消しますか" trigger="開く">
      <button type="button">中のボタン</button>
    </OverlayDialog>,
  );
  fireEvent.click(screen.getByText("開く"));
  await settle();
  const popup = document.querySelector('[data-slot="overlay-dialog"]');
  expect(popup).not.toBeNull();
  expect(popup?.getAttribute("role")).toBe("dialog");
  // **【実測】既定では出ない。本製品が明示的に書いている。**
  expect(popup?.getAttribute("aria-modal")).toBe("true");
  // 題は `aria-labelledby` で結ばれる(読み上げの役に名前が付く)。
  expect(popup?.getAttribute("aria-labelledby")).not.toBeNull();
});

test("(T01-2b) 小窓を開くとフォーカスが中へ移り、外側は aria-hidden で隠れる", async () => {
  render(
    <OverlayDialog title="題" trigger="開く">
      <button type="button">中のボタン</button>
    </OverlayDialog>,
  );
  fireEvent.click(screen.getByText("開く"));
  await settle();
  const popup = document.querySelector('[data-slot="overlay-dialog"]');
  expect(popup?.contains(document.activeElement)).toBe(true);
  // 番人の要素が前後に居る(閉じ込めの機構が実在する)。
  expect(document.querySelectorAll("[data-base-ui-focus-guard]").length).toBeGreaterThan(0);
  // 外側は隠れている。
  const inert = document.querySelector('[data-base-ui-inert][aria-hidden="true"]');
  expect(inert).not.toBeNull();
});

test("(T01-2c) Escape で閉じ、閉じたら開いた元へフォーカスが戻る", async () => {
  render(
    <OverlayDialog title="題" trigger="開く">
      <button type="button">中のボタン</button>
    </OverlayDialog>,
  );
  const trigger = screen.getByText("開く");
  fireEvent.click(trigger);
  await settle();
  expect(document.querySelector('[data-slot="overlay-dialog"]')).not.toBeNull();

  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await settle();
  expect(document.querySelector('[data-slot="overlay-dialog"]')).toBeNull();
  expect(document.activeElement?.textContent).toBe("開く");
});

test("(T01-2d) 既定では閉じている(開くまで DOM に1要素も出ない)", () => {
  render(
    <OverlayDialog title="題" trigger="開く">
      <button type="button">中のボタン</button>
    </OverlayDialog>,
  );
  expect(document.querySelector('[data-slot="overlay-dialog"]')).toBeNull();
});

// ---------------------------------------------------------------------------
// (T01-3) 開くメニュー —— 限定8 の2点
// ---------------------------------------------------------------------------

test("(T01-3) メニューは role=menu を持ち、矢印キーで項目が移る", async () => {
  render(
    <OverlayMenu
      trigger="操作"
      items={[
        { label: "複製する", onSelect: () => {} },
        { label: "書き出す", onSelect: () => {} },
        { label: "消す", onSelect: () => {} },
      ]}
    />,
  );
  fireEvent.click(screen.getByText("操作"));
  await settle();
  const menu = document.querySelector('[data-slot="overlay-menu"]');
  expect(menu?.getAttribute("role")).toBe("menu");
  const items = () => [...document.querySelectorAll('[role="menuitem"]')];
  expect(items()).toHaveLength(3);
  expect(items()[0]?.hasAttribute("data-highlighted")).toBe(true);

  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
  await settle();
  expect(items()[1]?.hasAttribute("data-highlighted")).toBe(true);
  expect(document.activeElement?.textContent).toBe("書き出す");
});

test("(T01-3b) メニューも Escape で閉じる", async () => {
  render(<OverlayMenu trigger="操作" items={[{ label: "複製する", onSelect: () => {} }]} />);
  fireEvent.click(screen.getByText("操作"));
  await settle();
  expect(document.querySelector('[data-slot="overlay-menu"]')).not.toBeNull();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  await settle();
  expect(document.querySelector('[data-slot="overlay-menu"]')).toBeNull();
});

// ---------------------------------------------------------------------------
// (T01-4) 一時的な知らせ —— 限定8 の1点
// ---------------------------------------------------------------------------

test("(T01-4) 知らせは role=status を持つ", async () => {
  function Trigger() {
    const notify = overlay.useOverlayNotice();
    return (
      <button type="button" onClick={() => notify("保存しました")}>
        出す
      </button>
    );
  }
  render(
    <OverlayNotice>
      <Trigger />
    </OverlayNotice>,
  );
  fireEvent.click(screen.getByText("出す"));
  await settle();
  const notice = document.querySelector('[data-slot="overlay-notice"]');
  expect(notice).not.toBeNull();
  // **【実測】既定では `role="dialog" aria-modal="false"` が出る。本製品が上書きしている。**
  expect(notice?.getAttribute("role")).toBe("status");
  expect(notice?.textContent?.includes("保存しました")).toBe(true);
  // 囲みは読み上げの生きた領域である。
  const region = document.querySelector('[aria-live="polite"]');
  expect(region).not.toBeNull();
});

test("(T01-4b) 知らせを出すまで DOM に1件も出ない", () => {
  render(
    <OverlayNotice>
      <span>本文</span>
    </OverlayNotice>,
  );
  expect(document.querySelector('[data-slot="overlay-notice"]')).toBeNull();
});

// ---------------------------------------------------------------------------
// (T01-5) 依存を1本も足していない(ADR-0094 限定5)
// ---------------------------------------------------------------------------

test("(T01-5) 器の import 元は既に dependencies に在る1本だけである", () => {
  const body = readFileSync(join(WEB_SRC, "ui", "overlay.tsx"), "utf8");
  const packages = [...body.matchAll(/from "([^".][^"]*)"/g)]
    .map((match) => match[1] as string)
    .filter((name) => !name.startsWith(".") && !name.startsWith("node:"));
  const roots = [
    ...new Set(
      packages.map((name) => (name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name)),
    ),
  ].sort();
  expect(roots).toEqual(["@base-ui-components/react", "react"]);
  const manifest = JSON.parse(
    readFileSync(join(dirname(dirname(import.meta.dir)), "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  for (const root of roots) {
    expect(Object.keys(manifest.dependencies).includes(root), root).toBe(true);
  }
});

// ---------------------------------------------------------------------------
// (T01-6) 2段とも当たり先を持つ / 色のリテラルを1バイトも書かない / ダークモード0件
// ---------------------------------------------------------------------------

test("(T01-6) 重ね順の2段が、どちらも器の実装に当たり先を持つ", () => {
  const body = readFileSync(join(WEB_SRC, "ui", "overlay.tsx"), "utf8");
  const used = new Set(
    [...body.matchAll(/z-\((--layer-[a-z0-9-]+)\)/g)].map((m) => m[1] as string),
  );
  expect([...used].sort()).toEqual(["--layer-notice", "--layer-overlay"]);
});

test("(T01-7) 器の実装に色のリテラルが1バイトも無い(ADR-0094 限定7)", () => {
  const body = readFileSync(join(WEB_SRC, "ui", "overlay.tsx"), "utf8").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  expect(/#[0-9a-fA-F]{3,8}\b/.test(body)).toBe(false);
  expect(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i.test(body)).toBe(false);
});

test("(T01-8) 器の実装にダークモードの機構が1バイトも無い(ADR-0094 限定10)", () => {
  // **コメントを落としてから見る** —— 器の冒頭は「これらを1バイトも書いていない」と
  // **名指しで宣言している**ので、素の文字列検査だと自分の宣言文に当たって赤くなる。
  // **見るのはコードだけである。**(色のリテラルを見る (T01-7) と同じ扱い。)
  const body = readFileSync(join(WEB_SRC, "ui", "overlay.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["prefers-color-scheme", "data-theme", "light-dark(", "color-scheme:"]) {
    expect(body.includes(forbidden), forbidden).toBe(false);
  }
  expect(/\bdark:/.test(body)).toBe(false);
});
