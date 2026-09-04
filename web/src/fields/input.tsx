/**
 * フィールド型ごとの入力UI(V0-P3-T05)。
 *
 * v0 語彙のフィールド型は7種で固定(`src/kernel/types.ts` の `FieldType`)なので、
 * ここは **網羅的な `switch` 1箇所**に閉じてある。表引き(`Record<FieldType, ...>`)に
 * すると `Field` 判別共用体が絞り込まれず、`select` の `options` や `reference` の
 * `reference_table` に型安全に触れない。`switch` なら型が増えた瞬間に
 * コンパイルエラーになり、語彙の拡張が黙って通ることがない(憲法2)。
 *
 * ここに置いてよいのは「マニフェストに書いてあることの入力手段」だけである。
 * プレースホルダ文言・レイアウト・色・ヘルプテキストのような、マニフェストに現れない
 * 表示オプションを足さないこと(handover 3.10)。
 *
 * ## 部品体系での描き直し(V4-M15-T04 / T06。`ADR-0087`)
 *
 * **描く要素そのものは1つも変えていない。** `input[type=text]` は `input[type=text]` の
 * ままで、`type` / `id` / `aria-*` / `data-testid` を1つも動かしていない。変えたのは
 * **体裁の当て方だけ**で、`web/src/ui/form-controls.tsx` の `Input` / `Textarea` /
 * `Select` / `Checkbox` を通す形にした。
 *
 * - **`Select` は素の `<select>` である**(`ADR-0087` 限定8。重ねて出すメニューを1つも
 *   入れない)。`role="listbox"` も `position` も増えない。
 * - **`Checkbox` は素の `<input type="checkbox">` に体裁だけを当てた部品である。**
 *   別の部品に置き換えていない。
 * - **`aria-invalid` は「エラーがある入力欄」にだけ付ける**(`V4-M15-T14` の一部)。
 *   **枠線の色は部品側の `aria-invalid:border-destructive` が持つ**ので、ここが足すのは
 *   属性1つだけであり、色のクラスを型ごとに書き分けていない。
 *   **どのフィールドがエラーかを知っているのは `FormRenderer` だけ**なので、判定は
 *   ここに置かず `invalid` として受け取る(判定が2箇所に住むと必ず食い違う)。
 */
import { useEffect, useRef, useState } from "react";
import type { RecordRow } from "../../../src/kernel/records.ts";
import type { Field, FormView, Manifest, ResourceId, Table } from "../../../src/kernel/types.ts";
import { fetchRecord, fetchRecordPage, fetchRecords, fileDeliveryUrl, uploadFile } from "../api.ts";
import { type AsyncState, toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { resolveViewTable } from "../table-resolution.ts";
import { Button } from "../ui/button.tsx";
import { Checkbox, Input, Select, Textarea } from "../ui/form-controls.tsx";
// **重ねて出す器は既存の3つから選ぶ**(`K-G19`。`V6-M5-T01` / `ADR-0094` 限定2)——
// **取るのは1つだけであり、4つ目の器を1バイトも作らない。**
import { OverlayDialog } from "../ui/overlay.tsx";
import {
  TableBody,
  TableCell,
  TableFrame,
  Table as TableGrid,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table.tsx";
// **打った語から `filter` を組み立てる規則は、製品にただ1本しか無い**
// (`ADR-0112` 限定7・限定9。`V6-M4-T01` / `K-G11`)。**ここに再実装しない。**
import { buildSearchFilter } from "../views/search-filter.ts";
// ピッカーのラベルは一覧のセルと同じ規則で決める。ここに再実装しないこと。
// **探す対象の解決(`referenceSearchFields`)も同じ1本を呼ぶ**(`ADR-0290` 限定7)。
// **別の面に並べる列(`referencePopupColumns`)も同じ1本である**(`K-G10`。`V6-M3-T05`)。
import {
  missingReferenceLabel,
  referenceLabel,
  referencePopupColumns,
  referenceSearchFields,
} from "./reference-label.ts";
// **利用者IDの書き写しを不要にする選択肢の型**(`UM-G2`。`V13-M1-T02`)——
// **型だけを取る。** 一覧を読む口(`listAppUsers`)はここに1バイトも import しない
// (`web/test/reference-candidate-permission.test.tsx` が
//  「入力欄が `../api.ts` から取る名前は5本」を固定している)。
import type { UserAccountChoice } from "./user-account.ts";

/**
 * フォームが保持する入力値。
 *
 * `boolean` 型だけ真偽値、それ以外は DOM の入力要素が扱う**文字列そのまま**にする。
 * 入力途中の文字列を数値へ丸めたりしないので、利用者が打った値がそのまま
 * カーネルに届き、カーネルの検証結果と画面の表示がずれない。
 */
export type FieldInputValue = string | boolean;

/** reference の選択肢(参照先レコード1件)。 */
export type ReferenceChoice = { id: string; label: string };

/** 参照先テーブルID → 選択肢の取得状態。 */
export type ReferenceChoices = Map<ResourceId, AsyncState<ReferenceChoice[]>>;

/** 未選択(値なし)を表す option の値。空文字は「未設定」として `null` に写す。 */
const UNSELECTED = "";

/**
 * **参照項目の「選び方」を書かなかったときの既定**(`K-G5`。`V6-M1-T03` /
 * `ADR-0288` 限定3)。
 *
 * **既定は今日どおりのプルダウン(`list`)である。既定を反転させない。**
 * **マニフェストスキーマに `default` を1つも書いていない**(書くと既定の置き場が2つに
 * なる)。**この定数が製品における唯一の既定である。**
 *
 * **カーネルは既定を1つも持たない** —— `change_field` も `add_field` も、書かなかった
 * 項目に本キーを1バイトも生やさない(実測は `src/kernel/reference-picker.test.ts` の
 * (e) 群)。**したがって「書かなかった項目の画面は今日と1バイトも変わらない」は、
 * この定数と下の解決関数の外に1箇所も依存を持たない。**
 */
export const DEFAULT_REFERENCE_PICKER = "list" as const;

/**
 * **一度に取る参照候補の上限**(`K-G14`。`V6-M4-T03` / `D-V6-4` / `D-V6-7`)。
 *
 * **プラットフォームが決めて固定する。作る人は1バイトも指定できない**(`D-V6-7`)——
 * **マニフェストに置き場を作っていない。**
 *
 * **【承知して受ける非対称。隠さない】** **一覧の1ページの件数(`page_size`)は
 * 作る人が 10 / 20 / 50 / 100 の4値から選べる**(`ADR-0113`)。**参照候補の上限は選べない。**
 * **同じ製品の中で「件数の決め方」が2つある**(`01` §6-7 の緊張1)。**これはユーザ決定
 * `D-V6-7` の帰結であって、本タスクが選んだものではない。**
 *
 * **【正直に書く】この値が妥当かどうかを1度も測っていない。** **数千件の候補を描いた
 * ときの実際の描画時間はブラウザで1度も測っていない**(`v6-m0.md` §11-1 の未確認)。
 * **一覧の既定の1ページ(50)に合わせた** —— それ以上の根拠は無い。
 */
export const REFERENCE_CANDIDATE_LIMIT = 50;

/**
 * **打つたびの取り直しの間隔(ミリ秒)**(`K-G13`。`V6-M4-T02`)。
 *
 * **プラットフォームが決めて固定する。作る人は1バイトも指定できない。**
 *
 * **【正直に書く】この値が妥当かどうかを1度も測っていない**(`v6-m0.md` §7-5 の
 * `S3` (3) の逐語「**間隔を長くすると反応が遅く感じられ、短くすると読取の回数が増える。
 * どちらの値が良いかを本審査は測っていない**」)。
 */
export const REFERENCE_SEARCH_DEBOUNCE_MS = 250;

/**
 * **探せる項目が1本も無いときの断り**(`V6-M4` が決めた形。`v6-m3.md` §5-2 の 3)。
 *
 * **文言を2箇所に住まわせない** —— **打って絞る形(`type_filter`)と、別の面を開いて
 * 探す形(`search`)の両方が、この1本を出す**(`v6-m4.md` §5-2 の 2 の申し送り)。
 */
const SEARCH_UNAVAILABLE_NOTE =
  "この項目は打って絞り込めません(参照先に文字の項目が1つもありません)。";

/**
 * **候補の件数の案内**(`K-G15` / `K-G16`。`V6-M4-T03` / `V6-M5-T03`)。
 *
 * **判定(`total` と返ってきた件数の比較)も文言も、製品にこの1本しか無い**
 * (`v6-m4.md` §5-2 の 2 の申し送り「**文言と判定を2箇所に住まわせないこと**」)。
 *
 * **【`K-G16` を入れたことで「上限に当たった」の意味が二重になった。隠さない】**
 * **`v6-m0.md` §7-7 の `S3` (1) が予告したとおりである**(逐語: 「**ページ送りを入れると
 * 「上限に当たった」の意味が二重になる —— 1ページ目の上限なのか、全体の上限なのか**」)。
 * **本関数はそれを `paged` の2値で割った**:
 *
 * - **`paged: false`(打って絞る形)** —— **続きを見る手段が無い。** だから
 *   「**{n}件だけを出しています**」と言い、絞り込みを促す。
 * - **`paged: true`(別の面を開いて探す形)** —— **続きはページ送りで見られる。** だから
 *   「**全{total}件のうち何件目から何件目**」と言う。**「絞り込んでください」とは言わない**
 *   (言うと、続きを見る手段が無いかのような嘘になる)。
 *
 * **どちらの側にも「黙って切る」経路は1本も無い。**
 */
function referenceCandidateNote(params: {
  total: number;
  count: number;
  offset: number;
  searchable: boolean;
  paged: boolean;
}): string | undefined {
  const { total, count, offset, searchable, paged } = params;
  // **全部出ているときは1文字も出さない**(1ページ目で総件数に届いている)。
  if (offset === 0 && total <= count) {
    return undefined;
  }
  if (!paged) {
    return `候補が多いので、${total}件のうち${count}件だけを出しています。${
      searchable ? "文字を打って絞り込んでください。" : ""
    }`;
  }
  if (count === 0) {
    return `全${total}件のうち、このページには1件も出ていません。`;
  }
  return `全${total}件のうち${offset + 1}件目から${offset + count}件目を出しています。${
    searchable ? "文字を打って絞り込めます。" : ""
  }`;
}

/**
 * 参照先の1行を、選択肢1つ(ID と表示ラベル)に写す。
 *
 * **ラベルの規則を再実装しない** —— {@link referenceLabel} の1本だけを呼ぶ。
 * **参照先テーブルが引けないときだけ `_id` に倒れる。**
 */
function toReferenceChoice(table: Table | undefined, row: RecordRow): ReferenceChoice {
  return { id: row._id, label: table === undefined ? row._id : referenceLabel(table, row) };
}

/**
 * 打った語を、**間隔をあけて**サーバへ渡す語に写す(`K-G13`。`V6-M4-T02`)。
 *
 * **間隔はプラットフォームが持ち、作る人は1バイトも指定できない**
 * ({@link REFERENCE_SEARCH_DEBOUNCE_MS})。**最後に打った語だけがサーバへ行く。**
 */
function useDebouncedTerm(term: string): string {
  const [query, setQuery] = useState(term);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(term), REFERENCE_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);
  return query;
}

/** 候補の1ページぶん(生の行と、絞り込み後の総件数)。 */
type ReferenceCandidatePage = { rows: RecordRow[]; total: number };

/**
 * **候補を1ページぶん取る**(`K-G11` / `K-G14` / `K-G16` / `K-G18`)。
 *
 * **打って絞る形と、別の面を開いて探す形の両方がこの1本を呼ぶ** ——
 * **取得の口を2箇所に住まわせない。**
 *
 * - **照合の規則を再実装しない** —— {@link buildSearchFilter} に渡すだけである(`K-G11`)。
 * - **一度に取る件数には上限がある**({@link REFERENCE_CANDIDATE_LIMIT}。`K-G14`)。
 * - **続きは `offset` で取る**(`K-G16`)—— **1ページ目では `offset` を1バイトも載せない**
 *   (載せると `list` / `type_filter` の今日のリクエストが変わる)。
 * - **取得は既存の {@link fetchRecordPage} の1本だけを通る**(`K-G18`)——
 *   **`st_owner` / `st_public` の post-filter も `audience` の射影も、サーバの同じ1本の
 *   読取ルートが今日どおり掛ける。****迂回する経路を1本も作っていない。**
 * - **`cancelled` が「遅い応答が新しい応答を上書きしない」の担保である**(`K-G13`)。
 * - **`enabled` が偽のあいだは1件も取りに行かない** —— **別の面を開いて探す形は、
 *   面を開くまで取得を1件も飛ばさない。**
 */
function useReferenceCandidatePage(params: {
  appId: string;
  tableId: ResourceId;
  searchFieldIds: string;
  query: string;
  offset: number;
  enabled: boolean;
}): AsyncState<ReferenceCandidatePage> {
  const { appId, tableId, searchFieldIds, query, offset, enabled } = params;
  const [state, setState] = useState<AsyncState<ReferenceCandidatePage>>({ status: "loading" });
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    const ids = searchFieldIds === "" ? [] : searchFieldIds.split(",");
    const filter = buildSearchFilter(undefined, ids, query);
    fetchRecordPage(appId, tableId, {
      ...(filter === undefined ? {} : { filter }),
      limit: REFERENCE_CANDIDATE_LIMIT,
      ...(offset === 0 ? {} : { offset }),
    }).then(
      (page) => {
        if (!cancelled) {
          setState({ status: "ready", value: { rows: page.records, total: page.total } });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, tableId, searchFieldIds, query, offset, enabled]);
  return state;
}

/**
 * **選択済みの1件を、候補とは別に読み直す**(`K-G17`。`v6-m0.md` §7-8 の `S3` (3))。
 *
 * **読取が1回増える。** **既存の1件読取ルートを通るので、`st_owner` / `audience` は
 * 今日どおり効く** —— **見えない相手には {@link missingReferenceLabel} が出る**(同 (4))。
 * **打って絞る形と、別の面を開いて探す形の両方がこの1本を呼ぶ。**
 */
function useSelectedReferenceChoice(
  appId: string,
  tableId: ResourceId,
  table: Table | undefined,
  value: string,
): ReferenceChoice | undefined {
  const [selected, setSelected] = useState<ReferenceChoice | undefined>(undefined);
  useEffect(() => {
    if (value === "") {
      setSelected(undefined);
      return;
    }
    let cancelled = false;
    fetchRecord(appId, tableId, value).then(
      (row) => {
        if (!cancelled) {
          setSelected(toReferenceChoice(table, row));
        }
      },
      () => {
        if (!cancelled) {
          setSelected({ id: value, label: missingReferenceLabel(value) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, tableId, value, table]);
  return selected;
}

/**
 * 参照項目の「選び方」を解決する(`K-G5`。`V6-M1-T03` / `ADR-0288` 限定3)。
 *
 * **書いてあればそれを、書いていなければ {@link DEFAULT_REFERENCE_PICKER} を返す。**
 * **解決の規則はこの1関数だけである** —— 器の割り当ても、優先順位も、ここには無い。
 *
 * **【`V6-M2-T03` / `K-G2` / `K-G5` / `ADR-0289` 限定5 で優先順位を足した】**
 * **上の1文「優先順位も、ここには無い」は今日から偽である** —— **`V6-M2` が
 * 入力画面ごとの上書き(`FormView.reference_pickers`)を足し、その解決を
 * この関数の中に置いた。****旧文を1バイトも消していない。**
 *
 * **優先順位は「画面 > 項目 > 既定」の1本だけである**(`ADR-0289` 限定5):
 *
 * 1. **画面**: 第2引数の入力画面が `reference_pickers` にこの項目のIDを書いていれば、それ。
 * 2. **項目**: 書いていなければ、項目側の `reference_picker`(`ADR-0288`)。
 * 3. **既定**: どちらも書いていなければ {@link DEFAULT_REFERENCE_PICKER}(= `list`)。
 *
 * **どちらが勝つかの規則を2つ作らない**(`ADR-0084` 限定4 と同じ精神)——
 * **この関数の外に解決の規則は1箇所も無い。**
 * **第2引数を渡さない呼び出しは「画面側の宣言が無い」と同じに倒れる**(2 → 3 の順)。
 *
 * **【今日この関数を呼ぶ描画経路は1つも無い。隠さない】**
 * **`V6-M1` は宣言だけを受け付け、画面は今日どおりプルダウンのままである** ——
 * **`type_filter`(打った文字で絞る)と `search`(別の面を開いて探す)の描画は
 * `V6-M4` / `V6-M5` の担当であり、今日は1バイトも実装されていない。**
 * **つまり今日この2値を書いても画面は変わらない = 「書けるが今日は効かない」。**
 * **この関数をここに置いたのは、既定を持つ場所を先に1箇所へ固定するためである**
 * (`V6-M2` の「画面 > 項目 > 既定」の解決も、ここを起点に足す)。
 *
 * **`ReferenceInput` はこの関数を呼んでいない** —— **呼ばないことが
 * 「書かなかった項目の画面が今日と1バイトも変わらない」の担保そのものであり、
 * `web/test/reference-picker.test.tsx` がそれを実測で固定している。**
 */
export function resolveReferencePicker(
  field: Extract<Field, { type: "reference" }>,
  view?: Pick<FormView, "reference_pickers">,
): NonNullable<Extract<Field, { type: "reference" }>["reference_picker"]> {
  return view?.reference_pickers?.[field.id] ?? field.reference_picker ?? DEFAULT_REFERENCE_PICKER;
}

/**
 * form に現れる reference フィールドの参照先レコードを取得する。
 *
 * 参照先テーブル単位で1回だけ取りに行く(同じテーブルを2つのフィールドが参照しても
 * 1回)。取得に失敗しても選択肢が空になるだけで、フォーム全体は描画され続ける。
 */
export function useReferenceChoices(
  appId: string,
  manifest: Manifest,
  referenceTableIds: ResourceId[],
): ReferenceChoices {
  // 依存配列に配列そのものを置くと毎レンダリングで再取得になるので、内容を鍵にする。
  const key = [...new Set(referenceTableIds)].sort().join(",");
  const [choices, setChoices] = useState<ReferenceChoices>(new Map());

  useEffect(() => {
    const tableIds = key === "" ? [] : key.split(",");
    let cancelled = false;
    setChoices(new Map(tableIds.map((tableId) => [tableId, { status: "loading" }])));

    for (const tableId of tableIds) {
      // 解決だけを他の3箇所と揃える(ADR-0006 §7 の #12)。`reference_table` は
      // システムテーブルを取れない(§9 の裏口封じ)ので**ここへは到達しないはず**
      // だが、未解決だと下の早期 return が選択肢を黙って空にして握り潰す。
      // 「到達しないはず」に安全性を預けない。
      const table = resolveViewTable(manifest, tableId);
      fetchRecords(appId, tableId).then(
        (rows) => {
          if (cancelled || table === undefined) {
            return;
          }
          const value = rows.map((row) => ({
            id: row._id,
            label: referenceLabel(table, row),
          }));
          setChoices((previous) => new Map(previous).set(tableId, { status: "ready", value }));
        },
        (reason: unknown) => {
          if (cancelled) {
            return;
          }
          setChoices((previous) =>
            new Map(previous).set(tableId, {
              status: "error",
              errors: toValidationErrors(reason),
            }),
          );
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [appId, key, manifest]);

  return choices;
}

// ---------------------------------------------------------------------------
// 付与表の「相手」の候補を、親の行に権限を持つ人へ絞る(`Z-G27`。`V7-M6-T02`)
// ---------------------------------------------------------------------------
//
// **【最初に書く】候補に出さないことは、書込を止めることではない。**
// **書込を止めているのはサーバ側の `Z-G33`(`V7-M3-T04`)であり、その拒否は本ファイルを
// 1バイトも実装しなくても今日どおり効く**(`v7-m0.md` §6-2 の `Z-G33` 限定 (6) の逐語
// 「**`Z-G27` を担保にしない**」)。**実在の確認は
// `web/test/reference-candidate-permission.test.tsx` の (3) が名指しで行う。**
//
// **【新しい読取経路を1本も作っていない】** —— 使うのは既存の {@link fetchRecord} と
// {@link fetchRecords} だけで、絞り込みは既存の `filter` の**等値1葉**だけで書く。
// **`web/src/api.ts` に関数を1本も足していない。**
//
// **【判定の家を増やしていない】** —— **`read` / `write` / `delete` を計算する場所は
// 今日もサーバの1本だけである。** ここがしているのは「付与の行を読んで、`read` が真の
// 権限を持つ相手を集める」ことだけで、判定の関数を1つも呼んでいない。

/**
 * 付与表の入力画面で、候補を絞る足場(`Z-G27`)。
 *
 * **`undefined` を返したときは、候補が今日と1バイトも変わらない。**
 */
export type GrantMemberScope = {
  /** この付与表を名指ししている、保護されている表。 */
  protectedTableId: ResourceId;
  /** 付与表の「対象の行」を指す項目。 */
  targetFieldId: ResourceId;
  /** 付与表の「相手(利用者)」を指す項目。 */
  memberFieldId: ResourceId;
  /** 「相手」の参照先(利用者表)。 */
  memberTableId: ResourceId;
  /** 引き継ぎ元(親)を指す、保護されている表の `reference` 項目。**1本以上ある。** */
  inheritFrom: ResourceId[];
};

/**
 * 入力画面の対象テーブルが「アクセス権管理を宣言した表の付与表」かどうかを、
 * **マニフェストの宣言だけ**から解く(読取を1件も飛ばさない)。
 *
 * **絞り込みが効くのは、次の全部が揃ったときだけである。**
 *
 *  1. その表を `access_control.grant.table` に名指しした表が在り、`enabled` が真。
 *  2. その宣言の `inherit_from`(親)が**1本以上**ある —— **空の表では絞らない**
 *     (サーバ側の (C-1)「`inherit_from` が空の表では何も止めない」と境界を揃える)。
 *  3. `grant.member` が実在の `reference` 項目である。
 *
 * **どれか1つでも欠けたら `undefined` を返す**(= 今日どおり)。
 */
export function grantMemberScope(
  manifest: Manifest,
  formTableId: ResourceId,
): GrantMemberScope | undefined {
  const grantTable = resolveViewTable(manifest, formTableId);
  if (grantTable === undefined) {
    return undefined;
  }
  for (const table of manifest.app.tables) {
    const declared = table.access_control;
    if (declared === undefined || declared.enabled !== true) {
      continue;
    }
    if (declared.grant?.table !== formTableId) {
      continue;
    }
    const inheritFrom = Array.isArray(declared.inherit_from) ? declared.inherit_from : [];
    const memberFieldId = declared.grant.member;
    if (inheritFrom.length === 0 || memberFieldId === undefined) {
      return undefined;
    }
    const memberField = grantTable.fields.find((field) => field.id === memberFieldId);
    if (memberField === undefined || memberField.type !== "reference") {
      return undefined;
    }
    return {
      protectedTableId: table.id,
      targetFieldId: declared.grant.target,
      memberFieldId,
      memberTableId: memberField.reference_table,
      inheritFrom: [...inheritFrom],
    };
  }
  return undefined;
}

/** 行の値を、参照先の `_id` として読む(空文字は「指していない」)。 */
function referencedId(value: unknown): string {
  return typeof value === "string" && value !== "" ? value : "";
}

/**
 * **親の行を読める利用者行の id を集める** —— 既存の一覧 GET と `filter` の等値1葉だけで引く。
 *
 * 1. 親の付与表を `filter.<target>=<親の行>` で引く(**葉は `equals` 1本**)。
 * 2. `read` が真の権限を持つ行だけを残す(権限の値域は宣言から読む)。
 * 3. 直接の相手はそのまま、班(グループ)への付与は**その班に属する利用者行**へ広げる
 *    (こちらも `filter.<members.group>=<班>` の等値1葉)。
 *
 * **`_id` を `filter` の葉に書けない**(宣言した項目しか絞り込みに使えない)ので、
 * **集めた id の集合は受け取ってから当てる。**
 */
async function readParentPermittedMemberIds(
  appId: string,
  declared: NonNullable<Table["access_control"]>,
  parentRecordId: string,
): Promise<Set<string>> {
  const readable = new Set(
    declared.permissions.filter((permission) => permission.read === true).map((p) => p.id),
  );
  const grantRows = await fetchRecords(appId, declared.grant.table, {
    filter: [{ field: declared.grant.target, equals: parentRecordId }],
  });
  const memberIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const row of grantRows) {
    const permission = referencedId(row[declared.grant.permission]);
    if (!readable.has(permission)) {
      continue;
    }
    const memberField = declared.grant.member;
    const memberId = memberField === undefined ? "" : referencedId(row[memberField]);
    if (memberId !== "") {
      memberIds.add(memberId);
    }
    const groupField = declared.grant.group;
    const groupId = groupField === undefined ? "" : referencedId(row[groupField]);
    if (groupId !== "") {
      groupIds.add(groupId);
    }
  }
  const memberTable = declared.members?.table;
  const memberGroupField = declared.members?.group;
  if (memberTable !== undefined && memberGroupField !== undefined) {
    for (const groupId of groupIds) {
      const rows = await fetchRecords(appId, memberTable, {
        filter: [{ field: memberGroupField, equals: groupId }],
      });
      for (const row of rows) {
        memberIds.add(row._id);
      }
    }
  }
  return memberIds;
}

/**
 * 候補に残してよい利用者行の id を解く。**`undefined` は「絞らない」である。**
 *
 * **サーバ側(`Z-G33`)と境界を揃えて、次のときは絞らない**:
 * 対象の行が親を1つも指していない / 親の表が宣言していない / 親と子の利用者表が別物。
 */
async function resolvePermittedGrantMemberIds(
  appId: string,
  manifest: Manifest,
  scope: GrantMemberScope,
  targetRecordId: string,
): Promise<ReadonlySet<string> | undefined> {
  const protectedTable = resolveViewTable(manifest, scope.protectedTableId);
  if (protectedTable === undefined) {
    return undefined;
  }
  const targetRow = await fetchRecord(appId, scope.protectedTableId, targetRecordId);
  let permitted: Set<string> | undefined;
  for (const fieldId of scope.inheritFrom) {
    const field = protectedTable.fields.find((candidate) => candidate.id === fieldId);
    if (field === undefined || field.type !== "reference") {
      continue;
    }
    const parentRecordId = referencedId(targetRow[fieldId]);
    if (parentRecordId === "") {
      continue; // **親を指していない行では絞らない。**
    }
    const parentTable = resolveViewTable(manifest, field.reference_table);
    const declared = parentTable?.access_control;
    if (declared === undefined || declared.enabled !== true) {
      continue; // **親が宣言していなければ絞らない。**
    }
    if (declared.members?.table !== scope.memberTableId) {
      return undefined; // **親と子で利用者表が違うと、id を突き合わせられない。**
    }
    const ids = await readParentPermittedMemberIds(appId, declared, parentRecordId);
    permitted = permitted === undefined ? ids : new Set([...permitted].filter((id) => ids.has(id))); // 親が2本なら両方を読める人だけ
  }
  return permitted;
}

/**
 * 付与表の「相手」の候補に残してよい利用者行の id(`Z-G27`)。
 *
 * **`undefined` を返すあいだは、候補が今日と1バイトも変わらない。**
 *
 * **【正直に書く】読取に失敗したら `undefined` に倒す**(= 今日どおり全件を出す)——
 * **黙って空の候補にすると、誰も選べない画面になる。** **書込を止めているのは
 * サーバ側であって候補ではないので、ここは開く側に倒している。**
 */
export function usePermittedGrantMemberIds(
  appId: string,
  manifest: Manifest,
  formTableId: ResourceId,
  targetRecordId: string,
): ReadonlySet<string> | undefined {
  const [permitted, setPermitted] = useState<ReadonlySet<string> | undefined>(undefined);
  useEffect(() => {
    const scope = grantMemberScope(manifest, formTableId);
    if (scope === undefined || targetRecordId === "") {
      setPermitted(undefined);
      return;
    }
    let cancelled = false;
    resolvePermittedGrantMemberIds(appId, manifest, scope, targetRecordId).then(
      (ids) => {
        if (!cancelled) {
          setPermitted(ids);
        }
      },
      () => {
        if (!cancelled) {
          setPermitted(undefined);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, manifest, formTableId, targetRecordId]);
  return permitted;
}

/**
 * 取得済みの候補から、残してよい id だけを残す(`Z-G27`)。
 *
 * **ラベルを1つも作らない** —— 受け取った選択肢をそのまま残すだけである
 * (ラベルの規則は {@link referenceLabel} の1本しか無い)。
 * **絞る集合を渡さなければ、受け取った Map をそのまま返す**(今日どおり)。
 *
 * **【正直に書く】絞るのは参照先テーブルの単位である** —— **同じ画面に同じ利用者表を
 * 指す別の参照項目があれば、それも一緒に絞られる。**
 */
export function restrictReferenceChoices(
  choices: ReferenceChoices,
  memberTableId: ResourceId | undefined,
  permitted: ReadonlySet<string> | undefined,
): ReferenceChoices {
  if (memberTableId === undefined || permitted === undefined) {
    return choices;
  }
  const state = choices.get(memberTableId);
  if (state === undefined || state.status !== "ready") {
    return choices;
  }
  return new Map(choices).set(memberTableId, {
    status: "ready",
    value: state.value.filter((choice) => permitted.has(choice.id)),
  });
}

/**
 * すべての入力要素に共通で載せる属性。
 *
 * **`aria-invalid` は省略可にしてある** —— 妥当な入力欄には**属性ごと出さない**。
 * `aria-invalid="false"` を出しても部品側の `aria-invalid:border-destructive` は当たらないが、
 * 「着手前0件 → 着手後 N件」を数えるときに数え方が濁るので、出さない側に倒す。
 */
type CommonInputProps = {
  id: string;
  "aria-required": boolean;
  "aria-invalid"?: true;
  "data-testid": string;
};

export type FieldInputProps = {
  field: Field;
  /** ラベルと結びつける DOM の id。 */
  inputId: string;
  value: FieldInputValue;
  onChange: (value: FieldInputValue) => void;
  /** reference の選択肢(その他の型では使わない)。 */
  referenceChoices: ReferenceChoices;
  /**
   * 所属アプリのID。**image / file 型でだけ使う** —— アップロード先
   * `POST /api/apps/<appId>/files` と配信 URL `/api/apps/<appId>/files/<file_id>` を
   * 組むのに要る(他の型では参照しない)。
   */
  appId: string;
  /**
   * この入力欄に紐づくエラーがあるか(`V4-M15-T14` の一部)。
   *
   * **判定はここでしない** —— カーネルが返した統一形式エラーを `path` で振り分けているのは
   * `FormRenderer` の `groupErrorsByField` 1箇所だけであり、その結果をそのまま受ける。
   * **省略時は「エラーなし」**(`FieldInput` を単体で使う経路の既定)。
   */
  invalid?: boolean;
  /**
   * **この入力欄が載っている入力画面**(`K-G2`。`V6-M4-T01`)。
   *
   * **`reference_pickers`(画面ごとの上書き)を読むためだけに受け取る** ——
   * **解決は {@link resolveReferencePicker} の1関数だけが行い、ここでは分岐しない。**
   * **渡さなければ「画面側の宣言が無い」に倒れる**(= 項目側 → 既定の順)。
   */
  view?: Pick<FormView, "reference_pickers">;
  /**
   * **所属アプリのマニフェスト**(`K-G9` / `K-G11`。`V6-M4-T01`)。
   *
   * **`reference_picker: "type_filter"` の項目でだけ使う** —— 参照先テーブルの定義を引いて
   * **「何を打つと当たるか」を `referenceSearchFields` に解決させる**のに要る
   * (**その規則をここに再実装しない**)。**他の型では1バイトも参照しない。**
   *
   * **渡さないと参照先テーブルが引けない** —— そのとき `type_filter` は
   * **「打って絞れません」と正直に出す**(黙って全件のプルダウンに倒さない)。
   */
  manifest?: Manifest;
  /**
   * **名簿の `account` 欄に出す、利用者の選択肢**(`UM-G2`。`V13-M1-T02`)。
   *
   * **渡ってくるのはその1項目のときだけである** —— どの項目がその欄かを解くのは
   * `views/FormRenderer.tsx` 側の `accountFieldFor` 1本であり、**ここに再実装しない。**
   *
   * **`undefined` なら今日どおりの `<input type="text">` に倒す**(一覧が読めない立場・
   * 名簿でない表・そもそも宣言が無いアプリは、すべてこちらに落ちる)。
   */
  userAccountChoices?: readonly UserAccountChoice[] | undefined;
};

/**
 * 1フィールドの入力UI。
 *
 * `required` は `aria-required` として**表示にだけ**反映し、`required` 属性による
 * ブラウザの送信ブロックは行わない。理由は `FormRenderer` の冒頭コメントを参照。
 */
export function FieldInput({
  field,
  inputId,
  value,
  onChange,
  referenceChoices,
  appId,
  invalid,
  view,
  manifest,
  userAccountChoices,
}: FieldInputProps) {
  const common: CommonInputProps = {
    id: inputId,
    "aria-required": field.required === true,
    "data-testid": `field-input-${field.id}`,
    // **エラーのある欄にだけ付ける。** 無い欄には属性そのものを出さない。
    ...(invalid === true ? { "aria-invalid": true as const } : {}),
  };

  switch (field.type) {
    case "text":
      // **選択肢が渡ってきたときだけプルダウンにする**(`UM-G2`。`V13-M1-T02`)——
      // **それ以外は着手前と1バイトも同じ `<input type="text">` である。**
      return userAccountChoices === undefined ? (
        <Input
          {...common}
          type="text"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <UserAccountInput
          common={common}
          choices={userAccountChoices}
          value={asText(value)}
          onChange={onChange}
        />
      );
    case "long_text":
      return (
        <Textarea
          {...common}
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "number":
      return (
        <Input
          {...common}
          type="number"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "boolean":
      // **`Checkbox` は素の `<input type="checkbox">` に体裁を当てただけの部品である。**
      // `type` は部品側が持つので、ここでは書かない(書いても同じ値になる)。
      return (
        <Checkbox
          {...common}
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      );
    case "date":
      return (
        <Input
          {...common}
          type="date"
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "select":
      return (
        <Select
          {...common}
          value={asText(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {/* 未選択を表現できること。required でも「まだ選んでいない」は起こりうる。 */}
          <option value={UNSELECTED} />
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </Select>
      );
    case "reference": {
      // **「選び方」の解決はここ1箇所でしか呼ばない**(`ADR-0288` 限定3 /
      // `ADR-0289` 限定5)。**器の割り当ての分岐もここだけである。**
      // **`list`(既定)は今日どおりの `ReferenceInput` へ倒れ、その関数は
      // 新しいキーを1バイトも読まない** —— **「書かなかった項目の画面が今日と
      // 1ピクセルも変わらない」の担保である。**
      // **【`V6-M5-T01` の書き換え。旧文を1バイトも消していない】**
      // **旧文**: 「**`search` は今日も `list` と同じ描画に倒れる**(器は `V6-M5` の担当。
      // **「書けるが今日は効かない」を隠さない**)。」
      // **今日この文は偽である** —— **`V6-M5` が `search` に器を当てた。**
      // **3値とも当たり先が実在し、「書けるが効かない」は参照の選び方から1値も残っていない。**
      const picker = resolveReferencePicker(field, view);
      const referenceTable =
        manifest === undefined ? undefined : resolveViewTable(manifest, field.reference_table);
      if (picker === "type_filter") {
        return (
          <ReferenceTypeFilterInput
            field={field}
            common={common}
            appId={appId}
            table={referenceTable}
            value={asText(value)}
            onChange={onChange}
          />
        );
      }
      if (picker === "search") {
        return (
          <ReferenceSearchInput
            field={field}
            common={common}
            appId={appId}
            table={referenceTable}
            value={asText(value)}
            onChange={onChange}
          />
        );
      }
      return (
        <ReferenceInput
          field={field}
          common={common}
          value={asText(value)}
          onChange={onChange}
          state={referenceChoices.get(field.reference_table)}
        />
      );
    }
    case "image":
      return (
        <ImageInput
          field={field}
          common={common}
          appId={appId}
          value={asText(value)}
          onChange={onChange}
        />
      );
    case "file":
      return (
        <GeneralFileInput
          field={field}
          common={common}
          appId={appId}
          value={asText(value)}
          onChange={onChange}
        />
      );
  }
}

/**
 * image の入力(V2-M2-T04 / ADR-0035)。
 *
 * `<input type=file>` で画像を選ぶと `POST /api/apps/<appId>/files` へ multipart で送り、返った
 * `file_id` をフォーム値にする(ADR-0035 §1b: レコードの image フィールドに書けるのは
 * アップロード済み file_id のみ)。**フォーム値は生の file_id 文字列**で、他の型と同じく
 * `onChange` で親へ届く —— 送信時にそのまま image フィールドの値になる。
 *
 * 現在値(file_id)があれば配信 URL(`/api/apps/<appId>/files/<file_id>`)を `<img>` で
 * プレビューする。アップロードの失敗は握り潰さず統一形式(`ErrorList`)で出す(憲法6)。
 * mime/size の制約検査はサーバの責務なので、ここで先回りして弾かない(`accept` 属性は
 * ファイル選択ダイアログの利便のためだけに付け、これを検証とは見なさない)。
 */
function ImageInput({
  field,
  common,
  appId,
  value,
  onChange,
}: {
  field: Field;
  common: CommonInputProps;
  appId: string;
  value: string;
  onChange: (value: FieldInputValue) => void;
}) {
  const [state, setState] = useState<AsyncState<null>>({ status: "ready", value: null });

  const handleFile = (file: File | undefined): void => {
    if (file === undefined) {
      return;
    }
    setState({ status: "loading" });
    uploadFile(appId, file).then(
      (uploaded) => {
        onChange(uploaded.file_id);
        setState({ status: "ready", value: null });
      },
      (reason: unknown) => {
        setState({ status: "error", errors: toValidationErrors(reason) });
      },
    );
  };

  return (
    <>
      <Input
        {...common}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        onChange={(event) => handleFile(event.target.files?.[0])}
      />
      {state.status === "loading" && (
        <span
          data-testid={`image-uploading-${field.id}`}
          className="text-note text-muted-foreground"
        >
          アップロード中…
        </span>
      )}
      {value !== "" && (
        // 現在値のプレビュー。file_id は配信 URL の一部としてだけ使い、生値を読み手に出さない。
        <img
          data-testid={`image-preview-${field.id}`}
          src={fileDeliveryUrl(appId, value)}
          alt={field.name}
          className="max-w-full rounded-ui"
        />
      )}
      {state.status === "error" && (
        <div data-testid={`image-error-${field.id}`}>
          <ErrorList errors={state.errors} />
        </div>
      )}
    </>
  );
}

/**
 * `file`(一般のファイル)の入力(`V5-M16-T05` / `ADR-0161` + `D-V5-84`)。
 *
 * `ImageInput` と同じ形だが、**3点だけ違う**:
 *
 * 1. **`accept` 属性を1つも付けない。** **受け入れる種類の制限は0件である**(`D-V5-84`)——
 *    `accept` を書くとファイル選択ダイアログが絞られ、**利用者に「この種類しか上げられない」
 *    という嘘を見せる。**
 * 2. **`uploadFile` に `kind="file"` を渡す**(上限 20,000,000 バイト。415 は返らない)。
 * 3. **現在値をプレビュー画像にしない。** **ダウンロードのリンクにする** ——
 *    **配信は実体が4種の画像と判定できない限り必ずダウンロードで返る**ので、
 *    `<img>` に入れても何も映らない。
 *
 * **`ImageInput` と1つの部品に畳んでいない。** 畳むと `accept` と `kind` と現在値の見せ方を
 * 引数で切り替えることになり、**「画像かどうか」の分岐が部品の中に増える** —— 型で分かれて
 * いるものを実行時の引数に落とし込まない。
 */
function GeneralFileInput({
  field,
  common,
  appId,
  value,
  onChange,
}: {
  field: Field;
  common: CommonInputProps;
  appId: string;
  value: string;
  onChange: (value: FieldInputValue) => void;
}) {
  const [state, setState] = useState<AsyncState<null>>({ status: "ready", value: null });

  const handleFile = (file: File | undefined): void => {
    if (file === undefined) {
      return;
    }
    setState({ status: "loading" });
    uploadFile(appId, file, "file").then(
      (uploaded) => {
        onChange(uploaded.file_id);
        setState({ status: "ready", value: null });
      },
      (reason: unknown) => {
        setState({ status: "error", errors: toValidationErrors(reason) });
      },
    );
  };

  return (
    <>
      <Input {...common} type="file" onChange={(event) => handleFile(event.target.files?.[0])} />
      {state.status === "loading" && (
        <span
          data-testid={`file-uploading-${field.id}`}
          className="text-note text-muted-foreground"
        >
          アップロード中…
        </span>
      )}
      {value !== "" && (
        // 現在値。**プレビューしない**(配信はダウンロードで返る)。file_id は配信 URL の
        // 一部としてだけ使い、生値を読み手に出さない。
        <a data-testid={`file-current-${field.id}`} href={fileDeliveryUrl(appId, value)} download>
          {field.name}をダウンロード
        </a>
      )}
      {state.status === "error" && (
        <div data-testid={`file-error-${field.id}`}>
          <ErrorList errors={state.errors} />
        </div>
      )}
    </>
  );
}

/**
 * **名簿の `account` 欄**(`UM-G2`。`V13-M1-T02`)。**生の利用者IDを打たせない。**
 *
 * **保存される値は利用者IDのままである** —— 変えたのは「打つ」を「選ぶ」にしたことだけで、
 * ログイン名を値として書き込む経路を1本も作っていない。
 *
 * **今入っている値がどの利用者にも一致しないときは、黙って消さない。**
 * その値の選択肢を**先頭**に足し、**一致していないことが分かるラベル**を付ける
 * (書き写しの事故で入った値を、画面が勝手に別人へ付け替えない)。
 */
function UserAccountInput({
  common,
  choices,
  value,
  onChange,
}: {
  common: CommonInputProps;
  choices: readonly UserAccountChoice[];
  value: string;
  onChange: (value: FieldInputValue) => void;
}) {
  const known = choices.some((choice) => choice.id === value);
  return (
    /* **素の `<select>` である**(`ADR-0087` 限定8)。重ねて出すメニューにしない。 */
    <Select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
      {value !== UNSELECTED && !known && (
        <option value={value}>{`${value}(該当する利用者が居ません)`}</option>
      )}
      {/* 未選択。**文言は参照のプルダウンに倣う**(空のまま)。 */}
      <option value={UNSELECTED} />
      {choices.map((choice) => (
        <option key={choice.id} value={choice.id}>
          {choice.label}
        </option>
      ))}
    </Select>
  );
}

/**
 * reference の入力。**生の `_id` を打たせない**ピッカーにする。
 *
 * 参照先が空・取得失敗のときも `select` 自体は描画し、失敗の理由は統一形式のまま
 * 出す(黙って空の選択肢にしない = 憲法6)。
 */
function ReferenceInput({
  field,
  common,
  value,
  onChange,
  state,
}: {
  field: Extract<Field, { type: "reference" }>;
  common: CommonInputProps;
  value: string;
  onChange: (value: FieldInputValue) => void;
  state: AsyncState<ReferenceChoice[]> | undefined;
}) {
  const choices = state !== undefined && state.status === "ready" ? state.value : [];
  return (
    <>
      {/* **素の `<select>` である**(`ADR-0087` 限定8)。重ねて出すメニューにしない。 */}
      <Select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={UNSELECTED} />
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </Select>
      {state !== undefined && state.status === "error" && (
        <div data-testid={`reference-error-${field.id}`}>
          <ErrorList errors={state.errors} />
        </div>
      )}
    </>
  );
}

/**
 * reference の入力のうち、**打った文字で候補を絞る**もの
 * (選び方 = `type_filter`。`K-G11` / `K-G13` / `K-G14` / `K-G15` /
 * `K-G17` / `K-G18`。`V6-M4-T01` 〜 `V6-M4-T05`)。
 *
 * **`ReferenceInput`(今日どおりのプルダウン)と1つの部品に畳んでいない。** 畳むと
 * 「打つ口があるか」「上限があるか」「取得を自分で持つか」の分岐が部品の中に増え、
 * **`list` の描画が今日と1ピクセルも変わらないことを機械で言えなくなる。**
 *
 * ## 何をしていて、何をしていないか
 *
 * - **打った語は {@link buildSearchFilter} に渡すだけである**(`K-G11`)——
 *   **照合の規則(`contains` の OR 固定)をここに1バイトも再実装していない。**
 * - **探す対象は {@link referenceSearchFields} が解決する**(`ADR-0290` 限定7)——
 *   **優先順位も既定もここに1バイトも再実装していない。**
 * - **取得は既存の {@link fetchRecordPage} の1本だけを通る**(`K-G18`)——
 *   **`st_owner` / `st_public` の post-filter も `audience` の射影も、サーバの
 *   同じ1本の読取ルートが今日どおり掛ける。****迂回する経路を1本も作っていない。**
 * - **打った語はマニフェストに1バイトも入らない**(`K-G12`。不可侵条件)——
 *   **語は `useState` の中と、リクエストのクエリにしか存在しない。**
 *   **このファイルに書込のAPI を呼ぶ行は1行も無い。**
 *
 * ## 【正直に書く】この部品が解いていないこと
 *
 * 1. **探せる項目が0本のとき、打つ口を出さない。** **黙って全件に倒さず、「打って
 *    絞り込めません」と出す**(憲法6)。**`v6-m3.md` §5-2 の 3 が `V6-M4` に決めさせた
 *    論点であり、本タスクが「口を出さない」側を選んだ。**
 * 2. **上限に当たったかどうかは `total` と返ってきた件数の比較で判定するが、`total` は
 *    可視性の post-filter 後の値である** —— **相手によって「上限に当たった」の出方が
 *    変わる**(`v6-m0.md` §7-6 の `S3` (2))。
 * 3. **絞り込んでも出てこない語がありうる**(`contains` の OR 固定)。**何を打てば当たるかは
 *    画面に出ない** —— **探せる項目の宣言は作る人と AI のものであり、使う人には見えない。**
 * 4. **ページ送りが無い**(`K-G16` は `V6-M5-T03` の担当)。**上限を超えた分は、絞り込む
 *    以外に見る手段が今日は1つも無い。**
 */
function ReferenceTypeFilterInput({
  field,
  common,
  appId,
  table,
  value,
  onChange,
}: {
  field: Extract<Field, { type: "reference" }>;
  common: CommonInputProps;
  appId: string;
  table: Table | undefined;
  value: string;
  onChange: (value: FieldInputValue) => void;
}) {
  const tableId = field.reference_table;
  // **探す対象の解決は1本だけ**(`ADR-0290` 限定7)。**IDの並びを依存配列の鍵にする**
  // —— 配列そのものを置くと毎レンダリングで取り直しになる(`useReferenceChoices` と同じ作法)。
  const searchFieldIds = referenceSearchFields(table, field)
    .map((searchField) => searchField.id)
    .join(",");
  const searchable = searchFieldIds !== "";

  /** 打っている途中の語。**画面の一時状態であり、どこにも保存しない。** */
  const [term, setTerm] = useState("");
  /** 実際にサーバへ投げる語(間隔をあけて `term` から遅れて追いつく)。 */
  const query = useDebouncedTerm(term);
  /**
   * **候補の取得**(`K-G11` / `K-G14` / `K-G18`)。
   * **【`V6-M5-T01` の書き換え】** **取得の本体を {@link useReferenceCandidatePage} へ
   * 移した** —— **別の面を開いて探す形が同じ取得を要るので、口を2箇所に住まわせない。**
   * **渡している値も、飛ぶリクエストも1バイトも変えていない**(この形はページを送らないので
   * `offset` は常に 0 = クエリに1バイトも載らない)。
   */
  const state = useReferenceCandidatePage({
    appId,
    tableId,
    searchFieldIds,
    query,
    offset: 0,
    enabled: true,
  });
  /** **選択済みの値のラベル**(`K-G17`)。候補の外に在っても値を消さないために持つ。 */
  const selected = useSelectedReferenceChoice(appId, tableId, table, value);

  const choices =
    state.status === "ready" ? state.value.rows.map((row) => toReferenceChoice(table, row)) : [];
  const total = state.status === "ready" ? state.value.total : 0;
  /** **上限に当たったか。** 黙って切らない(`K-G15`)。**判定は1本しか無い。** */
  const note =
    state.status === "ready"
      ? referenceCandidateNote({
          total,
          count: choices.length,
          offset: 0,
          searchable,
          paged: false,
        })
      : undefined;
  /**
   * **選択済みの値が候補の中に無い**(`K-G17`)。
   * **このとき option を1つ足す** —— 足さないと `<select>` の値が DOM から消え、
   * **利用者が何も触らずに保存したつもりでも、画面上は空に見える。**
   */
  const keepSelected = value !== "" && !choices.some((choice) => choice.id === value);

  return (
    <>
      {searchable ? (
        <Input
          type="search"
          data-testid={`reference-search-${field.id}`}
          aria-label={`${field.name}を絞り込む`}
          value={term}
          onChange={(event) => setTerm(event.target.value)}
        />
      ) : (
        // **黙って全件のプルダウンに倒さない**(憲法6)。**打っても当たらないことを言う。**
        <span
          data-testid={`reference-search-unavailable-${field.id}`}
          className="text-note text-muted-foreground"
        >
          {SEARCH_UNAVAILABLE_NOTE}
        </span>
      )}
      {/* **素の `<select>` のままである**(`ADR-0087` 限定8)。重ねて出すメニューにしない。 */}
      <Select {...common} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value={UNSELECTED} />
        {keepSelected && <option value={value}>{selected?.label ?? value}</option>}
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </Select>
      {note !== undefined && (
        <span
          data-testid={`reference-limit-${field.id}`}
          className="text-note text-muted-foreground"
        >
          {note}
        </span>
      )}
      {state.status === "error" && (
        <div data-testid={`reference-error-${field.id}`}>
          <ErrorList errors={state.errors} />
        </div>
      )}
    </>
  );
}

/**
 * reference の入力のうち、**別の面を開いて探す**もの
 * (選び方 = `search`。`K-G16` / `K-G19` / `K-G20`。`V6-M5-T01` 〜 `V6-M5-T04`)。
 *
 * ## 器は既存の3つのうちの1つである(`K-G19`。`ADR-0094` 限定2)
 *
 * **{@link OverlayDialog}(重ねて出す小窓)をそのまま呼ぶ。** **4つ目の器を1バイトも
 * 作っていない** —— `OVERLAY_CONTAINERS` の配列に要素を1つも足していない。
 * **重ね順の段も増やしていない**(`ADR-0094` 限定4。段は今日も2つである)。
 *
 * **`modal`(`form` 専用の宣言。`ADR-0095`)を1バイトも引き直していない** ——
 * **これは「画面まるごとを重ねる」宣言ではなく、画面の中の1項目のために開く器である**
 * (`01` §4-6 (c))。**マニフェストに新しい置き場を1つも作っていない。**
 *
 * ## テーマのスコープの中に出す(完了条件 (v))
 *
 * **`ViewHost` の `ViewShell` が既に採っている作法に倣う** —— 自分の DOM 上の位置から
 * `.app-theme` の祖先を引いて差し込み先に渡す。**`document.querySelector` で文書の先頭から
 * 探さない**(テーマ候補のプレビューが同じクラス名の器を同時に描くので、別のアプリの配色を
 * 引きうる)。**祖先に `.app-theme` が無ければ `document.body` へ倒す**(fail-open)——
 * **黙って器を出さない方が危険である**(そのとき配色は既定に倒れる。隠さない)。
 *
 * ## 中に出すのは「選ぶための一覧」だけである
 *
 * - **並べる列は {@link referencePopupColumns} が宣言から導く**(`K-G10`。`V6-M3-T05`)——
 *   **列のための新しいキーを1本も足していない。** **最大8列になりうる。**
 * - **操作の起点(v5 の軸が通した一覧行の操作)を1つも出していない** ——
 *   **この器は選ぶためだけのものである**(`01` §7-2)。**一覧の描画部品を1つも呼んでいない。**
 * - **画面ごとの「見せ方」の9軸(`preset_` で始まるキー)は、この一覧に1つも効かない。**
 *   **`preset_` を読む分岐がこのファイルに1つも無い**(機械的な固定は
 *   `web/test/reference-search-popup.test.tsx` の (h))。**列の寄せも列の幅も器の形も
 *   詰まり具合も、ここでは書けない。** **`ADR-0050` / `ADR-0051` の規則は
 *   `.list-table` などの既存クラスに当たっており、この一覧はそのクラスを1つも持たない。**
 *   **「書けるが効かない」を黙って作らないために、ここに明記する**(`V6-M5-T04`)。
 * - **見つからない相手をその場で作る導線を1本も出していない**(`D-V6-19`)——
 *   **見つからなければ、今日どおり別の画面で登録することになる。** **その案内も出さない**
 *   (出すと、この器の中で作れるかのような期待を作る)。
 *
 * ## 続きはページ送りで見る(`K-G16`)
 *
 * **既存の `offset` / `limit` / `total` だけで動く。** **語彙を1つも増やしていない。**
 * **ページ位置はこの部品の一時状態であり、マニフェストにも URL にも1バイトも入らない**
 * (`ADR-0042` 限定2 / §3a-2 を1バイトも引き直さない)。
 *
 * ## 【正直に書く】この器が解いていないこと
 *
 * 1. **ページを送っている最中に他の人が行を足すと、同じ行が2回出たり出なかったりする**
 *    (既存のページネーションと同じ性質。`v6-m0.md` §7-7 の `S3` (3))。**解いていない。**
 * 2. **並び順は作成順である。** **名前順で並べる口を1つも作っていない。**
 * 3. **列に出すのは値そのままの文字である。** 単位・強調・空欄の隠しなど、一覧が持つ
 *    見せ方の宣言はこの器に1つも効かない。
 * 4. **探せる項目に代表の項目が入っていない宣言では、一覧に名前の列が並ばない**
 *    (`ADR-0290` §この ADR の限界 4。`v6-m3.md` §5-3 の 3)。**解いていない。**
 * 5. **狭い画面での見え方を1度も測っていない**(`v6-m3.md` §5-3 の 2)。
 */
function ReferenceSearchInput({
  field,
  common,
  appId,
  table,
  value,
  onChange,
}: {
  field: Extract<Field, { type: "reference" }>;
  common: CommonInputProps;
  appId: string;
  table: Table | undefined;
  value: string;
  onChange: (value: FieldInputValue) => void;
}) {
  const tableId = field.reference_table;
  const columns = referencePopupColumns(table, field);
  const searchFieldIds = referenceSearchFields(table, field)
    .map((searchField) => searchField.id)
    .join(",");
  const searchable = searchFieldIds !== "";

  const [open, setOpen] = useState(false);
  /** 打っている途中の語。**画面の一時状態であり、どこにも保存しない。** */
  const [term, setTerm] = useState("");
  const query = useDebouncedTerm(term);
  /** 何件目から出しているか。**一時状態であり、どこにも保存しない**(`K-G16`)。 */
  const [offset, setOffset] = useState(0);

  // **語が変わったら1ページ目へ戻す** —— 戻さないと、絞り込んだ結果より後ろのページを
  // 指したままになり、**1件も出ないページが黙って出る。**
  // **描画の途中で直す形を採る**(効果でやると、古いページ位置と新しい語の組で
  // **1回ぶん余計な読取が飛ぶ**。実測で見つけた)。
  const [pagedQuery, setPagedQuery] = useState(query);
  if (pagedQuery !== query) {
    setPagedQuery(query);
    setOffset(0);
  }

  // **器を差す先を、自分の DOM 上の位置から引く**(`ViewHost` と同じ作法)。
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [scope, setScope] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setScope(anchorRef.current?.closest<HTMLElement>(".app-theme") ?? document.body);
  }, []);

  const state = useReferenceCandidatePage({
    appId,
    tableId,
    searchFieldIds,
    query,
    offset,
    enabled: open,
  });
  const selected = useSelectedReferenceChoice(appId, tableId, table, value);

  const rows = state.status === "ready" ? state.value.rows : [];
  const total = state.status === "ready" ? state.value.total : 0;
  const note =
    state.status === "ready"
      ? referenceCandidateNote({ total, count: rows.length, offset, searchable, paged: true })
      : undefined;

  /**
   * **閉じる。** **閉じるだけでは値を1バイトも変えない**(完了条件 (ii))——
   * **この関数は `onChange` を1度も呼ばない。**
   * **焦点は開いた元の口へ戻す**(`K-G20`)。
   */
  function close(): void {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return (
    <>
      {/* 自分の DOM 上の位置を知るための目印。**見た目を1ピクセルも持たない。** */}
      <div ref={anchorRef} hidden data-testid={`reference-popup-scope-${field.id}`} />
      <Button
        {...common}
        ref={triggerRef}
        variant="secondary"
        // **今の値を機械で読めるようにする** —— 選んでいなければ空文字である。
        data-value={value}
        onClick={() => setOpen(true)}
      >
        <span data-testid={`reference-value-${field.id}`}>
          {selected === undefined ? "(未選択)" : selected.label}
        </span>
        <span aria-hidden="true">|</span>
        <span>探す</span>
      </Button>
      {scope === null ? null : (
        <OverlayDialog
          title={`${field.name}を探す`}
          open={open}
          onOpenChange={(next) => {
            if (next) {
              setOpen(true);
              return;
            }
            close();
          }}
          container={scope}
        >
          {searchable ? (
            <Input
              type="search"
              data-testid={`reference-popup-search-${field.id}`}
              aria-label={`${field.name}を絞り込む`}
              value={term}
              onChange={(event) => setTerm(event.target.value)}
            />
          ) : (
            // **黙って全件に倒さない**(憲法6)。**打っても当たらないことを言う。**
            <span
              data-testid={`reference-popup-search-unavailable-${field.id}`}
              className="text-note text-muted-foreground"
            >
              {SEARCH_UNAVAILABLE_NOTE}
            </span>
          )}
          <TableFrame>
            <TableGrid>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column.id}>{column.name}</TableHead>
                  ))}
                  <TableHead>選ぶ</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const choice = toReferenceChoice(table, row);
                  return (
                    <TableRow key={choice.id}>
                      {columns.map((column) => (
                        <TableCell key={column.id}>{cellText(row[column.id])}</TableCell>
                      ))}
                      <TableCell>
                        <Button
                          size="sm"
                          data-testid={`reference-popup-choose-${choice.id}`}
                          aria-label={`${choice.label}を選ぶ`}
                          onClick={() => {
                            // **選ぶと値が入り、器が閉じる**(完了条件 (ii))。
                            onChange(choice.id);
                            close();
                          }}
                        >
                          選ぶ
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableGrid>
          </TableFrame>
          {note !== undefined && (
            <span
              data-testid={`reference-limit-${field.id}`}
              className="text-note text-muted-foreground"
            >
              {note}
            </span>
          )}
          <div className="flex items-center gap-s2">
            <Button
              size="sm"
              variant="secondary"
              data-testid={`reference-popup-prev-${field.id}`}
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - REFERENCE_CANDIDATE_LIMIT))}
            >
              前へ
            </Button>
            <Button
              size="sm"
              variant="secondary"
              data-testid={`reference-popup-next-${field.id}`}
              disabled={offset + rows.length >= total}
              onClick={() => setOffset(offset + REFERENCE_CANDIDATE_LIMIT)}
            >
              次へ
            </Button>
            {value !== "" && (
              // **選び直せるようにする** —— プルダウンの側には空の選択肢が在るので、
              // **この口が無いと、一度選んだ値を外す手段がこの形にだけ1つも無くなる。**
              <Button
                size="sm"
                variant="secondary"
                data-testid={`reference-popup-clear-${field.id}`}
                onClick={() => {
                  onChange(UNSELECTED);
                  close();
                }}
              >
                選択を外す
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              data-testid={`reference-popup-close-${field.id}`}
              onClick={close}
            >
              閉じる
            </Button>
          </div>
          {state.status === "error" && (
            <div data-testid={`reference-error-${field.id}`}>
              <ErrorList errors={state.errors} />
            </div>
          )}
        </OverlayDialog>
      )}
    </>
  );
}

/**
 * 器の中の一覧のセルに出す文字。
 *
 * **値そのままの文字である** —— **単位・強調・空欄の隠しなど、一覧が持つ見せ方の宣言を
 * 1つも当てていない**(当てると、この器に画面の宣言が効くかのような形になる)。
 * **並ぶのは `text` / `long_text` の項目だけである**(`ADR-0290` 限定の値域)。
 */
function cellText(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function asText(value: FieldInputValue): string {
  return typeof value === "string" ? value : String(value);
}
