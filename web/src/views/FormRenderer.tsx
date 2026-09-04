/**
 * form の汎用コンポーネント(V0-P3-T05)。
 *
 * マニフェストの `form`(`table` / `fields`)を**解釈して**作成・編集フォームを描く。
 * アプリごとのフォームを生成するのではなく、このコンポーネント1つに任意のマニフェストを
 * 流し込む(handover 3.7 / 憲法3)。したがってここにアプリ固有の名前は現れない。
 *
 * ## フロントで検証しない、という設計判断
 *
 * `required` は**印を出すだけ**で、未入力でも送信をブロックしない。数値として読めない
 * 文字列も、そのままカーネルへ送る。理由は次のとおり:
 *
 * - 検証の正はカーネル(`src/kernel/records.ts`)ただ1つである。フロントに同じ判定を
 *   置くと実装が2つになり、必ずいつか食い違う。
 * - このアプリは HTTP(ブラウザ)からも MCP(LLM)からも同じカーネルを叩く。フロントで
 *   先回りして弾くと、**同じ操作が経路によって通ったり通らなかったりする**。利用者と
 *   LLM が見る世界が割れることは、信頼を落とす形の嘘になる(憲法6)。
 * - カーネルのエラーは `allowed_values` / `hint` 付きの統一形式で、そのまま出せば
 *   自己修正できる情報になっている(handover 3.8)。フロントが文面を作り直す必要はない。
 *
 * よってフロントの役割は「送って、返ってきた統一形式エラーを、該当フィールドの直下に
 * 置く」ことに徹する。
 *
 * ## 部品体系での描き直し(V4-M15-T04。`ADR-0087`)
 *
 * 描画を `web/src/ui/` の部品(`Label` / `Button` / `Alert`)と、`fields/input.tsx` 経由の
 * 入力部品で組み直した。**契約は1つも動かしていない**:
 *
 * - **既存の `data-testid` を1つも落としていない**(`view-renderer-form` / `form-errors` /
 *   `field-label-<id>` / `required-<id>` / `field-error-<id>` / `form-read-only`)。
 * - **既存のクラス名 `record-form` / `field` / `required` / `read-only-note` を1つも
 *   消していない** —— `web/src/styles.css` の規則が当たり続ける。**部品体系のクラスは
 *   既存クラスに「足す」形**で入れてある(`cn("record-form", …)`)。
 * - **上の「フロントで検証しない」は今日も真である。** 足したのは `aria-invalid` だけで、
 *   これは**カーネルが返したエラーを見た目に写すだけ**であり、送信を1件も止めない。
 *
 * ## 画面幅への対応(`D-V4-44`)
 *
 * **断点は `sm:`(40rem)と `lg:`(64rem)の2つだけ**で、ここが使うのは `sm:` 1つである。
 * **狭い画面では項目名と入力欄が縦に積まれ、入力欄と保存ボタンは幅いっぱいに広がる。**
 * `sm:` 以上では従来どおり —— **項目名と入力欄の縦の並びは着手前も同じ**
 * (`web/src/styles.css` の `.record-form label { display: block }`)なので、`sm:` で
 * 戻しているのは**幅**である(部品の `w-full` が広い画面で窓幅いっぱいに伸びるのを止め、
 * 着手前に近い見え方へ戻す)。**「`sm:` 以上で横並びに変えた」ではない。**
 *
 * ## 画面プリセットを2軸だけ通した(`V4-M16-T11` / `P-G29`。`ADR-0091`)
 *
 * **`preset_label_placement`(項目名と値の向き)と `preset_field_columns`(項目の段組数)を
 * form でも書けるようにした。****通したのは2軸だけで、残る5軸は今日も form に書けない。**
 * **【禁止】「form の見せ方が指定できるようになった」と書かない**(`ADR-0091` §Decision 3)。
 *
 * - **`ViewRendererProps` に props を1つも足していない** —— 値は `view` から読む。
 * - **書かなかった form の DOM は着手前と完全一致する**(属性も器も1つも出ない。
 *   固定は `web/test/form-view-presets.test.tsx` の (f))。
 * - **既存の `data-testid` とクラス名を1つも落としていない。**
 * - **【正直に書く】`ADR-0091` 限定6 の「既定は `inline`」は form については実物と
 *   一致しない** —— **form の既定は縦積みである**(上の `.record-form label` の説明のとおり)。
 *   **`stacked` と書いた form が今日の描画と同じになり、`inline` と書いた form だけが変わる。**
 */
import type { FormEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Field, FormView, Manifest, Table } from "../../../src/kernel/types.ts";
import {
  createRecord,
  fetchRecord,
  isApplyInProgress,
  isForbidden,
  isWriteConflict,
  type RecordInput,
  type RecordRow,
  updateRecord,
  type ValidationError,
} from "../api.ts";
import { type AsyncState, toValidationErrors } from "../async.ts";
import {
  // **【`V8-M22` / `J-G38`】面(役割に束ねた権限)の先回りを、サーバの判断に一致させる。**
  // **どちらも `src/server/owner-scope.ts` の述語をそのまま呼ぶ薄い包みであり、
  // 規則の読み方は表示層に1文字も無い。**
  canWriteFieldRole,
  canWriteTableActionRole,
  useCanWrite,
  useRole,
  viewIdForRecordRequest,
} from "../auth/authz.tsx";
import { ErrorList } from "../ErrorList.tsx";
import {
  FieldInput,
  type FieldInputValue,
  grantMemberScope,
  restrictReferenceChoices,
  usePermittedGrantMemberIds,
  useReferenceChoices,
} from "../fields/input.tsx";
// **名簿の `account` 欄を「利用者を選ぶプルダウン」にする**(`UM-G2`。`V13-M1-T02`)——
// **どの項目がその欄かを解くのも、一覧を1度だけ読むのも、この1本に住んでいる。**
import { accountFieldFor, useUserAccountChoices } from "../fields/user-account.ts";
import { navigate, resolveDetailViewTarget } from "../navigation.tsx";
import type { RoutePrefill } from "../route.ts";
import { resolveViewTable } from "../table-resolution.ts";
import { Button } from "../ui/button.tsx";
import { Label } from "../ui/form-controls.tsx";
import { Alert } from "../ui/surfaces.tsx";
import { cn } from "../ui/utils.ts";
// **【2026-08-21(`V10-M18-T03` / `FU-G3`)】** **`flowStepOf` はもう要らない** ——
// **「戻る」を器(`ViewHost.tsx`)へ1本だけ移したので、このファイルは段の宣言を1度も読まない。**
// **保存が成立したあとの行き先(`flowNextRoute`)だけが残っている。**
import { flowNextRoute } from "./flow.ts";
import type { FormRendererProps } from "./types.ts";
import { ApplyInProgress, WriteConflict } from "./WriteConflict.tsx";
import { WriteForbidden } from "./WriteForbidden.tsx";

type FormValues = Record<string, FieldInputValue>;

/**
 * `recordId` があれば既存レコードの編集、無ければ新規作成。
 *
 * 対象は URL(`route.ts` の `Route`)から props で降ってくる。コンポーネントの内部
 * 状態にしないので、リロードしても同じレコードの編集画面に戻る。
 */
export function FormRenderer({ appId, manifest, view, recordId, prefill }: FormRendererProps) {
  // 解決だけを他の3箇所と揃える(ADR-0006 §7 の #11)。form がシステムテーブルを
  // 指すマニフェストはカーネルの L2 が拒否するので**ここへは到達しないはず**だが、
  // 「到達しないはず」に安全性を預けない ―― L2 がほどけた瞬間、未解決のまま
  // `resolveFields` に `undefined` が渡って静かに壊れる経路が開く。
  // 書き込み自体の禁止は L2 とカーネルの L1 が担い続ける。
  const table = resolveViewTable(manifest, view.table);
  const resolved = useMemo(() => resolveFields(manifest, view, table), [manifest, view, table]);
  /**
   * **現在ユーザの立場**(`V8-M22` / `J-G38`)。**props ではなくコンテキストで受ける**
   * (`ADR-0053` 限定3 =「導線とロールは props に流さない」。`ViewRendererProps` に
   * 1つも足していない)。
   */
  const role = useRole();
  /**
   * **【`V8-M22` / `J-G38`】面が書込を許していない項目を、入力欄から落とす。**
   *
   * **着手前は落としていなかった** —— **`editor` の画面に、面が落とした項目の入力欄が
   * 描かれ、送ると 403 になっていた**(`docs/plan/v8/records/v8-m17.md:817`)。
   * **落とす理由は「見せない」ためではなく、`toRecordInput` が解決済みの項目を**全部**
   * 送るからである** —— **書けない項目が1つ混じるだけで、保存**全体**が 403 になる**
   * (`src/server/app.ts:3974` / `:4196`)。
   *
   * **判定は `src/server/owner-scope.ts` の `judgeRoleAccess` 1本**(`canWriteFieldRole`
   * はその薄い包みである)。**規則を再実装していない。**
   *
   * **【誇張しない】これは遮断ではない。** **最終防衛線は今日もサーバの 403 である**
   * (`ADR-0176` 限定5)。**消しているのは「送れば必ず失敗する入力欄」だけである。**
   *
   * **【代償を隠さない】** **必須項目が面で書込不可になっているとき、その項目は
   * 入力欄ごと消える** —— **保存はサーバ側の必須検査で 400 になる。**
   * **着手前は 403 だったものが 400 に変わるだけであり、どちらでも保存はできない。**
   * **「保存できるようになった」とは書かない。**
   */
  const fields = useMemo(
    () =>
      table === undefined
        ? resolved.fields
        : resolved.fields.filter((field) => canWriteFieldRole(role, manifest, table.id, field.id)),
    [manifest, resolved.fields, role, table],
  );

  const referenceChoices = useReferenceChoices(
    appId,
    manifest,
    fields.flatMap((field) => (field.type === "reference" ? [field.reference_table] : [])),
  );

  const [state, setState] = useState<AsyncState<FormValues>>({ status: "loading" });
  const [submitErrors, setSubmitErrors] = useState<ValidationError[]>([]);
  const [submitting, setSubmitting] = useState(false);
  /** サーバが 403(権限不足)を返したか。401(失効)とは別に「閲覧のみ」を出す。 */
  const [writeForbidden, setWriteForbidden] = useState(false);
  /** 409(版不一致)。別のユーザ/セッションが先に変更した。最新を取り込んでやり直す(M9-T02)。 */
  const [writeConflict, setWriteConflict] = useState(false);
  /** 409(適用中)。いま差分適用中なので、少し待って再試行する(M9-T02)。 */
  const [applyInProgress, setApplyInProgress] = useState(false);
  /**
   * 楽観ロック(M9-T02)用に、編集対象を読んだときの版(`_updated_at`)を保持する。
   * update の `If-Match` に載せる。新規作成では版が無いので `undefined`。
   */
  const [version, setVersion] = useState<string | undefined>(undefined);
  /**
   * viewer は書込できない。UI を先回りで閉じる(最終防衛線はサーバの 403)。
   *
   * **対象テーブルを渡す**(V3-M3-T04 / D-G12b)—— customer だけはテーブル単位で可否が
   * 分かれる。渡さないと「customer は何にも保存できない」(fail-closed)に倒れ、
   * 自分のカート(`st_owner` テーブル)にも保存できなくなる。判定は
   * `canWriteRole` → `nonAdminTableAccess` の1本にあり、ここには規約を置かない。
   */
  const roleAllowsWrite = useCanWrite(table);
  /**
   * **【`V8-M22` / `J-G38`】面のボタンの規則が立てた「表 × 書込の種類」の壁も見る。**
   *
   * **サーバは `POST` / `PATCH` のボディを読む前にこの壁を当てる**
   * (`src/server/app.ts:3947` / `:4164`)—— **壁は(アプリ, 表, 書込の種類)だけで決まり、
   * 要求が画面を名乗ったかどうかを1ミリも見ない。** **したがって、その表を書き先とする
   * 名前つきの操作起点を1本も読めない相手は、この `form` の「保存」でも必ず 403 になる。**
   * **着手前はその相手にも保存ボタンが出ていた**(本タスクが `web/test/` の検査で実測した)。
   *
   * **種類は「いま何をするか」で決まる** —— **`recordId` が無ければ作成、あれば更新。**
   * **これは `handleSubmit` が `createRecord` / `updateRecord` を選ぶ条件とまったく同じである。**
   *
   * **判定は `src/server/owner-scope.ts` の壁の述語1本である**
   * (`canWriteTableActionRole` はその薄い包み。**述語の綴りをここに書かないのは、
   * `src/server/view-action-audience.test.ts` の (C-4b) が「その綴りが現れるファイルの集合」を
   * 4ファイルちょうどで固定しているからである** —— **綴りを書くと5ファイル目になって赤くなる。**
   * **`src/` は本タスクの担当外なので、期待値を動かさずに済む側を採った**)。
   * **壁を表示層に再実装していない。**
   *
   * **【誇張しない】** **壁を通っても書けるとは限らない**(固定ロールの層・個人スコープ・
   * 点の付与が今日どおり別に効く)。**遮断は今日もサーバである。**
   */
  const actionWallAllowsWrite = canWriteTableActionRole(
    role,
    manifest,
    view.table,
    recordId === undefined ? "create" : "update",
  );
  /** **2本の `AND`。** **どちらかが止めれば保存ボタンを出さない**(既存の「閲覧のみ」の注記に落ちる)。 */
  const canWrite = roleAllowsWrite && actionWallAllowsWrite;

  // **`audience` を書いた画面だけサーバに名乗る**(V4-M3-T04 / ADR-0070 限定3・限定4)。
  // **【`V8-M20` / `J-G27`】旧文の `audience` は撤去された。今日名乗る条件は「面の規則がその画面を名指ししているか」である。**
  // **effect の外で解決する** —— effect の依存は `view.table` の粒度のままにする。
  const namedViewId = viewIdForRecordRequest(manifest, view);

  // 新規作成なら空の値、編集なら既存レコードを初期値にする。
  useEffect(() => {
    if (recordId === undefined) {
      // 操作起点のプリフィル(EC-G14 / ADR-0045)は新規作成時だけ反映する。
      setState({ status: "ready", value: emptyValues(fields, prefill) });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    // **どの画面から読んでいるかをサーバに渡す**(V4-M3-T03 / `B-G1` / ADR-0070 限定3)。
    // **渡すのは `audience` を書いた画面だけである**(限定4)。
    // **【`V8-M20` / `J-G27`】旧文の `audience` は撤去された。今日名乗る条件は「面の規則がその画面を名指ししているか」である。**
    fetchRecord(appId, view.table, recordId, namedViewId).then(
      (row) => {
        if (!cancelled) {
          setVersion(row._updated_at);
          setState({ status: "ready", value: valuesFromRow(fields, row) });
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
  }, [appId, view.table, namedViewId, recordId, fields, prefill]);

  const handleChange = useCallback((fieldId: string, value: FieldInputValue) => {
    setState((previous) =>
      previous.status === "ready"
        ? { status: "ready", value: { ...previous.value, [fieldId]: value } }
        : previous,
    );
  }, []);

  const values = state.status === "ready" ? state.value : undefined;

  /**
   * **名簿の `account` 欄を「利用者を選ぶプルダウン」にする**(`UM-G2`。`V13-M1-T02`)。
   *
   * **解決はマニフェストの宣言だけから行う**(`accountFieldFor`)。名簿でない表では
   * `undefined` のままで、**利用者の一覧を1度も読まない。**
   *
   * **【画面に出ることを権限の担保にしていない】** 一覧が読めない立場では
   * `undefined` に倒れ、**着手前どおりのテキスト欄**になる —— 書込を止めているのは
   * サーバであって、この欄の見た目ではない。
   */
  const accountFieldId = accountFieldFor(manifest, view.table);
  const userAccountChoices = useUserAccountChoices(appId, accountFieldId !== undefined);

  /**
   * **付与表の「相手」の候補を、親の行に権限を持つ人へ絞る**(`Z-G27`。`V7-M6-T02`)。
   *
   * **【画面に出ないことを権限の担保にしていない】** —— **書込を止めているのはサーバ側の
   * `Z-G33`(`V7-M3-T04` / `src/server/access-control-grant-write.test.ts`)であって、
   * ここではない。** **候補に出さないことは、書込を止めることではない。**
   *
   * **足場が解けない画面(付与表でない / 親の宣言が無い)では `undefined` のままで、
   * 候補は今日と1バイトも変わらない。** 解決も絞り込みも `fields/input.tsx` の1本ずつに
   * 住んでいる —— **ここに規則を再実装しない。**
   */
  const grantScope = grantMemberScope(manifest, view.table);
  const grantTargetRecordId =
    grantScope === undefined || values === undefined
      ? ""
      : ((raw) => (typeof raw === "string" ? raw : ""))(values[grantScope.targetFieldId]);
  const permittedMemberIds = usePermittedGrantMemberIds(
    appId,
    manifest,
    view.table,
    grantTargetRecordId,
  );
  const scopedReferenceChoices = restrictReferenceChoices(
    referenceChoices,
    grantScope?.memberTableId,
    permittedMemberIds,
  );

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (values === undefined) {
        return;
      }
      setSubmitting(true);
      setSubmitErrors([]);
      setWriteForbidden(false);
      setWriteConflict(false);
      setApplyInProgress(false);
      const input = toRecordInput(fields, values);
      try {
        /*
         * **保存が成立した行1件の `_id`**(`V10-M2-T02` / `NV-G2` / `ADR-0357` 限定3b-1)。
         * **編集では今日どおり `recordId` そのものであり、新規作成では `createRecord` が
         * 返した行の `_id` である。**
         */
        let savedRecordId = recordId;
        if (recordId === undefined) {
          /*
           * **【`V10-M2-T02` / `NV-G2` / `ADR-0357` §Decision 2 で引き直した。旧文を1バイトも
           * 消していない】** **着手前この段は `await createRecord(appId, view.table, input);`
           * であり、直下の `navigate` に付いていたコメントの逐語は
           * 「**`V10-M2-T01`(`NV-G1`)で成立するのは編集経路だけである** —— **新規作成では
           * `recordId` が `undefined` なので、5番目の引数も `undefined` になり今日どおり
           * 何も運ばない。** **`createRecord` の戻り値を受けるのは `V10-M2-T02`(`NV-G2`)
           * である。**」だった。** **今日は偽である。**
           *
           * **受け取るのは行1件の `_id` だけである**(限定3b-1。行の他の列を1バイトも使わない)。
           * **`web/src/api.ts` は1バイトも触っていない** —— **`createRecord` は着手前から
           * 行を返していた**(`ADR-0357` §Context 1 の逐語「**受けていないのは呼び出し側である。**」)。
           * **失敗時の扱いも1バイトも変えていない**(限定3b-4)—— **投げれば今日どおり
           * 直下の `catch` に落ち、画面は移らない。**
           */
          const created = await createRecord(appId, view.table, input);
          savedRecordId = created._id;
        } else {
          // 編集画面では必ず fetchRecord 済みなので version は入っている。
          await updateRecord(appId, view.table, recordId, input, version ?? "");
        }
        /*
         * **`recordId` と `savedRecordId` を別々に渡すことが限定3b-2 の実装そのものである**
         * —— **既定の段2〜段4 は `recordId` だけを見るので、宣言が無い新規作成の行き先は
         * 今日どおり同じテーブルの `list_view` のままである。**
         * **`savedRecordId` を既定へ流すと `ADR-0102` 限定7 / §3a-6 を破る。**
         */
        navigate(afterSubmitRoute(appId, manifest, view, recordId, savedRecordId));
      } catch (reason: unknown) {
        // 状況ごとに文面を分ける。403(権限)・409(適用中)・409(版不一致)は専用表示、
        // それ以外は統一形式のエラーを該当箇所に出す(M9-T02)。
        if (isForbidden(reason)) {
          setWriteForbidden(true);
        } else if (isApplyInProgress(reason)) {
          setApplyInProgress(true);
        } else if (isWriteConflict(reason)) {
          setWriteConflict(true);
        } else {
          setSubmitErrors(toValidationErrors(reason));
        }
      } finally {
        setSubmitting(false);
      }
    },
    [appId, fields, manifest, recordId, values, version, view],
  );

  // マニフェストが壊れている場合は黙って隠さず、何が無いのかを出す(憲法6)。
  if (resolved.errors.length > 0) {
    return (
      <section data-testid="view-renderer-form" className="font-sans">
        <div data-testid="form-errors">
          <Alert variant="destructive">
            <ErrorList errors={resolved.errors} />
          </Alert>
        </div>
      </section>
    );
  }
  if (state.status === "loading") {
    // 地色と文字色は必ず対で書く(`ADR-0046` §3a の門に当たらないための条件)。
    return (
      <section
        data-testid="view-renderer-form"
        className="font-sans bg-background text-muted-foreground"
      >
        読み込み中…
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section data-testid="view-renderer-form" className="font-sans">
        <div data-testid="form-errors">
          <Alert variant="destructive">
            <ErrorList errors={state.errors} />
          </Alert>
        </div>
      </section>
    );
  }

  const grouped = groupErrorsByField(submitErrors, fields);
  const currentValues = state.value;

  /**
   * 画面の器に出すプリセット(`V4-M16-T11` / `ADR-0091` 限定3。**2軸だけ**)。
   *
   * **`DetailViewRenderer` の `fieldListPresets` と同型に書く** —— 段組数は `String()` で
   * 文字列にする(属性値は文字列である)。**書かなかった画面には属性を1つも出さない**
   * (当たり先の無い属性を DOM に置かない = `ADR-0050` 限定1 の精神。限定6 の
   * 「書かなかった form は今日と1ピクセルも変わらない」はこの形で担保する)。
   *
   * **値は `view` から読む** —— **`ViewRendererProps` に props を1つも足さない**
   * (`web/test/preset-boundary.test.ts` の (v) が5つちょうどを固定している)。
   */
  const formPresets = {
    ...(view.preset_label_placement !== undefined
      ? { "data-preset-label": view.preset_label_placement }
      : {}),
    ...(view.preset_field_columns !== undefined
      ? { "data-preset-columns": String(view.preset_field_columns) }
      : {}),
  };

  /**
   * **段の器を挟むか**(軸5)。
   *
   * **`.record-form` は `<form>` であり、直下に項目以外の子(送信ボタン・エラー表示・
   * 書込不可の注記)を持つ。** `display: grid` を `<form>` 自身に掛けると**送信ボタンまで
   * 段に入る**(実測)ので、**項目だけを包む器を1つ挟み、CSS はその器に当てる。**
   *
   * **器を出すのは段組数を書いた form だけである** —— 常に出すと、プリセットを書かない
   * form の DOM が変わってしまう(限定6 に触れる)。**器を出さない画面では当たる規則が
   * 1つも無いので、器の有無で描画は変わらない。**
   */
  const fieldNodes = fields.map((field) => {
    const inputId = `${view.id}-${field.id}`;
    const fieldErrors = grouped.byId.get(field.id) ?? [];
    return (
      // **狭い画面では縦**(項目名 → 入力欄 → エラー)。**`sm:` 以上では幅を戻す**
      // —— 入力部品の `w-full` が窓幅いっぱいに伸びるのを止める(`D-V4-44`)。
      <div className={cn("field", "flex flex-col gap-s1 sm:max-w-md")} key={field.id}>
        <Label htmlFor={inputId} data-testid={`field-label-${field.id}`}>
          {field.name}
          {field.required === true && (
            <span className="required" data-testid={`required-${field.id}`}>
              必須
            </span>
          )}
        </Label>
        <FieldInput
          field={field}
          inputId={inputId}
          value={currentValues[field.id] ?? ""}
          onChange={(value) => handleChange(field.id, value)}
          referenceChoices={scopedReferenceChoices}
          appId={appId}
          // **画面ごとの「選び方」の上書きを届ける**(`K-G2`。`V6-M4-T01`)——
          // **解決は `resolveReferencePicker` の1関数だけが行う。**
          view={view}
          // **参照先テーブルの「探せる項目」を引くために要る**(`K-G9` / `K-G11`)——
          // **`type_filter` の項目でだけ使われる。**
          manifest={manifest}
          // **エラーがある欄にだけ `aria-invalid` が付く**(`V4-M15-T14` の一部)。
          // 判定はここ(`groupErrorsByField` の結果)1箇所だけである。
          invalid={fieldErrors.length > 0}
          // **渡すのは名簿の `account` 欄ちょうど1つだけである**(`UM-G2`)——
          // **他の `text` 項目の DOM は1バイトも変わらない。**
          userAccountChoices={field.id === accountFieldId ? userAccountChoices : undefined}
        />
        {fieldErrors.length > 0 && (
          <div data-testid={`field-error-${field.id}`}>
            {/* 本文は `ErrorList` のまま。ここは器だけを足す。 */}
            <Alert variant="destructive">
              <ErrorList errors={fieldErrors} />
            </Alert>
          </div>
        )}
      </div>
    );
  });

  return (
    <section data-testid="view-renderer-form" className="font-sans">
      {/* noValidate: ブラウザ組み込みの検証も使わない(上のコメントの理由と同じ)。 */}
      <form
        className={cn(
          // **既存クラスを消さずに足す。** `web/src/styles.css` の `.record-form` が当たり続ける。
          "record-form",
          "flex flex-col gap-s3 rounded-ui p-s4",
          "bg-background text-foreground",
        )}
        noValidate
        onSubmit={handleSubmit}
        {...formPresets}
      >
        {view.preset_field_columns === undefined ? (
          fieldNodes
        ) : (
          <div className="form-fields">{fieldNodes}</div>
        )}
        {grouped.rest.length > 0 && (
          <div data-testid="form-errors">
            <Alert variant="destructive">
              <ErrorList errors={grouped.rest} />
            </Alert>
          </div>
        )}
        {writeForbidden && <WriteForbidden />}
        {writeConflict && <WriteConflict />}
        {applyInProgress && <ApplyInProgress />}
        {/* viewer は保存できない。書込ボタンを出さず「閲覧のみ」を明示する(先回りガード)。 */}
        {canWrite ? (
          // **送信中は押せない。** `disabled` の体裁(不透明度・カーソル)は部品側が持つ。
          // 狭い画面では幅いっぱい、`sm:` 以上は従来どおりの内容幅(`D-V4-44`)。
          //
          // **`render` で `type="submit"` を渡す。** `Button` の既定は
          // `<button type="button" />` で、**`props` の側に `type` を書いても既定が勝つ**
          // (`useRender` の合成順。実測した)—— そのままだと form の submit が起きず、
          // 保存が1件も飛ばなくなる。**`render` を使うのはそのためであって、見た目のためではない。**
          <Button
            render={<button type="submit" />}
            disabled={submitting}
            className="w-full sm:w-auto"
          >
            保存
          </Button>
        ) : (
          <p
            className={cn("read-only-note", "text-note text-muted-foreground")}
            data-testid="form-read-only"
          >
            閲覧のみ(書き込み権限がありません)。
          </p>
        )}
      </form>
    </section>
  );
}

// --- マニフェストの解釈 ----------------------------------------------------------

/**
 * `view.fields` に並んだIDを、対象テーブルの `Field` に**その順序のまま**解決する。
 * 解決できないものは無視せずエラーとして返す。
 */
function resolveFields(
  manifest: Manifest,
  view: FormView,
  table: Table | undefined,
): { fields: Field[]; errors: ValidationError[] } {
  if (table === undefined) {
    return {
      fields: [],
      errors: [
        {
          path: "",
          message: `テーブル "${view.table}" はこのアプリのマニフェストにありません。`,
          allowed_values: manifest.app.tables.map((candidate) => candidate.id),
        },
      ],
    };
  }
  const fields: Field[] = [];
  const errors: ValidationError[] = [];
  for (const fieldId of view.fields) {
    const field = table.fields.find((candidate) => candidate.id === fieldId);
    if (field === undefined) {
      errors.push({
        path: `/${fieldId}`,
        message: `フィールド "${fieldId}" はテーブル "${table.id}" に存在しません。`,
        allowed_values: table.fields.map((candidate) => candidate.id),
      });
      continue;
    }
    fields.push(field);
  }
  return { fields, errors };
}

/**
 * 新規作成時の初期値。`boolean` だけ偽、それ以外は空文字(= 未設定)。
 *
 * `prefill`(EC-G14 / ADR-0045)があれば、指定された**参照フィールド1つ**に開いている
 * レコードの `_id` を初期値として入れる(「この商品をカートに入れる」)。ユーザは変更できる
 * (埋めるだけで固定しない)。**対象フィールドが form に出ている reference のときだけ反映**し、
 * 他型・不在フィールドには黙って入れない —— カーネルは参照フィールドにしか `_id` を受けず、
 * 表示できない値をこっそり握らせない(憲法6)。プリフィルは1つに固定なので複数は写さない。
 */
function emptyValues(fields: Field[], prefill?: RoutePrefill): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    values[field.id] = field.type === "boolean" ? false : "";
  }
  if (prefill !== undefined) {
    const target = fields.find((field) => field.id === prefill.field);
    if (target !== undefined && target.type === "reference") {
      values[prefill.field] = prefill.value;
    }
  }
  return values;
}

/** 既存レコードを入力欄の値に写す(`null` は未設定)。 */
function valuesFromRow(fields: Field[], row: RecordRow): FormValues {
  const values: FormValues = {};
  for (const field of fields) {
    const value = row[field.id];
    if (field.type === "boolean") {
      values[field.id] = value === true;
      continue;
    }
    values[field.id] = value === null || value === undefined ? "" : String(value);
  }
  return values;
}

/**
 * 入力欄の値を API に送る形へ写す。
 *
 * ここでやるのは**型の写し替えだけ**で、妥当性の判定はしない:
 * - 空文字は「未設定」なので `null`(required 違反かどうかはカーネルが決める)
 * - `number` は数値として読めれば数値、読めなければ**打たれた文字列のまま**送る。
 *   フロントで握り潰すと、カーネルが返すはずの「型が違う」というエラーが利用者に
 *   届かなくなるため。
 */
function toRecordInput(fields: Field[], values: FormValues): RecordInput {
  const input: RecordInput = {};
  for (const field of fields) {
    const value = values[field.id];
    switch (field.type) {
      case "boolean":
        input[field.id] = value === true;
        break;
      case "number": {
        const text = typeof value === "string" ? value.trim() : "";
        if (text === "") {
          input[field.id] = null;
          break;
        }
        const parsed = Number(text);
        input[field.id] = Number.isNaN(parsed) ? text : parsed;
        break;
      }
      case "text":
      case "long_text":
      case "date":
      case "select":
      case "reference":
      // image / file 値は file_id 文字列(V2-M2 / ADR-0035 / V5-M16 / ADR-0161)。
      // 他の TEXT 系と同じく文字列として運ぶ。
      case "image":
      case "file": {
        const text = typeof value === "string" ? value : String(value);
        input[field.id] = text === "" ? null : text;
        break;
      }
    }
  }
  return input;
}

/**
 * 統一形式エラーを「フィールドに紐づくもの」と「そうでないもの」に振り分ける。
 *
 * レコード書き込みのエラー `path` は**レコード本体を根とする JSON Pointer**で、
 * フィールド単位の違反は `/<field_id>` の1階層になる(`src/kernel/records.ts` の
 * `validateInput` / `validateFieldValue`、および `src/server/app.test.ts` の
 * 期待値 `"/name"` `"/quantity"` で確認済み)。テーブル不在・レコード不在などの
 * フィールドに紐づかない違反は `path` が空文字になる。
 */
function groupErrorsByField(
  errors: ValidationError[],
  fields: Field[],
): { byId: Map<string, ValidationError[]>; rest: ValidationError[] } {
  const shown = new Set(fields.map((field) => field.id));
  const byId = new Map<string, ValidationError[]>();
  const rest: ValidationError[] = [];
  for (const error of errors) {
    const fieldId = error.path.startsWith("/") ? error.path.slice(1) : "";
    // form に出ていないフィールドのエラーを握り潰さないよう、表示中のものだけ紐づける。
    if (fieldId !== "" && shown.has(fieldId)) {
      const bucket = byId.get(fieldId);
      if (bucket === undefined) {
        byId.set(fieldId, [error]);
      } else {
        bucket.push(error);
      }
      continue;
    }
    rest.push(error);
  }
  return { byId, rest };
}

/**
 * 保存に成功したあとの行き先。
 *
 * - **`view.after_save` が書かれていて、その画面がこのマニフェストに在れば、そこへ行く**
 *   (`E-G34` / `V4-M20-T04` / `ADR-0102`)。
 * - 既存レコードの編集で、同じテーブルの `detail_view` があれば**そのレコードの詳細**へ。
 *   利用者は詳細から編集に来ているので、来た場所に戻すのが素直であり、保存結果が
 *   そのまま確認できる。
 * - それ以外(新規作成、または detail_view が無い)は同じテーブルの `list_view` へ。
 * - どちらも無ければそのアプリのビュー一覧へ。
 *
 * 行き先は**マニフェストから導く**ので、遷移先の設定という語彙は増えない。
 *
 * > **【V4-M20-T04 / ADR-0102 で、直上の1文は偽になった。1バイトも消していない】**
 * > **`ADR-0102` §S3 (b) が「本 ADR はこの文を偽にする」と自ら名指ししている**(Δ5)。
 * > **今日は「宣言があればそれ、無ければマニフェストから導く」である。**
 * > **宣言が無い form の挙動は1文字も変わっていない**(限定7)—— 下の3段の既定は無傷である。
 *
 * ## 宣言があっても倒れる場合(**壊れないことを1つに決めた。`ADR-0102` 限定8**)
 *
 * **指した画面がこのマニフェストに無ければ、既定の3段へ倒す。**
 * **実在しないIDは `referential-integrity.ts` が apply 時に倒しているので、ここに来るのは
 * 「`audience` によってこの人には配られなかった画面」である**(`ADR-0070` 限定3。サーバは
 * 見えない画面をマニフェストから落として配る)。**その人だけが既定へ倒れる。**
 * **エラーは出さない** —— 保存は成立しており、行き先が見えないことは保存の失敗ではない。
 *
 * ## 1ミリも解いていないこと
 *
 * - **成功 / 失敗で行き先を分けられない**(限定4)—— ここに来るのは成功したときだけである。
 * - **確認の段を1バイトも作っていない**(限定5。`E-G33`)。
 * - **【`V10-M2-T01` / `NV-G1` / `ADR-0357` 限定3a-2 で引き直した。旧文を1バイトも消していない】**
 *   **着手前の逐語は「**`recordId` を持ち回す先を宣言できない** —— **宣言した行き先へは
 *   `recordId` を渡さない**(下の既定の1段目だけが渡す)。**「保存した行の詳細へ」を宣言で
 *   選ぶことはできない** —— それは今日も既定の1段目の役目である。」だった。**
 *   **今日は偽である** —— **宣言した行き先がその `form` と同じテーブルの `detail_view` の
 *   ときだけ、保存が成立した行1件の `_id` を渡す。**
 *   **それ以外の行き先(別テーブルの `detail_view` / `list_view` / `report_view` / `form`)へは
 *   今日どおり1バイトも渡さない。**
 *   **運ぶのは `_id` 1本だけである**(限定3a-1。入力値も下書きも他の列も1バイトも運ばない)。
 *   **別テーブルの詳細を指した宣言は直していない**(限定3a-2。**どの行を開くかを読む場所が
 *   マニフェストに1つも無い**)—— **利用者は今日どおりエラー画面を見る。**
 * - **【`V10-M4-T02` / `NV-G9` / `NV-G11` / `ADR-0359` §4b / `ADR-0360` で引き直した。
 *   旧文を1バイトも消していない】**
 *   **上の「確認の段を1バイトも作っていない(限定5。`E-G33`)」は今日は偽である** ——
 *   **`ADR-0360` が `flow.kind` に `"confirm"` を通し、`V10-M4-T01` がスキーマに入れた。**
 *   **ただしこの関数が確認の段を作るわけではない** —— **ここが読むのは `flow` の並びだけで、
 *   確認の段は `detail_view` の側にしか置けない**(`ADR-0360` 限定2)。
 *   **`form` は「保存が成立したら次の段へ行く」であり、そのとき次の段が確認の段でも
 *   扱いは同じである**(行き先が `detail_view` なら、同じ表のときだけ `_id` を運ぶ)。
 *   **確認の段が「確定」したあとに次へ進む経路は、今日もこのファイルに1バイトも無い**
 *   (`V10-M4-T03` の担当)。
 */
function afterSubmitRoute(
  appId: string,
  manifest: Manifest,
  view: FormView,
  recordId: string | undefined,
  /**
   * **保存が成立した行1件の `_id`**(`V10-M2-T01` / `ADR-0357`)。
   *
   * **`recordId` と別の引数に割ってある** —— **既定の段2〜段4 は `recordId` だけを見る。**
   * **こちらを既定へ流すと新規作成の既定の行き先が動き、`ADR-0102` 限定7 / §3a-6 を破る。**
   * **使うのは直下の宣言分岐だけである。**
   */
  savedRecordId: string | undefined,
) {
  /*
   * **【`V10-M4-T02` / `NV-G9` / `ADR-0359` §4b 限定5】一続きの流れの段。**
   *
   * **規則は1本だけである**(限定5 の逐語):「**段の宣言がある画面では段の並びが効き、
   * 無ければ今日どおりの規約に倒れる**」。**したがって分岐は `after_save` より**前**に
   * 立つ** —— **`after_save` と `flow` の両方を書いた画面では段が勝つ**(`V10-M4` の決4)。
   *
   * **`after_save` の定義も、下の既定の段2〜段4 も1バイトも書き換えていない**
   * (`ADR-0102` 限定7 / §3a-6 不可侵)。**足したのはこの分岐1本だけである。**
   * **段を宣言していない `form` の挙動は今日と1文字も変わらない**
   * (`flowNextRoute` が `undefined` を返し、そのまま下へ落ちる)。
   *
   * **段が解けなければ倒れる**(`undefined` が返る場合 = 段を書いていない / 最後の段 /
   * 次の位置の画面がこのマニフェストに居ない)—— **ボタンの側(`ViewHost`)が
   * fail-closed で「出さない」のとは逆向きである。** **押す前に解決できるか否かで
   * 使い分けている** —— **ここへ来た時点で保存は既に成立しており、行き先が解けない
   * ことは保存の失敗ではない。**
   *
   * **行を運ぶのは `savedRecordId` の側である**(`recordId` ではない)——
   * **既定の段2〜段4 は今日どおり `recordId` だけを見る。**
   * **運ぶ線(`_id` 1件だけ / 同じ表の `detail_view` に限る)は `ADR-0357` 限定1・限定2
   * と同じだが、発火点が保存以外にも増えるので**規則の拡張**である**(点検 `B-3`)。
   * **`ViewHost` の「次へ」は保存を伴わずに同じ線で行を運ぶ。**
   */
  const flowRoute = flowNextRoute(appId, manifest, view, savedRecordId);
  if (flowRoute !== undefined) {
    return flowRoute;
  }
  if (view.after_save !== undefined) {
    const declared = manifest.app.views.find((candidate) => candidate.id === view.after_save);
    if (declared !== undefined) {
      // **`ADR-0357` 限定3a-2**: 同じテーブルの `detail_view` のときだけ、成立した行を運ぶ。
      if (
        declared.type === "detail_view" &&
        declared.table === view.table &&
        savedRecordId !== undefined
      ) {
        return { kind: "view", appId, viewId: declared.id, recordId: savedRecordId } as const;
      }
      return { kind: "view", appId, viewId: declared.id } as const;
    }
  }
  if (recordId !== undefined) {
    // 遷移先の決め方(定義順の先頭)は `navigation.tsx` に1つだけある。ここに再実装しない。
    const detail = resolveDetailViewTarget(manifest, view.table);
    if (detail !== undefined) {
      return { kind: "view", appId, viewId: detail.id, recordId } as const;
    }
  }
  const list = manifest.app.views.find(
    (candidate) => candidate.type === "list_view" && candidate.table === view.table,
  );
  return list === undefined
    ? ({ kind: "app", appId } as const)
    : ({ kind: "view", appId, viewId: list.id } as const);
}
