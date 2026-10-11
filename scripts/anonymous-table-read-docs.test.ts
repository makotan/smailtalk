/**
 * **未ログインの表ごとの読取・未ログインにだけ隠す項目・入口とログイン画面の場所 —— 説明書と手引きの波及の見張り**
 * (v21 の波及の段)。
 *
 * ## 何を固定するか
 *
 * 1. **説明書(`plugins/` の skill)に、AI が会話の口だけで使えるだけの書き方と限界が載っていること。**
 *    置き場は view-shape の `reference/view-keys.md`(書き方の全量)・`reference/cannot-do.md`(旧文の訂正)・
 *    diff-shape の `reference/op-required-keys.md`(規則のキー)・app-build の `SKILL.md`(入口の案内)。
 * 2. **公開の手引き `MANUAL.md` の偽になった行を消さずに、訂正を足していること。**
 * 3. **公開する文(公開用の5本と `plugins/`)に、この版の内部記号が1行も無いこと** ——
 *    既存の見張り(`public-docs-internal-symbols.test.ts`)の式に当たらない2種(単位の記号・穴の記号)を
 *    ここで見る(既存の見張りのファイルは書き換えない)。
 * 4. **説明書の版が 0.5.0 のままであること**(この版は公開しない)。
 *
 * ## しないこと
 *
 * - **文の正しさは、ここに挙げた綴りの有無でしか見ていない。**
 * - **説明書が実際に読まれて使われるかは測っていない。**
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = dirname(import.meta.dir);
const SKILLS = join(ROOT, "plugins", "smailtalk", "skills");

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...walk(path));
    } else {
      out.push(path);
    }
  }
  return out;
}

/** 本版の内部記号のうち、既存の見張りの式に当たらない2種。 */
const NEW_SYMBOLS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: "AN-G[0-9]", pattern: /AN-G[0-9]/ },
  { label: "H-V2[0-9]-", pattern: /H-V2[0-9]-/ },
];

const PUBLIC_FILES = ["README.md", "MANUAL.md", "TUTORIAL.md", "templates/CLAUDE.md", "LICENSE"];

describe("説明書: ログインしていない人に表ごと見せる書き方と限界", () => {
  const viewKeys = read(join(SKILLS, "view-shape", "reference", "view-keys.md"));
  const section = (() => {
    const start = viewKeys.indexOf("## ログインしていない人に表ごと見せる(`hidden_fields`)");
    if (start < 0) return "";
    const next = viewKeys.indexOf("\n## ", start + 1);
    return next < 0 ? viewKeys.slice(start) : viewKeys.slice(start, next);
  })();

  test("(S1) view-keys.md に節が在る", () => {
    expect(section.length).toBeGreaterThan(0);
  });

  test("(S2) 書き方: 表の読取規則・隠す項目の並び・書ける場所・適用の時点で断られる形", () => {
    for (const phrase of [
      '{ "target": "table", "table": "<表ID>", "can": ["read"], "hidden_fields": ["<項目ID>"] }',
      "`st_public` が無くても",
      "条件(`when`)を書いたときは、条件に合う行だけ",
      "`hidden_fields` を書けるのは `anonymous` の表の規則だけ",
      "隠した項目を消す(`remove_field`)ときは、同じ差分の `set_roles` で `hidden_fields` から外す",
      "項目のIDを変えると、`hidden_fields` の中も追随する",
      "未ログインの規則の条件(`when`)に、隠した項目は使えない",
    ]) {
      expect(section).toContain(phrase);
    }
  });

  test("(S3) 読めない表と、守りを外す差分の拒否", () => {
    for (const phrase of [
      "`st_owner` を持つ表",
      "`access_control` を宣言した表",
      "「自分」(`equals_current_user`)",
      "差分は通るが効かない",
      "守りを外す差分は、適用の前に拒否される",
    ]) {
      expect(section).toContain(phrase);
    }
  });

  test("(S4) 限界: 隠し忘れ・公開画面の絞り込み・参照の名前・file の ID・書き出したアプリ", () => {
    for (const phrase of [
      "後から足した項目は、足したときに `hidden_fields` へ書き足さなければ見える",
      "未ログインに見せる画面の絞り込み(`filter`)には、隠した項目を使わない",
      "「(見つかりません: 行ID)」",
      "`file` 型の値(ファイルのID)は、隠さなければ行に載る",
      "書き出したアプリ",
    ]) {
      expect(section).toContain(phrase);
    }
  });

  test("(S5) 画面: 参照の名前・入口・ログイン画面の場所", () => {
    for (const phrase of [
      "参照の列は、参照先の表も未ログインで読めるときは名前で出る",
      "`/apps/<アプリID>/login`",
      "並び順で最初のもの",
    ]) {
      expect(section).toContain(phrase);
    }
  });

  test("(S6) view-shape の cannot-do.md: 旧い引用を残し、(e) の訂正を足している", () => {
    const cannotDo = read(join(SKILLS, "view-shape", "reference", "cannot-do.md"));
    expect(cannotDo).toContain(
      "(e)**anonymous に read を書いても、その画面に行が出るとは限りません**",
    );
    const at = cannotDo.indexOf(
      "**【2026-09-27 訂正(この節では3本目)。上の引用も、上の2つの訂正の塊も消していない】**",
    );
    expect(at).toBeGreaterThan(cannotDo.indexOf("(e)**anonymous に read を書いても"));
    const tail = cannotDo.slice(at, cannotDo.indexOf("\n## ", at));
    for (const phrase of ["上の (e)", "今日は偽である", "`hidden_fields`", "view-keys.md"]) {
      expect(tail).toContain(phrase);
    }
  });

  test("(S7) diff-shape の規則のキー: anonymous の規則に hidden_fields を書けることを足している", () => {
    const keys = read(join(SKILLS, "diff-shape", "reference", "op-required-keys.md"));
    const at = keys.indexOf(
      '- **`anonymous` の規則は狭い** —— `target: "field"` を書けず、`can` は `read` だけである。',
    );
    expect(at).toBeGreaterThanOrEqual(0);
    const after = keys.slice(at, at + 1200);
    expect(after).toContain("`hidden_fields`");
    expect(after).toContain("view-keys.md");
  });

  test("(S8) app-build の SKILL.md: ログインしていない人にも見せたいときの案内がある", () => {
    const skill = read(join(SKILLS, "app-build", "SKILL.md"));
    expect(skill).toContain("ログインしていない人にも見せたいとき");
    expect(skill).toContain("view-shape の `reference/view-keys.md`");
  });
});

describe("公開の手引き MANUAL.md: 偽になった行を消さずに訂正を足す", () => {
  const manual = read(join(ROOT, "MANUAL.md"));

  test("(M1) 旧い行は消していない", () => {
    for (const line of [
      "| `st_public` | 立てた行だけ、ログインしていない相手にも読める |",
      "- ログイン前でも読める口が1本だけある。返るのは **アプリ名・ログイン前に見せると決めた画面の識別子と表示名・配色** だけで、",
      "`st_public` を持つ公開の表への読み取りだけは、ログインしていなくても公開行を返す。",
      "- **ログインしていない相手への配り方は、今日まで1つも変わっていない** ——",
    ]) {
      expect(manual).toContain(line);
    }
  });

  test("(M2) 訂正を足している(表ごとの読取・隠す項目・入口とログイン画面・画像)", () => {
    expect((manual.match(/【2026-09-27 訂正/g) ?? []).length).toBeGreaterThanOrEqual(4);
    for (const phrase of [
      '"hidden_fields"',
      "`/apps/<アプリID>/login`",
      "後から足した項目",
      "隠した項目を使わない",
      "読める行の画像",
    ]) {
      expect(manual).toContain(phrase);
    }
  });
});

describe("公開する文に本版の内部記号が無い", () => {
  test("(N1) 陽性対照: 2式は本版の記号に当たる", () => {
    expect(NEW_SYMBOLS.map(({ pattern }) => pattern.test("AN-G2"))).toEqual([true, false]);
    expect(NEW_SYMBOLS.map(({ pattern }) => pattern.test("H-V21-19"))).toEqual([false, true]);
  });

  test("(N2) 公開用の5本と plugins/ に 0行", () => {
    const files = [...PUBLIC_FILES.map((name) => join(ROOT, name)), ...walk(join(ROOT, "plugins"))];
    const hits: string[] = [];
    for (const file of files) {
      read(file)
        .split("\n")
        .forEach((line, index) => {
          for (const { label, pattern } of NEW_SYMBOLS) {
            if (pattern.test(line)) {
              hits.push(`${relative(ROOT, file)}:${index + 1}: [${label}]`);
            }
          }
        });
    }
    expect(hits).toEqual([]);
  });

  test("(N3) 説明書の版は 0.5.0 のまま", () => {
    const manifest = JSON.parse(
      read(join(ROOT, "plugins", "smailtalk", ".claude-plugin", "plugin.json")),
    );
    expect(manifest.version).toBe("0.5.0");
  });
});

// ---------------------------------------------------------------------------
// 入口の選び方の訂正(2026-09-28)。 旧文(並び順で最初のもの)を消さず、直後に訂正を足す。
// 公開する文(説明書と MANUAL.md)には内部の記号と【】を書かない。
// ---------------------------------------------------------------------------

/** 入口の訂正が書くこと(4か所で同じ綴り)。 */
const ENTRY_CORRECTION_PHRASES = [
  "訂正(2026-09-28。直前の行は消していない)",
  "`menu_listed` を `false` にしていないもの",
  "メニューに載せる一覧画面が1つも無いときだけ",
  "URL を直に開けば今日どおり開ける",
] as const;

/** 旧文の行(逐語の一部)と、その行の後ろ 600 文字の中に訂正が在ること。 */
function correctionAfter(text: string, oldLine: string): { old: boolean; slice: string } {
  const at = text.indexOf(oldLine);
  return { old: at >= 0, slice: at < 0 ? "" : text.slice(at, at + oldLine.length + 600) };
}

const ENTRY_DOCS: readonly {
  readonly label: string;
  readonly path: string;
  readonly oldLine: string;
}[] = [
  {
    label: "view-keys.md",
    path: join(SKILLS, "view-shape", "reference", "view-keys.md"),
    oldLine: "  画面の並び順で最初のものが出る。** その画面にはログインへの導線が出る。",
  },
  {
    label: "app-build/SKILL.md",
    path: join(SKILLS, "app-build", "SKILL.md"),
    oldLine:
      "   **未ログインに開いた一覧画面のうち並び順で最初のものが、アプリの入口 `/apps/<アプリID>` に出る。** ログイン画面は `/apps/<アプリID>/login` にある。",
  },
  {
    label: "cannot-do.md",
    path: join(SKILLS, "view-shape", "reference", "cannot-do.md"),
    oldLine:
      "**アプリの入口は、未ログインには最初の公開の一覧画面を出し、ログイン画面は `/apps/<アプリID>/login` に移った。**",
  },
  {
    label: "MANUAL.md",
    path: join(ROOT, "MANUAL.md"),
    oldLine:
      "  画面の並び順で最初のものが出る。ログイン画面は `/apps/<アプリID>/login` にある。ログイン前に見せる一覧画面が1つも無いアプリは、今日どおり入口でログイン画面が出る。",
  },
];

describe("入口の選び方の訂正(説明書3か所と MANUAL.md)", () => {
  for (const doc of ENTRY_DOCS) {
    test(`(E-${doc.label}) 旧文を消さず、直後に訂正が在り、内部の記号と【】を書いていない`, () => {
      const { old, slice } = correctionAfter(read(doc.path), doc.oldLine);
      expect(old).toBe(true);
      const tail = slice.slice(doc.oldLine.length);
      for (const phrase of ENTRY_CORRECTION_PHRASES) {
        expect(tail).toContain(phrase);
      }
      const at = tail.indexOf(ENTRY_CORRECTION_PHRASES[0]);
      const correction = tail.slice(at, at + 400);
      expect({
        記号: [/AN-G[0-9]/, /EN-G[0-9]/, /H-V2[0-9]-/, /V2[0-9]-M[0-9]/, /D-V2[0-9]/, /ADR-/]
          .filter((pattern) => pattern.test(correction))
          .map(String),
        見出しの括弧: correction.includes("【"),
      }).toEqual({ 記号: [], 見出しの括弧: false });
    });
  }
});
