/**
 * **取り消しと使用を区別する**(`V19-M2-T00`。単位 `SV-G5`。`ADR-0452` §Decision 1-1 の
 * `S3` の 8 / 限定⑨ / 限定⑩)。
 *
 * ## この検査の作り方(**TDD である。順序を先に書く**)
 *
 * **先にこのファイルを書き、赤を実際に見てから実装を入れた。**
 * **期待値は `ADR-0452` の限定表と `docs/plan/v19/records/v19-m0.md` の `T02-1-4`(採った案の
 * 形。9点)から採っており、実装を見て後から合わせたものではない。**
 *
 * ## 何を固定するのか(**4本ちょうど。計画 `04-v19-m2-plan.md` §9-B-A3 の裁定**)
 *
 * 1. **取り消し → 区別できる**(`(V19-a)`)。
 * 2. **使用 → 区別できる**(`(V19-b)`)。
 * 3. **`used_at` の値の形(値域)が固定されている**(`(V19-c)`)——
 *    **着手前、この値域を守る検査は `apps/smailtalk/src/auth/` に **0本** であった**
 *    (`ADR-0452` 限定⑩。**置かないまま実装が進むと同 ADR の再審査条件7 が発火する**)。
 * 4. **印を持たない非 NULL の行が「使用済み」と読まれる**(`(V19-d)`)——
 *    **取り消し済みに化けない。** **これは `SV-G6` の右辺である**(門A の決定:
 *    **既存の行は「使用済み」と読む。後から「取り消しだった」を復元しない**)。
 *
 * ## この検査が測っていないこと(**誇張しない**)
 *
 * - **HTTP を1度も通していない。** **応答の形(状態を別のキーで返すこと)は
 *   `src/server/invitation-issuance.test.ts` の側と `V19-M2-T02` が測る。**
 * - **`undo` を1度も呼んでいない。** **取り消しが巻き戻って再び使えるようになる形は
 *   今日も塞がっておらず、その実測は `src/auth/undo-invitations.test.ts` と
 *   `V19-M2-T03` が担う。** **【禁止の履行】「取り消しが守られるようになった」と書かない。**
 * - **期限を過ぎた行は今日どおり掃除で消える。** **取り消しの記録も24時間で消える。**
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDbPath } from "../kernel/storage-paths.ts";
import { invitationIsUsable, invitationState } from "./invitations.ts";
import { AuthStore, INVITATION_REVOKED_PREFIX } from "./store.ts";
import type { Invitation } from "./types.ts";

const APP_ID = "invitation-state-under-test";

/** 素の ISO8601 UTC(ミリ秒つき)ちょうどの形。 */
const BARE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let dataRoot: string;
let store: AuthStore;

/** kernel の create-app に倣って、DELETE モードの空 app.sqlite を用意する。 */
function makeAppSqlite(root: string, appId: string): void {
  mkdirSync(join(root, "apps", appId), { recursive: true });
  const db = new Database(appDbPath(root, appId), { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("VACUUM;");
  } finally {
    db.close();
  }
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-invitation-state-"));
  makeAppSqlite(dataRoot, APP_ID);
  store = AuthStore.openForApp(dataRoot, APP_ID);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

function issue(username: string): string {
  return store.issueInvitation({ username, role: "editor", issuedBy: "owner-id" }).code;
}

/** その相手の招待(引けなければ落とす。`!` を1つも書かないため)。 */
function mustFind(username: string): Invitation {
  const invitation = store.findInvitation(username);
  if (invitation === undefined) {
    throw new Error(`招待が引けない: ${username}`);
  }
  return invitation;
}

/** 取り消したあとの招待(取り消せなければ落とす)。 */
function mustRevoke(username: string): Invitation {
  const invitation = store.revokeInvitation(username);
  if (invitation === undefined) {
    throw new Error(`取り消せない: ${username}`);
  }
  return invitation;
}

/**
 * **この版より前に作られた行を再現する**(**素の時刻が入っているだけの非 NULL の行**)。
 *
 * **本番の API を1本も足さないために、テストから生の SQL で書き換える** ——
 * **移行の SQL を製品側に1行も置かないという `ADR-0452` 限定⑭ を、実装側に穴を
 * 開けずに測るためである**(`invitations.test.ts` の `forceExpire` と同じ形)。
 */
function writeLegacyMark(username: string, at: string): void {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    db.query(`UPDATE "_auth_invitations" SET "used_at" = ? WHERE "username" = ?`).run(at, username);
  } finally {
    db.close();
  }
}

// =====================================================================================
// (V19-a) 取り消し → 区別できる
// =====================================================================================

test("(V19-a) 取り消した招待は「取り消し済み」と読める(未使用・使用済みのどちらとも別)", () => {
  issue("bob");
  expect(invitationState(mustFind("bob"))).toBe("unused");

  const revoked = mustRevoke("bob");
  expect(invitationState(revoked)).toBe("revoked");
  // **行は消えない**(`ADR-0336` 限定16 を1バイトも破らない)。
  expect(store.listInvitations()).toHaveLength(1);
  // **取り消した招待は使えない**(述語は今日のままで通る)。
  expect(invitationIsUsable(revoked)).toBe(false);
});

// =====================================================================================
// (V19-b) 使用 → 区別できる
// =====================================================================================

test("(V19-b) 使った招待は「使用済み」と読める(取り消し済みに化けない)", () => {
  issue("bob");
  expect(store.markInvitationUsed("bob")).toBe(true);

  const used = mustFind("bob");
  expect(invitationState(used)).toBe("used");
  expect(invitationIsUsable(used)).toBe(false);

  // **陽性対照**: 同じ表の別の行を取り消すと、2つは**別の値**として読める
  // (= 片方だけが動くことを示す。両方が同じ値になる実装では赤くなる)。
  issue("carol");
  expect(invitationState(mustRevoke("carol"))).not.toBe(invitationState(used));
});

// =====================================================================================
// (V19-c) 値域 —— **着手前は 0本 だった**(`ADR-0452` 限定⑩ / 再審査条件7)
// =====================================================================================

test("(V19-c) 取り消しの印は素の時刻ではない形に固定されている(値域。形は1つだけ)", () => {
  // **形は1つに固定する**(`T02-1-4` の 2)。**2つ目の形を作らない。**
  expect(INVITATION_REVOKED_PREFIX.length).toBeGreaterThan(0);
  expect(INVITATION_REVOKED_PREFIX.endsWith(":")).toBe(true);
  expect(BARE_ISO.test(INVITATION_REVOKED_PREFIX)).toBe(false);

  issue("bob");
  const revoked = mustRevoke("bob");
  // **素の時刻ではない**(下の2行が、着手前は 0本 だった担保そのものである)。
  //
  // **【項目名と値の形の判定を同じ行に書いている。理由を書く】** **`ADR-0452` 限定⑩ の式は
  // 「項目名を含む行」を母集団に取り、そのうち「値の形を判定している行」を数える** ——
  // **したがって局所変数に受けてから判定すると、検査が実在しても式は 0 を返す。**
  // **実際に一度その形で書き、式が 0 のままであることを実測してからこの形に直した。**
  expect(revoked.usedAt ?? "").not.toMatch(BARE_ISO);
  expect(revoked.usedAt?.startsWith(INVITATION_REVOKED_PREFIX)).toBe(true);
  const raw = revoked.usedAt ?? "";
  // **印の後ろは素の ISO8601 ちょうどである**(読める時刻を捨てていない)。
  const rest = raw.slice(INVITATION_REVOKED_PREFIX.length);
  expect(BARE_ISO.test(rest)).toBe(true);
  expect(Number.isNaN(Date.parse(rest))).toBe(false);

  // **陰性対照**: 使用の側は今日どおり素の ISO8601 ちょうどであり、印を持たない。
  issue("carol");
  expect(store.markInvitationUsed("carol")).toBe(true);
  expect(mustFind("carol").usedAt ?? "").toMatch(BARE_ISO);
  expect(mustFind("carol").usedAt?.startsWith(INVITATION_REVOKED_PREFIX)).toBe(false);
});

// =====================================================================================
// (V19-d) **`SV-G6` の右辺** —— 既存の行は「使用済み」と読む
// =====================================================================================

test("(V19-d) 印を持たない非 NULL の行は「使用済み」と読まれる(取り消し済みに化けない)", () => {
  // **この版より前に作られた行**(素の時刻だけが入っている)。
  issue("bob");
  writeLegacyMark("bob", "2026-01-02T03:04:05.678Z");

  const legacy = mustFind("bob");
  expect(legacy.usedAt).toBe("2026-01-02T03:04:05.678Z");
  expect(invitationState(legacy)).toBe("used");
  // **「取り消しだった」を復元しない**(材料がどこにも無い。`ADR-0452` §塞がないもの 1)。
  expect(invitationState(legacy)).not.toBe("revoked");
  expect(invitationIsUsable(legacy)).toBe(false);

  // **陽性対照**: 同じ経路で印つきの値を書けば「取り消し済み」と読まれる
  // (= この検査は「常に使用済みと答える」実装では緑にならない)。
  issue("carol");
  writeLegacyMark("carol", `${INVITATION_REVOKED_PREFIX}2026-01-02T03:04:05.678Z`);
  expect(invitationState(mustFind("carol"))).toBe("revoked");
});

// =====================================================================================
// 未使用の側も落とさない(**3値のうち残る1つ**)
// =====================================================================================

test("(V19-e) 未使用の招待は「未使用」と読める(3値のどれか1つに必ず倒れる)", () => {
  expect(issue("bob")).toHaveLength(8);
  const fresh = mustFind("bob");
  expect(fresh.usedAt).toBeNull();
  expect(invitationState(fresh)).toBe("unused");
  expect(invitationIsUsable(fresh)).toBe(true);
});

// =====================================================================================
// **【2026-09-18 追記(`V19-M2-T04`)。上の節を1バイトも消していない】**
//
// **このファイルの冒頭は「何を固定するのか(**4本ちょうど**)」と書いているが、本葉が
// **1本**足した。** **したがって今日は 4本 ではない**(旧文は判定時点の記述として残す)。
//
// **足したものは「**出し直しは前の状態を残さない**」という**決めた形**の固定である。**
//
// **【禁止の履行】これを「直した」と書かない** —— **挙動を1バイトも変えていない。**
// **固定する理由は、次に誰かがこの帰結を黙って変えたときに、ここが赤くなって気づけるように
// するためである。** **今日の帰結をそのまま検査に写しているので、この検査は実装を1行も
// 変えずに緑になった**(赤を先に見られなかったことは記録に書いた。代わりに、出し直しの SQL の
// 該当行をわざと外すと赤くなることを実際に打って示した)。
//
// **なぜ「残す」を選べないのか**(`V19-M2-T04` の (b)。**併記しない**):
// **前の状態を残すには、同じ相手の行を**複数**持つ必要がある。** **それは `ADR-0452`
// §Decision 6 の**採らなかった案 (vi)**(相手1列の主キーをやめる案)そのものであり、
// **`ADR-0336` 限定18**(同じ相手に有効な招待が2件同時に存在しないことを主キーまたは
// 一意制約で構造的に保証する)を破る。** **同 ADR の**再審査条件5** が、その提案には門A を
// 新規に課すと定めている。** **本葉は門A を通していないので、採れない。**
// **採った案 (iv)(既存の7列の値域で表す)と、この「残さない」は矛盾しない** ——
// **案 (iv) は行を1本に保つ案であり、前の状態を残す場所を**構造として持たない**。**
//
// **残る穴は `docs/plan/v19/unfixed-holes.md` `§1` に `H-V19-1` として在る。**
// =====================================================================================

/** その相手の生の行(JSON 文字列)。**表に何が残っているかを、導出を通さずに見る。** */
function rawRowJson(username: string): string {
  const db = new Database(appDbPath(dataRoot, APP_ID));
  try {
    return JSON.stringify(
      db.query(`SELECT * FROM "_auth_invitations" WHERE "username" = ?`).all(username),
    );
  } finally {
    db.close();
  }
}

test("(V19-f) 出し直しは前の状態を残さない —— 取り消した相手に出し直すと、取り消した事実がこの表から読めなくなる", () => {
  issue("bob");
  const revoked = mustRevoke("bob");
  const stateBefore = invitationState(revoked);
  expect(stateBefore).toBe("revoked");
  // **取り消しの印が、この時点では表に在る**(下で「消える」を測るための左辺である)。
  expect(rawRowJson("bob")).toContain(INVITATION_REVOKED_PREFIX);

  // --- 出し直す ---
  issue("bob");

  // **決めた形(1)**: **状態は「未使用」に戻る。** **前の状態は導出からは読めない。**
  const after = mustFind("bob");
  expect(invitationState(after)).toBe("unused");
  expect(after.usedAt).toBeNull();
  expect(invitationIsUsable(after)).toBe(true);

  // **決めた形(2)**: **行は1本のままである**(案 (vi) を採っていないので、前の行が
  // 残る場所が構造として無い。`ADR-0336` 限定18)。
  expect(store.listInvitations().filter((i) => i.username === "bob")).toHaveLength(1);

  // **決めた形(3)**: **表のどこにも、取り消しの印が1バイトも残らない。**
  // **【これが「残さない」の実体である】**
  expect(rawRowJson("bob")).not.toContain(INVITATION_REVOKED_PREFIX);

  // **陽性対照**: **「使われた」の印も、同じ経路で同じように消える** ——
  // **すなわちこれは取り消しに固有の欠落ではなく、出し直しという操作の帰結である。**
  // (この行が無いと、上の3点が「印の書き方の問題」に見えてしまう。)
  issue("carol");
  expect(store.markInvitationUsed("carol")).toBe(true);
  expect(invitationState(mustFind("carol"))).toBe("used");
  issue("carol");
  expect(invitationState(mustFind("carol"))).toBe("unused");
  expect(mustFind("carol").usedAt).toBeNull();

  // **陰性対照**: **出し直していない相手の状態は動かない**
  // (= この検査は「常に未使用と答える」実装では緑にならない)。
  issue("dave");
  const untouched = mustRevoke("dave");
  expect(invitationState(untouched)).toBe("revoked");
  expect(rawRowJson("dave")).toContain(INVITATION_REVOKED_PREFIX);
});

// =====================================================================================
// **【2026-09-18 追記(`V19-M2-T07`。独立点検の指摘2 の実測)。上の節を1バイトも消していない】**
//
// **このファイルの冒頭は「何を固定するのか(**4本ちょうど**)」と書き、`V19-M2-T04` が
// **1本**足して 5本 にした。** **本葉がさらに **2本** 足すので、今日は 7本 である**
// (旧文はどちらも判定時点の記述として残す)。
//
// **足すのは「**決めた形**」ではない** —— **今日の**壊れ方**をそのまま写した検査である。**
// **印の在る行に取り消しを掛けると、列は1バイトも書き換わらないのに、呼び出し側は
// それを知る手段を1つも持たない**(`docs/plan/v19/unfixed-holes.md` の `H-V19-5`)。
//
// **【禁止の履行】これを「直した」と書かない** —— **製品コードを1バイトも変えていない。**
// **固定する理由は、次に誰かがこの帰結を黙って変えたときに、ここが赤くなって気づけるように
// するためである。** **今日の帰結をそのまま写しているので、この2本は実装を1行も変えずに
// 緑になった**(**赤を先に見られなかった**ことは記録に書いた。代わりに、印を守っている
// `WHERE` 句をわざと外すと赤くなることを実際に打って示した)。
//
// **【本葉は挙動を1バイトも変えていない】** **戻り値を見る分岐を足したくなるが、足さない**
// —— **取り消しが効かなかったときに何を返すかを決めることになり、それは口の条文
// (`ADR-0336` 限定5 / 限定18)に当たる。** **本段の完了条件には無い。**
// =====================================================================================

test("(V19-g) 印の在る行に取り消しを掛けても、列は1バイトも書き換わらない —— 使用済みは使用済みのまま", () => {
  issue("bob");
  expect(store.markInvitationUsed("bob")).toBe(true);
  const before = mustFind("bob");
  const rawBefore = rawRowJson("bob");
  expect(invitationState(before)).toBe("used");

  // **取り消しは行を返す** —— **「そんな招待は無い」ではない**(`undefined` ではない)。
  const after = mustRevoke("bob");

  // **今日の帰結(1)**: **列は1バイトも書き換わらない。**
  expect(after.usedAt).toBe(before.usedAt);
  expect(rawRowJson("bob")).toBe(rawBefore);
  expect(after.usedAt ?? "").toMatch(BARE_ISO);
  expect(rawRowJson("bob")).not.toContain(INVITATION_REVOKED_PREFIX);

  // **今日の帰結(2)**: **状態も動かない** —— **運営者が取り消したつもりの行が
  // 「使用済み」のまま残る。**
  expect(invitationState(after)).toBe("used");
  expect(invitationIsUsable(after)).toBe(false);

  // **今日の帰結(3)**: **戻り値からは、書けなかったことを読めない。**
  // **何度呼んでも同じものが返る。**
  expect(store.revokeInvitation("bob")).not.toBeUndefined();
  expect(rawRowJson("bob")).toBe(rawBefore);

  // **陽性対照**: **印の無い行に同じ操作を掛けると、列は実際に書き換わる** ——
  // **すなわち上の3点は「取り消しそのものが壊れている」のではない。**
  issue("carol");
  expect(mustFind("carol").usedAt).toBeNull();
  const freshAfter = mustRevoke("carol");
  expect(freshAfter.usedAt).not.toBeNull();
  expect(rawRowJson("carol")).toContain(INVITATION_REVOKED_PREFIX);
  expect(invitationState(freshAfter)).not.toBe(invitationState(after));
  expect(invitationIsUsable(freshAfter)).toBe(false);
});

test("(V19-h) 2度目の取り消しは、1度目の印の時刻をそのまま残す(今の時刻に進まない)", () => {
  issue("bob");
  const first = mustRevoke("bob");
  const rawFirst = rawRowJson("bob");
  expect(first.usedAt).not.toBeNull();
  expect(rawFirst).toContain(INVITATION_REVOKED_PREFIX);

  // **間を空ける** —— **空けないと、書き換わった場合でもミリ秒が衝突して同じ値になり、
  // この検査が偽の緑になる。**
  Bun.sleepSync(5);

  const second = mustRevoke("bob");

  // **今日の帰結**: **印の時刻は1度目のままで、2度目の時刻に進まない。**
  expect(second.usedAt).toBe(first.usedAt);
  expect(rawRowJson("bob")).toBe(rawFirst);
  expect(invitationState(second)).toBe(invitationState(first));

  // **陽性対照**: **同じ待ちを挟んで別の行を取り消すと、時刻は実際に進む** ——
  // **すなわち上の「同じ値」は、時計が止まっているからではない。**
  issue("dave");
  const other = mustRevoke("dave");
  expect(other.usedAt).not.toBe(first.usedAt);
  expect(rawRowJson("dave")).toContain(INVITATION_REVOKED_PREFIX);
});
