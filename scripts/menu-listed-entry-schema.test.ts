/**
 * **設計図の `menu_listed` の説明文と注記に、未ログインの入口の選び方に使うことを書き足した**ことの見張り
 * (2026-09-28。旧文は1バイトも消さず、末尾に足す)。
 *
 * - 説明文(`description`)と注記(`$comment`)は、2026-09-28 より前の文で始まり、その後ろに入口の文が在る。
 * - 値・型は変えていない(真偽値1つのまま)。
 *
 * **しないこと**: 文の正しさは綴りの有無でしか見ない。 挙動は `web/test/anonymous-menu-listed.test.tsx`。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = join(import.meta.dir, "..", "schemas", "manifest.schema.json");

/** 2026-09-28 より前の説明文(逐語)。 */
const OLD_DESCRIPTION =
  "この画面を画面一覧 (メニュー) に並べるかどうか。省略した画面は今日どおり並ぶ。false と書くと一覧から落ちるだけで、行クリックや URL からは今日どおり開ける (見せる相手を決めるのは役割の規則 (roles の rules) であって、このキーではない)。";

/** 2026-09-28 より前の注記の末尾(逐語)。 */
const OLD_COMMENT_TAIL =
  "**2本目の掲載・可視性のキーを足す提案、値を enum にする提案は、改めて ADR-0007 の門A を通すこと (ADR-0084 §Decision 4)。**";

function menuListed(): Record<string, unknown> {
  const schema = JSON.parse(readFileSync(SCHEMA, "utf8"));
  return schema.$defs.view.properties.menu_listed;
}

describe("設計図の menu_listed: 入口の選び方の書き足し", () => {
  test("(1) 説明文は旧文で始まり、後ろに入口の文が在る", () => {
    const description = String(menuListed().description);
    expect(description.startsWith(OLD_DESCRIPTION)).toBe(true);
    const added = description.slice(OLD_DESCRIPTION.length);
    expect(added).toContain("入口");
    expect(added).toContain("メニューに載せる公開の一覧画面");
    expect(added).toContain("1つも無ければ");
  });

  test("(2) 注記は旧文の末尾の後ろに、入口の候補を決めること・名指しのキーを足さないこと・既定を変えないことを書いている", () => {
    const comment = String(menuListed().$comment);
    const at = comment.indexOf(OLD_COMMENT_TAIL);
    expect(at).toBeGreaterThan(0);
    const added = comment.slice(at + OLD_COMMENT_TAIL.length);
    for (const phrase of [
      "未ログインの入口の候補に入れるか",
      "入口を名指しするキーは足していない",
      "既定 (書かなければ載せる) は変えていない",
    ]) {
      expect(added).toContain(phrase);
    }
  });

  test("(3) 値と型は変えていない(真偽値1つ・キーは3つのまま)", () => {
    const entry = menuListed();
    expect(entry.type).toBe("boolean");
    expect(Object.keys(entry).sort()).toEqual(["$comment", "description", "type"]);
  });
});
