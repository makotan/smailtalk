/**
 * 組み込みのテーマ候補集合のテスト(V3-M4-T01 / D-G7。**門外 Δ7**)。
 *
 * 完了条件の正は `docs/plan/v3/records/v3-m4.md` §2 の「V3-M4-T01」節、判定の正は
 * `docs/plan/v3/records/v3-m4-gate-a-intake.md` §3(S1〜S6)と
 * `docs/adr/0007-vocabulary-governance.md` §8 の 2026-07-26 の D-G7 の行(門 = 外・判定 = 将来送り)。
 *
 * ## 何を固定しているか
 *
 * 1. **候補集合は有限で列挙できる**(完了条件2 / ユーザ決定 D-M4-2)。数はコードが持つ定数で、
 *    実行時に足せない(凍結)。**AI は候補集合を増やせない** —— この製品で AI が触れるのは
 *    差分操作 `set_theme` の中身であって、この表ではない。
 * 2. **各候補は25スロット全部の実値を持つ**(完了条件3)。集合は
 *    `schemas/manifest.schema.json` の `$defs/theme` の properties キー集合と**完全一致**し、
 *    値は同スキーマの `pattern` を満たす。**スキーマはファイルとして読む**(ADR-0009 限定2 の作法。
 *    先例は `web/test/app-theme.test.tsx` / `web/test/theme-export.test.tsx`)。
 * 3. **同梱する候補は全部コントラスト検査を通る**(完了条件3。ADR-0046 / ADR-0047 限定8)。
 *    **カーネルの検査関数そのもの**(`src/kernel/theme-contrast.ts` の `checkThemeContrast`)で
 *    確かめる —— web 側に同じ規則を再実装しない。逆側(閾値未満の配色は落ちること)も測って、
 *    検査が空回りしていないことを示す。
 * 4. **選択した候補が既存の `apply_diff` 経路で適用され、dry_run / changelog / undo / redo が
 *    そのまま効く**(完了条件4)。**逃げ道経路を使わない** —— 送るのは普通の差分1件である。
 *
 * ## このファイルが証明しないこと(誇張しない)
 *
 * - **候補の配色が「良い」ことは1つも証明していない。** 通ったのは閾値の検査であって、
 *   読みやすさでも好みでもない(`src/kernel/theme-contrast.ts` 冒頭と同じ限界)。
 * - **画面に並ぶこと・見比べられることはここでは測らない**(happy-dom は描画を解かない)。
 *   単体は `web/test/theme-preview.test.tsx`、実測は `web/e2e/theme-preview.e2e.ts` である。
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  applyDiff,
  createApp,
  dryRunDiff,
  KernelMetaStore,
  redo,
  undo,
} from "../../src/kernel/index.ts";
import { checkThemeContrast } from "../../src/kernel/theme-contrast.ts";
import {
  newDiffSuffix,
  THEME_CANDIDATES,
  type ThemeCandidate,
  themeCandidateDiff,
} from "../src/theme-candidates.ts";

const REPO_ROOT = dirname(dirname(import.meta.dir));
const MANIFEST_SCHEMA_PATH = join(REPO_ROOT, "schemas", "manifest.schema.json");

type ThemeSchema = {
  $defs: { theme: { required: string[]; properties: Record<string, { pattern?: string }> } };
};

function themeSchema(): ThemeSchema["$defs"]["theme"] {
  return (JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as ThemeSchema).$defs.theme;
}

/** `$defs/resource_id` の pattern(差分IDの形)。スキーマから読む。 */
function resourceIdPattern(): RegExp {
  const schema = JSON.parse(readFileSync(MANIFEST_SCHEMA_PATH, "utf-8")) as {
    $defs: { resource_id: { pattern: string } };
  };
  return new RegExp(schema.$defs.resource_id.pattern);
}

// ---------------------------------------------------------------------------
// 1. 候補集合の有限性(完了条件2 / D-M4-2)
// ---------------------------------------------------------------------------

describe("候補集合は有限で列挙できる(D-M4-2 = 組み込み固定候補)", () => {
  test("候補は3件である(N の値をここで固定する)", () => {
    // **N を変えるときはこの数字を書き換えること。** 数を上げると
    // 「1画面を N 枚同時」(D-M4-3)の API 呼び出しが同じ倍率で増える
    // (実測は `web/test/theme-preview.test.tsx`)。
    expect(THEME_CANDIDATES.length).toBe(3);
    // 完了条件1 の下限(「少なくとも2種」)を、下限の側からも固定する。
    expect(THEME_CANDIDATES.length).toBeGreaterThanOrEqual(2);
  });

  test("実行時に候補を足せない(集合も候補もスロットも凍結されている)", () => {
    expect(Object.isFrozen(THEME_CANDIDATES)).toBe(true);
    expect(() => {
      (THEME_CANDIDATES as ThemeCandidate[]).push(THEME_CANDIDATES[0] as ThemeCandidate);
    }).toThrow();
    for (const candidate of THEME_CANDIDATES) {
      expect(Object.isFrozen(candidate)).toBe(true);
      expect(Object.isFrozen(candidate.slots)).toBe(true);
    }
  });

  test("候補のIDは一意で、リソースIDの形をしている(差分IDの材料になる)", () => {
    const ids = THEME_CANDIDATES.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(resourceIdPattern());
    }
  });

  test("候補は人間向けの名前と説明を持つ(どれを選んだかが画面で読める)", () => {
    for (const candidate of THEME_CANDIDATES) {
      expect(candidate.name.length).toBeGreaterThan(0);
      expect(candidate.note.length).toBeGreaterThan(0);
    }
    const names = THEME_CANDIDATES.map((candidate) => candidate.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// 2. 25スロット全部の実値である(完了条件3)
// ---------------------------------------------------------------------------

describe("候補は25スロット全部の実値である($defs/theme は全キー required)", () => {
  test("スロット名の集合がスキーマの properties と完全一致する", () => {
    const expected = Object.keys(themeSchema().properties).sort();
    expect(expected.length).toBe(25);
    for (const candidate of THEME_CANDIDATES) {
      const actual = Object.keys(candidate.slots).sort();
      const added = actual.filter((name) => !expected.includes(name));
      const removed = expected.filter((name) => !actual.includes(name));
      expect({ candidate: candidate.id, added, removed }).toEqual({
        candidate: candidate.id,
        added: [],
        removed: [],
      });
    }
  });

  test("required に挙がっているスロットが1つも欠けていない", () => {
    const required = themeSchema().required;
    for (const candidate of THEME_CANDIDATES) {
      for (const slot of required) {
        expect(typeof candidate.slots[slot]).toBe("string");
      }
    }
  });

  test("値がスキーマの pattern を満たす(式・計算・参照を1つも含まない)", () => {
    const properties = themeSchema().properties;
    for (const candidate of THEME_CANDIDATES) {
      for (const [slot, value] of Object.entries(candidate.slots)) {
        const pattern = properties[slot]?.pattern;
        if (pattern === undefined) {
          throw new Error(`スキーマに pattern が無いスロット: ${slot}`);
        }
        expect({ candidate: candidate.id, slot, ok: new RegExp(pattern).test(value) }).toEqual({
          candidate: candidate.id,
          slot,
          ok: true,
        });
      }
    }
  });

  test("候補どうしは配色が1色も重ならない(並べても見分けが付く)", () => {
    const backgrounds = THEME_CANDIDATES.map(
      (candidate) => candidate.slots["--color-page-background"],
    );
    expect(new Set(backgrounds).size).toBe(THEME_CANDIDATES.length);
  });
});

// ---------------------------------------------------------------------------
// 3. コントラスト検査(完了条件3。通らない候補を同梱しない)
// ---------------------------------------------------------------------------

describe("同梱する候補は全部コントラスト検査を通る(ADR-0046 / ADR-0047 限定8)", () => {
  test("カーネルの検査関数がどの候補にも1件もエラーを返さない", () => {
    for (const candidate of THEME_CANDIDATES) {
      const errors = checkThemeContrast(candidate.slots);
      expect({ candidate: candidate.id, messages: errors.map((error) => error.message) }).toEqual({
        candidate: candidate.id,
        messages: [],
      });
    }
  });

  test("検査は空回りしていない(本文色を地色に寄せた偽の候補は落ちる)", () => {
    const base = THEME_CANDIDATES[0];
    if (base === undefined) {
      throw new Error("候補が0件");
    }
    const broken = {
      ...base.slots,
      "--color-text": base.slots["--color-page-background"] as string,
    };
    expect(checkThemeContrast(broken).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. 差分の形(完了条件12 = intent に何を書くか)
// ---------------------------------------------------------------------------

describe("候補から作る差分の形", () => {
  test("差分IDは候補IDを含み、リソースIDの形で59文字以内である", () => {
    for (const candidate of THEME_CANDIDATES) {
      const diff = themeCandidateDiff(candidate, "abc123");
      expect(diff.diff_id).toMatch(resourceIdPattern());
      // `undo-` 接頭辞ぶんを含めて undo できる長さ(diff.schema.json の maxLength)。
      expect(diff.diff_id.length).toBeLessThanOrEqual(59);
      expect(diff.diff_id).toContain(candidate.id);
    }
  });

  test("操作は set_theme 1件だけで、由来(origin)を名乗らない", () => {
    for (const candidate of THEME_CANDIDATES) {
      const diff = themeCandidateDiff(candidate, "abc123");
      expect(diff.operations.length).toBe(1);
      const operation = diff.operations[0];
      expect(operation?.op).toBe("set_theme");
      expect(operation?.theme.slots).toEqual(candidate.slots);
      // 候補はアプリではないので `template_app_id` を名乗れない(ADR-0047 限定7)。
      expect(operation?.theme.origin).toBeUndefined();
    }
  });

  test("intent は、どの候補を選んだかと、機械が書いた定型文であることを書く", () => {
    for (const candidate of THEME_CANDIDATES) {
      const { intent } = themeCandidateDiff(candidate, "abc123");
      // どの候補を選んだかが後から読める(完了条件12 の最低条件)。
      expect(intent).toContain(candidate.name);
      expect(intent).toContain(candidate.id);
      // 人間の意図ではないことを、差分そのものが名乗る(憲法5 との緊張を隠さない)。
      expect(intent).toContain("人間が書いた意図ではない");
      expect(intent.length).toBeGreaterThan(0);
    }
  });

  test("差分IDの後半は毎回変わり、リソースIDに使える文字だけからなる", () => {
    const suffixes = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const suffix = newDiffSuffix();
      expect(suffix).toMatch(/^[a-z0-9]+$/);
      suffixes.add(suffix);
    }
    // 同一ミリ秒に何度押しても同じIDにならない(`_changelog` は diff_id の重複を受けない)。
    expect(suffixes.size).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// 5. 既存の apply_diff 経路(完了条件4)
// ---------------------------------------------------------------------------

describe("候補の差分は普通の差分である(dry_run / apply / undo / redo)", () => {
  let dataRoot: string;
  const APP_ID = "preview-demo";

  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), "gp-theme-candidates-"));
    const store = KernelMetaStore.open(dataRoot);
    try {
      createApp(store, "プレビューの検証", { app_id: APP_ID });
    } finally {
      store.close();
    }
  });

  afterEach(async () => {
    await rm(dataRoot, { recursive: true, force: true });
  });

  test("dry_run が候補3件とも valid を返す(本体は1バイトも変わらない)", () => {
    for (const candidate of THEME_CANDIDATES) {
      const result = dryRunDiff(dataRoot, APP_ID, themeCandidateDiff(candidate, "dryrun"));
      expect({ candidate: candidate.id, valid: result.valid }).toEqual({
        candidate: candidate.id,
        valid: true,
      });
    }
  });

  test("apply → changelog に載る → undo で戻る → redo で戻り直す", () => {
    const candidate = THEME_CANDIDATES[0];
    if (candidate === undefined) {
      throw new Error("候補が0件");
    }
    const diff = themeCandidateDiff(candidate, "applied");

    const applied = applyDiff(dataRoot, APP_ID, diff);
    if (!applied.valid) {
      throw new Error(`適用が失敗した: ${JSON.stringify(applied.errors)}`);
    }
    expect(applied.manifest.app.theme?.slots).toEqual(candidate.slots);
    // changelog に、web が自動生成した intent がそのまま載る(完了条件12 の帰結)。
    expect(applied.entry.diff_id).toBe(diff.diff_id);
    expect(applied.entry.intent).toBe(diff.intent);

    const undone = undo(dataRoot, APP_ID);
    if (!undone.valid) {
      throw new Error(`undo が失敗した: ${JSON.stringify(undone.errors)}`);
    }
    expect(undone.manifest.app.theme).toBeUndefined();

    const redone = redo(dataRoot, APP_ID);
    if (!redone.valid) {
      throw new Error(`redo が失敗した: ${JSON.stringify(redone.errors)}`);
    }
    expect(redone.manifest.app.theme?.slots).toEqual(candidate.slots);
  });
});

// ---------------------------------------------------------------------------
// V3-M7-T05: `length` だけを固定した検査の穴を1つ塞ぐ
//
// **出所**: `docs/plan/v3/records/v3-m6-t05.md` §11-10 の申し送り(逐語「**「`length` だけを
// 固定していて改名が素通りする検査」が他にどれだけ在るかを、V3-M7 が数えるかを判定すること**」)。
// **V3-M7-T05 が repo 全体を数えた結果、この型の穴は3件だった**(数え方と全量は
// `docs/plan/v3/records/v3-m7-t05.md` §4)。**本ファイルはそのうちの1件である。**
//
// **何が素通りしていたか**: 上の「候補は3件である」は `THEME_CANDIDATES.length` だけを固定して
// いる。**候補のIDは一意性と形しか検査されていなかった**ので、**`plain-light` を別の名前へ改名
// しても、候補を1つ消して1つ足しても、件数が3のままなら全部緑だった。** 候補集合は
// D-M4-2(組み込み固定候補)が有限性を約束している集合であり、**中身が黙って入れ替わることは
// 約束の側の変更である。**
// ---------------------------------------------------------------------------

test("V3-M7-T05: 候補の集合を**名前で**固定する(件数が3のままの改名・入れ替えを素通りさせない)", () => {
  // **順序ごと固定する。** 画面に並ぶ順そのものが利用者の見るものである。
  expect(THEME_CANDIDATES.map((candidate) => candidate.id)).toEqual([
    "plain-light",
    "deep-dark",
    "warm-roomy",
  ]);
  // **人間が読む名前も固定する** —— ID だけを固定すると、画面の表示名だけが黙って変わる。
  expect(THEME_CANDIDATES.map((candidate) => candidate.name)).toEqual([
    "明るい",
    "暗い",
    "暖色でゆったり",
  ]);
});
