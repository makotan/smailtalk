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
import type { Manifest, ResourceId } from "../../../src/kernel/types.ts";
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
      (users) => {
        if (!cancelled) {
          setChoices(users.map((user) => ({ id: user.id, label: userAccountLabel(user) })));
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
