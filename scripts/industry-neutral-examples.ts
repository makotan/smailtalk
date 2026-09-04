/**
 * `V5-M14`(汎用化の軸・面5): **差し替えの対照表**(`ADR-0162` 限定4/5 / `ADR-0163` 限定5/6 が
 * 記録に残すことを求めている対照表を、**データとして持つ**)。
 *
 * **検査は `scripts/industry-neutral-examples.test.ts` が当てる。**
 * **差し替えを実際に当てるのもこの表である**(手で書き換えず、この表から機械的に適用した)。
 */

/** 差し替え1件。**`before` は着手前の逐語、`after` は着手後の逐語**(`ADR-0162` 限定4 / `ADR-0163` 限定5 の対照表)。 */
export type Replacement = {
  /** 審査単位。 */
  readonly unit: "G-G15" | "G-G16" | "G-G17" | "G-G18" | "G-G19";
  readonly file: string;
  /** 04 §4-5 の表が名指しした行か(`false` = 本タスクが隣接ゆえに足した分。記録に書く)。 */
  readonly named: boolean;
  /** 着手前の行番号(**ずれたら「当時 → 今日」を記録に両方書く**)。 */
  readonly line: number;
  readonly before: string;
  readonly after: string;
  /** **意図して残した業種依存語**(理由は `keepReason`)。 */
  readonly keep?: readonly string[];
  readonly keepReason?: string;
};

export const REPLACEMENTS: readonly Replacement[] = [
  // ---------------------------------------------------------------------------
  // `G-G15` AI に渡す語彙の説明文(`src/mcp/vocabulary.ts`)
  // ---------------------------------------------------------------------------
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 358,
    before: "(「在庫が0のときだけ隠す」のような任意の条件は今日も書けません)。",
    after: "(「ある項目の値が0のときだけ隠す」のような任意の条件は今日も書けません)。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 396,
    before:
      "**and / or / not の組み合わせは1つも書けません**(「在庫が0 かつ 販売中」は書けません)。",
    after:
      "**and / or / not の組み合わせは1つも書けません**(「ある項目が0 かつ 別の項目が特定の値」は書けません)。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 568,
    before:
      "**「注文明細ができたら、在庫の増減明細を1行積み、同時に商品の在庫残高を更新する」を1回の発火で書けるのはこのモードだけです**",
    after:
      "**「子の行ができたら、増減の履歴テーブルに1行積み、同時に参照先の行の残数を更新する」を1回の発火で書けるのはこのモードだけです**",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 590,
    before:
      "(決済イベントのように所有者を持たない表からの発火でも、注文の持ち主としてポイントを積めます)。",
    after:
      "(外部から受け取ったイベントのように所有者を持たない表からの発火でも、参照先の行の持ち主として記録を積めます)。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 610,
    before:
      "**このモードでも演算はカーネルに1つもありません** —— 在庫の現在値を読んで stock - qty を計算するのは島の JS で、",
    after:
      "**このモードでも演算はカーネルに1つもありません** —— 今の値を読んで「今の値 − 変化分」を計算するのは島の JS で、",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 620,
    before: "**別行への在庫減算や親行への集計はここではできません**",
    after: "**別の行の値を減らすことや、親の行への集計はここではできません**",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 622,
    before: "別のテーブルの行の在庫を減らす形は、(iii) の write_ops で書けます",
    after: "別のテーブルの行の値を減らす形は、(iii) の write_ops で書けます",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 669,
    before: "(会員ごとのポイント履歴を、その会員ぶんだけ渡す、という形です)。",
    after: "(利用者ごとの履歴を、その利用者ぶんだけ渡す、という形です)。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 689,
    before:
      "注文確定(order 1行 + 明細 N行 + 在庫更新 M件)のように、複数テーブル・複数行を原子的に書くための入口です。",
    after:
      "1つの手続きの確定(親の行1件 + 子の行 N件 + 参照先の行の更新 M件)のように、複数テーブル・複数行を原子的に書くための入口です。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 694,
    before: "他が先に変更していれば版が合わずバッチ全体が巻き戻ります(在庫の売り越し防止の土台)。",
    after:
      "他が先に変更していれば版が合わずバッチ全体が巻き戻ります(読んでから書くまでの間に他が更新した分を取りこぼさないための土台)。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 712,
    before:
      "**したがって「今の在庫を読んで、その値から引く」形は、ワークフローのアクションの値(values)には書けません**",
    after:
      "**したがって「今の値を読んで、その値から引く」形は、ワークフローのアクションの値(values)には書けません**",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 734,
    before:
      "**在庫減算 stock - qty のような演算はバッチが行うのではなく、呼び出し側が計算した結果の値を渡します**",
    after:
      "**「今の値 − 変化分」のような演算はバッチが行うのではなく、呼び出し側が計算した結果の値を渡します**",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 1130,
    before: "「金額が1000円以上の注文だけ処理して」「在庫が10を下回った商品だけ印を付けて」",
    after: "「金額が1000円以上の行だけ処理して」「残数が10を下回った行だけ印を付けて」",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 1344,
    before: "「本人に見せるが本人には書かせない」(ポイント残高・ランク)を表せるのはそのためです。",
    after: "「本人に見せるが本人には書かせない」(集計された残高・ランク)を表せるのはそのためです。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 1353,
    before:
      "(e)**状態の順番(取り消し済みの注文を「発送した」にする等)は今日も1つも検査できません。**",
    after: "(e)**状態の順番(取り消し済みの行を「完了」にする等)は今日も1つも検査できません。**",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 2424,
    before:
      "**数値や文字列の大小をワークフローの条件に書く手段は1つも無い**(「在庫が10未満なら」「金額が1000以上なら」は書けない)。",
    after:
      "**数値や文字列の大小をワークフローの条件に書く手段は1つも無い**(「ある項目が10未満なら」「金額が1000以上なら」は書けない)。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2445,
    before:
      '例:「3日間 pending_payment のままの注文を打ち切る」は、trigger に { "table": "orders", "older_than": { "field": "placed_on", "days": 3 } } を書いて',
    after:
      '例:「3日間 waiting のままの行を打ち切る」は、trigger に { "table": "requests", "older_than": { "field": "opened_on", "days": 3 } } を書いて',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2446,
    before:
      '行を絞り、アクションに when: { "field": "status", "equals": "pending_payment" } を書いて絞る。',
    after: '行を絞り、アクションに when: { "field": "status", "equals": "waiting" } を書いて絞る。',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2453,
    before: "発火元以外の行を狙える —— 決済の受信行→対応する order、明細→参照先 product など)/ ",
    after: "発火元以外の行を狙える —— 受信した行→対応する親の行、子の行→参照先の行 など)/ ",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2616,
    before:
      "(在庫の増減明細を1行積みながら商品の在庫残高を更新する、のように**複数テーブルへ1原子で書ける唯一の形**)。",
    after:
      "(増減の履歴テーブルに1行積みながら参照先の行の残数を更新する、のように**複数テーブルへ1原子で書ける唯一の形**)。",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2623,
    before: "(別行への在庫減算・親行への集計は target 語彙であってここには無い",
    after: "(別の行の値を減らすこと・親行への集計は target 語彙であってここには無い",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2650,
    before: '"id": "allocate-stock",',
    after: '"id": "reserve-remaining",',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2651,
    before: '"name": "注文明細ができたら在庫を引き当てる",',
    after: '"name": "子の行ができたら参照先の残数を引き当てる",',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2652,
    before: '"trigger": { "type": "on_create", "table": "order_line" },',
    after: '"trigger": { "type": "on_create", "table": "child_line" },',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 2653,
    before:
      '"actions": [{ "action": "run_function", "function": "allocate-stock", "write_ops": true }],',
    after:
      '"actions": [{ "action": "run_function", "function": "reserve-remaining", "write_ops": true }],',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: false,
    line: 2658,
    before: "「きっかけの行(source: record)」と「在庫を持つテーブル(source: table)」を受け取り、",
    after: "「きっかけの行(source: record)」と「残数を持つテーブル(source: table)」を受け取り、",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2660,
    before:
      '[{ "op": "create", "table": "stock_move", "values": { "product": "<商品の_id>", "delta": -3, "source": "<注文明細の_id>" } },',
    after:
      '[{ "op": "create", "table": "change_log", "values": { "target_row": "<参照先の_id>", "delta": -3, "source": "<子の行の_id>" } },',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2661,
    before:
      '{ "op": "update", "table": "product", "target": "<商品の_id>", "if_match": "<読んだときの_updated_at>", "values": { "stock": 7 } }]',
    after:
      '{ "op": "update", "table": "parent_row", "target": "<参照先の_id>", "if_match": "<読んだときの_updated_at>", "values": { "remaining": 7 } }]',
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2662,
    before: "在庫が足りないなら op を返さずに例外で落とせばよい",
    after: "残数が足りないなら op を返さずに例外で落とせばよい",
  },
  {
    unit: "G-G15",
    file: "src/mcp/vocabulary.ts",
    named: true,
    line: 2663,
    before: "その発火元のレコード書込(注文明細)ごと成立しない。",
    after: "その発火元のレコード書込(子の行)ごと成立しない。",
  },

  // ---------------------------------------------------------------------------
  // `G-G16` バッチ書込ツールの説明文とコメント(`src/mcp/tools/write.ts`)
  // ---------------------------------------------------------------------------
  {
    unit: "G-G16",
    file: "src/mcp/tools/write.ts",
    named: true,
    line: 905,
    before: "order 1行 + order_line N行 + product.stock 更新",
    after: "親の行1件 + 子の行 N件 + 参照先の行の残数更新",
  },
  {
    unit: "G-G16",
    file: "src/mcp/tools/write.ts",
    named: true,
    line: 906,
    before: "M件のような「チェックアウトの原子書込」を、部分適用ゼロで書ける唯一の入口である。",
    after: "M件のような「1つの手続きの原子書込」を、部分適用ゼロで書ける唯一の入口である。",
  },
  {
    unit: "G-G16",
    file: "src/mcp/tools/write.ts",
    named: true,
    line: 913,
    before: "在庫減算 stock - qty の**演算は呼び出し側**が行い(カーネルは式言語を持たない)、",
    after: "「今の値 − 変化分」の**演算は呼び出し側**が行い(カーネルは式言語を持たない)、",
  },
  {
    unit: "G-G16",
    file: "src/mcp/tools/write.ts",
    named: true,
    line: 914,
    before: "update op には計算済みの新 stock 値 + if_match(売り越し防止の CAS)を渡す。",
    after: "update op には計算済みの新しい値 + if_match(取りこぼし防止の CAS)を渡す。",
  },
  {
    unit: "G-G16",
    file: "src/mcp/tools/write.ts",
    named: true,
    line: 921,
    before: "注文確定(order 1行 + 明細 N行 + 在庫更新 M件)のように、複数のテーブル・複数の行を",
    after:
      "1つの手続きの確定(親の行1件 + 子の行 N件 + 参照先の行の更新 M件)のように、複数のテーブル・複数の行を",
  },
  {
    unit: "G-G16",
    file: "src/mcp/tools/write.ts",
    named: true,
    line: 928,
    before: "(黙って上書きしない保護 = 在庫の売り越しもこれで防ぎます)。",
    after:
      "(黙って上書きしない保護 = 読んでから書くまでの間に他が更新した分の取りこぼしもこれで防ぎます)。",
  },
  {
    unit: "G-G16",
    file: "src/mcp/tools/write.ts",
    named: false,
    line: 930,
    before: "在庫を減らすといった計算(例: 残り = 現在庫 - 数量)はこのツールではできません。",
    after: "値を減らすといった計算(例: 残り = 今の値 - 変化分)はこのツールではできません。",
  },

  // ---------------------------------------------------------------------------
  // `G-G17` サーバ層の認可判定のコメント(`src/server/owner-scope.ts`)
  // ---------------------------------------------------------------------------
  {
    unit: "G-G17",
    file: "src/server/owner-scope.ts",
    named: true,
    line: 566,
    before: "顧客スコープテーブル(cart/order 等)。",
    after: "顧客スコープテーブル(本人ごとに行が分かれる表)。",
    keep: ["顧客"],
    keepReason:
      "「顧客」はロール `customer` の表示名であって業種の例示ではない。`V5-M17`(利用者の種類)が2度目に触る箇所であり、面5 の射程ではない。",
  },
  {
    unit: "G-G17",
    file: "src/server/owner-scope.ts",
    named: true,
    line: 569,
    before: "運営テーブル(product 管理・全注文一覧)。",
    after: "運営テーブル(運営だけが管理する表・全員分の一覧)。",
  },

  // ---------------------------------------------------------------------------
  // `G-G18` スキーマの注釈(`schemas/manifest.schema.json`)。`ADR-0162` 限定1〜7
  // ---------------------------------------------------------------------------
  {
    unit: "G-G18",
    file: "schemas/manifest.schema.json",
    named: true,
    line: 352,
    before: "任意の条件 (在庫が0のときだけ隠す等) は書けない。",
    after: "任意の条件 (ある項目の値が0のときだけ隠す等) は書けない。",
  },
  {
    unit: "G-G18",
    file: "schemas/manifest.schema.json",
    named: true,
    line: 1070,
    before: "クロス行更新・親集計 = 在庫減算 stock-qty を別行へ・親行への集計 subtotal=Σ",
    after: "クロス行更新・親集計 = ある行の値の減算を別行へ・親行への集計 subtotal=Σ",
  },
  {
    unit: "G-G18",
    file: "schemas/manifest.schema.json",
    named: true,
    line: 1075,
    before: "**カーネルは演算を1つも持たない** —— stock - qty を計算するのは島の JS であり、",
    after: "**カーネルは演算を1つも持たない** —— 「今の値 − 変化分」を計算するのは島の JS であり、",
  },

  // ---------------------------------------------------------------------------
  // `G-G19` カーネルのコメント(`src/kernel/`)。`ADR-0163` 限定1〜7
  // ---------------------------------------------------------------------------
  {
    unit: "G-G19",
    file: "src/kernel/batch.ts",
    named: false,
    line: 5,
    before: "`writeRecords` を提供する。order 1行 + order_line N行 +",
    after: "`writeRecords` を提供する。親の行1件 + 子の行 N件 +",
  },
  {
    unit: "G-G19",
    file: "src/kernel/batch.ts",
    named: true,
    line: 6,
    before: "product.stock 更新 M件のような「チェックアウトの原子書込」を、部分適用ゼロで書ける。",
    after: "参照先の行の残数更新 M件のような「1つの手続きの原子書込」を、部分適用ゼロで書ける。",
  },
  {
    unit: "G-G19",
    file: "src/kernel/batch.ts",
    named: false,
    line: 16,
    before: "CAS 失敗(版不一致)ならバッチ全体を巻き戻す(売り越し防止の土台)。",
    after: "CAS 失敗(版不一致)ならバッチ全体を巻き戻す(更新の取りこぼし防止の土台)。",
  },
  {
    unit: "G-G19",
    file: "src/kernel/batch.ts",
    named: true,
    line: 18,
    before:
      "`validateInput` を通る。在庫減算 `stock - qty` の**演算は呼び出し側 or Route B が行い、",
    after: "`validateInput` を通る。「今の値 − 変化分」の**演算は呼び出し側 or Route B が行い、",
  },
  {
    unit: "G-G19",
    file: "src/kernel/batch.ts",
    named: true,
    line: 23,
    before:
      "バッチの read-then-CAS-update(在庫を読んで CAS で減算)は、ADR-0018 が「busy_timeout=0 で",
    after:
      "バッチの read-then-CAS-update(今の値を読んで CAS で減算)は、ADR-0018 が「busy_timeout=0 で",
  },
  {
    unit: "G-G19",
    file: "src/kernel/batch.ts",
    named: false,
    line: 52,
    before: "版不一致ならバッチ全体が巻き戻る(売り越し防止)。",
    after: "版不一致ならバッチ全体が巻き戻る(更新の取りこぼし防止)。",
  },
  {
    unit: "G-G19",
    file: "src/kernel/types.ts",
    named: false,
    line: 209,
    before: "**「在庫が0のときだけ隠す」は今日も明日も書けない。**",
    after: "**「ある項目の値が0のときだけ隠す」は今日も明日も書けない。**",
  },
  {
    unit: "G-G19",
    file: "src/kernel/types.ts",
    named: false,
    line: 1290,
    before: "を order_line 行自身に書く。",
    after: "を子の行自身に書く。",
  },
  {
    unit: "G-G19",
    file: "src/kernel/types.ts",
    named: false,
    line: 1300,
    before: "(在庫減算・親集計)は M4 の target 語彙であって Route B の射程外**",
    after: "(別の行の値の減算・親集計)は M4 の target 語彙であって Route B の射程外**",
  },
  {
    unit: "G-G19",
    file: "src/kernel/types.ts",
    named: true,
    line: 1319,
    before: "**カーネルは演算を1つも持たない** —— `stock - qty` を計算するのは島の JS であり、",
    after: "**カーネルは演算を1つも持たない** —— 「今の値 − 変化分」を計算するのは島の JS であり、",
  },
  {
    unit: "G-G19",
    file: "src/kernel/workflow-runner.ts",
    named: true,
    line: 1314,
    before: "**演算を1つも持たない**(限定 A2)—— `stock - qty` は島の JS が計算済みであり、",
    after: "**演算を1つも持たない**(限定 A2)—— 「今の値 − 変化分」は島の JS が計算済みであり、",
  },
];
