/**
 * **名簿の `account` 欄を「利用者を選ぶプルダウン」にするための解決**
 * (`UM-G2`。`V13-M1-T02`)。
 *
 * ## なぜ要るか(利用者から見て何が起きるか)
 *
 * 着手前は、名簿の表に人を1行足すとき、`account` 欄に**利用者ID**(`tM4nU3qS…` のような
 * 英数字)を手で書き写す必要があった。**その値は画面のどこにも出ていない**ので、
 * ログイン名を書いてしまい、**その人には一覧が全部0件になる**、という事故が実際に起きた。
 * ここが解くのは「**どの表のどの項目がその欄なのか**」の1点だけである。
 *
 * ## 何をしていて、何をしていないか
 *
 * - **語彙を1つも増やしていない。** 手掛かりは**既にマニフェストが書いている宣言**
 *   (`table.access_control.members`)だけであり、フィールド型も差分操作も
 *   `schemas/` も1バイトも変わらない。
 * - **形は {@link import("./input.tsx").grantMemberScope} に倣っている** ——
 *   **読取を1件も飛ばさず、マニフェストの宣言だけから解く。**
 *   表の解決は `resolveViewTable` の1本に任せ、ここに再実装しない。
 * - **一覧が読めなかったときは、区別せず「今日どおりのテキスト欄」に倒す**
 *   (403 でも 401 でも通信の失敗でも同じ)。**画面に出ないことを権限の担保にしていない**
 *   —— 書込を止めているのはサーバであって、この欄の見た目ではない。
 */
import { useEffect, useState } from "react";
import type { Manifest, ResourceId, Table } from "../../../src/kernel/types.ts";
import { type AppUser, listAppUsers } from "../api.ts";
import { resolveViewTable } from "../table-resolution.ts";

/**
 * **そのフォームの表が名簿なら、`account` に当たる項目IDを返す。**
 *
 * **次の全部が揃ったときだけ返す。どれか1つでも欠けたら `undefined`(= 今日どおり)。**
 *
 *  1. その表を `access_control.members.table` に名指しした表が在り、`enabled` が真。
 *  2. `members.account` が書かれている。
 *  3. その項目が**そのフォームの表に実在**し、**型が `text`** である。
 */
export function accountFieldFor(
  manifest: Manifest,
  formTableId: ResourceId,
): ResourceId | undefined {
  const memberTable = resolveViewTable(manifest, formTableId);
  if (memberTable === undefined) {
    return undefined;
  }
  for (const table of manifest.app.tables) {
    const declared = table.access_control;
    if (declared === undefined || declared.enabled !== true) {
      continue;
    }
    const members = declared.members;
    if (members === undefined || members.table !== formTableId) {
      continue;
    }
    const accountFieldId = members.account;
    if (accountFieldId === undefined) {
      return undefined;
    }
    const accountField = memberTable.fields.find((field) => field.id === accountFieldId);
    if (accountField === undefined || accountField.type !== "text") {
      return undefined;
    }
    return accountFieldId;
  }
  return undefined;
}

/**
 * **そのフォームの表が、名簿への自動登録(`auto_enroll`)で名前の列を宣言した名簿なら、その列の項目IDを返す**
 * (`V23-M1-T10`。上位: `docs/adr/0497-auto-enroll-and-last-row-admin.md` の本人の名前の列)。
 *
 * サーバは、運営でない人の名簿の行への更新を、**自分の行の名前の列だけを変える更新**に限って通す
 * (`src/server/owner-scope.ts` の `judgeGrantWrite` の名簿の断りの例外)。 編集画面はこの列だけを出し、
 * この列だけを送る。 **次の全部が揃ったときだけ返す**(どれか1つでも欠けたら `undefined` = 今日どおり):
 *
 *  1. その表を `access_control.members.table` に名指しした表が在り、`enabled` が真。
 *  2. `members.auto_enroll.name` が書かれ、その項目がフォームの表に実在する。
 *
 * **【`V23-M1-T13` の訂正。上の2項を消していない】** 同じ名簿を指す宣言が複数あるときは、`auto_enroll.name` を
 * 書いた最初の宣言を使う(書かない宣言は飛ばす。サーバの判定と同じ)。
 *
 * **これは遮断ではない** —— 他人の行・他の列への書込を止めているのは今日もサーバの 403 である。
 */
export function selfEditableRosterNameField(
  manifest: Manifest,
  formTableId: ResourceId,
): ResourceId | undefined {
  const memberTable = resolveViewTable(manifest, formTableId);
  if (memberTable === undefined) {
    return undefined;
  }
  for (const table of manifest.app.tables) {
    const declared = table.access_control;
    if (declared === undefined || declared.enabled !== true) {
      continue;
    }
    const members = declared.members;
    if (members === undefined || members.table !== formTableId) {
      continue;
    }
    const nameFieldId = members.auto_enroll?.name;
    // **【`V23-M1-T13`】`name` を持たない宣言は飛ばして次の宣言を探す**(サーバの `isOwnNameOnlyUpdate` と
    // 同じ探し方。 同じ名簿を指す宣言が複数あり、先の宣言が `auto_enroll` を書かない形は適用時に許されている)。
    if (nameFieldId === undefined) {
      continue;
    }
    if (!memberTable.fields.some((field) => field.id === nameFieldId)) {
      return undefined;
    }
    return nameFieldId;
  }
  return undefined;
}

/**
 * **行ごとの権限を `enabled: true` で宣言した表**(`V23-M1-T10`。運営の「管理者のいない行」の一覧が叩く表)。
 *
 * 宣言を読むだけで判定式を1つも持たない(判定の家は今日も `src/server/owner-scope.ts`)。 宣言の綴りを
 * `src/server/` の外で持ってよいファイルは列挙で閉じている(`src/server/access-control-localization.test.ts`)ので、
 * 新しいファイルに綴りを書かず、既に列挙されたこのファイルに置いた。
 */
export function orphanListTables(manifest: Manifest): Table[] {
  return manifest.app.tables.filter((table) => table.access_control?.enabled === true);
}

/**
 * **その表が行単位の招待を宣言しているか**(`V23-M5-T06`。`D-V23-129`・`ADR-0532` §Decision 1-8)。
 *
 * 行の詳細画面が、宣言の無い表で行の招待の一覧の口を呼ばないために読む(計画 §24-6 中8)。 宣言を読むだけで
 * 判定式を1つも持たない(招待できるかを決めるのはサーバの口の答え)。 宣言の綴りを持つファイルを増やさないため、
 * {@link orphanListTables} と同じ理由でこのファイルに置いた(`D-V23-134` (3))。
 */
export function rowInvitationsDeclared(table: Table | undefined): boolean {
  const declared = table?.access_control;
  return declared?.enabled === true && Array.isArray(declared.invitations?.grantable);
}

/** プルダウンの選択肢1つ。**値は利用者ID**であり、ログイン名ではない。 */
export type UserAccountChoice = { readonly id: string; readonly label: string };

/**
 * 選択肢の見出し。**表示名が非空なら「表示名(ログイン名)」、無ければログイン名だけ。**
 *
 * **同姓同名を見分けられるように、ログイン名は常に出す。**
 */
export function userAccountLabel(user: AppUser): string {
  const displayName = user.displayName ?? "";
  return displayName === "" ? user.username : `${displayName}(${user.username})`;
}

/**
 * 利用者の一覧を1度だけ読み、選択肢に直す。
 *
 * - `enabled` が偽なら、**呼び出しを1本も飛ばさず** `undefined` を返す。
 * - **失敗したら `undefined`** —— 403 / 401 / 通信の失敗を**区別しない**
 *   (どれでも今日どおりのテキスト欄に戻る)。
 */
export function useUserAccountChoices(
  appId: string,
  enabled: boolean,
): readonly UserAccountChoice[] | undefined {
  const [choices, setChoices] = useState<readonly UserAccountChoice[] | undefined>(undefined);
  useEffect(() => {
    if (!enabled) {
      setChoices(undefined);
      return;
    }
    let cancelled = false;
    listAppUsers(appId).then(
      // **`V19-M3-T01` で一覧の口が招待も返すようになった** —— **相手の一覧だけを取る。**
      // **招待は1件も見ない**(候補に出すのは実在する利用者だけである)。
      (list) => {
        if (!cancelled) {
          setChoices(list.users.map((user) => ({ id: user.id, label: userAccountLabel(user) })));
        }
      },
      () => {
        if (!cancelled) {
          setChoices(undefined);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [appId, enabled]);
  return choices;
}
