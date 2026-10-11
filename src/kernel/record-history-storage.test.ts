/**
 * **行の変更履歴とデータの置き場**(計画 §27-3 の T09。決定 `D-V23-214`)。
 *
 * 内部表(行の変更履歴)の**有る台**(宣言した表に1件書いた後)と**無い台**(宣言はあるが、まだ1件も
 * 書いていない。M8 より前の `app.sqlite` と同じ形)の両方で、読取専用で `app.sqlite` を開く経路が落ちないことを撃つ。
 *
 * - ドライラン(`dryRunDiff`): 両方の台で通る。 有る台では、応答の `schema` に内部表の列名、`impacts` に内部表の
 *   件数(前後とも同じ。列の増減なし・影響0)が出る。 **値は出ない**(記録の中身の目印が応答に0件)。 無い台では
 *   内部表の名が応答に出ない。 どちらも本体の `app.sqlite` に内部表を作らない。
 * - 下見の写し(`createPreview`): 見本のモードでは内部表が空になる(表は残る)。 実データのモードでは本体と同じ件数。
 *   無い台ではどちらのモードでも内部表を作らない。
 * - undo の件数(`previewUndo`・`previewRedo`)・スナップショットと資材の点検(`auditAppSnapshots`・`auditAppBlobs`)・
 *   配る版の版の照合(`checkRunnerVersionGate`。内部表を作っても `user_version` は動かない)・一覧の読取
 *   (`readRecordList`)・差分の適用の読み(`change_field` の変換の可否の読み): 両方の台で通る。
 *
 * 置き場は `src/kernel`(T03・T06 と同じ理由)。
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
import { createPreview } from "../mcp/preview.ts";
import { createServerApp } from "../server/app.ts";
import { checkRunnerVersionGate } from "../server/runner-version-gate.ts";
import { seedSession, TEST_ORIGIN } from "../server/test-helpers.ts";
import { RUNNER_BUILD_VERSION } from "../shared/runner-build-version.ts";
import { dryRunDiff } from "./dry-run.ts";
import {
  appDbPath,
  applyDiff,
  applyManifest,
  createApp,
  KernelMetaStore,
  type Manifest,
  readRecordList,
} from "./index.ts";
import { auditAppBlobs, auditAppSnapshots } from "./snapshot-orphans.ts";
import { previewRedo, previewUndo } from "./undo.ts";

type Any = Record<string, unknown>;

/** 記録の中身の目印(ドライランの応答に出てはならない値)。 */
const VALUE_MARKER = "履歴の値の目印-7c3e";

function manifest(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: "履歴と置き場",
      tables: [
        {
          id: "items",
          name: "品目",
          history: true,
          fields: [
            { id: "title", name: "名前", type: "text" },
            { id: "qty", name: "数", type: "number" },
          ],
        },
      ],
      views: [],
      roles: [
        {
          id: "owner",
          name: "運営",
          rules: [
            { target: "app", can: ["write"] },
            { target: "role", can: ["write"] },
            { target: "table", table: "items", can: ["read", "write", "delete"] },
          ],
        },
        { id: "editor", name: "編集者" },
        { id: "viewer", name: "閲覧者" },
      ],
    },
  } as unknown as Manifest;
}

type Rig = { appId: string; dataRoot: string; work: string; userId: string };

const works: string[] = [];

afterEach(async () => {
  for (const dir of works.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/** `withHistory` が真なら、宣言した表に HTTP で1件作り、1回更新する(内部表に2件)。 */
async function makeRig(appId: string, withHistory: boolean): Promise<Rig> {
  const work = await mkdtemp(join(tmpdir(), "gp-rh-storage-"));
  works.push(work);
  const dataRoot = join(work, "data");
  const meta = KernelMetaStore.open(dataRoot);
  try {
    createApp(meta, "履歴と置き場", { app_id: appId });
  } finally {
    meta.close();
  }
  const applied = applyManifest(dataRoot, appId, manifest(appId));
  if (!applied.valid) {
    throw new Error(JSON.stringify(applied.errors));
  }
  // 差分を1本当てておく(undo の件数と、スナップショットの点検の材料)。
  const diff = applyDiff(dataRoot, appId, {
    diff_id: "d-memo",
    intent: "項目を足す",
    operations: [
      { op: "add_field", table: "items", field: { id: "memo", name: "メモ", type: "text" } },
    ],
  });
  if (!(diff as { valid?: boolean }).valid) {
    throw new Error(JSON.stringify(diff));
  }
  const session = seedSession(dataRoot, appId, { role: "owner", username: "boss" });
  const auth = AuthStore.openForApp(dataRoot, appId);
  let userId: string;
  try {
    userId = auth.listUsers().find((user) => user.username === "boss")?.id ?? "";
  } finally {
    auth.close();
  }
  if (withHistory) {
    const server = createServerApp({ dataRoot });
    const send = async (method: string, path: string, body: unknown, extra: Any = {}) => {
      const res = await server.request(
        new Request(`http://localhost/api/apps/${appId}${path}`, {
          method,
          headers: {
            cookie: session.cookie,
            origin: TEST_ORIGIN,
            "content-type": "application/json",
            ...(extra as Record<string, string>),
          },
          body: JSON.stringify(body),
        }),
      );
      const text = await res.text();
      return { status: res.status, body: JSON.parse(text || "{}") as Any, text };
    };
    const created = await send("POST", "/tables/items/records", {
      title: VALUE_MARKER,
      qty: 1,
    });
    expect(created.status, created.text).toBe(201);
    const id = String((created.body.record as Any)._id);
    const version = String((created.body.record as Any)._updated_at);
    const updated = await send(
      "PATCH",
      `/tables/items/records/${id}`,
      { qty: 2 },
      { "if-match": version },
    );
    expect(updated.status, updated.text).toBe(200);
  }
  return { appId, dataRoot, work, userId };
}

function historyRows(dataRoot: string, appId: string): number | null {
  const db = new Database(appDbPath(dataRoot, appId), { readonly: true });
  try {
    const exists =
      (db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '_record_history'",
        )
        .get()?.n ?? 0) > 0;
    if (!exists) {
      return null;
    }
    return db.query<{ n: number }, []>("SELECT count(*) AS n FROM _record_history").get()?.n ?? 0;
  } finally {
    db.close();
  }
}

const RIGS = [
  { label: "有る台", withHistory: true, rows: 2 },
  { label: "無い台", withHistory: false, rows: null },
] as const;

describe("(S) 内部表の有無で読取専用の経路が落ちない", () => {
  for (const { label, withHistory, rows } of RIGS) {
    test(`(S-1 ${label}) ドライラン: 通り、内部表の列名と件数だけが出て値は出ない。本体に内部表を作らない`, async () => {
      const rig = await makeRig(`rh-st-dry-${withHistory ? "h" : "n"}`, withHistory);
      expect(historyRows(rig.dataRoot, rig.appId)).toBe(rows);
      const result = dryRunDiff(rig.dataRoot, rig.appId, {
        diff_id: "d-dry",
        intent: "項目をもう1つ足す",
        operations: [
          { op: "add_field", table: "items", field: { id: "note", name: "備考", type: "text" } },
        ],
      });
      expect(result.valid, JSON.stringify(result)).toBe(true);
      if (!result.valid) return;
      const text = JSON.stringify(result.report);
      const impact = result.report.impacts.find((entry) => entry.table === "_record_history");
      if (withHistory) {
        expect(result.report.schema._record_history).toEqual([
          "seq",
          "table_id",
          "record_id",
          "op",
          "actor_id",
          "actor_login",
          "actor_role",
          "entry",
          "at",
          "changes",
        ]);
        expect(impact).toEqual({
          table: "_record_history",
          rows_before: 2,
          rows_after: 2,
          added_columns: [],
          removed_columns: [],
          affected_rows: 0,
        });
        // 記録の中身(作成の変更後の値)は応答に出ない。 陽性対照: 本体の内部表には在る。
        expect(text).not.toContain(VALUE_MARKER);
        const db = new Database(appDbPath(rig.dataRoot, rig.appId), { readonly: true });
        try {
          const changes = db
            .query<{ changes: string }, []>("SELECT changes FROM _record_history")
            .all()
            .map((row) => row.changes)
            .join("\n");
          expect(changes).toContain(VALUE_MARKER);
        } finally {
          db.close();
        }
      } else {
        expect(text).not.toContain("_record_history");
        expect(impact).toBeUndefined();
      }
      // 本体は1バイトも変えない(無い台に内部表を作らない・有る台の件数も同じ)。
      expect(historyRows(rig.dataRoot, rig.appId)).toBe(rows);
    });

    test(`(S-2 ${label}) 下見の写し: 見本のモードでは内部表が空、実データのモードでは本体と同じ件数。無い台では作らない`, async () => {
      const rig = await makeRig(`rh-st-pv-${withHistory ? "h" : "n"}`, withHistory);
      const previewRoot = join(rig.work, "previews");
      mkdirSync(previewRoot);
      const diff = {
        diff_id: "d-preview",
        intent: "下見",
        operations: [
          { op: "add_field", table: "items", field: { id: "note", name: "備考", type: "text" } },
        ],
      };
      const sample = createPreview({
        dataRoot: rig.dataRoot,
        appId: rig.appId,
        diff,
        mode: "sample",
        requesterUserId: rig.userId,
        previewRoot,
      });
      if (sample.kind !== "created") throw new Error(JSON.stringify(sample));
      expect(historyRows(sample.meta.shadow_data_root, rig.appId)).toBe(withHistory ? 0 : null);

      const real = createPreview({
        dataRoot: rig.dataRoot,
        appId: rig.appId,
        diff,
        mode: "real",
        requesterUserId: rig.userId,
        previewRoot,
      });
      if (real.kind !== "created") throw new Error(JSON.stringify(real));
      expect(historyRows(real.meta.shadow_data_root, rig.appId)).toBe(rows);
      expect(historyRows(rig.dataRoot, rig.appId)).toBe(rows);
    });

    test(`(S-3 ${label}) undo の件数・スナップショットと資材の点検・版の照合・一覧の読取・変換の可否の読みが通る`, async () => {
      const rig = await makeRig(`rh-st-ro-${withHistory ? "h" : "n"}`, withHistory);

      const undoPreview = previewUndo(rig.dataRoot, rig.appId);
      expect(undoPreview.valid, JSON.stringify(undoPreview)).toBe(true);
      expect(JSON.stringify(undoPreview)).not.toContain("_record_history");
      const redoPreview = previewRedo(rig.dataRoot, rig.appId);
      // redo の材料は無い(断りの形で返る)が、例外にならない。
      expect(typeof redoPreview.valid).toBe("boolean");

      const snapshots = auditAppSnapshots(rig.dataRoot, rig.appId);
      expect(snapshots.dangling_references).toEqual([]);
      expect(snapshots.orphans).toEqual([]);
      const blobs = auditAppBlobs(rig.dataRoot, rig.appId);
      expect(blobs.orphans).toEqual([]);

      // 内部表を作っても `user_version` は動かない(版を上げない)。
      const gate = checkRunnerVersionGate(rig.dataRoot);
      expect(gate.ok, JSON.stringify(gate)).toBe(true);
      const appVersion = gate.checked.find((db) => db.label === `apps/${rig.appId}/app.sqlite`);
      expect(appVersion?.user_version).toBe(RUNNER_BUILD_VERSION);

      const appDb = new Database(appDbPath(rig.dataRoot, rig.appId), { readonly: true });
      try {
        const list = readRecordList(
          { dataRoot: rig.dataRoot, appDb: () => appDb },
          JSON.parse(
            await Bun.file(join(rig.dataRoot, "apps", rig.appId, "manifest.json")).text(),
          ) as Manifest,
          "items",
        );
        expect(list.ok, JSON.stringify(list)).toBe(true);
        if (list.ok) {
          expect(list.value).toHaveLength(withHistory ? 1 : 0);
        }
      } finally {
        appDb.close();
      }

      // 差分の適用の読み(型の変換の可否を読取専用の接続で読む)。
      const converted = applyDiff(rig.dataRoot, rig.appId, {
        diff_id: "d-convert",
        intent: "数を文字に",
        operations: [
          { op: "change_field", table: "items", field: "qty", changes: { type: "text" } },
        ],
      });
      expect((converted as { valid?: boolean }).valid, JSON.stringify(converted)).toBe(true);
      // 差分の適用は内部表を作らず、記録も足さない。
      expect(historyRows(rig.dataRoot, rig.appId)).toBe(rows);
    });
  }
});

describe("(D) 説明書", () => {
  test("(D-1) ドライランに内部の表の列名と件数が出て値は出ないこと・見本の下見で履歴が空になることが書いてある", () => {
    const body = readFileSync(
      join(
        import.meta.dir,
        "..",
        "..",
        "plugins/smailtalk/skills/diff-shape/reference/cannot-do.md",
      ),
      "utf-8",
    );
    const start = body.indexOf("## 行の変更履歴でできないこと");
    expect(start).toBeGreaterThanOrEqual(0);
    const section = body.slice(start, body.indexOf("\n---", start));
    for (const phrase of [
      "ドライラン(`dry_run_diff`)の応答には",
      "列名(`schema`)と件数(`impacts` の前後の行数)が出る",
      "履歴の中身の値は出ない",
      "下見を見本の行で作ると、下見の中の履歴は空になる",
      "配る版と日次のバックアップには、履歴の行も入る",
    ]) {
      expect(section).toContain(phrase);
    }
    // 内部の表の名は書かない(公開の読み物)。
    expect(section).not.toMatch(/\b_record_history/);
  });
});
