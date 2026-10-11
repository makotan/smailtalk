/**
 * **マイページの「自分の記録」に載せる表を決める1本**(`V22-M3-T02`。`ADR-0488` §Decision 1 の 4・限定11 /
 * `ADR-0490` §Decision 1 の行1 / `ADR-0492` §Decision 3 の限定12'')。
 *
 * **持ち主が分かる表を決める関数は、リポジトリ全体でこの {@link myPageTables} 1本だけである**(限定11)。
 * 画面・サーバ・カーネルの適用時の検査は、どれもこの1本を呼ぶ(2本目の判定を書かない)。
 *
 * 載る表は3種類:
 *
 *  - **(i) 個人の持ち主の列を持つ表** —— 判定は再実装せず、`owner-scope.ts` の `personalOwnerField` を値で
 *    import して呼ぶ(限定12'')。 出どころの印は `"personal"`。
 *  - **(ii) 読取の条件に「自分」がある表** —— 判定は `owner-scope.ts` の末尾の export 1本
 *    (`myPageSelfConditionFields`)に任せ、**このファイルは役割の宣言を1つも読まない**(限定12''。
 *    `ADR-0305` 限定2 の検査の列の走査を守る)。 答えのうち、その表に実在する `text` 型の列だけを使う
 *    (持ち主の判定は `value === userId` の文字列比較なので)。 出どころの印は `"rule"`。
 *  - **(iii) `tables.include` で足した表**。 出どころの印は `"include"`。
 *
 * `tables.exclude` に書いた表は (i)・(ii) から外す。 **「自分の行」は、持ち主の列のどれか1つが自分の ID と
 * 等しい行である**(`D-V22-23`)。 同じ表に (i) と (ii) の両方があれば、列を1つにまとめる((i) の列が先)。
 *
 * **宣言(`app.workspace.my_page`)が無ければ空を返す。** 並びは表の定義順。 **宣言の検査はしない**
 * (実在しない表・列の名指しは適用時の検査 `referential-integrity.ts` が断る。ここでは黙って飛ばす)。
 */

import type { Manifest } from "../kernel/types.ts";
import {
  type ActorRoles,
  judgeRoleAccess,
  myPageSelfConditionFields,
  personalOwnerField,
} from "../server/owner-scope.ts";

/** 表が「自分の記録」に載った理由(`personal` = (i) / `rule` = (ii) / `include` = (iii))。 */
export type MyPageTableSource = "personal" | "rule" | "include";

/** 「自分の記録」に載る表1件。 `ownerFields` のどれか1つが自分の ID と等しい行が自分の行である。 */
export type MyPageTable = {
  table: string;
  ownerFields: string[];
  source: MyPageTableSource;
};

/** マイページの「自分の記録」に載せる表(表の定義順)。 宣言が無ければ空。 */
export function myPageTables(manifest: Manifest): MyPageTable[] {
  const myPage = manifest?.app?.workspace?.my_page;
  if (myPage === undefined || myPage === null) {
    return [];
  }
  const excluded = new Set(myPage.tables?.exclude ?? []);
  const included = new Map<string, string>();
  for (const entry of myPage.tables?.include ?? []) {
    if (!included.has(entry.table)) {
      included.set(entry.table, entry.owner_field);
    }
  }
  const tables = Array.isArray(manifest.app.tables) ? manifest.app.tables : [];
  const result: MyPageTable[] = [];
  for (const table of tables) {
    const tableId = table?.id;
    if (typeof tableId !== "string") {
      continue;
    }
    const personal = personalOwnerField(table)?.id;
    const textFieldIds = new Set(
      (table.fields ?? []).filter((field) => field?.type === "text").map((field) => field.id),
    );
    const conditioned = myPageSelfConditionFields(manifest, tableId).filter((id) =>
      textFieldIds.has(id),
    );
    if (personal !== undefined || conditioned.length > 0) {
      if (excluded.has(tableId)) {
        continue;
      }
      const ownerFields: string[] = [];
      for (const id of personal === undefined ? conditioned : [personal, ...conditioned]) {
        if (!ownerFields.includes(id)) {
          ownerFields.push(id);
        }
      }
      result.push({
        table: tableId,
        ownerFields,
        source: personal === undefined ? "rule" : "personal",
      });
      continue;
    }
    const ownerField = included.get(tableId);
    if (ownerField !== undefined) {
      result.push({ table: tableId, ownerFields: [ownerField], source: "include" });
    }
  }
  return result;
}

/**
 * **その役割から、この表の持ち主の列のどれかが丸ごと隠れているか**(`V22-M3-T08a`。独立点検の指摘 中-2 /
 * `ADR-0493`)。 **行を渡さない判定**であり、答えは `judgeRoleAccess` の1回の呼び出しの `allowed` をそのまま使う
 * (**判定を書き足さない**。このファイルは役割の宣言を1つも読まない。限定12'')。
 *
 * 真のとき、サーバはその表の `?my_page=1` を 400 で断り、画面はその表の節を出さない(`D-V22-24` と同じ扱い。
 * エラー枠を出さない)。 **同じ1本をサーバと画面の両方が呼ぶ**(2本目を書かない)。
 *
 * **行ごとに伏せる条件つきの項目の許可は、行を渡さない判定では「読める」側に出る**(`allowed: true`)。
 * その場合の「自分の行」の数え方はサーバの `keepMyPageRows` が行ごとに決める(方式(b)。`ADR-0493`)。
 */
export function myPageOwnerHidden(
  manifest: Manifest,
  roles: ActorRoles,
  entry: Pick<MyPageTable, "table" | "ownerFields">,
): boolean {
  return entry.ownerFields.some(
    (field) =>
      !judgeRoleAccess({
        manifest,
        roles,
        target: { target: "field", table: entry.table, field },
        verb: "read",
      }).allowed,
  );
}
