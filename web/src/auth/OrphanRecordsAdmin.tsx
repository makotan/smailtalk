/**
 * **管理者のいない行・誰にも開けなくなった行の一覧**(`V23-M1-T10`。運営だけ。読取専用)。
 *
 * 上位: `docs/adr/0497-auto-enroll-and-last-row-admin.md`(運営の回復の一覧の母集団を「付与が0件の行、
 * または管理者が0人の行」に広げ、並ぶ行に理由を1欄載せる)。 **口は既存の
 * `GET .../tables/:table_id/unreachable-records` 1本だけを叩く**(HTTP の口を1本も足していない)。
 *
 * ## なぜ画面を足したか(計画 T10 の【推測】「新しい画面の部品は作らない見込み」が偽だった)
 *
 * `V23-M1-T00d` の記録 (6) の2 のとおり、この一覧を出す画面は着手前に1つも無かった(API だけ)。
 * 計画 T10 の「運営の回復の一覧に『管理者がいない』理由が出る」を画面で確かめるには、画面が要る。
 * **組み立ては既存の部品だけ**(`Card`・`Table` 群・`Button`・`ErrorList`・`Skeleton`)で、
 * 新しい見た目の部品は1つも作っていない。 置き方は「逃げ道の管理」と同じ(運営だけの導線から開くパネル)。
 *
 * ## 越えていない線
 *
 * - **読取専用である。** 一覧から付与を書く導線を1つも置かない(同 ADR の越えてはならない線5)。
 * - **運営だけ。** 出し分けは先回りであり、遮断はサーバの 403 である。
 * - 叩く表は、行ごとの権限を有効に宣言した表だけである(`web/src/fields/user-account.ts` の `orphanListTables`)。
 */
import { useEffect, useState } from "react";
import type { Manifest, Table as TableDef } from "../../../src/kernel/types.ts";
import { fetchUnreachableRecords, type ValidationError } from "../api.ts";
import { toValidationErrors } from "../async.ts";
import { ErrorList } from "../ErrorList.tsx";
import { representativeField } from "../fields/reference-label.ts";
import { orphanListTables } from "../fields/user-account.ts";
import { Button } from "../ui/button.tsx";
import { Card, Skeleton } from "../ui/surfaces.tsx";
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

/** 理由の欄の値を、業務の言葉にする(内部の値をそのまま出さない)。 */
function reasonLabel(reason: unknown): string {
  if (reason === "no_admin") {
    return "管理者がいません";
  }
  if (reason === "no_grants") {
    return "付与が1件もありません";
  }
  return "誰にも開けません";
}

/** 行の見出し(代表の項目 → 最初の項目 → 行のID の順)。 */
function rowLabel(table: TableDef, row: Record<string, unknown>): string {
  const fieldId = representativeField(table)?.id ?? table.fields[0]?.id;
  const value = fieldId === undefined ? undefined : row[fieldId];
  if (typeof value === "string" && value !== "") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return String(row._id ?? "");
}

type TableRows =
  | { status: "loading" }
  | { status: "error"; errors: ValidationError[] }
  | { status: "ready"; rows: Record<string, unknown>[] };

export function OrphanRecordsAdmin({
  appId,
  manifest,
  onClose,
}: {
  appId: string;
  manifest: Manifest;
  onClose?: () => void;
}) {
  const tables = orphanListTables(manifest);
  const [byTable, setByTable] = useState<Record<string, TableRows>>({});

  useEffect(() => {
    let cancelled = false;
    const targets = orphanListTables(manifest);
    setByTable(Object.fromEntries(targets.map((table) => [table.id, { status: "loading" }])));
    for (const table of targets) {
      fetchUnreachableRecords(appId, table.id).then(
        (body) => {
          if (!cancelled) {
            setByTable((previous) => ({
              ...previous,
              [table.id]: { status: "ready", rows: body.records as Record<string, unknown>[] },
            }));
          }
        },
        (reason: unknown) => {
          if (!cancelled) {
            setByTable((previous) => ({
              ...previous,
              [table.id]: { status: "error", errors: toValidationErrors(reason) },
            }));
          }
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [appId, manifest]);

  return (
    <Card className={cn("orphan-records-admin")} data-testid="orphan-records-admin">
      <header
        className={cn(
          "orphan-records-admin-header",
          "flex flex-wrap items-center justify-between gap-s2",
        )}
      >
        <h3 className={cn("m-0")}>管理者のいない行</h3>
        {onClose !== undefined && (
          <Button
            size="sm"
            variant="secondary"
            data-testid="close-orphan-records-admin"
            onClick={onClose}
          >
            閉じる
          </Button>
        )}
      </header>
      <p role="note" className={cn("m-0", "text-note text-muted-foreground")}>
        付与が1件も無い行と、管理の権限を持つ人が1人もいなくなった行を並べます(引き継ぎ元に管理者がいる行は並びません)。
        この一覧は読むだけで、ここから権限を渡すことはできません。この画面は運営者にだけ出しています。
      </p>
      {tables.map((table) => {
        const state = byTable[table.id] ?? { status: "loading" };
        return (
          <section
            key={table.id}
            className={cn("orphan-records-table", "flex flex-col gap-s2")}
            data-testid="orphan-records-table"
            data-table-id={table.id}
          >
            <h4 className={cn("m-0")}>{table.name}</h4>
            {state.status === "loading" && <Skeleton className="h-6 w-full" />}
            {state.status === "error" && <ErrorList errors={state.errors} />}
            {state.status === "ready" &&
              (state.rows.length === 0 ? (
                <p className={cn("m-0", "text-muted-foreground")}>並ぶ行はありません。</p>
              ) : (
                <TableFrame>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead scope="col" className="px-s2 py-s1">
                          行
                        </TableHead>
                        <TableHead scope="col" className="px-s2 py-s1">
                          理由
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {state.rows.map((row) => (
                        <TableRow
                          key={String(row._id)}
                          data-testid="orphan-records-row"
                          data-record-id={String(row._id)}
                        >
                          <TableCell className="px-s2 py-s1">{rowLabel(table, row)}</TableCell>
                          <TableCell className="px-s2 py-s1" data-testid="orphan-records-reason">
                            {reasonLabel(row._orphan_reason)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableFrame>
              ))}
          </section>
        );
      })}
    </Card>
  );
}
