/**
 * detail_view の汎用コンポーネント(V0-P3-T06)。
 *
 * マニフェストの `detail_view` 定義を**解釈して** 1レコードを表示する。アプリごとに
 * 詳細画面を生成するのではなく、このコンポーネント1つに任意のマニフェストを流し込む
 * (handover 3.7 / 憲法3)。したがってこのファイルにアプリ固有の名前は現れない。
 *
 * ## 何を表示するかの根拠
 *
 * **`fields` を書けば、書いた項目だけを書いた順に出す。書かなければ対象テーブルの
 * 全フィールドをテーブル定義の順に出す**(V1-M0-T09 / v0 所見 F-3)。
 *
 * v0 では `detail_view` の `fields` はスキーマで `false`(禁止)にされており、選ぶ
 * 語彙が存在しなかったので必ず全項目を出していた。V1-M0-T09 がこの `false` だけを
 * 解除した(ADR-0007 の Δ6 = 既存キーの値域変更。**新しいキーは1つも増えていない**)。
 * `columns` ではなく `fields` を再利用しているのは、`columns` が「表の列」を、
 * `fields` が「1レコードの項目」を指す既存の使い分けに合うためである(判断の根拠は
 * `docs/plan/v1/records/v1-m0-t09.md`)。
 *
 * V1-M0-T09 の追補で `src/kernel/types.ts` の `DetailView` に `fields?` が入り、
 * 不在フィールドIDは `referential-integrity.ts` が **`apply_diff` の時点で**弾くように
 * なった(list_view.columns / form.fields と同じ扱い)。ここでの照合はそれでも残す ——
 * 表示層が「与えられたマニフェストを信じて黙って落とす」ことをしないためである。
 * **ここで独自に「主要なフィールドだけ」等を選ぶことは引き続きしない** ——
 * マニフェストに書かれていない表示上の判断を実装が持つことになる(handover 3.10)。
 *
 * 表示形式は7型ぶんすべて `../fields/display.tsx` にある。一覧と同じ実装を使うので、
 * 同じレコードが一覧と詳細で違う顔を持つことはない(憲法6)。
 *
 * ## 対象レコード
 *
 * どのレコードかは URL(`route.ts` の `Route.recordId`)から props で降ってくる。
 * コンポーネントの内部状態にしないので、リロードでも同じレコードに戻る。
 *
 * ## 削除以外の破壊的操作は持たない
 *
 * ここに置くのはレコード1件の削除だけである。スキーマ変更(フィールドを消す等)は
 * v0 の差分 op が additive 4種しか持たない以上、そもそも表現できない。
 *
 * ## 画面ごとの見せ方(ADR-0050)
 *
 * `view` に書かれた有限 enum を `data-preset-*` 属性として出す(経路B。限定5)。
 * **値を CSS 文字列として組み立てない。** 当てる規則は `web/src/styles.css` の1箇所にあり、
 * セレクタにアプリID・画面ID・フィールドIDは1つも現れない(限定11)。**未指定の画面では
 * 属性が1つも出ないので DOM は今日と1バイトも変わらない**(ADR-0051 限定4)。
 *
 * **どの器に出すかが `related` への当たり方を決める**(ADR-0050 §4):
 *
 * - **軸4(項目名と値の向き)/ 軸5(項目の段組数)は `<dl class="detail-fields">` に出す。**
 *   `related` の子一覧はこの `<dl>` の**外**にあるので、`.detail-fields` を経由する規則は
 *   子一覧に届かない(= 当たらない)。
 * - **軸6(image の表示サイズ)は `<section class="detail-view">` に出す。** 子一覧は
 *   この器の**中**にあるので、1本の規則で自レコードの画像と子一覧の画像の両方に当たる
 *   (同じ画面の中で画像の大きさが割れないため)。**「詳細の項目はサムネイル、子一覧は
 *   中サイズ」の使い分けはできない**(ADR-0050 §3a 6 の門)。
 * - **軸7(`long_text` の切り詰め長)だけは属性ではなく表示関数の引数で当てる**
 *   (V3-M2-T04。ADR-0050 限定10 が許した唯一の例外)—— 切り詰め後の文字列しか DOM に
 *   出ないので CSS では実装できない。**当たり方は軸6 と同じ**で、自レコードの項目にも
 *   `related` の子一覧にも同じ値が渡る(器ではなく `FieldValue` / `FieldCell` へ渡す)。
 *   **`ViewRendererProps` には props を1つも足していない**(値は `view` の中に入っている)。
 */
import { useEffect, useMemo, useState } from "react";
import type { DetailView, Field, Manifest, ResourceId, Table } from "../../../src/kernel/types.ts";
import {
  deleteRecord,
  fetchRecord,
  fetchRecords,
  isApplyInProgress,
  isForbidden,
  isWriteConflict,
  type RecordRow,
  // **【`V5-M25-T08` / `L-G8`】手動起動の入口を叩く1本**(`ADR-0176` 限定1)。
  runViewAction,
  updateRecord,
  type ValidationError,
} from "../api.ts";
import { type AsyncState, toValidationErrors } from "../async.ts";
import {
  canUseAction,
  canUseView,
  canWriteRole,
  canWriteRowScope,
  isWriteAudienceRole,
  useActorId,
  useCanWrite,
  useRole,
  viewIdForRecordRequest,
} from "../auth/authz.tsx";
import { ErrorList } from "../ErrorList.tsx";
import {
  FieldCell,
  FieldValue,
  RELATED_CELL_CLASS,
  referenceLinkTarget,
} from "../fields/display.tsx";
import {
  buildReferenceLabelIndex,
  type ReferenceLabelIndex,
  representativeField,
} from "../fields/reference-label.ts";
// **`DetailTargetNote` の import は `V10-M18-T02`(`FU-G2`)で落とした** ——
// **呼び出し3件を撤去したので、残すと `biome` の `noUnusedImports` が error になる。**
// **`resolveDetailViewTarget` は残っている**(子行の遷移先を決めるのは今日も同じ1本である)。
import { navigate, ReferenceLinkScope, resolveDetailViewTarget } from "../navigation.tsx";
import { isSystemTableId, resolveViewTable, viewTargetIds } from "../table-resolution.ts";
import { Button } from "../ui/button.tsx";
import { Card, Separator, Skeleton } from "../ui/surfaces.tsx";
// **`Table` は別名で受ける** —— カーネルの型 `Table`(上の `types.ts`)と名前が衝突する。
// **別名を付けたのは部品の側**であり、カーネルの型名は1バイトも動かしていない。
import {
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
  Table as UiTable,
} from "../ui/table.tsx";
import { cn } from "../ui/utils.ts";
import { flowNextRoute } from "./flow.ts";
import type { DetailViewRendererProps } from "./types.ts";
import { visibleWhenMatches } from "./visible-when.ts";
import { ApplyInProgress, WriteConflict } from "./WriteConflict.tsx";
import { WriteForbidden } from "./WriteForbidden.tsx";

/**
 * ビューが指定した表示項目を読む(V1-M0-T09 / F-3)。
 *
 * `DetailView.fields` は任意である。未指定は `undefined` = 全項目表示。
 * 空配列はスキーマ(`field_id_list` の `minItems: 1`)が弾くので、
 * ここに来る配列は必ず1件以上ある。
 *
 * V1-M0-T09 の本体ではカーネルの `DetailView` がこのキーを持たず、ここで型を
 * キャストして読んでいた。追補で `src/kernel/types.ts` に `fields?` を足したので
 * キャストは不要になった(併せて不在フィールドIDが `apply_diff` 時に弾かれる)。
 */
function detailViewFields(view: DetailView): ResourceId[] | undefined {
  return view.fields;
}

/** 詳細の描画に必要な、取得済みのデータ一式。 */
type DetailData = {
  record: RecordRow;
  referenceLabels: ReferenceLabelIndex;
};

export function DetailViewRenderer({ appId, manifest, view, recordId }: DetailViewRendererProps) {
  // 対象テーブルの解決はシステムテーブルも見る(ADR-0006 §7 の #10)。
  const table = resolveViewTable(manifest, view.table);
  /** 対象が読み取り専用のシステムテーブルか。書き込みの導線を出すかどうかに効く(L4)。 */
  const readOnly = isSystemTableId(view.table);

  /** ビューが指定した表示項目(未指定なら `undefined` = 全項目)。 */
  const selectedFieldIds = detailViewFields(view);

  /**
   * 表示するフィールド。
   *
   * - `fields` 指定あり … 指定されたIDの順に並べる(テーブル定義の順ではない。
   *   「この順で読ませたい」がマニフェストに書かれている以上、それに従う)
   * - `fields` 指定なし … 対象テーブルの全フィールドをテーブル定義の順に出す(従来どおり)
   *
   * 実在しないIDはここでは落とさず、下の `manifestErrors` がエラーとして表に出す。
   * 参照の解決(下の `referencedTables`)が依存するので、参照の同一性を保つ。
   */
  const fields = useMemo<Field[]>(() => {
    const all = table?.fields ?? [];
    if (selectedFieldIds === undefined) {
      return all;
    }
    return selectedFieldIds
      .map((id) => all.find((field) => field.id === id))
      .filter((field): field is Field => field !== undefined);
  }, [table, selectedFieldIds]);

  /**
   * マニフェスト自体の不整合。黙って隠さず、実在する候補を出す。
   *
   * 2種類ある:
   * 1. 対象テーブルが無い
   * 2. `fields` が対象テーブルに無いフィールドIDを指している(V1-M0-T09)
   *
   * 2 で「実在するぶんだけ描く」ことはしない —— 指定した項目が黙って消えるのは
   * **できたふり**であり、憲法6 に反する。カーネルも `apply_diff` の時点で同じ照合を
   * 行う(V1-M0-T09 追補)ので、ここに来るのは手で壊した manifest.json のような
   * 経路だけだが、**「到達しないはず」に安全性を預けない**(ADR-0006 §7 #11)。
   */
  const manifestErrors: ValidationError[] = useMemo(() => {
    if (table === undefined) {
      return [
        {
          path: "",
          message: `ビュー "${view.id}" の対象テーブル "${view.table}" がありません。`,
          allowed_values: viewTargetIds(manifest),
        },
      ];
    }
    const known = table.fields.map((field) => field.id);
    return (selectedFieldIds ?? [])
      .filter((id) => !known.includes(id))
      .map((id) => ({
        path: "",
        message: `ビュー "${view.id}" の表示項目(fields)に指定されたフィールド "${id}" はテーブル "${table.id}" にありません。`,
        allowed_values: known,
        hint: `テーブル "${table.id}" に実在するフィールドIDを指定するか、fields を省略して全項目を表示してください。`,
      }));
  }, [manifest, table, view, selectedFieldIds]);

  /**
   * 表示するフィールドに出てくる reference の参照先テーブル(重複なし)。
   * 代表値を引くために、参照先テーブルのレコードもまとめて取得する(一覧と同じ作法)。
   */
  const referencedTables = useMemo(() => {
    const ids = new Set<ResourceId>();
    for (const field of fields) {
      if (field.type === "reference") {
        ids.add(field.reference_table);
      }
    }
    return [...ids]
      .map((id) => resolveViewTable(manifest, id))
      .filter((candidate): candidate is Table => candidate !== undefined);
  }, [manifest, fields]);

  const [state, setState] = useState<AsyncState<DetailData>>({ status: "loading" });
  /** 削除の確認中かどうか。誤操作で1レコードが消えないための一段。 */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteErrors, setDeleteErrors] = useState<ValidationError[]>([]);
  /** 削除が 403(権限不足)で拒否されたか。401(失効)とは別に「閲覧のみ」を出す。 */
  const [writeForbidden, setWriteForbidden] = useState(false);
  /** 削除が 409(版不一致)。別のユーザ/セッションが先に変更した(M9-T02)。 */
  const [writeConflict, setWriteConflict] = useState(false);
  /** 削除が 409(適用中)。いま差分適用中なので少し待って再試行する(M9-T02)。 */
  const [applyInProgress, setApplyInProgress] = useState(false);
  /**
   * viewer は書込できない。編集/削除の導線を先回りで閉じる(最終防衛線はサーバの 403)。
   *
   * **対象テーブルを渡す**(V3-M3-T04 / D-G12b)—— customer だけはテーブル単位で可否が
   * 分かれ、公開テーブル(`st_public`)や運営テーブルへの書込は 403 になる。判定は
   * `canWriteRole` → `nonAdminTableAccess` の1本にあり、ここには規約を置かない。
   */
  const canWrite = useCanWrite(table);
  /**
   * 現在ユーザのロール。**操作起点(`actions`)だけは遷移先のテーブルで判定する**ので、
   * `canWrite`(= `view.table` 基準)とは別に生のロールが要る(B-G3。下の `writableActions`)。
   */
  const role = useRole();
  /**
   * 現在ユーザの id(`E-G53` / V4-M6)。**`st_owner`(誰の行か)の判定にはロールではなく
   * id が要る。** 渡されていなければ `null` で、そのときは判定を据え置く。
   */
  const actorId = useActorId();

  /**
   * **描いてよい操作起点**(`B-G3` / `V4-M1`)。
   *
   * ## 判定先を `view.table` から遷移先 form のテーブルへ変える
   *
   * 操作起点のボタンを押して実際に書き込む先は、**遷移先 form のテーブル**であって
   * いま見ているビューのテーブルではない。`V3-M3-T04`(`822140f`)が `useCanWrite()` を
   * `useCanWrite(table)` に変えたとき、**`actions` のガードも一緒に `view.table` 基準に
   * なり**、公開テーブル(`st_public`)の詳細から自分のテーブル(`st_owner`)の form へ
   * 遷移する導線が customer から消えた —— EC のカタログから「カートに入れる」が
   * 押せない、という退行である(`V3-M3` の審査記録・実装記録に `actions` を検討した
   * 形跡は無い。意図された制限ではない)。
   *
   * ## 編集/削除の判定先は動かさない(切り方 (ii))
   *
   * 下の編集/削除と「閲覧のみ」注記は**今までどおり `canWrite`(= `view.table` 基準)**
   * である。編集/削除が書き換えるのは開いているレコード自身であり、判定先はそちらで
   * 正しい。**2つのガードは別々の書込を守っているので、変数を1つに束ねない。**
   * その結果 customer は「閲覧のみ」注記を見ながら操作起点を押せる見た目になる ——
   * **この不整合は `B-G3` では解消していない**(`web/test/detail-view.test.tsx` が固定)。
   *
   * ## 規約は再実装しない
   *
   * 可否は `canWriteRole` → `nonAdminTableAccess` の1本のままである(`web/src/auth/authz.tsx`
   * のヘッダが禁じた「同じ判定が2箇所」を作らない)。**遷移先 form が実在しない / 対象
   * テーブルを解決できないときは `table` が `undefined` になり、customer は fail-closed で
   * 不可**(`canWriteRole` のヘッダの決定そのまま)。**API も props も1つも足していない**
   * (`ADR-0053` 限定3 を破らない)。
   *
   * ## **【V4-M19-T01】書かれた配列の位置を、絞り込みの前に持たせる**
   *
   * **主副の描き分け(下の `variant`)は `view.actions`(マニフェストに書かれた配列)の
   * 位置で決まり、この絞り込みの後の位置では決まらない。** そのため `filter` の前に
   * `declaredIndex` を持たせる。**判定そのものは1バイトも変えていない**(残る要素も順序も
   * 着手前と同じである)。
   */
  const writableActions = useMemo(
    () =>
      (view.actions ?? [])
        .map((action, declaredIndex) => ({ action, declaredIndex }))
        .filter(({ action }) => {
          /*
           * **【`V5-M23-T02` / `L-G14` / `ADR-0177` 限定5】宣言による2段目。**
           * **判定は AND 1つである**: **この宣言が真** かつ **下の自動判定が真**。
           * **「どちらが勝つか」の規則を1つも作っていない。**
           * **【`V8-M20` / `J-G29`。旧文を1バイトも消していない】** 旧文は 「**判定は `isActionAudienceAllowed` 1本**であり、**一覧と同じ実装を見る**」だった。 **その再実装(`web/src/views/action-audience.ts`)は撤去された。** **今日の判定は `canUseAction` 1本であり、サーバと**同じ** `judgeRoleAccess` を呼ぶ。**
           * **3形すべて(遷移 / 値の書換 / 行き先の宣言)に同じ1本が当たる。**
           * **【禁止】「宣言すれば押せなくなる」と書かない**(`ADR-0177` 限定6)。
           */
          if (!canUseAction(manifest, view.id, action, role)) {
            return false;
          }
          /*
           * **【V4-M20-T01 / ADR-0100 限定4・限定6】形 (ii)(値の書換)の書込先は
           * 「今開いているレコード」そのもの**であり、遷移先 form のテーブルではない。
           * したがって判定先は `view.table`(= `table`)である —— **編集/削除と同じ
           * 判定先**になる。**新しい述語を1本も作っていない**(`canWriteRole` 1本)。
           *
           * **ボタンを隠すことは書込を止めることではない**(`ADR-0101` 限定6 と同じ線)
           * —— これは先回りガードであり、最終防衛線はサーバの 403 である。
           */
          /*
           * **【`V5-M25-T08` / `L-G8` / `ADR-0174`】4形目(自動処理の起動)。**
           *
           * **判定は2つの AND である**(新しい述語を1本も作っていない):
           *  - **その自動処理が実在し、`manual` と宣言されているか**(fail-closed)。
           *  - **この人がこの画面のテーブルへ書ける相手か**(`canWriteRole` 1本)。
           *
           * **`canUseView` を当てる先が無い** —— **`set` 形と同じ限界である**
           * (`v5-m23.md` §4-1)。**最終防衛線は入口(`ADR-0176` 限定5)である。**
           */
          if ("run" in action) {
            const workflow = (manifest.app.workflows ?? []).find(
              (candidate) => candidate.id === action.run,
            );
            if (workflow === undefined || workflow.trigger.type !== "manual") {
              return false;
            }
            return canWriteRole(role, table);
          }
          if ("set" in action) {
            /*
             * **【`V5-M23-T01` / `L-G13`】`set` 形には `canUseView` を当てる先が無い。**
             * **書込先は「今開いているレコード」であって、別の画面ではない** ——
             * **行き先の画面が存在しないので、「その画面を使えるか」を問えない。**
             * **当てるなら「今開いている画面」になるが、それは既に開けている画面である**
             * (開けなければここまで描かれていない)。**したがって1バイトも足していない。**
             * **これは限界であり、`docs/plan/v5/records/v5-m23.md` §4-1 に書いた。**
             */
            return canWriteRole(role, table);
          }
          const form = manifest.app.views.find(
            (candidate) => candidate.type === "form" && candidate.id === action.form,
          );
          /*
           * **【`V5-M23-T01` / `L-G13`(門 = 外)で足した1点】遷移先 form を使えるか。**
           *
           * **着手前は `canWriteRole`(遷移先 form のテーブル基準)1本だけだった** ——
           * **`audience` を宣言した form へ向かう操作起点は、書ける相手には出続けていた。**
           * **【`V8-M20` / `J-G29`】その `audience` は撤去された。今日は面のボタンの規則である。**
           * **押すとサーバが 403 を返す**(`src/server/app.ts:1457` の
           * `isViewAudienceAllowed`)ので、**「押しても必ず失敗する導線」だった。**
           *
           * **判定は `canUseView` 1本**(`web/src/auth/authz.tsx`。着手前から在る関数)——
           * **新しい述語も規約も1つも作っていない。** **一覧側
           * (`ListViewRenderer.tsx` の `writableActions`)と1バイトも同じ形である。**
           *
           * **【禁止】これを「押せなくなった」と書かない** —— **出さないだけである。**
           */
          return (
            canWriteRole(
              role,
              form === undefined ? undefined : resolveViewTable(manifest, form.table),
            ) &&
            form !== undefined &&
            canUseView(role, manifest, form)
          );
        }),
    [view.id, manifest, view.actions, role, table],
  );

  /**
   * **形 (ii) の書込が進行中かどうか**(`V4-M20-T01`)。**押している間だけボタンを止める。**
   *
   * **これは冪等性の担保ではない**(`ADR-0100` §限界1)—— 書込が終われば同じボタンを
   * また押せる。**押した回数だけ書込が起き、`on_update` もそのたびに発火する。**
   */
  const [settingAction, setSettingAction] = useState<number | null>(null);
  /**
   * **起動中の自動処理のID**(`V5-M25-T08`)。**押している間だけボタンを止める。**
   *
   * **これは冪等性の担保ではない**(`ADR-0175` §限界2)—— **規則を持つのは入口である。**
   * **【禁止】「二重押しが防げる」と読まない。**
   */
  const [runningWorkflow, setRunningWorkflow] = useState<string | null>(null);
  /** **起動が断られた / アクションが失敗した理由**(黙って捨てない = 憲法6)。 */
  const [runError, setRunError] = useState<string | null>(null);

  // **`audience` を書いた画面だけサーバに名乗る**(V4-M3-T04 / ADR-0070 限定3・限定4)。
  // **【`V8-M20` / `J-G27`】旧文の `audience` は撤去された。今日名乗る条件は「面の規則がその画面を名指ししているか」である。**
  // **effect の外で解決する** —— effect の依存は `view.id` / `view.table` の粒度のままにする。
  const namedViewId = viewIdForRecordRequest(manifest, view);

  useEffect(() => {
    if (manifestErrors.length > 0) {
      setState({ status: "error", errors: manifestErrors });
      return;
    }
    if (recordId === undefined) {
      // どのレコードを出すのか URL が言っていない。適当な1件を選んで誤魔化さない(憲法6)。
      setState({
        status: "error",
        errors: [
          {
            path: "",
            message: `ビュー "${view.id}" は1件のレコードを表示する画面ですが、URL に対象のレコードが指定されていません。`,
            hint: "一覧から行を選ぶと、そのレコードの詳細が開きます。",
          },
        ],
      });
      return;
    }

    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([
      // **どの画面から読んでいるかをサーバに渡す**(V4-M3-T03 / `B-G1` / ADR-0070 限定3)。
      // **渡すのは `audience` を書いた画面だけである**(限定4)。
      // **【`V8-M20` / `J-G27`】旧文の `audience` は撤去された。今日名乗る条件は「面の規則がその画面を名指ししているか」である。**
      fetchRecord(appId, view.table, recordId, namedViewId),
      Promise.all(
        referencedTables.map(async (target) => ({
          table: target,
          records: await fetchRecords(appId, target.id),
        })),
      ),
    ]).then(
      ([record, referenceSources]) => {
        if (!cancelled) {
          setState({
            status: "ready",
            value: { record, referenceLabels: buildReferenceLabelIndex(referenceSources) },
          });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          // レコード不在(404)もここに来る。カーネルの文面をそのまま出す。
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, view.id, view.table, namedViewId, recordId, referencedTables, manifestErrors]);

  /**
   * 編集の行き先: 同じテーブルの form。無ければ導線を出さない(壊れない)。
   *
   * システムテーブルに form は作れない(カーネルの L2、`referential-integrity.ts` が
   * マニフェストごと拒否する)ので、`readOnly` なら本来この検索は必ず空になる。
   * それでも条件を書いているのは、**「到達しないはず」に安全性を預けない**という
   * ADR-0006 §7(#11 / #12)の方針をそのまま適用しているためである。L2 が将来
   * ほどけたとき、フロントが静かに書き込み導線を出すことがない。
   */
  const formView = readOnly
    ? undefined
    : manifest.app.views.find(
        (candidate) => candidate.type === "form" && candidate.table === view.table,
      );

  const handleDelete = async (): Promise<void> => {
    if (recordId === undefined) {
      return;
    }
    // 楽観ロック(M9-T02)の `If-Match` に載せる版は、読み込んだレコードの `_updated_at`。
    // 読み込めていない状態では削除ボタン自体が出ないので、通常ここは満たされる。
    const version = state.status === "ready" ? state.value.record._updated_at : undefined;
    if (version === undefined) {
      return;
    }
    setDeleting(true);
    setDeleteErrors([]);
    setWriteForbidden(false);
    setWriteConflict(false);
    setApplyInProgress(false);
    try {
      await deleteRecord(appId, view.table, recordId, version);
      navigate(afterDeleteRoute(appId, manifest, view.table, view.after_delete));
    } catch (reason: unknown) {
      // 消えていないのに画面だけ進めない。理由を出してその場に留まる。403(権限)・
      // 409(適用中)・409(版不一致)は専用表示、それ以外は統一形式のエラー(M9-T02)。
      if (isForbidden(reason)) {
        setWriteForbidden(true);
      } else if (isApplyInProgress(reason)) {
        setApplyInProgress(true);
      } else if (isWriteConflict(reason)) {
        setWriteConflict(true);
      } else {
        setDeleteErrors(toValidationErrors(reason));
      }
      setConfirmingDelete(false);
    } finally {
      setDeleting(false);
    }
  };

  /**
   * **形 (ii)(値の書換)の押下**(`V4-M20-T01` / `ADR-0100` 限定6)。
   *
   * **既存のレコード更新経路をそのまま通る** —— `updateRecord`(= `PATCH` +
   * `If-Match`)であり、削除・編集フォームからの保存と**同じ関数**である。
   * **新しい書込の口を1本も開いていない。** したがって `writable_by`(`ADR-0076`)・
   * ロール判定・`If-Match` の CAS(`ADR-0017`)は今日と同じ経路で効く。
   *
   * **送るのは宣言された1フィールド1値だけである**(限定2 / 限定3)—— 画面が
   * 他の値を混ぜない。**`$record.` の解決も演算も1つも行わない**(値はリテラルのまま)。
   *
   * **冪等ではない**(`ADR-0100` §限界1)—— 押した回数だけ書込が起き、
   * `on_update` のワークフローもそのたびに発火する。**確認の段を1つも作っていない**
   * (削除と違い、書換は元の値へ戻す手段がアプリ側にある)。
   */
  const handleSetAction = async (
    declaredIndex: number,
    set: { field: ResourceId; value: string | number | boolean },
  ): Promise<void> => {
    if (recordId === undefined || state.status !== "ready") {
      return;
    }
    const version = state.value.record._updated_at;
    setSettingAction(declaredIndex);
    setDeleteErrors([]);
    setWriteForbidden(false);
    setWriteConflict(false);
    setApplyInProgress(false);
    try {
      const updated = await updateRecord(
        appId,
        view.table,
        recordId,
        { [set.field]: set.value },
        version,
      );
      // 書けたら画面の値を更新後のものに差し替える。**再取得はしない**(新しい読取経路を
      // 1本も開かない)—— サーバが返した行をそのまま使う(編集フォームと同じ作法)。
      setState((previous) =>
        previous.status === "ready"
          ? { status: "ready", value: { ...previous.value, record: updated } }
          : previous,
      );
      /*
       * **【`V10-M1-T01` / `NV-G3a` / `ADR-0358` 限定1・限定2・限定5・限定7】
       * 書換が成立したあとの行き先。**
       *
       * **ここに来るのは `updateRecord` が成功したときだけである** —— **失敗は下の
       * `catch` に落ちるので、画面は1バイトも動かない**(「成立したときだけ」の全実装が
       * この位置である)。
       * **`handleRunAction`(自動処理の起動)には1バイトも足していない**(限定2)——
       * **あちらは 200 でも `result.failures` を出す形なので、「成功したら次へ」を
       * 付けると失敗しても次へ行く。**
       *
       * **宣言が無ければ今日と1文字も変わらない** —— **`navigate` を1度も呼ばない**
       * (既定の行き先という概念を1つも作っていない。**`form` の3段の既定は
       * `FormRenderer.tsx` の側に在り、1バイトも触っていない**)。
       * **宣言した画面がこのマニフェストに無ければ、その場に留まる**(壊れない)——
       * **実在しないIDは `referential-integrity.ts` が apply 時に倒しているので、
       * ここに来るのは「役割の規則でこの人には配られなかった画面」だけである。**
       * **エラーは出さない** —— **書換は成立しており、行き先が無いことは書換の失敗ではない。**
       *
       * **画面に1本である**(限定5)—— **押したボタンがどれであっても行き先は同じで、
       * ボタンごとの行き先を読む場所が1つも無い。**
       * **`recordId` を宣言した行き先へ渡さない** —— **「書き換えた行の詳細へ」を
       * 宣言で選ぶ形は1つも作っていない。**
       * **【`V10-M2-T01` / `NV-G1` / `ADR-0357`。挙動は1バイトも変えていない。コメントだけを
       * 引き直した】** **着手前この行の末尾には逐語「(`ADR-0102` が `form` で採ったのと
       * 同じ線)」が付いていた。** **今日は偽である** —— **`form` の側は、宣言した行き先が
       * 同じテーブルの `detail_view` のときだけ保存した行を運ぶようになった**
       * (`FormRenderer.tsx` の `afterSubmitRoute`)。**詳細画面の側は今日も運ばない**
       * ——**`ADR-0358` の領分であり、本タスクは1バイトも足していない。**
       */
      /*
       * **【`V10-M4-T03` / `NV-G11` / `ADR-0360` 限定3・限定4 / `ADR-0359` §4b 限定5】
       * 一続きの流れの段。**
       *
       * **規則は1本だけである**(`ADR-0359` §4b 限定5 の逐語):「**段の宣言がある画面では
       * 段の並びが効き、無ければ今日どおりの規約に倒れる**」。**したがって分岐は
       * `after_save` より**前**に立つ** —— **`after_save` と `flow` の両方を書いた画面では
       * 段が勝つ**(`V10-M4` の決4)。**`FormRenderer.tsx` の `afterSubmitRoute` が
       * 保存の後に採っているのと**同じ形・同じ導出関数**である**(`./flow.ts` の
       * `flowNextRoute` 1本)—— **同じ規則を2箇所に書いていない。**
       *
       * **ここに来るのは `updateRecord` が成功したときだけである**(上と同じ位置)——
       * **失敗は下の `catch` に落ちるので、画面は1バイトも動かない。**
       *
       * **`kind` で分岐していない** —— **確認の段(`kind: "confirm"`)でも入力の段でも、
       * 段を宣言した詳細画面の `set` 形は同じ1本の規則を通る。** **`ADR-0360` が通したのは
       * 「確認の段の確定が次へ進むこと」だが、`kind` を見る2本目の規則を作ると
       * `ADR-0359` §4b 限定5 の1本に反するので作っていない**(実測は
       * `web/test/flow-confirm-step.test.tsx` の (a-6))。
       *
       * **段が解けなければ今日どおりに倒れる**(`undefined` が返る場合 = 段を書いて
       * いない / 最後の段 / 次の位置の画面がこのマニフェストに居ない)—— **その場合は
       * 下の `after_save` の分岐がそのまま効き、`after_save` も無ければその場に留まる。**
       * **既定の行き先を1つも作っていない。**
       *
       * **次の段が同じ表の `detail_view` のときだけ、今開いている行の `_id` を運ぶ**
       * (`ADR-0357` 限定1・限定2 と同じ線。判定は `flowNextRoute` の中の1箇所)。
       * **【非対称を隠さない】同じ画面の `after_save` は今日も行を1バイトも運ばない**
       * (すぐ下の分岐は `recordId` を渡していない)。
       */
      const flowRoute = flowNextRoute(appId, manifest, view, recordId);
      if (flowRoute !== undefined) {
        navigate(flowRoute);
      } else if (view.after_save !== undefined) {
        const declared = manifest.app.views.find((candidate) => candidate.id === view.after_save);
        if (declared !== undefined) {
          navigate({ kind: "view", appId, viewId: declared.id });
        }
      }
    } catch (reason: unknown) {
      // 書けていないのに画面だけ変えない。理由を出してその場に留まる(削除と同型)。
      if (isForbidden(reason)) {
        setWriteForbidden(true);
      } else if (isApplyInProgress(reason)) {
        setApplyInProgress(true);
      } else if (isWriteConflict(reason)) {
        setWriteConflict(true);
      } else {
        setDeleteErrors(toValidationErrors(reason));
      }
    } finally {
      setSettingAction(null);
    }
  };

  /**
   * **自動処理を名指しで起こす**(`V5-M25-T08` / `L-G8` / `ADR-0174`)。
   *
   * **入口は HTTP に1本だけである**(`ADR-0176` 限定1)。**引数を1つも渡さない**(限定4)。
   * **対象は今開いているレコード1行だけである**(限定3)。
   * **冪等ではない** —— **押した回数だけ走る。** **断られるのは処理が重なったときだけである。**
   *
   * ## **【`V10-M4-T03` / `NV-G11` / `ADR-0360` 限定3 / `ADR-0359` §4b 限定7】
   * 段が宣言されていても、`run` 形の確定では次の段へ進まない**
   *
   * **`ADR-0360` 限定3 は「確定の操作は (ii) `set` 形か (iv) `run` 形」と書いているが、
   * 次の段へ進むのは `set` 形だけである。** **この関数には `navigate` が1行も無く、
   * `V10-M4-T03` は1バイトも足していない**(`V10-M4` の決8)。
   *
   * **理由は成否が確定しないことである** —— **この経路は 200 でも `result.failures` を
   * 出す形なので、「成功したら次へ」を付けると失敗しても次へ行く**(`ADR-0358` 限定2 が
   * 同じ理由で `after_save` を閉じたのと同じである)。
   * **`ADR-0358` の「越えてはならない線」2 が、これを解くには改めて門A を通すことを
   * 明記しており、`V10-M4` は門A を1つも通していない。**
   *
   * **【黙って効かない状態にしない】** **`run` 形で確定を書いた確認の段は、押しても
   * 画面が1ミリも動かない。** **このことは AI 側の説明(`V10-M4-T04`)にも書く** ——
   * **「書けるが効かない」を作らないための始末である**(`ADR-0359` §4b 限定7)。
   */
  const handleRunAction = async (workflowId: string): Promise<void> => {
    if (recordId === undefined) {
      return;
    }
    setRunningWorkflow(workflowId);
    setRunError(null);
    try {
      const result = await runViewAction(appId, view.id, workflowId, recordId);
      if (result.failures.length > 0) {
        // **200 でも黙らない** —— 起動は受理されたがアクションが失敗した、を区別して出す。
        setRunError(result.failures.join(" / "));
      }
    } catch (reason: unknown) {
      const errors = toValidationErrors(reason);
      setRunError(
        errors.length > 0
          ? errors.map((error) => error.message).join(" / ")
          : "自動処理を起こせませんでした。",
      );
    } finally {
      setRunningWorkflow(null);
    }
  };

  // どの状態でも `data-testid` は同じ。ディスパッチ層がこのビューを選んだことは
  // 取得の成否とは無関係だからである(一覧と同じ作法)。
  //
  // **【V4-M15-T05 / T06(`V4-M15-T14` の一部)】読み込み中は骨組み(`Skeleton`)を出す。**
  // **文言(`読み込み中…`)は1文字も変えていない** —— 骨組みは `aria-hidden` なので、
  // 支援技術には今日と同じ1文だけが届く。**`data-testid` も変えていない。**
  // **プリセット属性はここでも出さない**(当たり先の画像も項目も1つも無い。ADR-0050 限定1)。
  if (state.status === "loading") {
    return (
      <section
        className={cn("detail-view", "flex flex-col gap-s3")}
        data-testid="view-renderer-detail_view"
      >
        <p className={cn("m-0", "text-muted-foreground")}>読み込み中…</p>
        <Card>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </Card>
      </section>
    );
  }
  // エラーの器(`variant="destructive"` の `Alert`)は `ErrorList` の中にある ——
  // **同じ画面で二重に囲まない**ため、ここでは包み直さない。
  if (state.status === "error") {
    return (
      <section
        className={cn("detail-view", "flex flex-col gap-s3")}
        data-testid="view-renderer-detail_view"
      >
        <ErrorList errors={state.errors} />
      </section>
    );
  }

  const { record, referenceLabels } = state.value;

  /**
   * **描く操作起点**(`V4-M20-T02` / `ADR-0101`)—— ロールで残ったもののうち、
   * **表示条件(`visible_when`)が真であるものだけ**。
   *
   * **条件は今開いているレコードの値だけで決まる**ので、レコードが読めてからでないと
   * 評価できない(`writableActions` = ロール判定はレコードに依らないので上で済ませてある)。
   * **条件を書かなかった起点は今日どおり必ず残る**(既定を反転させていない)。
   *
   * **主副の位置(`declaredIndex`)は1バイトも動かさない** —— **条件で消えた起点があっても、
   * 残った起点の主副は「書かれた配列」の位置のまま**である(`V4-M19-T01` の規約)。
   * **したがって1番目が条件で消えた画面では、主のボタンが1つも出ない**(ロールで消えたとき
   * と同じ挙動。繰り上げない)。
   *
   * **ボタンを隠すことは書込を止めることではない**(限定6)—— 最終防衛線はサーバである。
   */
  const visibleActions = writableActions.filter(
    ({ action }) =>
      action.visible_when === undefined || visibleWhenMatches(action.visible_when, record),
  );

  /**
   * **この行を書き換えられるか**(`E-G53` / V4-M6)。**ロールの可否(`canWrite`)に、
   * 「誰の行か」(`st_owner`)を重ねる。**
   *
   * **着手前は `canWrite` だけを見ており、運営(owner)の注文詳細に「押すと必ず 404 になる
   * 削除ボタン」が出ていた**(02 §5-9 `E-G53`。実測)。**サーバは `ADR-0061` により読取2経路
   * しか開いておらず、他人の個人行への書込は今日も 404 である。**
   *
   * **UI を閉じただけであって、サーバの書込を1バイトも開けていない。** **運営が「届けるのに
   * 必要な項目だけ直せる」ようにする側(`D-V4-19` / `D-V4-49`)は、`ADR-0061` §3a-2 が門A の
   * 新規審査を要求している** —— **`V4-M7` の判定を待つ。**
   */
  const canWriteRecord = canWrite && canWriteRowScope(table, record, actorId);

  /**
   * 参照先レコードへ実際にリンクになる項目と、その遷移先(V3-M3-T02)。
   *
   * **リンクになるかどうかの判定は `referenceLinkTarget`(`fields/display.tsx`)1本**であり、
   * ここには条件を書かない —— セルの側とここで判定が割れると、**リンクが無いのに注記だけが
   * 出る**(あるいはその逆)ことになる。**当たり先の無い注記を DOM に置かない**ため、
   * 「参照切れ」「未設定」「参照先に detail_view が無い」項目はここに現れない。
   *
   * **【`V10-M18-T02`(`FU-G2`)の追記。上の説明を1バイトも消していない】**
   * **この `linkedReferences` は撤去した。** **唯一の読み手が、下で消した「項目の参照の
   * 注記」だったからである**(残すと `biome` の `noUnusedVariables` が赤くなる)。
   * **`referenceLinkTarget` そのものは1バイトも触っていない** —— **項目の値をリンクに
   * するかどうかは今日も同じ1本の判定であり、この画面のリンクは着手前と同じである。**
   */

  /**
   * 画面の器に出すプリセット(軸6)。**読み込み中・エラー時の器には出さない** ——
   * その2状態には画像も項目も1つも無く、当たり先が存在しないためである
   * (「当たり先の無い属性を DOM に置かない」= ADR-0050 限定1 の精神)。
   */
  const imagePreset =
    view.preset_image_size !== undefined ? { "data-preset-image": view.preset_image_size } : {};
  /** 項目の器に出すプリセット(軸4 / 軸5)。**数値の段組数も属性値は文字列である。** */
  const fieldListPresets = {
    ...(view.preset_label_placement !== undefined
      ? { "data-preset-label": view.preset_label_placement }
      : {}),
    ...(view.preset_field_columns !== undefined
      ? { "data-preset-columns": String(view.preset_field_columns) }
      : {}),
  };

  /**
   * **画面幅への対応(`D-V4-44` / `V4-M15-T05`)を出してよいか。**
   *
   * **狭い画面では項目名と値を縦に積み、`sm`(40rem)以上では今までどおり横に並べる。**
   * ただし **`preset_label_placement` を書いた画面ではプリセットが勝つ** ——
   * **そのときはクラスを1つも出さない**(下の `if` ではなく値の有無で切る)。
   *
   * **CSS の詳細度で競わせるのではなく、出す / 出さないで切っている。** 理由は2つある:
   * (i) `web/src/styles.css` の `.detail-fields[data-preset-label="…"] .detail-field` と
   * `.detail-field dt` に**1バイトも触れない**ため(触ってよいファイルの外である)。
   * (ii) 詳細度で競わせると「プリセットを書いた画面の見え方」が幅によって変わりうる ——
   * **プリセットを書いた画面は、着手前と幅によらず1ピクセルも変わらない**方に倒した。
   *
   * `dt` の側の `basis` を上書きするのは、`.detail-field dt` の `flex: 0 0 var(--detail-label-width)`
   * が**縦積みでは幅ではなく高さとして解釈される**ためである(`ADR-0050` 限定8 が
   * `stacked` について書いているのと同じ事情)。`sm` 以上では元の値へ戻すので、
   * **40rem 以上での描画は着手前と1バイトも変わらない。**
   */
  const widthAdaptiveLabel = view.preset_label_placement === undefined;

  /**
   * **項目のまとまり**(`P-G17` の (C) 側。`V4-M16-T12` / `ADR-0092`)。
   *
   * ## 器は「見出し付きの区切り」である(限定6。**アプリは選べない**)
   *
   * **タブにしなかった** —— タブは支援技術の要件(役割属性・フォーカス管理・キーボード操作)を
   * 負うが、**この製品に支援技術の検査は0本である**(`ADR-0092` §Context 4 の 7)。
   * **`web/src/` に `role="tab"` は0件 / `tablist` も0件**(`V4-M16-T12` 着手時に数えた実数)
   * なので、タブを選ぶとこの差分で初めてその要件を負い、それを測る手段を1つも持たないまま
   * 出すことになる。**見出し付きの区切りには既存の先例がある** —— 下の `RelatedList` の
   * `h3.related-heading` + `Separator`。**まとまりの出し方をマニフェストに置いていない。**
   *
   * ## 描画の順序(**限定3 —— 並び順を指定するキーが無い**)
   *
   * **(1) どのまとまりにも属さない項目を、今日どおりの順序で先に並べる**(`fields` を書いた
   * 画面ならその順、書いていない画面ならテーブル定義順。**上の `fields` をそのまま使う**)。
   * **(2) そのあとに、まとまりを「マニフェストの記述順」で並べる** —— 順序を指定する語彙が
   * 無いので、`Object.entries`(= 書いた順)が唯一の順序である。
   *
   * ## 当たり方(`ADR-0050` §4 と同じ形の表は `web/test/detail-field-grouping.test.tsx`)
   *
   * **まとまりの中の項目も器は `<dl class="detail-fields">` のままである** —— したがって
   * **軸4(項目名と値の向き)と軸5(項目の段組数)は今日と同じ形で当たる。**
   * **`related` の子一覧はこの器の外にある**ので、今日どおり当たらない(限定8)。
   *
   * **実在しないID・重複は `apply_diff` の時点で弾かれている**(`referential-integrity.ts` の
   * 類型15)。それでも `find` の結果を絞るのは、**「到達しないはず」に安全性を預けない**
   * (`ADR-0006` §7 #11)ためである。
   */
  const groupedFieldIds = new Set(
    Object.values(view.field_groups ?? {}).flatMap((group) =>
      Array.isArray(group) ? group : group.fields,
    ),
  );
  const ungroupedFields = fields.filter((field) => !groupedFieldIds.has(field.id));
  const fieldGroups = Object.entries(view.field_groups ?? {}).map(([name, group]) => ({
    name,
    fields: (Array.isArray(group) ? group : group.fields)
      .map((id) => fields.find((field) => field.id === id))
      .filter((field): field is Field => field !== undefined),
  }));

  /**
   * **値が無いとき行ごと出さない項目を落とす**(`E-G17` / `D-V4-84` の一部。
   * `V4-M19-T08` / `ADR-0119` 限定3 / 限定4 / 限定5)。
   *
   * ## これは何で、何ではないか
   *
   * **`ADR-0086` 限定4(「書けるが効かない」を1つも作らない)の履行がここである** ——
   * **`V4-M19-T07` が通した宣言(`hide_when_empty`)の当たり先は、着手前 `web/src/` に
   * 0件だった。**
   *
   * - **宣言した項目についてだけ効く**(限定3)—— **書かなかった項目は今日どおり
   *   「未設定」と出る。****既定を反転させていない。**
   * - **未設定の判定を2箇所に住まわせない** —— **`web/src/fields/display.tsx` の
   *   `FieldValue` が使っているのと同じ判定(`null` / `undefined` だけが未設定)を
   *   ここでも使う。** **空文字 `""` は今日も「値がある」側であり、宣言しても行は残る**
   *   (限定3。`display.tsx` の逐語を1バイトも変えていない)。
   * - **消えるのは行ごとである**(限定5)—— **`dt`(項目名)も `dd`(値)も出ない。**
   *   **「ラベルだけ残して値を空欄にする」形を作っていない。**
   * - **効くのは詳細画面の項目の行だけである**(限定4)—— **`ListViewRenderer` を
   *   1バイトも触っていないので一覧の列には効かず、`FormRenderer` も無傷なので入力
   *   フォームにも効かず、`RelatedList` は自分の描画を持つので子一覧にも効かない。**
   *   **機械では止めていない** —— **止めるには型とプリセットの対応検査に当たる仕組みが
   *   要り、それは今日この製品に1つも無い。****黙って効かないままにしない**ことを
   *   `src/mcp/vocabulary.ts` が明記する。
   * - **表示関数の引数を1本も増やしていない**(限定9)—— **値は `field`(既にこの関数が
   *   持っている)の中に入って届く。** **`ViewRendererProps` にも props を1つも足していない。**
   *
   * ## この実装が判定しないこと(**隠さない**)
   *
   * **「その項目を本当に消してよいか」を1度も検証しない。** **アプリが「この項目は
   * 消してよい」と主張したら、そのまま消える**(`ADR-0047` 限定7 / `ADR-0090` と同型)。
   * **宣言した項目については、`display.tsx` が憲法6 を根拠に置いた区別(値が無いのか
   * 取得漏れなのか)が失われる。**
   */
  const visibleFields = (listFields: Field[]) =>
    listFields.filter((field) => {
      if (field.hide_when_empty !== true) {
        return true;
      }
      const value = record[field.id];
      return value !== null && value !== undefined;
    });

  /**
   * **重く描く項目**(`V4-M19-T02`。**画面の中で大事な情報が、文字の大きさや体裁で伝わる**)。
   * **門A の判定は「将来送り」であり、これはその送り先の履行である。`ADR` は無い(台帳1行)。**
   *
   * ## 材料は既にマニフェストにある宣言だけである(**足した語彙は0**)
   *
   * **そのテーブルが宣言した代表項目(`table.representative_field`。`ADR-0080`)1本だけを
   * 重く描く。** **`src/` にも `schemas/` にも1バイトも差分を出していない。**
   * **【禁止】「大事な情報を宣言できるようになった」と書かない** —— **語彙は増えていない。**
   *
   * ## 重みを3つに割らない(**この判断を先に書く**)
   *
   * **`field_groups` の見出しと「書いた順」は今日すでに描画に反映されており**(見出しは
   * `<h3>`、順序は並び順)、**そこに新しい重みを1バイトも足していない。** 足すと
   * 「何が大事か」の材料が3つに割れ、**同じ画面で互いに食い違う**(見出しの下にある
   * 目立たない項目と、順序が先の項目と、代表項目のどれが「大事」なのかが決まらない)。
   *
   * ## 宣言が無いテーブルでは何も起きない
   *
   * **`representativeField()`(`web/src/fields/reference-label.ts`)は宣言が無いとき
   * 「最初の `text` フィールド」へ倒れる**(`ADR-0080` 限定5 = 参照表示の既定を変えないため)。
   * **その 2 段目をここへ持ち込まない** —— 持ち込むと**宣言を1つも書いていない既存アプリの
   * 詳細画面が全部変わる。** そこで **「宣言が在り、かつ `representativeField()` の答えが
   * その宣言と一致する」ときだけ**重みを当てる。**代表項目の決め方を再実装しない**ため、
   * 判定は今日どおり `representativeField()` 1本を通す(`web/src/navigation.tsx:99` が
   * 名指しで禁じた「同じ判定が2箇所」を作らない)。**宣言が実在しない / `text` でないときは
   * 何も起きない**(黙って別の項目へ倒れない)。
   *
   * ## 当たり先(**`ADR-0090` の `emphasis` と衝突しない**)
   *
   * **重みが当たるのは `<dd>`(値の外側の器)の文字の太さと大きさだけである。**
   * **`ADR-0090` の `emphasis` は `<dd>` の中の `<span class="field-emphasis">` に色を当てる**
   * (`web/src/fields/display.tsx`)—— **器が違うので、同じ項目に両方が来ても互いを
   * 上書きしない。** **そもそも重ならない** —— 代表項目は `text` に限られ、`emphasis` は
   * `select` にしか書けない(実測は `web/test/information-weight.test.tsx` の (d))。
   * **色を1バイトも扱っていない。** **`web/src/styles.css` にも `web/src/tailwind.css` にも
   * 1バイトも書いていない**(使うのは既存のユーティリティだけである)。
   * **`ViewRendererProps` に props を1つも足していない**(`web/src/views/types.ts` は0行差分)。
   * **表示関数(`FieldValue` / `FieldCell`)の引数も1本も増やしていない。**
   *
   * ## **解けていないこと(先に書く)**
   *
   * - **代表項目は1テーブルに1本だけで、2本目を「大事」と言えない。**
   * - **代表項目は参照の表示ラベルと共用なので意味が二重になる** —— **重みのために
   *   代表項目を変えると、そのテーブルを参照しているリンクの見え方が全部変わる。**
   * - **画面ごとに変えられない**(宣言はテーブルに1つで、`detail_view` 側に置き場が無い)。
   * - **大きさか太さかをアプリが選べない** —— **表示層が1通りに決める。**
   * - **一覧(`ListViewRenderer`)には1バイトも当てていない** —— 同じ項目が一覧では
   *   今日どおりの重さで出る。**それが読みやすいかを1件も測っていない。**
   */
  const declaredRepresentative = (table as { representative_field?: unknown } | undefined)
    ?.representative_field;
  const weightedFieldId =
    typeof declaredRepresentative === "string" &&
    representativeField(table)?.id === declaredRepresentative
      ? declaredRepresentative
      : undefined;

  /**
   * 重みの当たり先(**太さと大きさだけ。色は1つも無い**)。
   *
   * **`leading-base` を添えているのは、Tailwind の `text-…` が行間も一緒に上書きし、
   * テーマの行間スロット(`--line-height-base`)から外れてしまうためである**
   * (`web/src/tailwind.css` の `--leading-base: var(--line-height-base)` へ戻す)。
   * **これは「行間を新しく決めている」のではなく、今日の値に据え置くための1語である。**
   */
  const FIELD_WEIGHT_CLASS = "font-semibold text-lg leading-base";

  /** 1つぶんの項目の器(`<dl class="detail-fields">`)。**まとまりの内外で同じ器を使う。** */
  const renderFieldList = (listFields: Field[]) => (
    <dl className={cn("detail-fields", "m-0")} data-testid="detail-fields" {...fieldListPresets}>
      {listFields.map((field) => (
        <div
          className={cn("detail-field", widthAdaptiveLabel && "flex-col sm:flex-row")}
          key={field.id}
        >
          {/* 見出しはマニフェストの Field.name。ID を出すと利用者の言葉と食い違う。 */}
          <dt
            className={cn(
              "text-label",
              "font-medium",
              widthAdaptiveLabel && "basis-auto! sm:basis-[var(--detail-label-width)]!",
            )}
          >
            {field.name}
          </dt>
          {/*
            **【V4-M19-T02】代表項目1本だけを重く描く。** **宣言を持たないテーブルでは
            `weightedFieldId` が `undefined` になり、className は今日どおり `"m-0"` 1つで、
            DOM は着手前と1バイトも変わらない**(実測は
            `web/test/information-weight.test.tsx` の (c) —— 着手前に取った DOM との完全一致)。
          */}
          <dd
            className={cn("m-0", field.id === weightedFieldId && FIELD_WEIGHT_CLASS)}
            data-testid={`detail-field-${field.id}`}
            data-field={field.id}
            data-field-type={field.type}
          >
            <ReferenceLinkScope
              target={referenceLinkTarget(manifest, field, record[field.id], referenceLabels)}
              appId={appId}
              recordId={record[field.id]}
            >
              <FieldValue
                field={field}
                value={record[field.id]}
                referenceLabels={referenceLabels}
                appId={appId}
                textPreview={view.preset_text_preview}
              />
            </ReferenceLinkScope>
          </dd>
        </div>
      ))}
    </dl>
  );

  return (
    <section
      className={cn("detail-view", "flex flex-col gap-s4")}
      data-testid="view-renderer-detail_view"
      {...imagePreset}
    >
      <Card>
        {/*
          **どのまとまりにも属さない項目**(今日どおりの順序)。**まとまりを1つも書いていない
          画面ではここに全項目が並び、DOM は着手前と1文字も変わらない**(限定8。実測は
          `web/test/detail-field-grouping.test.tsx` の (h) —— 着手前に取った DOM と完全一致)。
          **全項目がまとまりに属する画面ではこの器を出さない** —— **当たり先の無い器を DOM に
          置かない**(下の注記・操作起点と同じ作法)。
        */}
        {/*
          **【V4-M19-T08 / ADR-0119 限定3 / 限定5】宣言した項目のうち値が無いものを落とす。**
          **宣言を1つも持たない画面では `visibleFields` が同じ配列を返すので、DOM は
          着手前と1文字も変わらない**(限定3。実測は `web/test/detail-field-grouping.test.tsx`
          の (h) —— 着手前に取った DOM そのものとの完全一致)。
          **全部落ちた画面では器そのものを出さない** —— 既存の「当たり先の無い器を DOM に
          置かない」作法をそのまま使う(下のまとまりも同じ)。
        */}
        {visibleFields(ungroupedFields).length > 0 &&
          renderFieldList(visibleFields(ungroupedFields))}
        {/*
          **まとまり**(マニフェストの記述順)。**見出し + 区切り + そのまとまりの項目**である
          (限定6。器の形はアプリが選べない)。**重ねて出す表現(モーダル / トースト /
          開くメニュー)を1つも作らない**(`ADR-0087` 限定8 / `ADR-0092` 限定7)。
        */}
        {fieldGroups.map((group) => (
          <section
            className={cn("detail-field-group", "flex flex-col gap-s2")}
            // まとまりは安定IDを持たず、**名前が同一性である**(schema の `propertyNames` が
            // キーの一意性を保証している)。
            key={group.name}
            data-testid="detail-field-group"
            data-field-group={group.name}
          >
            {/*
              見出しは `<h3>` —— **`RelatedList` の `h3.related-heading` と同じ階層**である
              (どちらも詳細画面の中の塊の見出しであり、階層を割らない)。**`CardTitle` を
              使わないのは、それが `<div>` を描く部品であり見出しの意味づけを捨てるためである。**
            */}
            <h3
              className={cn(
                "detail-field-group-heading",
                "m-0",
                "font-semibold",
                "text-foreground",
              )}
            >
              {group.name}
            </h3>
            <Separator />
            {/*
              **まとまりの中でも同じ規則で落ちる**(`V4-M19-T08`)。
              **中身が全部落ちたまとまりには `<dl>` を出さない** —— 空の器を DOM に置かない。
              **見出しと区切りは残る** —— **まとまりの見出しを消す宣言は今日1つも無く、
              それは `ADR-0119` の射程外である**(見出しを消すと「まとまりが在ること」自体が
              画面から消え、`ADR-0092` 限定6 が決めた器の形を本タスクが動かすことになる)。
            */}
            {visibleFields(group.fields).length > 0 && renderFieldList(visibleFields(group.fields))}
          </section>
        ))}
      </Card>

      {/*
        遷移先が2つ以上あるときの注記(ユーザ決定 D-M3-6)。**一覧が出しているものと
        同じ規約・同じ判定**である —— 遷移先が実在し、かつ同じテーブルの detail_view が
        2つ以上あるときだけ出す(判定の中身は `DetailTargetNote` にある)。

        **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
        **項目の参照の注記を出すのをやめた。** **ユーザ決定 `D-V10-21` が選んだ見出しは
        「出すのをやめる」である。** **代わりの手だてを1つも作っていない**(別の場所に
        同じ説明を出す・`title` 属性に入れる 等)。**役割・利用者・見せる相手を見る式も
        1本も足していない**(`FU-G2` 限定1)——**出し分けではなく、消したのである。**
        **項目の参照がリンクになるかどうかは1ビットも変えていない。**
      */}

      {/*
        関連レコードの動的表示(EC-G17 / ADR-0044)。**自レコード表示の下に**、
        「今開いているレコードを親に持つ子レコードの一覧」を埋め込む。各定義は独立に
        子レコードを取得するので、専用のサブコンポーネントに切り出す(1ホップのみ)。
      */}
      {view.related?.map((rel, index) => (
        <RelatedList
          // related は順序を持つ表示定義で、同じ table/via を2回並べることもありうる ——
          // 位置そのものが同一性なので、定義位置(index)を鍵に含める。
          // biome-ignore lint/suspicious/noArrayIndexKey: related は安定IDを持たず、定義位置が同一性である
          key={`${rel.table}:${rel.via}:${index}`}
          appId={appId}
          manifest={manifest}
          related={rel}
          parentRecordId={record._id}
          textPreview={view.preset_text_preview}
        />
      ))}

      {/*
        ビューからの操作起点(EC-G14 / ADR-0045)。**自レコード表示の下に**、指定 form へ
        遷移し、参照フィールド1つを今開いているレコードの `_id` でプリフィルするボタンを置く
        (「この商品をカートに入れる」)。プリフィルは URL ではなく navigate に載せて運ぶ
        一時状態で、遷移先 form の reference フィールドが選択済みで開く。**「操作の起点」であって
        表示の見た目(配色/グラフ)ではない**(§1b。配色・グラフ・表示体裁を1つも持たない)。
        遷移先 form は書き込み画面なので、編集/削除と同じく viewer には出さない(先回りガード。
        最終防衛線はサーバの 403)。**書けるかどうかは遷移先 form のテーブルで1本ずつ判定する**
        (B-G3 / V4-M1。上の `writableActions`)—— `canWrite`(= `view.table` 基準)ではない。
      */}
      {/*
        **【V4-M19-T01】押してほしい主なボタンと、そうでないボタンを見た目で区別する。**
        **門A の判定は「将来送り」であり、これはその送り先の履行である。`ADR` は無い(台帳1行)。**

        ## 決めた規約(**宣言ではない**)

        **`view.actions`(マニフェストに書かれた配列)の1番目を主(`variant="default"`)、
        それ以外を副(`variant="secondary"`)とする。** **`web/src/ui/button.tsx` を
        1バイトも触っていない** —— **既存5値のうち2つを選んでいるだけで、新しい variant を
        1つも作っていない。** **編集(`detail-edit`)/ 削除(`detail-delete-*`)の `variant` も
        1バイトも変えていない**(当たっているのは操作起点だけである)。

        ## **満たしていない完了条件を隠さない**

        **起票時の完了条件は「規約が `src/mcp/vocabulary.ts` の散文に明記される」だったが、
        それは満たしていない。** 発注が「将来送りの5単位については語彙を1バイトも増やさない
        (表示層だけで行う)」と定めており、**`src/` を0行差分に保つ側を採った**ためである。
        **その結果、この規約はマニフェストにも MCP の説明文にも1文字も現れない** ——
        **マニフェストを読んだだけでは、どのボタンが主として描かれるか分からない。**
        **これは自己完結性(憲法3)の後退であり、隠さずここに書く。**

        ## **解けていないこと(先に書く)**

        - **並び順と主副を独立に選べない** —— **主にしたいものを先頭へ動かすと表示順も動く。**
          **したがって「2番目に置いたまま主にする」ことはできず、3つ以上並ぶとき2つ目を
          主にすることはできない。**
        - **1番目がロールで絞り落とされた画面では、主のボタンが1つも出ない**(2番目は
          繰り上がらない)。**これは意図した挙動である** —— 繰り上げると、同じマニフェストの
          同じ画面が見る人によって違うボタンを「主」として押させることになる。
          **実測は `web/test/action-emphasis.test.tsx` の (c)。**
        - **主が実際に目立って見えるか(見分けが付くか)を1件も測っていない** ——
          `variant` の対はコントラスト検査にも chromium の実測にも1件も載っていない。
      */}
      {visibleActions.length > 0 && (
        <div
          className={cn("detail-action-origins", "flex flex-wrap items-center gap-s2")}
          data-testid="detail-action-origins"
        >
          {visibleActions.map(({ action, declaredIndex }, index) =>
            /*
              **【V4-M20-T01 / ADR-0100 限定1】形は2つだけである。**
              **`"set" in action` の1点で分かれ、3つ目の分岐は無い**(schema の `oneOf` が
              2形を排他に閉じているので、ここに来る要素は必ずどちらか一方である)。
              **形 (ii) は遷移しない** —— `navigate` を1度も呼ばない。
            */
            "run" in action ? (
              <Button
                // biome-ignore lint/suspicious/noArrayIndexKey: actions は安定IDを持たず、定義位置が同一性である
                key={`run:${action.run}:${index}`}
                variant={declaredIndex === 0 ? "default" : "secondary"}
                type="button"
                data-testid={`action-run-${action.run}`}
                disabled={runningWorkflow !== null}
                onClick={() => {
                  void handleRunAction(action.run);
                }}
              >
                {action.name ?? "実行する"}
              </Button>
            ) : "set" in action ? (
              <Button
                // 同じ field/value を複数並べられる(位置が同一性)ので定義位置を鍵に含める。
                // biome-ignore lint/suspicious/noArrayIndexKey: actions は安定IDを持たず、定義位置が同一性である
                key={`set:${action.set.field}:${index}`}
                variant={declaredIndex === 0 ? "default" : "secondary"}
                type="button"
                data-testid={`action-set-${action.set.field}`}
                disabled={settingAction !== null}
                onClick={() => {
                  void handleSetAction(declaredIndex, action.set);
                }}
              >
                {action.name ?? "この値にする"}
              </Button>
            ) : (
              <Button
                // 同じ form/field を複数並べられる(位置が同一性)ので定義位置を鍵に含める。
                // biome-ignore lint/suspicious/noArrayIndexKey: actions は安定IDを持たず、定義位置が同一性である
                key={`${action.form}:${action.prefill.field}:${index}`}
                // **主副は「書かれた配列」の位置で決まる**(`declaredIndex`)—— 絞り込み後の
                // 位置(`index`)ではない。**この1行が上の規約の全実装である。**
                variant={declaredIndex === 0 ? "default" : "secondary"}
                type="button"
                data-testid={`action-origin-${action.form}`}
                onClick={() => {
                  // プリフィルは参照フィールド1つ × 今開いているレコードの `_id`(ADR-0045 限定2/3)。
                  navigate({
                    kind: "view",
                    appId,
                    viewId: action.form,
                    prefill: { field: action.prefill.field, value: record._id },
                  });
                }}
              >
                {action.name ?? "新規作成へ"}
              </Button>
            ),
          )}
          {runError === null ? null : (
            // **黙って捨てない**(憲法6)。**押した場所のすぐ横に理由を出す。**
            <span
              className={cn("detail-action-run-error", "text-destructive text-sm")}
              data-testid="detail-action-run-error"
              role="alert"
            >
              {runError}
            </span>
          )}
        </div>
      )}

      <div className={cn("detail-actions", "flex-wrap items-center")}>
        {/*
          viewer は編集/削除できない。導線を先回りで閉じ、閲覧のみである旨を出す。

          **【E-G20 / V4-M6】出すのは「編集できる想定の人が編集できないとき」だけである。**
          **買い物客が公開テーブル(店の商品ページ)を見ているときは出さない** —— そもそも
          編集する立場に無い相手に「書き込み権限がありません」と言う理由が無く、実地では
          商品説明の下にこの文言が出て、店の画面ではなく管理ツールの画面に見えていた
          (02 §5-3 `E-G20`。5画面で実測)。**判定は `isWriteAudienceRole`(`auth/authz.tsx`)
          1本にあり、ここに規約を置かない。** **`canWrite`(= 編集/削除の導線の可否)は
          1バイトも変えていない** —— 消えるのは注記だけである。
        */}
        {!canWriteRecord && isWriteAudienceRole(role, table) && (
          <p
            className={cn("read-only-note", "text-muted-foreground")}
            data-testid="detail-read-only"
          >
            閲覧のみ(書き込み権限がありません)。
          </p>
        )}
        {formView !== undefined && canWriteRecord && (
          <Button
            type="button"
            data-testid="detail-edit"
            onClick={() => {
              // 同じレコードを編集するので、対象を URL に載せたまま form へ渡す。
              navigate({ kind: "view", appId, viewId: formView.id, recordId: record._id });
            }}
          >
            編集
          </Button>
        )}
        {/*
          読み取り専用のシステムテーブルには削除の導線を出さない(ADR-0006 §8 の L4)。
          これは**防御ではなく UI の一貫性**である ―― DevTools から fetch を投げれば
          ここは素通りするが、カーネルの L1(最終防衛線)は通れない。
          viewer にも同様に出さない(先回りガード。最終防衛線はサーバの 403)。
        */}
        {/*
          **【V4-M15-T05 / `ADR-0087` 限定8】確認はその場に開く。**
          **重ねて出す表現(モーダル / トースト / 開くメニュー)を1つも作らない** ——
          着手前もその場に開く形であり、**この載せ替えで重ね方を1つも増やしていない。**
        */}
        {readOnly || !canWriteRecord ? null : confirmingDelete ? (
          <div
            className={cn("flex flex-wrap items-center gap-s2")}
            data-testid="detail-delete-confirm"
          >
            <p className={cn("m-0", "text-destructive")}>
              このレコードを削除します。元に戻せません。
            </p>
            <Button
              variant="destructive"
              type="button"
              data-testid="detail-delete-execute"
              disabled={deleting}
              onClick={() => {
                void handleDelete();
              }}
            >
              削除する
            </Button>
            <Button
              variant="secondary"
              type="button"
              data-testid="detail-delete-cancel"
              disabled={deleting}
              onClick={() => {
                setConfirmingDelete(false);
              }}
            >
              やめる
            </Button>
          </div>
        ) : (
          <Button
            variant="destructive"
            type="button"
            data-testid="detail-delete"
            onClick={() => {
              setDeleteErrors([]);
              setConfirmingDelete(true);
            }}
          >
            削除
          </Button>
        )}
      </div>

      {writeForbidden && <WriteForbidden />}
      {writeConflict && <WriteConflict />}
      {applyInProgress && <ApplyInProgress />}
      {deleteErrors.length > 0 && (
        <div data-testid="detail-errors">
          <ErrorList errors={deleteErrors} />
        </div>
      )}
    </section>
  );
}

/**
 * 関連レコードの動的表示 —— 子一覧の1つ(EC-G17 / ADR-0044)。
 *
 * **「今開いているレコード(`parentRecordId`)を親に持つ子レコードの一覧」**を、`columns` を
 * 列とする表として描く。取得は既存の `fetchRecords` に **親条件の等値 filter1つだけ**
 * (`related.via == parentRecordId`)と `related.sort` を渡す —— 新しい読取経路を作らず、
 * list_view と同じサーバ経路を通す(ADR-0044 §1c / 限定2)。
 *
 * ## 越えない線(ADR-0044 §3a)
 *
 * - **1ホップのみ**。子の子(孫)は辿らない。子一覧のセルに出る reference は list_view と
 *   同じく参照先の代表値をラベルにするだけで、そこから先へは展開しない。
 * - **子一覧への一般 filter は持たない**。絞り込みは親 id の等値1つに固定されている
 *   (`related` に filter キーが無いことを schema が担保している)。
 *
 * サーバ側の参照整合(`referential-integrity.ts` の類型14)が apply 時に via/columns/sort を
 * 検査済みなので、通常ここに来る定義は健全である。それでも「与えられたマニフェストを信じて
 * 黙って落とす」ことはせず、対象テーブル・列が解決できなければ統一形式で報告する(憲法6)。
 */
function RelatedList({
  appId,
  manifest,
  related,
  parentRecordId,
  textPreview,
}: {
  appId: string;
  manifest: Manifest;
  related: NonNullable<DetailView["related"]>[number];
  parentRecordId: string;
  /**
   * 親の detail_view に書かれた切り詰め長(ADR-0050 の軸7)。**`FieldCell` へ渡すだけ。**
   * 軸6 と同じく子一覧にも当たる(ADR-0050 §4)—— 同じ画面の中で長さが割れないため。
   * **`related` ごとに別の値を持つ語彙は無い**(§3a 6 の門)。
   */
  textPreview: DetailView["preset_text_preview"];
}) {
  /** 子テーブル(宣言テーブル。子レコードはシステムテーブルには置けない)。 */
  const childTable = resolveViewTable(manifest, related.table);

  /** `columns` をフィールド定義に解決する。解決できない列は隠さず報告する(憲法6)。 */
  const resolved = useMemo(() => {
    if (childTable === undefined) {
      return {
        columns: [] as Field[],
        errors: [
          {
            path: "",
            message: `関連レコード一覧(related)の子テーブル "${related.table}" がありません。`,
            allowed_values: viewTargetIds(manifest),
          } satisfies ValidationError,
        ],
      };
    }
    const columns: Field[] = [];
    const errors: ValidationError[] = [];
    for (const columnId of related.columns) {
      const field = childTable.fields.find((candidate) => candidate.id === columnId);
      if (field === undefined) {
        errors.push({
          path: "",
          message: `関連レコード一覧(related)の列 "${columnId}" は子テーブル "${childTable.id}" にありません。`,
          allowed_values: childTable.fields.map((candidate) => candidate.id),
        });
        continue;
      }
      columns.push(field);
    }
    return { columns, errors };
  }, [manifest, childTable, related]);

  /** 子一覧の列に出てくる reference の参照先テーブル(代表値を引くためまとめて取得)。 */
  const referencedTables = useMemo(() => {
    const ids = new Set<ResourceId>();
    for (const field of resolved.columns) {
      if (field.type === "reference") {
        ids.add(field.reference_table);
      }
    }
    return [...ids]
      .map((id) => resolveViewTable(manifest, id))
      .filter((candidate): candidate is Table => candidate !== undefined);
  }, [manifest, resolved.columns]);

  const [state, setState] = useState<
    AsyncState<{ records: RecordRow[]; labels: ReferenceLabelIndex }>
  >({ status: "loading" });

  useEffect(() => {
    if (resolved.errors.length > 0) {
      setState({ status: "error", errors: resolved.errors });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });

    // **親条件の等値1つだけ**を filter に載せる(ADR-0044 §1c)。演算子は書かない。
    const options = {
      filter: [{ field: related.via, equals: parentRecordId }],
      ...(related.sort !== undefined ? { sort: related.sort } : {}),
    };

    Promise.all([
      fetchRecords(appId, related.table, options),
      Promise.all(
        referencedTables.map(async (target) => ({
          table: target,
          records: await fetchRecords(appId, target.id),
        })),
      ),
    ]).then(
      ([records, referenceSources]) => {
        if (!cancelled) {
          setState({
            status: "ready",
            value: { records, labels: buildReferenceLabelIndex(referenceSources) },
          });
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
    // 依存はマニフェスト由来の値 + 親レコードID(`referencedTables` は useMemo 済み)。
    // `related.sort` は list_view と同じくそのまま依存に入れる(表記の正規化は api 層 =
    // カーネルと共有の normalizeSort が引き受けるので、ここは値を渡すだけ)。
  }, [
    appId,
    related.table,
    related.via,
    related.sort,
    parentRecordId,
    referencedTables,
    resolved.errors,
  ]);

  /** 見出し。`name` 未指定なら子テーブルの表示名(無ければテーブルID)を出す。 */
  const heading = related.name ?? childTable?.name ?? related.table;

  /**
   * 子行クリックの遷移先(V3-M3-T02)。規約(定義順の先頭)は `navigation.tsx` の
   * `resolveDetailViewTarget` が唯一の実装であり、ここには書かない —— **一覧の行と
   * 同じ関数を通す**ので、同じマニフェストで一覧と子一覧の行き先が割れることはない。
   * 無い場合(子テーブルに detail_view が無い)は行をクリックできないままにする。
   *
   * **【`V10-M18-T01` / `FU-G1a` / `ADR-0362` §Decision 1 の遷移点2】一続きの流れの段に
   * なっている `detail_view` を候補から外す。** **一覧の行と同じ引数を渡す**ので、
   * 同じマニフェストで一覧と子一覧の行き先が割れることは今日も無い。
   * **外した結果0個になれば、今日どおり子行が押せなくなる**(別の画面へ倒さない。
   * `ADR-0362` §Decision 3)。
   */
  const childDetailView = resolveDetailViewTarget(manifest, related.table, {
    skipFlowStepViews: true,
  });

  /**
   * 子一覧の列のうち、実際にリンクになる参照とその遷移先。**判定は
   * `referenceLinkTarget` 1本**である(セルの側と割れないため)。
   * **1行でもリンクになる列だけ**を注記の対象にする(当たり先の無い注記を置かない)。
   *
   * **【`V10-M18-T02`(`FU-G2`)の追記。上の説明を1バイトも消していない】**
   * **この `linkedReferenceColumns` は撤去した。** **唯一の読み手が、下で消した「子一覧の
   * 列の参照の注記」だったからである**(残すと `biome` の `noUnusedVariables` が赤くなる)。
   * **子一覧のセルがリンクになるかどうかは1ビットも変えていない**(判定は今日も
   * `referenceLinkTarget` 1本であり、この関数の中では下の表の描画がそれを呼んでいる)。
   */

  return (
    <section
      className={cn("related-list", "flex flex-col gap-s2")}
      data-testid="related-list"
      data-related-table={related.table}
    >
      {/*
        見出しは `<h3>` のまま(見出しの階層は載せ替えで動かさない)。**`related-heading` の
        クラス名も落としていない。** `CardTitle` を使わないのは、それが `<div>` を描く部品で
        あり、**見出しの意味づけ(`h3`)を捨てることになる**ためである。
      */}
      <h3 className={cn("related-heading", "m-0", "font-semibold", "text-foreground")}>
        {heading}
      </h3>
      <Separator />
      {/*
        **読み込み中 / 0件 / エラーの見え方**(`V4-M15-T14` の一部)。**文言も `data-testid` も
        1文字も変えていない** —— 変えたのは器だけである。0件は控えめな一文にする
        (**「無い」ことは隠さない** = 憲法6。`related-empty` は今日も出る)。
      */}
      {state.status === "loading" ? (
        <div className={cn("flex flex-col gap-s2")}>
          <p className={cn("m-0", "text-muted-foreground")}>読み込み中…</p>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : state.status === "error" ? (
        <ErrorList errors={state.errors} />
      ) : state.value.records.length === 0 ? (
        <p className={cn("m-0", "text-muted-foreground")} data-testid="related-empty">
          該当するレコードはありません。
        </p>
      ) : (
        // **横に溢れる表を狭い画面でも読めるようにする**(`D-V4-44`)。器を1枚挟むだけで、
        // **`related-table` のクラスも `data-testid` も、軸6 の当たり先(`.detail-view` から
        // 始まる規則)も1バイトも変わらない。**
        <TableFrame>
          <UiTable className="related-table" data-testid="related-table">
            <TableHeader>
              <TableRow>
                {resolved.columns.map((field) => (
                  <TableHead key={field.id} scope="col" className={RELATED_CELL_CLASS}>
                    {field.name}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.value.records.map((child) => (
                <RelatedRow
                  key={child._id}
                  appId={appId}
                  manifest={manifest}
                  columns={resolved.columns}
                  record={child}
                  referenceLabels={state.value.labels}
                  textPreview={textPreview}
                  onOpen={
                    childDetailView === undefined
                      ? undefined
                      : () => {
                          // どのレコードを開いたかを URL に載せる(一覧の行と同じ形)。
                          navigate({
                            kind: "view",
                            appId,
                            viewId: childDetailView.id,
                            recordId: child._id,
                          });
                        }
                  }
                />
              ))}
            </TableBody>
          </UiTable>
        </TableFrame>
      )}
      {/*
        遷移先が2つ以上あるときの注記(ユーザ決定 D-M3-6)。**行が1件も無いときは出さない**
        —— 押せる行が無いところに「行をクリックすると」と書いても当たり先が無い。

        **【`V10-M18-T02`(`FU-G2`)の追記。上の行を1バイトも消していない】**
        **子一覧の行の注記と、子一覧の列の参照の注記を、どちらも出すのをやめた。**
        **ユーザ決定 `D-V10-21` が選んだ見出しは「出すのをやめる」である。**
        **代わりの手だてを1つも作っていない。** **役割・利用者・見せる相手を見る式も
        1本も足していない**(`FU-G2` 限定1)。**子行が押せるかどうか、どの `detail_view` へ
        移るかは、着手前と1ビットも同じである**(`childDetailView` は今日もそのために在る)。
      */}
    </section>
  );
}

/**
 * `related` の子一覧の1行(V3-M3-T02)。`onOpen` が無いとき(遷移先が無いとき)は
 * ただの行として振る舞う —— **一覧の `ListRow` と同じ規約**である。
 *
 * ## 行クリックとセル内リンクが二重発火しないこと
 *
 * 子行のセルには `reference` のリンクが出る(同じ DOM で導線が交差する)。**リンクを
 * 押したときに行の遷移も起きると、利用者が押した先とは別のレコードが開く。** そこで
 * 行の側で「リンクの中から来たイベントか」を見て降りる —— リンクの側に
 * `stopPropagation` を書くのではなく行の側で見るのは、**リンクの実装(`RouteLink`)を
 * この事情で変えると、クリック可能な行の中に無い他の全リンクの挙動まで変わる**ためである。
 */
function RelatedRow({
  appId,
  manifest,
  columns,
  record,
  referenceLabels,
  textPreview,
  onOpen,
}: {
  appId: string;
  manifest: Manifest;
  columns: Field[];
  record: RecordRow;
  referenceLabels: ReferenceLabelIndex;
  textPreview: DetailView["preset_text_preview"];
  onOpen: (() => void) | undefined;
}) {
  const interactive = onOpen !== undefined;
  return (
    <TableRow
      // **既存のクラス名を2つとも残す** —— `.related-row-interactive` には
      // `web/src/styles.css` が `cursor` と hover/focus の地色を当てている(一覧の行と
      // 同じ規則に載っている)。**部品体系のクラスは既存クラスに足す形で入れる。**
      className={cn(
        interactive ? "related-row related-row-interactive" : "related-row",
        "border-b-[length:var(--border-width)] border-solid border-border",
      )}
      data-testid="related-row"
      {...(interactive
        ? {
            tabIndex: 0,
            onClick: (event: React.MouseEvent<HTMLTableRowElement>) => {
              // セル内のリンクが自分で遷移したので、行はもう何もしない(二重発火の防止)。
              if ((event.target as HTMLElement).closest("a") !== null) {
                return;
              }
              onOpen();
            },
            onKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>) => {
              // 行そのものにフォーカスがあるときだけ。セル内のリンク上での Enter は
              // リンク自身の既定動作であって、行を開く操作ではない。
              if (event.target !== event.currentTarget) {
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onOpen();
              }
            },
          }
        : {})}
    >
      {columns.map((field) => {
        const target = referenceLinkTarget(manifest, field, record[field.id], referenceLabels);
        // リンクにならないセルは従来どおり `FieldCell` が器ごと描く(DOM は1バイトも同じ)。
        return target === undefined ? (
          <FieldCell
            key={field.id}
            field={field}
            value={record[field.id]}
            referenceLabels={referenceLabels}
            appId={appId}
            textPreview={textPreview}
          />
        ) : (
          // **器の属性は `FieldCell` と同じにする**(片方だけ変えると列と型の対応が割れる)。
          // **クラスも同じにする** —— 実体は `fields/display.tsx` の `RELATED_CELL_CLASS` 1つ
          // だけで、2箇所に書かない(片方だけ変えると同じ表の中で列が揃わない)。
          <TableCell
            key={field.id}
            data-field={field.id}
            data-field-type={field.type}
            className={RELATED_CELL_CLASS}
          >
            <ReferenceLinkScope target={target} appId={appId} recordId={record[field.id]}>
              <FieldValue
                field={field}
                value={record[field.id]}
                referenceLabels={referenceLabels}
                appId={appId}
                textPreview={textPreview}
              />
            </ReferenceLinkScope>
          </TableCell>
        );
      })}
    </TableRow>
  );
}

/**
 * 削除に成功したあとの行き先。消したレコードの詳細に留まれないので一覧へ戻る。
 *
 * 同じテーブルの `list_view` があればそこへ、無ければそのアプリのビュー一覧へ。
 * 行き先は**マニフェストから導く**ので、遷移先の設定という語彙は増えない。
 *
 * ---
 *
 * **【2026-08-20。`V10-M1-T02` / `NV-G4` / `ADR-0359` §4a。上の本文を1バイトも
 * 書き換えていない。ただし最後の1文は今日は全量ではない】**
 *
 * **`ADR-0359`(門A / 判定 = 限定採用)が `$defs/view` に `after_delete` を1本足した** ——
 * **したがって「遷移先の設定という語彙」は今日 **在る**(30キー目)。**
 * **【禁止】この軸について「語彙ゼロ増」と書かない**(`ADR-0359` §Consequences)。
 *
 * **宣言があればそこへ、無ければ**上の3行の既定にそのまま倒れる**(限定5)——
 * **既定の実装は1文字も書き換えていない**(下の `list` を求める式は着手前と同じである)。
 * **これは `ADR-0173` `L-G6` の「宣言があれば宣言、無ければ規約」と同じ形である。**
 *
 * **宣言した画面がこのマニフェストに無ければ既定へ倒れる**(壊れない)——
 * **実在しないIDと、行を必要とする画面(`detail_view` / `form`)は
 * `referential-integrity.ts` が apply 時に倒しているので、ここに来るのは
 * 「役割の規則でこの人には配られなかった画面」だけである。**
 * **エラーは出さない** —— **削除は成立しており、行き先が無いことは削除の失敗ではない。**
 *
 * **確認ダイアログには1バイトも触っていない**(限定6)。
 */
function afterDeleteRoute(
  appId: string,
  manifest: Manifest,
  tableId: ResourceId,
  declared?: ResourceId,
) {
  if (declared !== undefined) {
    const destination = manifest.app.views.find((candidate) => candidate.id === declared);
    if (destination !== undefined) {
      return { kind: "view", appId, viewId: destination.id } as const;
    }
  }
  const list = manifest.app.views.find(
    (candidate) => candidate.type === "list_view" && candidate.table === tableId,
  );
  return list === undefined
    ? ({ kind: "app", appId } as const)
    : ({ kind: "view", appId, viewId: list.id } as const);
}
