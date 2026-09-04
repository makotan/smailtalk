import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { loadScenario, parseScenario, scenariosDir } from "./scenario.ts";

const SAMPLE = `---
id: sample
title: サンプル
allowed_tools: mcp__smailtalk__*, ToolSearch
disallowed_tools: Bash, Read, Write
expected_absent_tools: Read
---

## 目的

ここは自由文。判定には使わない。

## ターン1

> 読書記録アプリを作って。

## ターン2

> ブラウザで見たよ。
> 追加で薦めてくれた人も記録したい。
`;

describe("parseScenario", () => {
  test("frontmatter を読む", () => {
    const s = parseScenario(SAMPLE);
    expect(s.id).toBe("sample");
    expect(s.title).toBe("サンプル");
    expect(s.allowedTools).toEqual(["mcp__smailtalk__*", "ToolSearch"]);
    expect(s.disallowedTools).toEqual(["Bash", "Read", "Write"]);
    expect(s.expectedAbsentTools).toEqual(["Read"]);
  });

  test("ターン本文は引用行だけを拾い、複数行は改行で繋ぐ", () => {
    const s = parseScenario(SAMPLE);
    expect(s.turns).toEqual([
      "読書記録アプリを作って。",
      "ブラウザで見たよ。\n追加で薦めてくれた人も記録したい。",
    ]);
  });

  test("目的セクションはターンに混ざらない", () => {
    const s = parseScenario(SAMPLE);
    expect(s.purpose).toContain("自由文");
    expect(s.turns.join("")).not.toContain("自由文");
  });

  test("frontmatter が無ければ落ちる", () => {
    expect(() => parseScenario("## ターン1\n\n> あ\n")).toThrow(/frontmatter/);
  });

  test("ターンが1つも無ければ落ちる", () => {
    expect(() => parseScenario("---\nid: x\ntitle: y\nallowed_tools: A\n---\n\n## 目的\n")).toThrow(
      /ターン/,
    );
  });

  test("必須キーが欠けたら落ちる", () => {
    expect(() => parseScenario("---\nid: x\n---\n\n## ターン1\n\n> a\n")).toThrow(/title/);
  });
});

describe("scenarios/ に置かれた実物", () => {
  const files = readdirSync(scenariosDir()).filter((f) => f.endsWith(".md"));

  // V0-P5 の5本 + V0-P7-T04 の再実地確認 1本(`t04-improvements.md`)
  // + V1-M0-T01 の1本(`record-correction.md`。F-13 / F-37 / F-38 の観測)
  // + V1-M0-T07 の2本(`view-shaping.md` = T02 / T03 / T09 / T10(a) を発火させる /
  //   `app-id-conflict.md` = F-25 の衝突エラーを実際に発火させる)。
  // + V1-M1-T07-a の4本(未到達経路の誘発。`blind-session-prep.md` = 別セッションで
  //   アプリを作る下ごしらえ / `blind-broken-reference.md` = F-19 参照切れ /
  //   `system-table-write.md` = システムテーブルのカーネル拒否 /
  //   `stale-record-id.md` = delete_record の異常系)。
  // + V1-M1-T06 の3本(破壊的変更の運用フロー。`destructive-type-change.md` =
  //   change_field の型変換 / `destructive-field-removal.md` = remove_field による
  //   値の永久消失 / `destructive-consent-granted.md` = 同意付与後の apply → 検証 → undo)。
  // + V1-M1-T07-b の4本(T06 が残した2つの穴を埋める。`unconvertible-value-rejection.md`
  //   = 変換不能値による拒否を実地で発火させる(動機が語彙外だったため apply 未到達)/
  //   `unconvertible-value-sortable.md` = 同じ拒否を語彙内の動機(並べ替え)で再試行し、
  //   `_id` を使った自己修正を観測する / `destructive-removal-applied.md` =
  //   同意付与後に remove_field を実際に適用しきる(削除系 apply の実地初例)/
  //   `remove-view-then-table.md` = remove_view → remove_table の順序組み立て
  //   (ADR-0012 §申し送り3 の履行))。
  // + V1-M2-T05 の3本(ワークフロー語彙の実地検証。`t05-workflow-lifecycle.md` =
  //   会話のみでワークフロー作成 → 動作確認 → undo が完遂するか /
  //   `t05-external-send-refusal.md` = 外部送信の依頼に対する断り分け
  //   (「自動化は無い」→「自動化はあるが外部送信は無い」)/
  //   `t05-workflow-failure-visible.md` = 失敗が理由付きで履歴に残ることの E2E)。
  // + V1-M2-T05g の1本(`t05-workflow-undo.md` = undo を名指しする版の lifecycle。
  //   既存の `t05-workflow-lifecycle.md` のターン4「取り消して」は undo と
  //   remove_workflow のどちらでも正しく応じられる問い方であり、3世代9試行のうち
  //   undo が観測されたのは1回だけだった。undo 経路を安定して観測するために足した)。
  // + V1-M6 着手ゲート・条件②の4本(F-7 の独立再観測。`agg-signup-monthly.md` =
  //   count/月 をワークフローで保持できるか / `agg-sales-by-category.md` =
  //   sum/カテゴリ を on_create 走行合計で保持できるか / `agg-avg-rating.md` =
  //   avg/商品 を ai_transform に計算させられるか / `agg-organic-compare.md` =
  //   集計語を使わずに集計需要が自然発生するか)。いずれも現行カーネル(workflow /
  //   ai_transform)に逃げ道が無いことを敵対的に再検査する。記録は
  //   `docs/plan/v1/records/v1-m6-gate2.md`。
  // + V1-M6-T05 の1本(`t05-function-island-lifecycle.md` = 会話のみでコードの島
  //   (関数リソース + run_function)の追加 → 動作確認(自己更新集計)→ undo が
  //   完遂するか。ADR-0024。T05 の完了条件そのもの)。
  // + V1-M9-T09 の1本(`delete-app-mistaken.md` = 間違えて作ったアプリを消したい。
  //   `delete_app` を呼ぶ前に消える中身を人間に見せて同意を取るか / 取り消せないことを
  //   正直に言うか。ADR-0031)。
  // + V1-M9-T05 の1本(`redo-overshot-undo.md` = undo したが戻しすぎた。redo を使う前に
  //   preview_redo で消える/戻るものを人間に見せて同意を取るか / 「redo があるから安全」と
  //   誤って説明しないか。ADR-0032)。
  // + V1-M9-T13(2) の1本(`workflow-type-mismatch.md` = ワークフローで型の合わない列へ書こうと
  //   する。適用時に機構が型不整合を拒否するか / hint が正しい直し方へ導くか / 型が合う書き込みは
  //   通す(過剰拒否なし)。ADR-0029)。
  // + V2-M7-T04 の1本(`ec-catalog-cart.md` = D-M7a ハイブリッドのライブ側。人間の自然な
  //   会話だけで AI にリファレンス EC の代表スライス — カタログ(商品/カテゴリ table + 公開
  //   list_view)/ カート(cart/cart_line table + 商品画面の actions 起点)/ 注文(order/
  //   order_line table + on_create ワークフロー)— を既存語彙だけで組ませる。
  //   記録は `docs/plan/v2/records/v2-m7.md` §1 V2-M7-T04)。
  // + V3-M7-T04 の1本(`t04-design-request.md` = ライブ mcp-trial のデザイン指定側。
  //   参照アプリ `ref-ec` に対し、アプリ全体の見た目(ターン1)/ 画面ごとの調整(ターン2)/
  //   **逃げ道に当たる要求**(ターン3)を人間の言葉だけで頼み、**実際の AI が MCP 経由で
  //   何往復で反映するか**と、**`D-2`(逃げ道は owner 専用)の帰結**を実測する。
  //   記録は `docs/plan/v3/records/v3-m7-t04.md`)。
  // + V8-M50 の1本(`shared-lending-app.md` = 4本目の説明書(`app-build`)を配ったことで
  //   何が変わるかを本物の AI で測る2腕比較の台。**複数人で共有するアプリ**(表への関門と
  //   名簿と役割)を会話だけで1本作り切らせる。**このシナリオだけが `Skill` を
  //   `allowed_tools` にも `disallowed_tools` にも書かない** —— 腕の別は `run.ts` の
  //   `--skill allow|deny` が付ける。記録は `docs/plan/v8/records/v8-m50-prep.md`)。
  // 件数を固定しているのは、シナリオを1本消して1本足したときに
  // 「同じ本数のまま中身が入れ替わる」ことに気づけるようにするためである。
  test("35本ある", () => {
    expect(files.length).toBe(35);
  });

  // -------------------------------------------------------------------------
  // V3-M7-T04: `length` だけを固定した検査の穴を塞ぐ
  //
  // **出所**: `docs/plan/v3/records/v3-m7.md` §2a-6 の裁定7(逐語「**`V3-M7-T04` が2つとも
  // 行う** —— **(i) シナリオ追加に伴う本数の更新、(ii) 穴を塞ぐ強化。**」)。**強化の形は
  // `V3-M7-T05` が他の2件(`web/test/theme-candidates.test.ts` の候補3件 /
  // `web/test/preset-coverage.test.ts` の要求60件)に施したのと同じ** ——
  // **本数だけでなく、要素の名前の集合を固定する。**
  //
  // **何が素通りしていたか**: 上の「34本ある」は `files.length` だけを固定している。
  // **シナリオIDそのものは1つも固定されていなかった**ので、**`bootstrap.md` を別の名前へ
  // 改名しても、1本消して1本足しても、34本のままなら全部緑だった。** シナリオの集合は
  // 「どの経路を実地で観測したか」の台帳そのものであり(上のコメント群が V0-P5 以来
  // 出所つきで積み上げてきたもの)、**中身が黙って入れ替わることは台帳の書き換えである。**
  //
  // **`length` の固定を消さないのは意図である** —— 2つは別のことを言っている。件数の固定は
  // 「本数が動いたらコメント群を書き足せ」であり、名前の固定は「中身が入れ替わったら気づけ」である。
  // -------------------------------------------------------------------------

  test("V3-M7-T04: シナリオIDの集合を**名前で**固定する(本数のままの改名・入れ替えを素通りさせない)", () => {
    // **ディレクトリの読み出し順は環境依存なので、並べ替えてから突き合わせる**
    // (`readdirSync` の順序はファイルシステムの都合であって、台帳の順序ではない)。
    expect([...files].map((f) => f.replace(/\.md$/, "")).sort()).toEqual([
      "agg-avg-rating",
      "agg-organic-compare",
      "agg-sales-by-category",
      "agg-signup-monthly",
      "app-id-conflict",
      "blind-broken-reference",
      "blind-session-prep",
      "bootstrap",
      "broken-reference",
      "delete-app-mistaken",
      "destructive-consent-granted",
      "destructive-field-removal",
      "destructive-removal-applied",
      "destructive-type-change",
      "ec-catalog-cart",
      "error-self-correction",
      "out-of-vocabulary",
      "record-correction",
      "redo-overshot-undo",
      "remove-view-then-table",
      "shared-lending-app",
      "stale-record-id",
      "system-table-write",
      "t04-design-request",
      "t04-improvements",
      "t05-external-send-refusal",
      "t05-function-island-lifecycle",
      "t05-workflow-failure-visible",
      "t05-workflow-lifecycle",
      "t05-workflow-undo",
      "unconvertible-value-rejection",
      "unconvertible-value-sortable",
      "undo-consent",
      "view-shaping",
      "workflow-type-mismatch",
    ]);
  });

  test("すべてパースでき、id はファイル名と一致する", () => {
    for (const f of files) {
      const s = loadScenario(join(scenariosDir(), f));
      expect(s.id).toBe(f.replace(/\.md$/, ""));
      expect(s.turns.length).toBeGreaterThan(0);
    }
  });

  test("すべてのシナリオがファイル系ツールを禁止している(cp-5.md §0-(a) の隔離条件)", () => {
    for (const f of files) {
      const s = loadScenario(join(scenariosDir(), f));
      for (const forbidden of ["Bash", "Read", "Write", "Edit", "Grep", "Glob", "Task"]) {
        expect(s.disallowedTools).toContain(forbidden);
      }
    }
  });

  test("すべてのシナリオが ToolSearch を許可している(禁止が効いた証拠を生ログに残すため)", () => {
    for (const f of files) {
      const s = loadScenario(join(scenariosDir(), f));
      expect(s.allowedTools).toContain("ToolSearch");
    }
  });

  test("broken-reference は get_manifest を実効一覧から外している", () => {
    const s = loadScenario(join(scenariosDir(), "broken-reference.md"));
    expect(s.allowedTools).not.toContain("mcp__smailtalk__get_manifest");
    expect(s.disallowedTools).toContain("mcp__smailtalk__get_manifest");
    expect(s.expectedAbsentTools).toContain("mcp__smailtalk__get_manifest");
  });

  // V1-M0-T07 の要件6。既存アプリの存在を AI が知る経路を全部塞がないと
  // `create_app` の衝突エラーが発火せず、T04 が足した hint は今回も読まれないまま終わる
  // (001-t04-improvements で実際にそうなった)。4つのうち1つでも残っていれば
  // AI は呼ぶ前に気付いて止まりうるので、4つまとめて固定する。
  test("app-id-conflict は既存アプリを照会できるツールを4つとも実効一覧から外している", () => {
    const s = loadScenario(join(scenariosDir(), "app-id-conflict.md"));
    for (const tool of ["list_apps", "get_manifest", "get_changelog", "list_records"]) {
      const name = `mcp__smailtalk__${tool}`;
      expect(s.allowedTools).not.toContain(name);
      expect(s.disallowedTools).toContain(name);
      expect(s.expectedAbsentTools).toContain(name);
    }
    // 衝突を起こすには create_app 自体は呼べなければならない。
    expect(s.allowedTools).toContain("mcp__smailtalk__create_app");
  });
});
