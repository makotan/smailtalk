import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Manifest } from "../kernel/types.ts";
import {
  collectDesignNotices,
  DESIGN_NOTICE_LONG_FORM_FIELDS,
  DESIGN_NOTICE_MAX_ACTIONS,
} from "./design-notices.ts";

/**
 * 注意の文面・綴りに使わない3語(重大度の段を持つ別の仕組みと取り違えさせないため)。
 * **綴りを組み立てて書く** —— 逐語で書くと、製品コードの中の綴りを数える式
 * (`grep -rn '<綴り>' src web/src schemas`)がこの検査自身を数えてしまう。
 */
const FORBIDDEN_WORDS = [
  ["警", "告"].join(""),
  ["warn", "ings"].join(""),
  ["sever", "ity"].join(""),
];

/**
 * 画面の作りの点検(注意)の単体検査。
 *
 * 3件の注意(主ボタンが2つ以上 / ボタンが多すぎる / 長いフォームに区切りが無い)を
 * 1件ずつ分けて撃つ。閾値の境界(7/8・9/10)と、当たらない側(組込ボタンを数えない・
 * まとまりがあれば出ない)も撃つ。
 */

const SOURCE_PATH = join(import.meta.dir, "design-notices.ts");

/** 表1つ(項目 f1〜f12)と、渡した画面だけを持つマニフェスト。 */
function manifestWith(views: unknown[]): Manifest {
  const fields = Array.from({ length: 12 }, (_, i) => ({
    id: `f${i + 1}`,
    name: `項目${i + 1}`,
    type: "text",
  }));
  return {
    app: {
      id: "sample",
      name: "見本",
      tables: [{ id: "items", name: "品目", fields }],
      views,
    },
  } as unknown as Manifest;
}

/** 遷移の形のボタンを n 個。 */
function navActions(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ view: "item-list", name: `ボタン${i + 1}` }));
}

/** 書き換えの形のボタンを、指定した主副で並べる。 */
function setActions(emphases: (string | undefined)[]): unknown[] {
  return emphases.map((emphasis, i) => ({
    set: { field: "f1", value: `v${i}` },
    name: `ボタン${i + 1}`,
    ...(emphasis === undefined ? {} : { action_emphasis: emphasis }),
  }));
}

function fieldIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `f${i + 1}`);
}

describe("定数", () => {
  test("閾値はコード定数に固定されている(ボタン 8 / 項目 10)", () => {
    expect(DESIGN_NOTICE_MAX_ACTIONS).toBe(8);
    expect(DESIGN_NOTICE_LONG_FORM_FIELDS).toBe(10);
  });

  test("閾値を引数に取らない(引数は1つだけ)", () => {
    expect(collectDesignNotices.length).toBe(1);
  });
});

describe("注意1: 主ボタンが2つ以上(multiple_primary_actions)", () => {
  test("詳細画面に主ボタンが2つあると注意が1件出る", () => {
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-list", type: "list_view", table: "items", columns: ["f1"] },
        {
          id: "item-detail",
          type: "detail_view",
          table: "items",
          actions: setActions(["primary", "secondary", "primary"]),
        },
      ]),
    );
    const hits = report.notices.filter((n) => n.rule === "multiple_primary_actions");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.view).toBe("item-detail");
    expect(hits[0]?.path).toBe("/app/views/1/actions");
    expect(hits[0]?.count).toBe(2);
    expect(hits[0] && "threshold" in hits[0]).toBe(false);
    expect(hits[0]?.message).toContain("注意");
  });

  test("主ボタンが1つなら出ない(危険・副・無指定は主に数えない)", () => {
    const report = collectDesignNotices(
      manifestWith([
        {
          id: "item-detail",
          type: "detail_view",
          table: "items",
          actions: setActions(["primary", "danger", "secondary", undefined]),
        },
      ]),
    );
    expect(report.notices.filter((n) => n.rule === "multiple_primary_actions")).toEqual([]);
  });

  test("主ボタン4つは count 4 の1件(ボタンごとに出さない)", () => {
    const report = collectDesignNotices(
      manifestWith([
        {
          id: "item-detail",
          type: "detail_view",
          table: "items",
          actions: setActions(["primary", "primary", "primary", "primary"]),
        },
      ]),
    );
    const hits = report.notices.filter((n) => n.rule === "multiple_primary_actions");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.count).toBe(4);
  });
});

describe("注意2: ボタンが多すぎる(too_many_actions)", () => {
  test("境界: 詳細画面のボタン7個では出ない", () => {
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-detail", type: "detail_view", table: "items", actions: navActions(7) },
      ]),
    );
    expect(report.notices.filter((n) => n.rule === "too_many_actions")).toEqual([]);
  });

  test("境界: 詳細画面のボタン8個で出る", () => {
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-detail", type: "detail_view", table: "items", actions: navActions(8) },
      ]),
    );
    const hits = report.notices.filter((n) => n.rule === "too_many_actions");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rule: "too_many_actions",
      view: "item-detail",
      path: "/app/views/0/actions",
      count: 8,
      threshold: 8,
    });
    expect(hits[0]?.message).toContain("注意");
  });

  test("境界: 一覧のボタン8個でも出る(一覧は1行あたりの宣言数で数える)", () => {
    const report = collectDesignNotices(
      manifestWith([
        {
          id: "item-list",
          type: "list_view",
          table: "items",
          columns: ["f1"],
          actions: navActions(8),
        },
      ]),
    );
    const hits = report.notices.filter((n) => n.rule === "too_many_actions");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.view).toBe("item-list");
    expect(hits[0]?.count).toBe(8);
  });

  test("組込ボタン(編集・削除など)は数えない: 書いたボタン7個の詳細画面には出ない", () => {
    // 詳細画面は編集・削除の2つを常に出すので、組込を足せば 9 になる。数えるのは書いた7個だけ。
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-detail", type: "detail_view", table: "items", actions: navActions(7) },
      ]),
    );
    expect(report.notices).toEqual([]);
    expect(report.limits.some((line) => line.includes("最初から付くボタン"))).toBe(true);
  });

  test("境界: 一覧のボタン7個では出ない(組込の新規作成は数えない)", () => {
    // 一覧は組込の「新規作成」を常に出すので、組込を足せば 8 になる。数えるのは書いた7個だけ。
    const report = collectDesignNotices(
      manifestWith([
        {
          id: "item-list",
          type: "list_view",
          table: "items",
          columns: ["f1"],
          actions: navActions(7),
        },
      ]),
    );
    expect(report.notices.filter((n) => n.rule === "too_many_actions")).toEqual([]);
    expect(report.notices).toEqual([]);
  });

  test("ボタンを書いていない画面には出ない", () => {
    const report = collectDesignNotices(
      manifestWith([{ id: "item-detail", type: "detail_view", table: "items" }]),
    );
    expect(report.notices).toEqual([]);
  });
});

describe("注意3: 長いフォームに区切りが無い(long_form_without_sections)", () => {
  test("境界: 項目9個のフォームには出ない", () => {
    const report = collectDesignNotices(
      manifestWith([{ id: "item-form", type: "form", table: "items", fields: fieldIds(9) }]),
    );
    expect(report.notices.filter((n) => n.rule === "long_form_without_sections")).toEqual([]);
  });

  test("境界: 項目10個で区切りの無いフォームに出る", () => {
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-list", type: "list_view", table: "items", columns: ["f1"] },
        { id: "item-form", type: "form", table: "items", fields: fieldIds(10) },
      ]),
    );
    const hits = report.notices.filter((n) => n.rule === "long_form_without_sections");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      rule: "long_form_without_sections",
      view: "item-form",
      path: "/app/views/1/fields",
      count: 10,
      threshold: 10,
    });
    expect(hits[0]?.message).toContain("注意");
  });

  test("まとまり(field_sections)があれば出ない", () => {
    const report = collectDesignNotices(
      manifestWith([
        {
          id: "item-form",
          type: "form",
          table: "items",
          fields: fieldIds(12),
          field_sections: { 基本: ["f1", "f2"] },
        },
      ]),
    );
    expect(report.notices).toEqual([]);
  });

  test("並べ方の木(layout)は区切りに数えない: 10項目・field_sections 無し・layout 有りのフォームに出る", () => {
    const report = collectDesignNotices(
      manifestWith([
        {
          id: "item-form",
          type: "form",
          table: "items",
          fields: fieldIds(10),
          layout: {
            type: "stack",
            gap: "md",
            children: [{ type: "switcher", threshold: "sm", children: ["f1", "f2"] }, "f3"],
          },
        },
      ]),
    );
    const hits = report.notices.filter((n) => n.rule === "long_form_without_sections");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ view: "item-form", count: 10, threshold: 10 });
    expect(report.limits.some((line) => line.includes("layout"))).toBe(true);
  });

  test("詳細画面の項目10個には出ない(当たるのは入力フォームだけ)", () => {
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-detail", type: "detail_view", table: "items", fields: fieldIds(12) },
      ]),
    );
    expect(report.notices).toEqual([]);
  });
});

describe("返り値の形", () => {
  test("キーは notices / not_counted / limits の3つだけ(件数の欄を持たない)", () => {
    const report = collectDesignNotices(manifestWith([]));
    expect(Object.keys(report).sort()).toEqual(["limits", "not_counted", "notices"]);
    expect(report.notices).toEqual([]);
  });

  test("数えなかったもの: 入れ子の深さを理由つきで挙げる", () => {
    const report = collectDesignNotices(manifestWith([]));
    expect(report.not_counted).toHaveLength(1);
    expect(report.not_counted[0]?.what).toContain("入れ子の深さ");
    expect(report.not_counted[0]?.reason).toContain("拒否");
  });

  test("限界は6項", () => {
    const report = collectDesignNotices(manifestWith([]));
    expect(report.limits).toHaveLength(6);
    const joined = report.limits.join("\n");
    for (const word of [
      "最初から付くボタン",
      "visible_when",
      "一部の項目だけ",
      "layout",
      "undo",
      "見た目の良さ",
    ]) {
      expect(joined).toContain(word);
    }
    // 注意が出ない返事は undo / redo だけではない: 人が画面から保存したときの返事にも出ない。
    // 同じ項に並べて書く(個数は6項のまま)。
    const quiet = report.limits.find((line) => line.includes("undo"));
    expect(quiet).toContain("画面から保存");
  });

  test("3件が同時に当たると、画面の並び順に全件挙がり、件数は列挙から数え直せる", () => {
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-form", type: "form", table: "items", fields: fieldIds(11) },
        {
          id: "item-detail",
          type: "detail_view",
          table: "items",
          actions: setActions(["primary", "primary", ...Array(6).fill(undefined)]),
        },
      ]),
    );
    expect(report.notices.map((n) => [n.rule, n.view, n.path, n.count])).toEqual([
      ["long_form_without_sections", "item-form", "/app/views/0/fields", 11],
      ["multiple_primary_actions", "item-detail", "/app/views/1/actions", 2],
      ["too_many_actions", "item-detail", "/app/views/1/actions", 8],
    ]);
  });

  test("入力のマニフェストを書き換えない", () => {
    const manifest = manifestWith([
      { id: "item-form", type: "form", table: "items", fields: fieldIds(11) },
    ]);
    const before = JSON.stringify(manifest);
    collectDesignNotices(manifest);
    expect(JSON.stringify(manifest)).toBe(before);
  });

  test("呼ぶたびに新しい配列を返す(返り値をいじっても次の呼び出しに漏れない)", () => {
    const first = collectDesignNotices(manifestWith([]));
    first.limits.push("x");
    first.not_counted.push({ what: "x", reason: "x" });
    const second = collectDesignNotices(manifestWith([]));
    expect(second.limits).toHaveLength(6);
    expect(second.not_counted).toHaveLength(1);
  });
});

describe("綴りと置き場", () => {
  test("返り値にも元のファイルにも禁じた3つの綴り(下の FORBIDDEN_WORDS)が無い", () => {
    const report = collectDesignNotices(
      manifestWith([
        { id: "item-form", type: "form", table: "items", fields: fieldIds(11) },
        {
          id: "item-detail",
          type: "detail_view",
          table: "items",
          actions: setActions(["primary", "primary", ...Array(6).fill(undefined)]),
        },
      ]),
    );
    expect(report.notices).toHaveLength(3);
    const text = `${JSON.stringify(report)}\n${readFileSync(SOURCE_PATH, "utf-8")}`;
    for (const word of FORBIDDEN_WORDS) {
      expect(text).not.toContain(word);
    }
  });

  test("src/kernel からの値 import が0件(型だけを取る)", () => {
    const source = readFileSync(SOURCE_PATH, "utf-8");
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
    expect(transpiled).not.toMatch(/from\s+["'][^"']*kernel/);
    expect(transpiled).not.toMatch(/import\s*\(\s*["'][^"']*kernel/);
    // 副作用だけの import(`import "…/kernel/…";`)と require の形も数える(値を取らなくても
    // kernel のモジュールを読み込み、そこに書かれた処理を走らせてしまうため)。
    expect(transpiled).not.toMatch(/import\s*["'][^"']*kernel/);
    expect(transpiled).not.toMatch(/require\s*\(\s*["'][^"']*kernel/);
    // 空振りでないこと: 元のソースには kernel からの型 import が実在する。
    expect(source).toMatch(/import type [^;]+from "\.\.\/kernel\/types\.ts"/);
  });

  test("【陽性対照】値 import は同じ変換のあとも残る(上の検査が恒真でない)", () => {
    // 行き先の綴りを組み立てて書く —— 逐語で書くと、層またぎの採取
    // (`scripts/kernel-import-drift.test.ts`)がこの文字列を本物の import と数えてしまう。
    const target = ["..", "kernel", "validate.ts"].join("/");
    const sample = `import { check } from "${target}";\ncheck({});\n`;
    const transpiled = new Bun.Transpiler({ loader: "ts" }).transformSync(sample);
    expect(transpiled).toMatch(/from\s+["'][^"']*kernel/);
  });

  test("【陽性対照】副作用だけの import と require も同じ変換のあとに残る(上の2式が恒真でない)", () => {
    const target = ["..", "kernel", "validate.ts"].join("/");
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const sideEffect = transpiler.transformSync(`import "${target}";\nexport const x = 1;\n`);
    expect(sideEffect).toMatch(/import\s*["'][^"']*kernel/);
    const required = transpiler.transformSync(
      `const mod = require("${target}");\nexport const x = mod;\n`,
    );
    expect(required).toMatch(/require\s*\(\s*["'][^"']*kernel/);
  });
});
