/**
 * **集計表の計算**(`V8-M8`。台帳 `Q-G1` / `Q-G2` / `Q-G3` / `Q-G4` / `Q-G35`。
 * ユーザ決定 `D-V8-5` / `D-V8-120` / `D-V8-122`。門A 本審査 = `V8-M7`。
 * 審査記録 `docs/plan/v8/records/v8-m7.md`)。
 *
 * ## 集計は JS のメモリ上で行う。**SQL に `GROUP BY` を1文字も書かない**
 *
 * **理由は3つあり、どれも判定に接地している。**
 *
 * 1. **`D-V8-4`(見る人ごとに数が変わる)と `D-V8-5`(毎回計算する)を満たすには、
 *    `V8-M10` で可視性の post-filter を通した**あと**の行集合の上で束ねる必要がある。**
 *    **SQL で束ねると、post-filter のあとに束ね直せない**(束ねた結果からは元の行が
 *    復元できない)。
 * 2. **`ADR-0043` 限定6 が「絞り込みはどの経路でも同一意味論」を要求している。**
 *    **実装を1本にすれば、その義務は構造的に満たされる** —— 2本持つと必ず割れる。
 *    (限定6 の逐語は「メモリ経路」を名指ししていた。**その2本目は SQ-M4 で消えた**が、
 *    「1本にすれば構造的に満たされる」というここの理由づけは1バイトも変わらない。)
 * 3. **`bun:sqlite` で `strftime` が使えるかを `V8-M7` は1度も確かめていない**
 *    (`v8-m7.md` §11 の 26)。**使わなければ確かめる必要が無い。**
 *
 * **【`V8-M7` の申し送り §10-1 の2 の見立てと違う形を採っている。隠さない】**
 * **申し送りは「カーネルの SQL に日付を丸める関数が初めて入る」と書いた。**
 * **本実装は SQL に1文字も入れていない。** **理由は上の3点である。**
 *
 * ## 行の読み出しは既存の経路をそのまま使う
 *
 * **`readRecordList(source, manifest, tableId, { filter })` を1回呼ぶだけである。**
 * **`filter` はそのまま渡す** —— **ユーザテーブルでもシステムテーブルの投影でも
 * `compileFilter` が既存の意味論で解釈する**(SQ-M4 で読取が SQL 1本になった。
 * かつてはシステムテーブルだけ `applyOptions` という別の実装が解釈していた)。**
 * **集計表専用のフィルタコンパイラを1本も作っていない** —— **したがって葉演算子は今日も
 * 5種ちょうどで、ネストの上限(`MAX_FILTER_DEPTH = 8`)もそのまま効く。**
 * **新しい読み出し関数を1本も作っていない。**
 *
 * ## 何を掛けていないか(**必ず読むこと**)
 *
 * - **可視性(誰に何が見えるか)を1つも掛けていない**(`V8-M8` の範囲)——
 *   **掛けるのは `V8-M10` である。** **`judgeRoleAccess` も `projectForRoleFields` も
 *   `st_owner` も `st_public` も、このファイルに1つも現れない**(機械的な固定は
 *   `src/server/report-declaration-boundary.test.ts` の (28))。
 *   **`V8-M10` はここに post-filter を1枚挟むことになる。**
 * - **上限(群の件数の頭打ち)を1つも掛けていない**(同じく `V8-M10`)——
 *   **群が何万件でも全部返る。**
 * - **【2026-08-16 訂正(`V8-M13-T04`。台帳 `Q-G30`)。上の2項目を1バイトも書き換えていない】**
 *   **上の2項目の将来形は今日はもう将来ではない** —— **`V8-M10` が両方とも掛けた。**
 *   **集計の母集団には、その要求をした人が読める行だけが入るので、見る人によって数が変わる**
 *   (掛かる場所は今日も**このファイルの外**である —— 本ファイルには `judgeRoleAccess` も
 *   `projectForRoleFields` も今日も1つも現れず、`report-declaration-boundary.test.ts` の (28)
 *   は今日も反転していない)。**群と読む行の上限も掛かっている**
 *   (**上限の定数も、それを見る述語も、このファイルには今日も1つも無い** ——
 *   **どちらもサーバ層に在る。** **所在の綴りをここに書くと、それを白箱で見ている
 *   `src/server/` 側の検査が赤くなる**(**実際に赤くした。`V8-M13-T04` の実測**)ので、
 *   **このコメントは綴りを1文字も書いていない**。超えると 400)。
 *   **【禁止】これを「集計に権限が効くようになった」と書かない** —— **島が `output_table` へ
 *   書いた表には1ミリも掛からず、受信口・ワークフロー・`schedule` は今日も素通りである。**
 * - **キャッシュを1つも置いていない**(`D-V8-5`)—— **要求のたびに読み直して数え直す。**
 * - **結合(join)を1つもしていない** —— **母集団は `view.table` が指す1つの表だけである。**
 *   **参照(`reference`)で束ねても、束ねるのは参照先のIDであって参照先の項目ではない**
 *   (参照先を読む集計は `V8-M9` の範囲である)。
 *
 * ## 【2026-08-14。`V8-M9` による追記。**上の1行は今日は偽である**】結合を実装した
 *
 * **台帳 `Q-G6` / `Q-G7` / `Q-G8` / `Q-G9`(4件とも限定採用)。門A 本審査 = `V8-M7`。
 * 裁定 `M7-1`。ユーザ決定 `D-V8-1` / `D-V8-120`。**
 * **【禁止】上の「結合(join)を1つもしていない」を書き換えない** —— **旧文は `V8-M8` の
 * 時点の事実であり、そのまま残す。** **今日の正は本節である。**
 *
 * ### **行をメモリに読んでから束ねる形を、1ミリも崩していない**(**これが判定の根拠である**)
 *
 * **`V8-M7` の門A 本審査は、`ADR-0043` §3a-2 が集約の帰属先を「島(`run_function` +
 * `output_table`)」と名指ししている条文を、**島が可視性を1つも通らないことの実測**で
 * 倒して限定採用にした。** **したがって結合も、`V8-M10` で可視性を掛けられる形
 * (= 行をメモリに読んでから束ねる形)でなければ、判定の根拠そのものを裏切る。**
 * **本実装は SQL の `JOIN` を1文字も書いていない** —— **結合先の表も
 * `readRecordList` で読み、突き合わせは JS のメモリ上で行う。**
 * **`V8-M10` は「読んだ直後の行集合」に post-filter を1枚挟めばよい**(結合の前でも
 * 後でも挟める形になっている)。
 *
 * ### 意味論(**ここに無い形を1つも作らない**)
 *
 * - **`{ table: T, via: f }` は「表 `T` の `reference` 型フィールド `f` による突き合わせ」**
 *   である。**向きは宣言から決まる** —— **`T` がすでに在れば順方向(子 → 親。行数は
 *   増えない)、参照先がすでに在れば逆方向(親 → 子。行数が増える)。**
 *   **両方在る・どちらも無い形は apply 時に拒否されている**(`referential-integrity.ts`
 *   の類型18b)。**ここでは判定を持たない** —— **判定を2箇所に住まわせない。**
 * - **宣言の順序が評価の順序である** —— **下の `for ... of` は書かれた順にしか進まない。**
 *   **「どの順で辿ると速いか」を選ぶコードが1行も無い**(**プランナを持たない**)。
 *   **機械的な固定は `src/server/report-join-boundary.test.ts` の (19)。**
 * - **相手が無い行を1行も落とさない**(`D-V8-120`。**宣言で選べない**)——
 *   **順方向で参照先が無ければその表は `null`、逆方向で子が1件も無ければ1行として残って
 *   子側が `null` になる。** **その表の `count` は 0、`sum` は 0 である**
 *   (**「売れていない商品が 0 で並ぶ」の実体**)。
 * - **絞り込み(`filter`)は今日も起点の表の読取にだけ渡す** —— **結合先の列で絞る形を
 *   1つも作っていない**(`ADR-0043` §3a-3)。**代償は「区分Bの注文だけを商品ごとに
 *   集計する」が書けないことである。**
 *
 * ### 【正直に書く】重複について
 *
 * **逆方向(一対多)の結合が1本でも入れば、起点の行はその子の数だけ数えられる。**
 * **`V8-M9` が閉じたのは「逆方向を2本以上書けること」だけである**(2本あると
 * ファンアウトが掛け算になる)。**【禁止】「重複しない」と書かない。**
 *
 * ### 上限(**裁定 `M7-1`**)
 *
 * **結合する表は起点を含めて5本・段数は3段まで。** **どちらも apply 時に閉じてあり、
 * ここには1つも無い。** **【禁止】この2つを「測って決めた値」と書かない**
 * (由来は `referential-integrity.ts` の類型18b の doc に書いた)。
 *
 * ## 集計は読取専用の導出値である(`Q-G35`)
 *
 * **行を1件も作らず、1件も書き換えず、システムが持つ表を1本も増やさない**
 * (今日も `_apps` / `_changelog` / `_ai_usage` の3本ちょうど)。
 * **書き込む口は HTTP にも MCP にも1つも無い。**
 */
import { type ReadSource, readRecordList } from "./read-records.ts";
import type { RecordResult, RecordRow, RecordValue } from "./records.ts";
import type { Manifest, ReportView, ResourceId } from "./types.ts";

/** 群のキー1つ(どの項目の、どの値で束ねたか)。 */
type ReportGroupKey = { field: ResourceId; value: RecordValue };

/** 集計値1つ。**`count` には `field` が付かない**(付ける場所そのものが宣言に無い)。 */
type ReportAggregateValue = { type: "sum" | "count"; field?: ResourceId; value: number };

/** 群1つ。 */
type ReportGroup = { keys: ReportGroupKey[]; aggregates: ReportAggregateValue[] };

/**
 * 集計表の応答。
 *
 * **`totals` は全体の合計である**(`D-V8-122`)—— **群ごとの値の和ではなく、
 * 母集団そのものを1度数えたものである。** **`count` については両者が一致することを
 * `src/server/report-declaration-boundary.test.ts` の (16) が固定している**
 * (`Q-G15` の受け皿。**本体の判定は `V8-M10`**)。
 */
type ReportResult = {
  groups: ReportGroup[];
  total_groups: number;
  totals: ReportAggregateValue[];
};

/**
 * **ISO 8601 の文字列を、束ね方の単位へ丸める。**
 *
 * **この製品で日付を丸める実装はこの1本だけである** —— **SQL 側と JS 側で別々の
 * 実装を持たない**(丸めの SQL そのものが無い。上の doc)。機械的な固定は
 * `src/server/report-declaration-boundary.test.ts` の (27)。
 *
 * **読み方は「先頭10文字を暦日として読む」だけである** —— **時差(タイムゾーン)の変換を
 * 1度もしない。** **`2026-08-09T23:59:00Z` と `2026-08-09T23:59:00+09:00` は同じ
 * `2026-08-09` として扱われる。** **これは「時差を正しく扱っている」ではない。**
 * **`date` 型が受け付ける形は `YYYY-MM-DD` と `YYYY-MM-DDThh:mm...` の2つだけなので
 * (`src/kernel/records.ts` の `ISO_DATE_RE` / `ISO_DATE_TIME_RE`)、先頭10文字は
 * 必ず暦日である。**
 *
 * **週の始まりは月曜日(ISO 8601)である** —— **日曜 23:59 の行と月曜 00:00 の行は
 * 別の群に入る。** **返すのはその週の月曜日の暦日そのものである**(週番号を返さない ——
 * 週番号は年をまたぐところで規則が増える)。
 *
 * **読めない値は `null` に倒す** —— **群から落とさない**(`D-V8-120` の「相手が無い行を
 * 落とさない」と同じ向き)。
 */
function truncateToGranularity(
  value: RecordValue,
  granularity: "day" | "week" | "month",
): RecordValue {
  if (typeof value !== "string" || value.length < 10) {
    return null;
  }
  const day = value.slice(0, 10);
  if (granularity === "month") {
    return day.slice(0, 7);
  }
  if (granularity === "day") {
    return day;
  }
  // 週: その暦日を含む ISO 週の月曜日へ戻す。
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) {
    return null;
  }
  const utc = new Date(Date.UTC(year, month - 1, date));
  if (Number.isNaN(utc.getTime())) {
    return null;
  }
  // `getUTCDay()` は日曜が 0・月曜が 1。**月曜からの経過日数**は `(day + 6) % 7` である。
  const offset = (utc.getUTCDay() + 6) % 7;
  utc.setUTCDate(utc.getUTCDate() - offset);
  return utc.toISOString().slice(0, 10);
}

/**
 * **群の並び順**(`V8-M11` が並べ替えを足すまでの既定)。
 *
 * **束ねるキーの値の昇順**(複数キーなら宣言順の辞書式)で、**`null` は最後**である。
 *
 * **読取の並べ替えに合わせていない** —— **あちらは SQLite の `ORDER BY` そのもので、
 * `null` を**先頭**に置く(NULLS FIRST)。**
 * **集計表では `null` は「値が入っていない群」であり、先頭に置くと本題の群が押し下げられる。**
 * **意図して向きが違うので、写しではなくここに小さな比較を1本置いてある。**
 *
 * **【2026-08-16 訂正】旧文は「`src/kernel/read-records.ts` の `compareValues` を
 * 使っていない」「同じ『値を比べる』関数がカーネルに2本ある」と書いていた。**
 * **`compareValues` は読取の SQL 一本化(`ADR-0347`)で削除され、今日は実在しない。**
 * **JS で値を比べる関数はこの1本だけである。** **ただし「並び規則が2つある」ことは
 * 今日も真である** —— **読取は SQLite の UTF-8 バイト順、ここは JS の UTF-16
 * コードユニット順で、`𠮷` と `Ａ` のような文字が混ざると順序が逆転する**
 * (`ADR-0347` 限界3)。
 */
function compareGroupValue(a: RecordValue, b: RecordValue): number {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  if (typeof a === "boolean" || typeof b === "boolean") {
    return Number(a) - Number(b) < 0 ? -1 : 1;
  }
  if (typeof a === "number" && typeof b === "number") {
    return a < b ? -1 : 1;
  }
  return String(a) < String(b) ? -1 : 1;
}

/**
 * **並べ替えの宣言1つ**(`V8-M11`。台帳 `Q-G21a` / `Q-G12`。ユーザ決定 `D-V8-130`)。
 *
 * **【export しない】** —— **`scripts/kernel-export-snapshot.txt` は `src/kernel/` の
 * 公開識別子を1つ増やすだけで `scripts/kernel-export-drift.test.ts` が赤くなる。**
 * **`v8-m11.md` §1-0c の決定4 は「並べ替えは `report.ts` の**中**に書く。ただし公開識別子を
 * 1つも増やさない」と定めた** —— **したがって型は宣言そのものから辿って名付けている
 * (`ReportReadSource` が同じ理由で export されていないのと同型)。**
 */
type ReportSort = NonNullable<ReportView["report"]["sort"]>;

/**
 * **既定の順序**(`V8-M11-T02` で関数に切り出した。**規則は1バイトも変えていない**)。
 *
 * **束ねるキーの値の昇順**(複数キーなら宣言順の辞書式)で、**`null` は最後**である。
 * **着手前は `computeReport` の中に直接書かれていた** —— **並べ替えを宣言したときの
 * 第2キーとして同じ規則を使うので、2箇所に写さないためにここへ出した**(決定13)。
 */
function compareByDefault(left: ReportGroup, right: ReportGroup): number {
  for (const [index] of left.keys.entries()) {
    const compared = compareGroupValue(
      left.keys[index]?.value ?? null,
      right.keys[index]?.value ?? null,
    );
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

/**
 * **宣言が指している値を1つ取り出す**(`V8-M11-T02`)。
 *
 * **指し方は添字である**(`v8-m11.md` §1-0c の決定2)—— **`index` が宣言した本数の内側で
 * あることは apply 時に `src/kernel/referential-integrity.ts` が保証している。**
 * **判定を2箇所に住まわせない** —— **ここでは「万一外だったら `null`」に倒すだけである。**
 */
function sortValueOf(group: ReportGroup, sort: ReportSort): RecordValue {
  if (sort.target === "group_by") {
    return group.keys[sort.index]?.value ?? null;
  }
  return group.aggregates[sort.index]?.value ?? null;
}

/**
 * **群を2つ比べる**(`V8-M11-T02`。台帳 `Q-G21a` / `Q-G12`)。
 *
 * **並べ替えを宣言していなければ、着手前の既定の順序そのものである**(決定3)——
 * **`sort` が `undefined` のとき、この関数は `compareByDefault` と1バイトも同じ値を返す。**
 *
 * **宣言してあるときは、指された値で比べ、同値なら既定の順序で比べる**(決定13)——
 * **`Array.prototype.sort` の安定性に暗黙に頼っていない。** **頼ると、同値の群の並びが
 * 「群ができた順」(= 行を読んだ順)に化け、宣言から読めない順序になる。**
 *
 * **`desc` は比較の向きを反転させるだけである** —— **したがって群のキーで降順に並べると、
 * `null` の群は末尾ではなく先頭に来る。** **【正直に書く】これは「`null` は最後」という
 * 既定の言い分と向きが揃っていない。** **揃えるには `null` を特別扱いする分岐が要り、
 * その分岐は昇順と降順で意味が割れる**(`null` を常に最後に置くと、降順の列を逆から
 * 読んだものと一致しなくなる)。**単純な反転を採り、代償をここに書く側に倒した。**
 *
 * ## 【2026-08-15。**メインの裁定**(`v8-m11.md` §1-0e の**決定15**)による差し戻し。
 *    **直前の段落を1バイトも書き換えていない。ただし今日は偽である**】
 *
 * **今日の正**: **`null` の群は、昇順でも降順でも常に最後である。**
 * **上の段落の「降順に並べると `null` の群は末尾ではなく先頭に来る」は今日は成り立たない。**
 *
 * **理由(裁定の逐語)**: **「値が無い群」は順位の対象外である。**
 * **「売上の多い順」で未分類の群が先頭に来るのは、読み手の期待と正面から食い違う。**
 * **上の段落が挙げた懸念(昇順と降順で意味が割れる)は裁定も正しいと認めており、
 * **割れることを承知で読み手の側に倒した**。**
 * **したがって今日、降順の列は昇順の列を逆から読んだものと一致しない** ——
 * **一致しないのは `null` の群の位置だけである。**
 *
 * **【`compareGroupValue` の本文は1バイトも書き換えていない】** —— **書き換えると既定の
 * 順序(`sort` を書かなかったときの順序)が動く。** **`null` を寄せるのは**反転の外側**で
 * 行っている** —— **反転(`-primary`)を通るのは、両方とも値が在るときだけである。**
 *
 * **【効くのは `target: "group_by"` の降順だけである】** —— **集計値(`aggregate`)は
 * 必ず数であり、`null` が1つも出ない**(`aggregateRows` は `sum` を `0` から始め、
 * `count` は行数そのものである)。**したがって集計値で降順に並べたとき、群のキーが空の群は
 * 末尾ではなく「その集計値の大きさの位置」に入る。** **機械的な固定は
 * `src/server/report-declaration-boundary.test.ts` の (37)(昇順・降順の両方を打っている)。**
 */
function compareGroups(
  left: ReportGroup,
  right: ReportGroup,
  sort: ReportSort | undefined,
): number {
  if (sort !== undefined) {
    const leftValue = sortValueOf(left, sort);
    const rightValue = sortValueOf(right, sort);
    // **【決定15】値が無い群は順位の対象外である** —— **向きの反転より**外側**で寄せる。**
    // **片方だけが空なら、昇順でも降順でも空のほうが後ろである。**
    // **両方とも空なら順位が付かないので、下の既定の順序へ落とす。**
    if (leftValue === null || rightValue === null) {
      if (leftValue !== rightValue) {
        return leftValue === null ? 1 : -1;
      }
    } else {
      const primary = compareGroupValue(leftValue, rightValue);
      if (primary !== 0) {
        return sort.order === "desc" ? -primary : primary;
      }
    }
  }
  return compareByDefault(left, right);
}

/**
 * **結合した1行**(`V8-M9`)。
 *
 * **「表ID → その表の行(結び付く行が無ければ `null`)」の対応そのものである。**
 * **結合を1つも書いていない集計表では、鍵が起点の表1本だけの対応になる** ——
 * **`V8-M8` の1行と同じものが、1本だけ入った形で表せている**(**2つの形を持たない**)。
 */
type JoinedRow = Record<ResourceId, RecordRow | null>;

/** 結合した行から、ある表の行を取り出す(結び付いていなければ `null`)。 */
function rowOf(joined: JoinedRow, tableId: ResourceId): RecordRow | null {
  return joined[tableId] ?? null;
}

/** 1行から群のキーの値を取り出す(`date` は束ね方で丸める)。 */
function keyValuesOf(row: JoinedRow, view: ReportView): RecordValue[] {
  return view.report.group_by.map((key) => {
    // **書かれていない項目は `undefined` で返るので `null` へ倒す** ——
    // **群から落とさない**(`D-V8-120` の「相手が無い行を落とさない」と同じ向き)。
    // **`table` を省略したら起点の表である**(`V8-M9`)—— **結び付く行が無い表の項目も
    // `null` に倒れる**(**逆方向の結合で子が1件も無い行がここを通る**)。
    const value: RecordValue = rowOf(row, key.table ?? view.table)?.[key.field] ?? null;
    if (key.granularity === undefined) {
      return value;
    }
    return truncateToGranularity(value, key.granularity);
  });
}

/** 行の集合を1本ずつ集計する(宣言に書いた順で返す)。 */
function aggregateRows(rows: JoinedRow[], view: ReportView): ReportAggregateValue[] {
  return view.report.aggregates.map((aggregate) => {
    const tableId = aggregate.table ?? view.table;
    if (aggregate.type === "count") {
      // **数えるのは「その表の行が結び付いている行」だけである**(`V8-M9`)——
      // **逆方向の結合で子が1件も無い群は 0 になる**(`D-V8-120`。**「売れていない商品が
      // 0 で並ぶ」の実体**)。**起点の表は必ず結び付いているので、`table` を省略した
      // `count` は `V8-M8` と同じ「行の数」である**(意味論を1ミリも変えていない)。
      return {
        type: "count" as const,
        value: rows.filter((row) => rowOf(row, tableId) !== null).length,
      };
    }
    // **`sum`。** **値が数でない行は飛ばし、`0` から始める** —— **`records.ts` の
    // `SUM()`(NULL を無視し、0件なら `0` に倒す)と同じ意味論に揃える。**
    // **結び付く行が無い行も同じ扱いである**(飛ばすので `0` に倒れる)。
    let total = 0;
    for (const row of rows) {
      const value = rowOf(row, tableId)?.[aggregate.field ?? ""];
      if (typeof value === "number" && Number.isFinite(value)) {
        total += value;
      }
    }
    // **`field` を「無い」と「`undefined`」で使い分けない**(`exactOptionalPropertyTypes`)——
    // **`sum` には必ず列が在る**(無い宣言は適用時に拒否されている)。
    return { type: "sum" as const, field: aggregate.field ?? "", value: total };
  });
}

/**
 * **可視な行だけを返す読取元**(`V8-M10-T03`。台帳 `Q-G13`。`v8-m10.md` §1-0c の決定1)。
 *
 * ## **なぜ「注入」なのか** —— **判定をこのファイルに1文字も書かないため**
 *
 * **`ADR-0061` 限定4 は「判定は `src/server/owner-scope.ts` に集約する」と定めている。**
 * **`src/kernel/` からサーバ層の判定を呼ぶと、その集約が破れる**(**憲法1**)——
 * **`src/kernel/workflow-runner.ts:76` にはカーネルから `owner-scope` を import した
 * 先例が在るが、`v8-m10.md` §1-0c の決定1 は「その先例を採らない」と定めた。**
 *
 * **したがってこのファイルは「誰に何が見えるか」を1つも知らない。**
 * **知っているのは「読んだ行を、渡された1本に通してから使う」ことだけである** ——
 * **通した先で何が起きるかは、`src/server/app.ts` が組む側の話である。**
 *
 * **【この関数を渡さなければ、着手前と1バイトも同じである】** ——
 * **省略できる**(`readRows` が素通しする)。**MCP・ワークフロー・島など、
 * 今日 `computeReport` を呼んでいない経路には1バイトの影響も無い。**
 *
 * @param tableId **今読んだ表**(起点の表 / 結合先の表のどちらもここを通る)。
 *   **`V8-M10-T03` の時点では、`app.ts` 側が起点の表だけを絞り、結合先は素通しにしている**
 *   —— **結合先に当てるのは `T04`(`Q-G14`)である。**
 */
// **【export しない】** **`scripts/kernel-export-snapshot.txt` は `ADR-0007` §1b の
// `Δ8` の基準であり、`src/kernel/` の公開識別子が1つ増えるだけで
// `scripts/kernel-export-drift.test.ts` が赤くなる。** **`V8-M10-T03` は語彙を1つも
// 増やさないマイルストーンなので、この型に名前を公開しない** ——
// **呼び出し側(`src/server/app.ts`)は `computeReport` の引数の位置で
// 文脈から型を受け取るので、import する必要が無い。**
type ReportReadSource = ReadSource & {
  readonly visibleRows?: (tableId: ResourceId, rows: RecordRow[]) => RecordRow[];
};

/**
 * **表を1本読む**(`V8-M9` で**この1本に寄せた**)。
 *
 * **起点の表も結合先の表も、この1本を通る** —— **読取の経路を2本持たない**
 * (`readRecordList` を呼ぶ行が製品コードに1本しか無いことを
 * `src/server/report-join-boundary.test.ts` の (18) が固定している)。
 *
 * **【`V8-M10` が塞ぐ穴を、今日の事実として書いておく】** **結合先の表は `filter` も
 * 可視性も1つも掛けずに全件読む。** **要求した人がその表を1行も読めなくても、
 * 集計はその行を数える**(実測は同ファイルの (23))。
 * **【`V8-M10-T03` による引き直し。上の3行を1バイトも消していない】** ——
 * **読んだ行は {@link ReportReadSource.visibleRows} に通してから返す。**
 * **起点の表については、可視性が**群化の前**に掛かる**(`Q-G21d`)——
 * **この1本の返り値がそのまま `applyJoins` と群化の入力になるので、
 * 「群を作ってから絞る」形はこのファイルの構造の上で書けない。**
 * **結合先の表がどうなるかは、注入する側が決める**(`T03` は素通し。`T04` が当てる)。
 */
function readRows(
  source: ReportReadSource,
  manifest: Manifest,
  tableId: ResourceId,
  filter: ReportView["report"]["filter"],
): RecordResult<RecordRow[]> {
  const read = readRecordList(source, manifest, tableId, filter === undefined ? {} : { filter });
  if (!read.ok || source.visibleRows === undefined) {
    return read;
  }
  return { ok: true, value: source.visibleRows(tableId, read.value) };
}

/**
 * **宣言に書いた順で結合を1本ずつ当てる**(`V8-M9`。**プランナを持たない**)。
 *
 * **向きの判定は「どちらの表がすでに結合に入っているか」だけで決まる** ——
 * **`referential-integrity.ts` の類型18b が apply 時に「ちょうど一方だけが入っている」
 * ことを保証しているので、ここでは `present.has(step.table)` の1問だけで足りる。**
 * **判定を2箇所に住まわせない。**
 */
function applyJoins(
  source: ReportReadSource,
  manifest: Manifest,
  view: ReportView,
  origin: RecordRow[],
): RecordResult<JoinedRow[]> {
  let joined: JoinedRow[] = origin.map((row) => ({ [view.table]: row }));
  const present = new Set<ResourceId>([view.table]);
  for (const step of view.report.join ?? []) {
    const from = manifest.app.tables.find((candidate) => candidate.id === step.table);
    const via = from?.fields.find((candidate) => candidate.id === step.via);
    // **`reference_table` を持つのは `reference` 型の項目だけである**(型の側で分かれている)
    // —— **`via` が `reference` であることは apply 時に確かめてある。**
    const toId = via !== undefined && via.type === "reference" ? via.reference_table : undefined;
    if (toId === undefined) {
      // **到達しない** —— **実在しない表・実在しない列・`reference` でない列は、
      // すべて apply 時に拒否されている。** **黙って落とさないために、ここでは
      // 「何も結び付けない」ではなく「その結合を飛ばす」でもなく、素直に打ち切る。**
      break;
    }
    // **すでに入っているのが `table` 側なら順方向(子 → 親)、そうでなければ逆方向。**
    const forward = present.has(step.table);
    const added = forward ? toId : step.table;
    const fetched = readRows(source, manifest, added, undefined);
    if (!fetched.ok) {
      return { ok: false, errors: fetched.errors };
    }
    if (forward) {
      // **多対一。** **参照先を `_id` で引く** —— **行数は1行も増えない。**
      // **参照先が空・欠番なら `null` を結び付ける**(行は落とさない。`D-V8-120`)。
      const byId = new Map(fetched.value.map((row) => [row._id, row]));
      joined = joined.map((row) => {
        const child = rowOf(row, step.table);
        const reference = child?.[step.via];
        const parent = typeof reference === "string" ? (byId.get(reference) ?? null) : null;
        return { ...row, [added]: parent };
      });
    } else {
      // **一対多。** **子を参照先のIDで束ねる** —— **ここで行が増える(ファンアウト)。**
      // **子が1件も無い親は、子を `null` にした1行として残る**(`D-V8-120`)。
      const byReference = new Map<string, RecordRow[]>();
      for (const child of fetched.value) {
        const reference = child[step.via];
        if (typeof reference !== "string") {
          continue;
        }
        const bucket = byReference.get(reference);
        if (bucket === undefined) {
          byReference.set(reference, [child]);
        } else {
          bucket.push(child);
        }
      }
      joined = joined.flatMap((row) => {
        const parent = rowOf(row, toId);
        const children = parent === null ? [] : (byReference.get(parent._id) ?? []);
        if (children.length === 0) {
          return [{ ...row, [added]: null }];
        }
        return children.map((child) => ({ ...row, [added]: child }));
      });
    }
    present.add(added);
  }
  return { ok: true, value: joined };
}

/**
 * **集計表の宣言を1つ計算する。**
 *
 * **失敗は `ValidationError[]` で返す** —— **投げない。** 失敗しうるのは
 * **`filter` が読取経路で拒否されたとき**(実在しない列・深すぎるネストなど)だけである。
 * **宣言そのものの整合(実在・型・`granularity` の要否・役割の規則が名指ししていないこと)
 * は、apply 時に `src/kernel/referential-integrity.ts` が既に止めている** ——
 * **判定を2箇所に住まわせない。**
 */
export function computeReport(
  source: ReportReadSource,
  manifest: Manifest,
  view: ReportView,
): RecordResult<ReportResult> {
  // **絞り込みは起点の表の読取にだけ渡す**(`V8-M9` で1バイトも変えていない)——
  // **結合先の列で絞る形を1つも作っていない**(`ADR-0043` §3a-3)。
  const origin = readRows(source, manifest, view.table, view.report.filter);
  if (!origin.ok) {
    return { ok: false, errors: origin.errors };
  }
  // **結合を宣言順に当てる**(結合が無ければ、起点の行がそのまま1本の対応になる)。
  const rows = applyJoins(source, manifest, view, origin.value);
  if (!rows.ok) {
    return { ok: false, errors: rows.errors };
  }

  // **群の同一性は「束ねるキーの値の並び」だけで決まる。**
  // **JSON にして畳んでいるのは、`null` / 真偽値 / 数 / 文字列を1つの Map のキーに
  // まとめるためである** —— **表示に使う値は `keys` のほうに素の型のまま持っている。**
  // **束ねる対象は「結合した行」である**(`V8-M9` で `RecordRow[]` から変わった)。
  const buckets = new Map<string, { keys: RecordValue[]; rows: JoinedRow[] }>();
  for (const row of rows.value) {
    const keys = keyValuesOf(row, view);
    const identity = JSON.stringify(keys);
    const bucket = buckets.get(identity);
    if (bucket === undefined) {
      buckets.set(identity, { keys, rows: [row] });
    } else {
      bucket.rows.push(row);
    }
  }

  /*
   * **【`V8-M11-T02` による組み替え。並べる**前**に集計を済ませる形にした】**
   *
   * **着手前は「束ねたものを並べてから集計する」順だった** —— **集計値で並べるには、
   * 並べる時点で集計値が要る。** **並べ替えを宣言しなかったときの結果は1バイトも
   * 変わらない**(**同じ比較関数を同じ値に当てているだけである**。決定3)。
   * **集計の回数も1回も増えていない**(群ごとに1度ずつのままである)。
   */
  const collected: ReportGroup[] = [...buckets.values()].map((bucket) => ({
    keys: bucket.keys.map((value, index) => ({
      // biome-ignore lint/style/noNonNullAssertion: `keys` は `group_by` と同じ長さで作っている。
      field: view.report.group_by[index]!.field,
      value,
    })),
    aggregates: aggregateRows(bucket.rows, view),
  }));
  const groups = collected.sort((left, right) => compareGroups(left, right, view.report.sort));

  return {
    ok: true,
    value: {
      groups,
      total_groups: groups.length,
      // **全体の合計は母集団そのものを1度数える**(`D-V8-122`)——
      // **群ごとの値を足し直していない。**
      totals: aggregateRows(rows.value, view),
    },
  };
}
