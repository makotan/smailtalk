/**
 * 接続(capability)発行画面(owner 限定・V1-M4-T04 / ADR-0020)。
 *
 * owner が「AI が出した接続の申請」をレビューし、許可ホストと secret の**取得元**を指定して
 * 接続を発行する。3セクション:
 *   (A) 未承認の申請 …… `GET /connections/requests`。各申請を「承認して発行」で発行フォームへ
 *        プレフィルする(requestedName / suggestedHosts / requestId)。
 *   (B) 発行フォーム …… name / allowedHosts(カンマ・改行区切り)/ secretSource(kind + value)。
 *        送信で `POST /connections`。400/409 はサーバの統一文面をそのまま出す(作り直さない)。
 *   (C) 発行済み接続 …… `GET /connections`。各行を「失効」で `DELETE /connections/:id`。
 *
 * **secretSource は取得元の参照(環境変数名 or 取得コマンド)であって secret 値ではない**。
 * サーバは解決値を保管も返却もしないので、UI にも secret 値は一切出ない(参照だけを見せる)。
 *
 * この画面に入れるのは owner だけ(導線は `AppWorkspace` が owner のときだけ出す)。直接
 * 開かれても、サーバが非 owner に 403 を返す —— UI の出し分けは先回りで、最終防衛線はサーバ。
 *
 * ## 【V4-M15-T14】部品体系で組み直した(`ADR-0087` / `ADR-0089`)
 *
 * **文言も `data-testid` も1バイトも変えていない。** 変えたのは器だけである:
 * 入力欄を `Input` / `Textarea`、ラベルを `Label htmlFor` + `id` の対、操作を `Button`、
 * 発行の失敗(`issue-error`)を `Alert variant="destructive"`、
 * 読み込み中に `Skeleton`、発行済み接続の表を `TableFrame`(`overflow-x-auto`)で包んだ
 * (`D-V4-44`。**`class="connection-table"` は `<table>` に残してある**)。
 *
 * **secret 取得元の2択は素の `<input type="radio">` のままである** —— **部品体系の
 * `Checkbox` は `type="checkbox"` を持つ別物であり、`data-slot="checkbox"` を radio に
 * 付けると嘘になる。** **同じ体裁だけをクラスで当てている。**
 */
import { useCallback, useEffect, useState } from "react";
import {
  type ConnectionRequest,
  type ConnectionSummary,
  createConnection,
  listConnectionRequests,
  listConnections,
  revokeConnection,
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
 * **着手前は `<p>読み込み中…</p>` の1行だけで、skeleton は `web/src` 全体で0件だった**
 * (`03` §4-1)。
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

/** 入力部品に共通の体裁(`radio` は `Checkbox` 部品の対象外なのでここで当てる)。 */
const RADIO_CLASS = cn(
  "size-4 shrink-0 accent-foreground outline-none",
  "focus-visible:outline-[length:var(--focus-outline-width)] focus-visible:outline-solid focus-visible:outline-ring",
  "disabled:cursor-not-allowed disabled:opacity-50",
);

/** secret 取得元の種別。env=環境変数名 / command=取得コマンド(いずれも「値」ではなく参照)。 */
type SecretKind = "env" | "command";

/** 許可ホストのテキスト(カンマ・改行区切り)を配列に。空要素は落とす。 */
function parseHosts(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((host) => host.trim())
    .filter((host) => host !== "");
}

export function ConnectionAdmin({ appId, onClose }: { appId: string; onClose?: () => void }) {
  const [requestsState, setRequestsState] = useState<AsyncState<ConnectionRequest[]>>({
    status: "loading",
  });
  const [connectionsState, setConnectionsState] = useState<AsyncState<ConnectionSummary[]>>({
    status: "loading",
  });

  // 発行フォームの入力。承認導線からプレフィルされる。
  const [name, setName] = useState("");
  const [hostsText, setHostsText] = useState("");
  const [secretKind, setSecretKind] = useState<SecretKind>("env");
  const [secretValue, setSecretValue] = useState("");
  const [requestId, setRequestId] = useState<string | undefined>(undefined);

  /** 発行の失敗文面(400/409 など)。成功でクリアする。 */
  const [issueError, setIssueError] = useState<string | null>(null);
  /** 発行を送信中(二重送信を防ぐ)。 */
  const [issuing, setIssuing] = useState(false);
  /** 失効を送信中の接続ID(その行のボタンを一時的に無効化する)。 */
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const loadRequests = useCallback(() => {
    setRequestsState({ status: "loading" });
    listConnectionRequests(appId).then(
      (value) => setRequestsState({ status: "ready", value }),
      (reason: unknown) =>
        setRequestsState({ status: "error", errors: toValidationErrors(reason) }),
    );
  }, [appId]);

  const loadConnections = useCallback(() => {
    setConnectionsState({ status: "loading" });
    listConnections(appId).then(
      (value) => setConnectionsState({ status: "ready", value }),
      (reason: unknown) =>
        setConnectionsState({ status: "error", errors: toValidationErrors(reason) }),
    );
  }, [appId]);

  useEffect(() => {
    loadRequests();
    loadConnections();
  }, [loadRequests, loadConnections]);

  /** 申請を承認 → 発行フォームに requestedName / suggestedHosts / requestId をプレフィルする。 */
  const prefillFromRequest = useCallback((request: ConnectionRequest) => {
    setName(request.requestedName);
    setHostsText(request.suggestedHosts.join(", "));
    setRequestId(request.id);
    setIssueError(null);
  }, []);

  const issue = useCallback(async () => {
    setIssuing(true);
    setIssueError(null);
    try {
      await createConnection(appId, {
        name,
        allowedHosts: parseHosts(hostsText),
        secretSource: { kind: secretKind, value: secretValue },
        ...(requestId !== undefined ? { requestId } : {}),
      });
      // 成功。フォームをたたみ、両一覧を取り直す(締めた申請が消え、発行済みに増える)。
      setName("");
      setHostsText("");
      setSecretValue("");
      setRequestId(undefined);
      loadRequests();
      loadConnections();
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
  }, [appId, name, hostsText, secretKind, secretValue, requestId, loadRequests, loadConnections]);

  const revoke = useCallback(
    async (connectionId: string) => {
      setRevokingId(connectionId);
      try {
        await revokeConnection(appId, connectionId);
        loadConnections();
      } finally {
        setRevokingId(null);
      }
    },
    [appId, loadConnections],
  );

  return (
    <Card className={cn("connection-admin")} data-testid="connection-admin">
      <header
        className={cn(
          "connection-admin-header",
          "flex flex-wrap items-center justify-between gap-s2",
        )}
      >
        <h3 className={cn("m-0")}>接続の管理</h3>
        {onClose !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="close-connection-admin"
            onClick={onClose}
          >
            閉じる
          </Button>
        )}
      </header>

      {/* (A) 未承認の申請 */}
      <div className={cn("connection-requests", "flex flex-col gap-s2")}>
        <h4 className={cn("m-0")}>未承認の申請</h4>
        {requestsState.status === "loading" && <LoadingRows />}
        {requestsState.status === "error" && <ErrorList errors={requestsState.errors} />}
        {requestsState.status === "ready" &&
          (requestsState.value.length === 0 ? (
            <p
              data-testid="connection-requests-empty"
              className={cn("m-0", "text-muted-foreground")}
            >
              未承認の申請はありません。
            </p>
          ) : (
            <ul className={cn("connection-request-list", "flex flex-col gap-s2")}>
              {requestsState.value.map((request) => (
                <li
                  key={request.id}
                  className={cn(
                    "connection-request-row",
                    "flex flex-col gap-s1 sm:flex-row sm:flex-wrap sm:items-center",
                  )}
                  data-testid="connection-request-row"
                  data-request-id={request.id}
                >
                  <span className={cn("connection-request-name", "font-medium")}>
                    {request.requestedName}
                  </span>
                  <span className={cn("connection-request-purpose", "text-note")}>
                    {request.purpose}
                  </span>
                  <span
                    className={cn("connection-request-hosts", "text-note text-muted-foreground")}
                  >
                    {request.suggestedHosts.join(", ")}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-full sm:w-auto"
                    data-testid="approve-request"
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
        className={cn("connection-issue-form", "flex flex-col gap-s2")}
        data-testid="connection-issue-form"
        onSubmit={(event) => {
          event.preventDefault();
          void issue();
        }}
      >
        <h4 className={cn("m-0")}>接続を発行</h4>
        {issueError !== null && (
          <Alert
            variant="destructive"
            className={cn("connection-issue-error")}
            data-testid="issue-error"
          >
            {issueError}
          </Alert>
        )}

        <div className={cn("connection-field", "flex flex-col gap-s1")}>
          <Label htmlFor="connection-name-input">接続名</Label>
          <Input
            id="connection-name-input"
            type="text"
            data-testid="connection-name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className={cn("connection-field", "flex flex-col gap-s1")}>
          <Label htmlFor="connection-hosts-input">許可ホスト(カンマまたは改行区切り)</Label>
          <Textarea
            id="connection-hosts-input"
            data-testid="connection-hosts-input"
            value={hostsText}
            onChange={(event) => setHostsText(event.target.value)}
          />
        </div>

        <fieldset
          className={cn(
            "connection-secret-source",
            "flex flex-col gap-s2 rounded-ui border-[length:var(--border-width)] border-solid border-border p-s3",
          )}
        >
          <legend className={cn("px-s1 text-sm font-medium text-label")}>secret 取得元</legend>
          <Label htmlFor="secret-kind-env">
            <input
              id="secret-kind-env"
              type="radio"
              name="secret-kind"
              className={RADIO_CLASS}
              data-testid="secret-kind-env"
              checked={secretKind === "env"}
              onChange={() => setSecretKind("env")}
            />
            環境変数(env)
          </Label>
          <Label htmlFor="secret-kind-command">
            <input
              id="secret-kind-command"
              type="radio"
              name="secret-kind"
              className={RADIO_CLASS}
              data-testid="secret-kind-command"
              checked={secretKind === "command"}
              onChange={() => setSecretKind("command")}
            />
            取得コマンド(command)
          </Label>
          <div className={cn("connection-field", "flex flex-col gap-s1")}>
            <Label htmlFor="secret-value-input">取得元の値</Label>
            <Input
              id="secret-value-input"
              type="text"
              data-testid="secret-value-input"
              value={secretValue}
              onChange={(event) => setSecretValue(event.target.value)}
            />
          </div>
          <p
            className={cn("connection-secret-hint", "m-0 text-note text-muted-foreground")}
            data-testid="secret-value-hint"
          >
            secret 本体ではなく取得元(環境変数名 or 取得コマンド)を入力してください。
          </p>
        </fieldset>

        <Button
          type="submit"
          variant="secondary"
          className="w-full sm:w-auto"
          data-testid="issue-connection"
          disabled={issuing}
        >
          発行
        </Button>
      </form>

      {/* (C) 発行済み接続 */}
      <div className={cn("connection-list", "flex flex-col gap-s2")}>
        <h4 className={cn("m-0")}>発行済み接続</h4>
        {connectionsState.status === "loading" && <LoadingRows />}
        {connectionsState.status === "error" && <ErrorList errors={connectionsState.errors} />}
        {connectionsState.status === "ready" &&
          (connectionsState.value.length === 0 ? (
            <p data-testid="connections-empty" className={cn("m-0", "text-muted-foreground")}>
              発行済みの接続はありません。
            </p>
          ) : (
            // **表は横に溢れうるので包む**(`D-V4-44`)。**`class` は `<table>` に残す。**
            <TableFrame>
              <Table className={cn("connection-table")}>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="px-s2 py-s1">
                      接続名
                    </TableHead>
                    <TableHead scope="col" className="px-s2 py-s1">
                      許可ホスト
                    </TableHead>
                    <TableHead scope="col" className="px-s2 py-s1">
                      secret 取得元
                    </TableHead>
                    <TableHead scope="col" className="px-s2 py-s1" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {connectionsState.value.map((connection) => (
                    <TableRow
                      key={connection.id}
                      className={cn("connection-row")}
                      data-testid="connection-row"
                      data-connection-id={connection.id}
                    >
                      <TableCell data-testid="connection-row-name" className="px-s2 py-s1">
                        {connection.name}
                      </TableCell>
                      <TableCell className="px-s2 py-s1">
                        {connection.allowedHosts.join(", ")}
                      </TableCell>
                      <TableCell className="px-s2 py-s1">
                        {/* 参照であって値ではない(env 名 / 取得コマンド)。 */}
                        {connection.secretSource.kind}: {connection.secretSource.value}
                      </TableCell>
                      <TableCell className="px-s2 py-s1">
                        <Button
                          size="sm"
                          variant="destructive"
                          data-testid="revoke-connection"
                          disabled={revokingId === connection.id}
                          onClick={() => {
                            void revoke(connection.id);
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
