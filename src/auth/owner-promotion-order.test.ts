import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appDbPath } from "../kernel/storage-paths.ts";
import { AuthStore, randomId } from "./store.ts";

/**
 * `V9-M11-T05` / `X-G37` / `ADR-0356`。
 *
 * **同じミリ秒に作られた2人のうち、どちらが owner に昇格するかが毎回同じに決まることを、
 * 「揺れではなく機構」で測る**(`ADR-0356` 限定5)。
 *
 * **【この検査が「N回打って落ちなかった」ではないこと】**
 * `created_at` を**明示的に同じ値**にして2人を入れ、**`id` は先に INSERT した側が
 * 辞書順で**後**になるように選ぶ。**したがって第2キーが `"id" ASC` のままなら、この検査は
 * 毎回**赤くなる**(偶然緑になることが無い)。第2キーが `rowid ASC` になって初めて緑になる。
 *
 * **【測っていないこと】**
 * - **同じミリ秒に3人以上入れた場合は1度も測っていない**(`ADR-0356` 限界1)。
 * - **`rowid` が `deleteUser` / 移行 / `VACUUM` を挟んでも挿入順を保つことは測っていない**
 *   (`ADR-0356`「この決定が保証しないこと」4・5)。各反復は**新しい app.sqlite** を立てる。
 * - **同着の起きやすさ**(`ADR-0356` の実測 (A) `227/300` と (B) `298/300`)は**打ち直していない。**
 *   本検査は同着を**人工的に起こす**ので、起きやすさに依存しない。
 */

/** 何回繰り返すか。**毎回同じ側が選ばれることを示す。** */
const N = 200;

/** 2人に与える、**まったく同じ** `created_at`(ミリ秒精度)。 */
const SAME_CREATED_AT = "2026-08-18T00:00:00.000Z";

/** kernel の create-app に倣って、DELETE モードの空 app.sqlite を用意する。 */
function makeAppSqlite(dataRoot: string, appId: string): void {
  mkdirSync(join(dataRoot, "apps", appId), { recursive: true });
  const db = new Database(appDbPath(dataRoot, appId), { create: true });
  try {
    db.exec("PRAGMA journal_mode = DELETE;");
  } finally {
    db.close();
  }
}

/**
 * **先に INSERT する側の `id` が、辞書順で**後**になる2つの `id`** を返す。
 *
 * `randomId()` は32バイト乱数の base64url なので、素で使うと辞書順は毎回入れ替わる。
 * **並べ替えて役割を固定する**ことで、「現行の `"id" ASC` でも偶然正しい答えが出る」
 * 経路を塞ぐ。
 */
function idsWithFirstInsertedSortingLast(): { firstId: string; secondId: string } {
  let a = randomId();
  let b = randomId();
  while (a === b) {
    b = randomId();
  }
  if (a < b) {
    [a, b] = [b, a];
  }
  // ここで a > b(辞書順)。先に INSERT する側に a を与える。
  return { firstId: a, secondId: b };
}

/** 同じ `created_at` を持つ2人を、**この順で** INSERT する(別接続。実物の表に直接入れる)。 */
function insertTwoUsersAtTheSameMillisecond(
  dataRoot: string,
  appId: string,
  firstId: string,
  secondId: string,
): void {
  const raw = new Database(appDbPath(dataRoot, appId));
  try {
    const insert = raw.query(
      `INSERT INTO "_auth_users" ("id", "username", "display_name", "role", "created_at")
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run(firstId, "first-inserted", "first", "viewer", SAME_CREATED_AT);
    insert.run(secondId, "second-inserted", "second", "viewer", SAME_CREATED_AT);
  } finally {
    raw.close();
  }
}

describe("owner 昇格の並び(X-G37 / ADR-0356)", () => {
  test(`同じミリ秒の2人 —— 昇格するのは先に INSERT された側。${N} 回とも同じ`, async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-owner-promotion-order-"));
    let firstInsertedWon = 0;
    let secondInsertedWon = 0;
    try {
      for (let i = 0; i < N; i += 1) {
        const appId = `app-promotion-${i}`;
        makeAppSqlite(dataRoot, appId);
        const store = AuthStore.openForApp(dataRoot, appId);
        try {
          const { firstId, secondId } = idsWithFirstInsertedSortingLast();
          insertTwoUsersAtTheSameMillisecond(dataRoot, appId, firstId, secondId);
          // 前提: 2人とも viewer なので owner は0人。ここで初めて自己修復が働く。
          expect(store.countOwners()).toBe(0);
          store.ensureOwnerExists();
          expect(store.countOwners()).toBe(1);
          if (store.findUserById(firstId)?.role === "owner") {
            firstInsertedWon += 1;
          }
          if (store.findUserById(secondId)?.role === "owner") {
            secondInsertedWon += 1;
          }
        } finally {
          store.close();
        }
      }
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
    console.log(
      `[X-G37] ensureOwnerExists: N=${N} / 先に INSERT した側が昇格=${firstInsertedWon} / 後に INSERT した側が昇格=${secondInsertedWon}`,
    );
    expect(firstInsertedWon).toBe(N);
    expect(secondInsertedWon).toBe(0);
  });

  test(`同じミリ秒の2人 —— 利用者一覧の先頭も先に INSERT された側。${N} 回とも同じ`, async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-owner-promotion-order-list-"));
    let firstInsertedHead = 0;
    let secondInsertedHead = 0;
    try {
      for (let i = 0; i < N; i += 1) {
        const appId = `app-list-${i}`;
        makeAppSqlite(dataRoot, appId);
        const store = AuthStore.openForApp(dataRoot, appId);
        try {
          const { firstId, secondId } = idsWithFirstInsertedSortingLast();
          insertTwoUsersAtTheSameMillisecond(dataRoot, appId, firstId, secondId);
          const head = store.listUsers()[0];
          if (head?.id === firstId) {
            firstInsertedHead += 1;
          }
          if (head?.id === secondId) {
            secondInsertedHead += 1;
          }
        } finally {
          store.close();
        }
      }
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
    console.log(
      `[X-G37] listUsers: N=${N} / 先頭が先に INSERT した側=${firstInsertedHead} / 先頭が後に INSERT した側=${secondInsertedHead}`,
    );
    expect(firstInsertedHead).toBe(N);
    expect(secondInsertedHead).toBe(0);
  });

  test("一覧の先頭と、昇格する1人が一致する(同じミリ秒の2人。D-V9-23 のユーザ決定)", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "gp-owner-promotion-order-agree-"));
    try {
      const appId = "app-agree";
      makeAppSqlite(dataRoot, appId);
      const store = AuthStore.openForApp(dataRoot, appId);
      try {
        const { firstId, secondId } = idsWithFirstInsertedSortingLast();
        insertTwoUsersAtTheSameMillisecond(dataRoot, appId, firstId, secondId);
        const head = store.listUsers()[0];
        store.ensureOwnerExists();
        const promoted = store.listUsers().find((u) => u.role === "owner");
        expect(promoted?.id).toBe(head?.id);
        expect(promoted?.id).toBe(firstId);
        expect(promoted?.id).not.toBe(secondId);
      } finally {
        store.close();
      }
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
