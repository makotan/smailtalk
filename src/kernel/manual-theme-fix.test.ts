/**
 * **利用者向けの説明書 `MANUAL.md` の「以前の版で保存したテーマの直し方」を固定する見張り。**
 *
 * 独立点検(2026-09-25)で、直し方の1行(「2行を消す」)を消しても検査が1本も赤くならなかった。
 * 本ファイルは次の3つを見る:
 *
 * 1. 手順の文(2行を消す・4行を足す・値の写し方の2行)が節の中に逐語で在る。
 * 2. 節の中の「直す前の例」は、保存済みのマニフェストとして読むと断られる(直す理由が実物で在る)。
 * 3. 節の中の「手順どおりに直した後の例」は、保存済みのマニフェストとして読める
 *    (`validateManifestFull(…, "stored")` が valid)。 かつ、直す前の例に手順(2行を消す・
 *    4行を足して値を写す)を機械で当てた結果と一致する(手順と例が食い違わない)。
 *
 * **行番号では引かない。** 節の見出しと次の見出しを錨にして取り出す。
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifestFull } from "./validate.ts";

const MANUAL = readFileSync(join(import.meta.dir, "..", "..", "MANUAL.md"), "utf-8");
const HEAD = "### 以前の版で保存したテーマの直し方";
const NEXT = "以前の版では、スロットの名前が CSS カスタムプロパティ名そのものだった。";

function section(): string {
  const start = MANUAL.indexOf(HEAD);
  const end = MANUAL.indexOf(NEXT, start);
  expect(MANUAL.split(HEAD)).toHaveLength(2);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return MANUAL.slice(start, end);
}

/** 目印の行の直後に在る `~~~json` の塊を、`"slots": { … }` として読む。 */
function exampleAfter(marker: string): Record<string, string> {
  const body = section();
  const at = body.indexOf(marker);
  expect(at, `目印が節の中に無い: ${marker}`).toBeGreaterThanOrEqual(0);
  const open = body.indexOf("~~~json\n", at);
  const close = body.indexOf("\n~~~", open + 1);
  expect(open).toBeGreaterThan(at);
  const text = body.slice(open + "~~~json\n".length, close);
  const parsed = JSON.parse(`{${text}}`) as { slots: Record<string, string> };
  return parsed.slots;
}

const BEFORE = "**直す前の例**";
const AFTER = "**手順どおりに直した後の例**";

function manifestWithSlots(slots: Record<string, string>): unknown {
  return {
    app: {
      id: "manual-theme-fix",
      name: "直し方の例",
      tables: [{ id: "notes", name: "メモ", fields: [{ id: "title", name: "題", type: "text" }] }],
      views: [{ id: "notes-list", type: "list_view", table: "notes", columns: ["title"] }],
      theme: { slots },
    },
  };
}

test("手順の文が節の中に逐語で在る(2行を消す・4行を足す・値の写し方)", () => {
  const body = section();
  for (const sentence of [
    '1. `"--detail-label-width": ...` と `"--login-max-width": ...` の **2行を消す。**',
    "2. 次の **4行を足す。** 値はそのテーマ自身の値を写す",
    "   - `primary_fill` と `overlay_background` には、そのテーマの `page_background` の値",
    "   - `on_primary` と `overlay_text` には、そのテーマの `body_text` の値",
    "元に戻す操作が使う過去の状態(`apps/<アプリID>/snapshots/` の下の各 `manifest.json`)も同じように直す。",
  ]) {
    expect(body).toContain(sentence);
  }
  // 平常時の見た目だけが直す前と同じ(主ボタンの hover / active は変わる)ことを書いている。
  expect(body).toContain("平常時の見た目は直す前と同じになる");
  expect(body).toContain("主ボタンにマウスを載せたとき・押している間の見た目は");
});

test("直す前の例は、保存済みのマニフェストとして読むと断られる", () => {
  const before = exampleAfter(BEFORE);
  expect(Object.keys(before)).toContain("--detail-label-width");
  expect(Object.keys(before)).toContain("--login-max-width");
  expect(validateManifestFull(manifestWithSlots(before), "stored").valid).toBe(false);
});

test("手順どおりに直した後の例は、保存済みのマニフェストとして読め、直す前の例に手順を当てた結果と一致する", () => {
  const before = exampleAfter(BEFORE);
  const after = exampleAfter(AFTER);
  // 手順を機械で当てる: 2行を消し、4行を足して page_background / body_text の値を写す。
  const fixed: Record<string, string> = { ...before };
  delete fixed["--detail-label-width"];
  delete fixed["--login-max-width"];
  fixed.primary_fill = before.page_background as string;
  fixed.overlay_background = before.page_background as string;
  fixed.on_primary = before.body_text as string;
  fixed.overlay_text = before.body_text as string;
  expect(after).toEqual(fixed);
  expect(validateManifestFull(manifestWithSlots(after), "stored")).toEqual({ valid: true });
});
