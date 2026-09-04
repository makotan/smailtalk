/**
 * 逃げ道(任意 CSS)の資産の発行画面(owner 限定・V3-M5-T03 / D-G5。ADR-0055)。
 *
 * **`ConnectionAdmin.tsx` の隣に置く同型の画面である**(計画 §2 の T03 行が置き場を
 * 名指ししている)。3セクションの構成も同じ:
 *   (A) 未承認の申請 …… `GET /escape-hatch-assets/requests`。各申請を「承認して発行」で
 *        発行フォームへプレフィルする(requestedName / suggestedScopeViews / requestId)。
 *        **CSS の本文はプレフィルされない** —— 申請は本文を運ばないからである(限定5)。
 *   (B) 発行フォーム …… name / css / scopeViews(カンマ・改行区切り)。送信で
 *        `POST /escape-hatch-assets`。400/409 はサーバの統一文面をそのまま出す。
 *   (C) 発行済み資産 …… `GET /escape-hatch-assets`。各行を「失効」で `DELETE …/:id`。
 *
 * ## **この画面は owner 限定の担保ではない**(計画 §1-1 の3点目。必ず読むこと)
 *
 * 導線(`AppWorkspace` の `open-escape-hatch-admin`)は owner のときだけ出るが、
 * **出さないことは遮断ではない。** 担保はサーバ側の `requireOwner`
 * (`src/server/auth-routes.ts` の `withEscapeHatchStore` / `POST` ハンドラ)であり、
 * **この画面を迂回して同じ URL を直接叩いても 403 になる。** その実測は
 * `web/e2e/escape-hatch.e2e.ts`(editor のセッションで直接 POST/DELETE/GET する)と
 * `src/server/escape-hatch-issuance.test.ts` にある。**UI の出し分けは先回りであって
 * 最終防衛線ではない** —— 同じ区別を `ConnectionAdmin.tsx` も自分のヘッダに書いている。
 *
 * ## CSS を1バイトも解釈しない(ADR-0055 限定8 / 憲法1)
 *
 * この画面は本文をそのまま送るだけである。**許可リストも拒否リストも構文検査も持たない。**
 * 検査するのは「空でないこと」と、**資産名がマニフェストから参照できる形かどうか**の2点だけ
 * (後者の理由は下の `isReferenceableAssetName` を読むこと)。
 *
 * ## 【V4-M15-T14】部品体系で組み直した(`ADR-0087` / `ADR-0089`)
 *
 * **文言も `data-testid` も1バイトも変えていない。** **`ConnectionAdmin.tsx` と同じ形で
 * ある**(同型の画面なので、器の当て方も同じにした):入力欄を `Input` / `Textarea`、
 * ラベルを `Label htmlFor` + `id` の対、操作を `Button`、発行の失敗
 * (`escape-hatch-issue-error`)を `Alert variant="destructive"`、読み込み中に `Skeleton`、
 * 発行済み資産の表を `TableFrame`(`overflow-x-auto`)で包んだ(`D-V4-44`。
 * **`class="escape-hatch-table"` は `<table>` に残してある**)。
 *
 * **CSS の本文を1バイトも解釈していない**(上の節の主張は1ミリも動いていない)。
 */
import { useCallback, useEffect, useState } from "react";
import {
  type EscapeHatchAssetRequest,
  type EscapeHatchAssetSummary,
  issueEscapeHatchAsset,
  listEscapeHatchAssetRequests,
  listEscapeHatchAssets,
  revokeEscapeHatchAsset,
} from "../api.ts";
import { type AsyncState, toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { Button } from "../ui/button.tsx";
import { Input, Label, Textarea } from "../ui/form-controls.tsx";
import { Alert, Card, Skeleton } from "../ui/surfaces.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table.tsx";
import { cn } from "../ui/utils.ts";

/**
 * 読み込み中の骨組み(`V4-M15-T14`)。**文言は1文字も変えていない。**
 *
 * **`ConnectionAdmin.tsx` の同名の関数と同じ形である** —— **共通化していない**のは、
 * 2つの画面が別ファイルとして同型を保つ既存の作法(冒頭の「隣に置く同型の画面」)に
 * 合わせたためである。**同型であることは、両方を読めば分かるようにしてある。**
 */
function LoadingRows() {
  return (
    <div className={cn("flex flex-col gap-s2")}>
      <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
      {["row-1", "row-2"].map((slot) => (
        <Skeleton key={slot} className="h-6 w-full" />
      ))}
    </div>
  );
}

/**
 * 資産名がマニフェストの参照キーから指せる形か(`$defs/resource_id` と同じ形)。
 *
 * **なぜ UI が見るのか**: 発行側(`POST /escape-hatch-assets`)は名前の**形**を検査して
 * いないが、参照側(`$defs/view.custom_css.asset`)は `$defs/resource_id` を `$ref` して
 * いる。したがって `Print Layout` のような名前でも**発行は成功し、しかしマニフェストから
 * 永久に参照できない**(発行できたのに1ピクセルも変わらない)。これは
 * `docs/plan/v3/records/v3-m5-t02.md` §6 の4 / §7 の申し送り3 が名指しした食い違いである。
 *
 * **これは根本の修正ではない。** 根本は発行側(`src/kernel/escape-hatch-store.ts` /
 * `src/server/auth-routes.ts`)に検査を置くことであり、**それは V3-M5-T01 の変更予定
 * ファイルなので本タスクは触らない**(判断と申し送りは `v3-m5-t03.md`)。**したがって
 * 規約の綴りがここにもう1箇所住んだことになる** —— 隠さずに書く。層をまたいで
 * `src/kernel/resource-id.ts` を**値として** import する道は採らなかった(ADR-0009 限定2 が
 * 「値として import してよいのは `normalizeSort` の1本だけ」と定めており、2本目を作るには
 * 門を通す必要がある)。
 */
function isReferenceableAssetName(name: string): boolean {
  return /^[a-z][a-z0-9_-]*$/.test(name) && name.length <= 64;
}

/** 作用域のテキスト(カンマ・改行区切り)を画面IDの配列に。空要素は落とす。 */
function parseScopeViews(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((viewId) => viewId.trim())
    .filter((viewId) => viewId !== "");
}

export function EscapeHatchAdmin({ appId, onClose }: { appId: string; onClose?: () => void }) {
  const [requestsState, setRequestsState] = useState<AsyncState<EscapeHatchAssetRequest[]>>({
    status: "loading",
  });
  const [assetsState, setAssetsState] = useState<AsyncState<EscapeHatchAssetSummary[]>>({
    status: "loading",
  });

  // 発行フォームの入力。承認導線からプレフィルされる(**css だけは決してされない**)。
  const [name, setName] = useState("");
  const [css, setCss] = useState("");
  const [scopeText, setScopeText] = useState("");
  const [requestId, setRequestId] = useState<string | undefined>(undefined);

  /** 発行の失敗文面(サーバの 400/409、または送る前の先回り)。成功でクリアする。 */
  const [issueError, setIssueError] = useState<string | null>(null);
  /** 発行を送信中(二重送信を防ぐ)。 */
  const [issuing, setIssuing] = useState(false);
  /** 失効を送信中の資産ID(その行のボタンを一時的に無効化する)。 */
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadRequests = useCallback(() => {
    setRequestsState({ status: "loading" });
    listEscapeHatchAssetRequests(appId).then(
      (value) => setRequestsState({ status: "ready", value }),
      (reason: unknown) =>
        setRequestsState({ status: "error", errors: toValidationErrors(reason) }),
    );
  }, [appId]);

  const loadAssets = useCallback(() => {
    setAssetsState({ status: "loading" });
    listEscapeHatchAssets(appId).then(
      (value) => setAssetsState({ status: "ready", value }),
      (reason: unknown) => setAssetsState({ status: "error", errors: toValidationErrors(reason) }),
    );
  }, [appId]);

  useEffect(() => {
    loadRequests();
    loadAssets();
  }, [loadRequests, loadAssets]);

  /**
   * 申請を承認 → 発行フォームに requestedName / suggestedScopeViews / requestId をプレフィル。
   * **css は空のままにする**(申請が本文を運ばないので、埋める材料が無い。限定5)。
   */
  const prefillFromRequest = useCallback((request: EscapeHatchAssetRequest) => {
    setName(request.requestedName);
    setScopeText(request.suggestedScopeViews.join(", "));
    setRequestId(request.id);
    setIssueError(null);
  }, []);

  const issue = useCallback(async () => {
    const scopeViews = parseScopeViews(scopeText);
    // --- 送る前の先回り(サーバの検査を写しているのではなく、**送っても無駄な形**を止める)---
    if (!isReferenceableAssetName(name)) {
      setIssueError(
        "資産名は英小文字で始まり、英小文字・数字・ハイフン・アンダースコアだけの1〜64文字にしてください。" +
          "この形でないと発行はできてもマニフェストの画面から参照できません(永久に当たりません)。",
      );
      return;
    }
    if (css === "") {
      setIssueError("CSS の本文が空です。当てたい内容を書いてください。");
      return;
    }
    if (scopeViews.length === 0 || scopeViews.includes("*")) {
      setIssueError(
        '作用域(この資産を当ててよい画面)を1つ以上指定してください。ワイルドカード "*" や空の宣言は受け付けません。',
      );
      return;
    }

    setIssuing(true);
    setIssueError(null);
    try {
      await issueEscapeHatchAsset(appId, {
        name,
        css,
        scopeViews,
        ...(requestId !== undefined ? { requestId } : {}),
      });
      // 成功。フォームをたたみ、両一覧を取り直す(締めた申請が消え、発行済みに増える)。
      setName("");
      setCss("");
      setScopeText("");
      setRequestId(undefined);
      loadRequests();
      loadAssets();
    } catch (reason: unknown) {
      // 400/409 はサーバの統一文面をそのまま出す(フロントで作り直さない)。
      setIssueError(
        toValidationErrors(reason)
          .map((error) => error.message)
          .join(" / "),
      );
    } finally {
      setIssuing(false);
    }
  }, [appId, name, css, scopeText, requestId, loadRequests, loadAssets]);

  const revoke = useCallback(
    async (assetId: string) => {
      setRevokingId(assetId);
      try {
        await revokeEscapeHatchAsset(appId, assetId);
        loadAssets();
      } finally {
        setRevokingId(null);
      }
    },
    [appId, loadAssets],
  );

  return (
    <Card className={cn("escape-hatch-admin")} data-testid="escape-hatch-admin">
      <header
        className={cn(
          "escape-hatch-admin-header",
          "flex flex-wrap items-center justify-between gap-s2",
        )}
      >
        <h3 className={cn("m-0")}>逃げ道(任意 CSS)の管理</h3>
        {onClose !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="close-escape-hatch-admin"
            onClick={onClose}
          >
            閉じる
          </Button>
        )}
      </header>

      {/*
       * **画面自身が「UI は担保ではない」と書く。**owner 限定を守っているのはサーバである。
       * ここに書くのは、この画面を読んだ人が「導線を隠したから安全」と読まないためである。
       */}
      <p
        data-testid="escape-hatch-guard-note"
        role="note"
        className={cn("m-0", "text-note text-muted-foreground")}
      >
        この画面は owner にだけ出しています。ただし、出し分けは先回りであって遮断ではありません ——
        発行と失効を owner に限っているのはサーバ側の検査で、画面を迂回して同じ URL を直接 叩いても
        owner 以外は 403 になります。AI(MCP)は申請までしかできず、CSS の本文を
        書き込める経路はこの発行フォームが叩く1本だけです。
      </p>

      {/* (A) 未承認の申請 */}
      <div className={cn("escape-hatch-requests", "flex flex-col gap-s2")}>
        <h4 className={cn("m-0")}>AI が出した未承認の申請</h4>
        {requestsState.status === "loading" && <LoadingRows />}
        {requestsState.status === "error" && <ErrorList errors={requestsState.errors} />}
        {requestsState.status === "ready" &&
          (requestsState.value.length === 0 ? (
            <p
              data-testid="escape-hatch-requests-empty"
              className={cn("m-0", "text-muted-foreground")}
            >
              未承認の申請はありません。
            </p>
          ) : (
            <ul className={cn("escape-hatch-request-list", "flex flex-col gap-s2")}>
              {requestsState.value.map((request) => (
                <li
                  key={request.id}
                  className={cn(
                    "escape-hatch-request-row",
                    "flex flex-col gap-s1 sm:flex-row sm:flex-wrap sm:items-center",
                  )}
                  data-testid="escape-hatch-request-row"
                  data-request-id={request.id}
                >
                  <span className={cn("escape-hatch-request-name", "font-medium")}>
                    {request.requestedName}
                  </span>
                  <span className={cn("escape-hatch-request-purpose", "text-note")}>
                    {request.purpose}
                  </span>
                  <span
                    className={cn("escape-hatch-request-scope", "text-note text-muted-foreground")}
                  >
                    {request.suggestedScopeViews.join(", ")}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full sm:w-auto"
                    data-testid="approve-escape-hatch-request"
                    onClick={() => prefillFromRequest(request)}
                  >
                    承認して発行
                  </Button>
                </li>
              ))}
            </ul>
          ))}
      </div>

      {/* (B) 発行フォーム */}
      <form
        className={cn("escape-hatch-issue-form", "flex flex-col gap-s2")}
        data-testid="escape-hatch-issue-form"
        onSubmit={(event) => {
          event.preventDefault();
          void issue();
        }}
      >
        <h4 className={cn("m-0")}>逃げ道を発行</h4>
        {issueError !== null && (
          <Alert
            variant="destructive"
            className={cn("escape-hatch-issue-error")}
            data-testid="escape-hatch-issue-error"
          >
            {issueError}
          </Alert>
        )}

        <div className={cn("escape-hatch-field", "flex flex-col gap-s1")}>
          <Label htmlFor="escape-hatch-name-input">資産名</Label>
          <Input
            id="escape-hatch-name-input"
            type="text"
            data-testid="escape-hatch-name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className={cn("escape-hatch-field", "flex flex-col gap-s1")}>
          <Label htmlFor="escape-hatch-css-input">CSS の本文</Label>
          <Textarea
            id="escape-hatch-css-input"
            data-testid="escape-hatch-css-input"
            value={css}
            onChange={(event) => setCss(event.target.value)}
          />
        </div>
        <p
          className={cn("escape-hatch-css-hint", "m-0 text-note text-muted-foreground")}
          data-testid="escape-hatch-css-hint"
        >
          本文を書くのは owner です(AI の申請には本文が含まれません)。内容は解釈も検査もされず、
          そのまま保存されます。当たるのは指定した画面の中だけで、外枠(シェル)には既定で
          漏れません。
        </p>

        <div className={cn("escape-hatch-field", "flex flex-col gap-s1")}>
          <Label htmlFor="escape-hatch-scope-input">
            作用域 = 当ててよい画面ID(カンマまたは改行区切り)
          </Label>
          <Textarea
            id="escape-hatch-scope-input"
            data-testid="escape-hatch-scope-input"
            value={scopeText}
            onChange={(event) => setScopeText(event.target.value)}
          />
        </div>
        <p
          className={cn("escape-hatch-scope-hint", "m-0 text-note text-muted-foreground")}
          data-testid="escape-hatch-scope-hint"
        >
          当ててよい画面を1つずつ書いてください。空にすると発行できません(全画面許可という
          指定は用意していません)。宣言していない画面では、参照が書かれていても配信が拒否されます。
        </p>

        <Button
          type="submit"
          variant="secondary"
          className="w-full sm:w-auto"
          data-testid="issue-escape-hatch"
          disabled={issuing}
        >
          発行
        </Button>
      </form>

      {/* (C) 発行済み資産 */}
      <div className={cn("escape-hatch-list", "flex flex-col gap-s2")}>
        <h4 className={cn("m-0")}>発行済みの逃げ道</h4>
        {assetsState.status === "loading" && <LoadingRows />}
        {assetsState.status === "error" && <ErrorList errors={assetsState.errors} />}
        {assetsState.status === "ready" &&
          (assetsState.value.length === 0 ? (
            <p
              data-testid="escape-hatch-assets-empty"
              className={cn("m-0", "text-muted-foreground")}
            >
              発行済みの逃げ道はありません。
            </p>
          ) : (
            // **表は横に溢れうるので包む**(`D-V4-44`)—— ダイジェストは長い。
            // **`class` は `<table>` に残す。**
            <TableFrame>
              <Table className={cn("escape-hatch-table")}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="px-s2 py-s1">
                      資産名
                    </TableHead>
                    <TableHead scope="col" className="px-s2 py-s1">
                      内容ダイジェスト(sha256)
                    </TableHead>
                    <TableHead scope="col" className="px-s2 py-s1">
                      作用域
                    </TableHead>
                    <TableHead scope="col" className="px-s2 py-s1" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assetsState.value.map((asset) => (
                    <TableRow
                      key={asset.id}
                      className={cn("escape-hatch-row")}
                      data-testid="escape-hatch-row"
                      data-asset-id={asset.id}
                      data-asset-name={asset.name}
                      data-asset-digest={asset.digest}
                    >
                      <TableCell data-testid="escape-hatch-row-name" className="px-s2 py-s1">
                        {asset.name}
                      </TableCell>
                      {/*
                       * **ダイジェストを画面に出す。**マニフェストの参照は資産名と
                       * この値の2要素で書くので、出さないと参照が書けない(名前だけでは
                       * 版が決まらない —— 同名で内容の違う版が並ぶ形だからである)。
                       * **CSS の本文はここに出ない**(サーバが一覧では返さない)。
                       */}
                      <TableCell data-testid="escape-hatch-row-digest" className="px-s2 py-s1">
                        {asset.digest}
                      </TableCell>
                      <TableCell data-testid="escape-hatch-row-scope" className="px-s2 py-s1">
                        {asset.scopeViews.join(", ")}
                      </TableCell>
                      <TableCell className="px-s2 py-s1">
                        <Button
                          size="sm"
                          variant="destructive"
                          data-testid="revoke-escape-hatch"
                          disabled={revokingId === asset.id}
                          onClick={() => {
                            void revoke(asset.id);
                          }}
                        >
                          失効
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableFrame>
          ))}
      </div>
    </Card>
  );
}
