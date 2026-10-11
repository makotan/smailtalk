/**
 * **下見の写しから秘密と他のアプリを消す**(`V20-M13-T02a`。計画 §10-3 / `ADR-0476` §Decision 1 の 3)。
 *
 * **固定するもの**(完了条件 17):
 * 本物に近いアプリ(パスワード・セッション・Passkey・招待・認証の途中の問い・他のアプリ・
 * 接続・外への送信・コメント・他のアプリの変更履歴)から下見を作り、**置き場の全ファイルの
 * バイト列**から既知の秘密と他のアプリの ID を探して **0件**。
 * **陽性対照**: 同じ差分を残す指定で当てただけの写し(整える前)では、同じ探し方で**当たる**
 * (探し方が空振りしていないことの証明)。
 *
 * ほかに: 残す許可リスト(`_auth_users` / `_auth_user_roles`)の中身は残る / 頼んだ人の
 * セッションが1行だけ在る / 頼んだ人を写せないときは作らずに理由を返す / `snapshots/` が無い /
 * 見本のモードでは差し込み口が呼ばれる(仮実装は作り手の表を空にする)。
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStore } from "../auth/store.ts";
import { AiCapabilityStore } from "../kernel/ai-capability-store.ts";
import { applyManifest } from "../kernel/apply-manifest.ts";
import { CapabilityStore } from "../kernel/capability-store.ts";
import { CommentStore } from "../kernel/comment-store.ts";
import { createApp } from "../kernel/create-app.ts";
import { dryRunDiff } from "../kernel/dry-run.ts";
import { KernelMetaStore } from "../kernel/meta-store.ts";
import { createRecord } from "../kernel/records.ts";
import { appDbPath, appManifestPath, appSnapshotsDir } from "../kernel/storage-paths.ts";
import type { Manifest } from "../kernel/types.ts";
import { findPreview } from "../server/preview-store.ts";
import { createPreview, PREVIEW_KEPT_AUTH_TABLES, scrubPreviewCopy } from "./preview.ts";

const APP_ID = "book-tracker";
const OTHER_APP_ID = "zz-other-secret-app";
const PASSWORD_HASH = "$argon2id$v=19$m=65536,t=2,p=1$KNOWNSALTMARKER$KNOWNHASHMARKER0001";
const OTHER_PASSWORD_HASH = "$argon2id$v=19$m=65536,t=2,p=1$OTHERSALT$OTHERHASHMARKER0002";
const PASSKEY_BYTES = new TextEncoder().encode("PASSKEY-PUBLIC-KEY-MARKER-0001");
const CONNECTION_SECRET = "ST_SECRET_ENV_MARKER_TARGET_0001";
const OTHER_CONNECTION_SECRET = "ST_SECRET_ENV_MARKER_OTHER_0002";
const OUTBOX_MARKER = "OUTBOX-PAYLOAD-MARKER-OTHER-0003";
const COMMENT_MARKER = "OTHER-APP-COMMENT-MARKER-0004";
/**
 * **対象のアプリ自身**の外への送信・コメント・AI の依頼・AI の使用量・変更履歴の意図の目印
 * (`V20-M13` 点検の処置 軽1)。`real` の写しでも消す(許可リストで届かなくても1時間ディスクに残るため)。
 */
const TARGET_OUTBOX_MARKER = "TARGET-OUTBOX-BODY-MARKER-0007";
const TARGET_COMMENT_MARKER = "TARGET-COMMENT-MARKER-0008";
const TARGET_AI_JOB_MARKER = "TARGET-AI-JOB-INPUT-MARKER-0009";
const TARGET_AI_USAGE_MARKER = "TARGET-AI-USAGE-ACTOR-MARKER-0010";
const TARGET_CHANGELOG_MARKER = "TARGET-CHANGELOG-INTENT-MARKER-0011";

let work = "";
let dataRoot = "";
let previewRoot = "";
let aliceId = "";
/** 本体に在るセッションの ID・招待の鍵・認証の途中の問い(写しに残ってはならない)。 */
let secrets: string[] = [];
/**
 * 他のアプリの `app.sqlite` に在る秘密。**他のアプリの `app.sqlite` は写しに複写されない**
 * (`createShadowRoot` の3点)ので、整える前の写しにも無い。陽性対照の対象から外し、
 * 整える前と後の両方で0件であることを別に撃つ。
 */
let otherAuthSecrets: string[] = [];

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function manifestFor(appId: string): Manifest {
  return {
    app: {
      id: appId,
      name: "蔵書管理",
      tables: [
        {
          id: "books",
          name: "本",
          fields: [{ id: "title", name: "タイトル", type: "text", required: true }],
        },
      ],
      views: [{ id: "book-list", type: "list_view", table: "books", columns: ["title"] }],
    },
  };
}

function seedApp(store: KernelMetaStore, appId: string): void {
  createApp(store, "蔵書管理", { app_id: appId });
  const applied = applyManifest(dataRoot, appId, manifestFor(appId));
  if (!applied.valid) {
    throw new Error("テスト前提の初期マニフェスト投入に失敗しました。");
  }
  const db = new Database(appDbPath(dataRoot, appId), { readwrite: true, create: false });
  try {
    const manifest = JSON.parse(readFileSync(appManifestPath(dataRoot, appId), "utf-8"));
    const created = createRecord(db, manifest, "books", { title: `${appId} の本` });
    if (!created.ok) throw new Error("行の投入に失敗しました。");
  } finally {
    db.close();
  }
}

function additiveDiff(diffId = "d-preview"): unknown {
  return {
    diff_id: diffId,
    intent: "本に ISBN を持たせたい",
    operations: [
      { op: "add_field", table: "books", field: { id: "isbn", name: "ISBN", type: "text" } },
    ],
  };
}

/** 置き場の全ファイルのバイト列を連結する(文字列として探す)。 */
function allBytes(dir: string): string {
  const chunks: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else chunks.push(readFileSync(p).toString("latin1"));
    }
  };
  walk(dir);
  return chunks.join("\n");
}

/** 探すものの全部(秘密 + 他のアプリの ID と中身)。 */
function needles(): string[] {
  return [
    PASSWORD_HASH,
    toBase64Url(PASSKEY_BYTES),
    CONNECTION_SECRET,
    OTHER_CONNECTION_SECRET,
    OUTBOX_MARKER,
    COMMENT_MARKER,
    OTHER_APP_ID,
    TARGET_OUTBOX_MARKER,
    TARGET_COMMENT_MARKER,
    TARGET_AI_JOB_MARKER,
    TARGET_AI_USAGE_MARKER,
    TARGET_CHANGELOG_MARKER,
    ...secrets,
  ];
}

function hits(dir: string): string[] {
  const hay = allBytes(dir);
  return needles().filter((needle) => hay.includes(needle));
}

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "gp-preview-scrub-"));
  dataRoot = join(work, "data");
  previewRoot = join(work, "previews");
  const kernel = KernelMetaStore.open(dataRoot);
  try {
    seedApp(kernel, APP_ID);
    seedApp(kernel, OTHER_APP_ID);
  } finally {
    kernel.close();
  }
  // 他のアプリの変更履歴(`changelog` に OTHER_APP_ID が載る)。
  const otherApplied = dryRunDiff(dataRoot, OTHER_APP_ID, additiveDiff("d-other")); // 本体は不変
  expect(otherApplied.valid).toBe(true);
  const { applyDiff } = await import("../kernel/apply-diff.ts");
  expect(applyDiff(dataRoot, OTHER_APP_ID, additiveDiff("d-other-real")).valid).toBe(true);

  secrets = [];
  const auth = AuthStore.openForApp(dataRoot, APP_ID);
  try {
    const alice = auth.createUser({ username: "alice", role: "owner" });
    aliceId = alice.id;
    const bob = auth.createUser({ username: "bob", role: "editor" });
    auth.grantRole(bob.id, "viewer");
    auth.setPassword(alice.id, PASSWORD_HASH);
    secrets.push(auth.createSession(alice.id, 3600).id);
    secrets.push(auth.createSession(bob.id, 3600).id);
    auth.addWebauthnCredential({
      id: "cred-marker-0005",
      userId: bob.id,
      publicKey: PASSKEY_BYTES,
      counter: 0,
    });
    secrets.push("cred-marker-0005");
    secrets.push(
      auth.issueInvitation({ username: "carol", role: "viewer", issuedBy: alice.id }).code,
    );
    secrets.push(
      auth.savePendingChallenge({
        challenge: "CHALLENGE-MARKER-0006",
        purpose: "authentication",
        ttlSec: 300,
      }).id,
    );
    secrets.push("CHALLENGE-MARKER-0006");
  } finally {
    auth.close();
  }
  const other = AuthStore.openForApp(dataRoot, OTHER_APP_ID);
  try {
    const dave = other.createUser({ username: "dave", role: "owner" });
    other.setPassword(dave.id, OTHER_PASSWORD_HASH);
    otherAuthSecrets = [OTHER_PASSWORD_HASH, other.createSession(dave.id, 3600).id];
  } finally {
    other.close();
  }
  const caps = CapabilityStore.openForKernel(dataRoot);
  try {
    const targetConn = caps.createConnection({
      appId: APP_ID,
      name: "mail",
      allowedHosts: ["mail.example.com"],
      secretSource: { kind: "env", value: CONNECTION_SECRET },
    });
    caps.enqueueOutbox({
      appId: APP_ID,
      connectionId: targetConn.id,
      destination: "https://mail.example.com/send",
      payload: { body: TARGET_OUTBOX_MARKER },
    });
    const otherConn = caps.createConnection({
      appId: OTHER_APP_ID,
      name: "mail",
      allowedHosts: ["mail.example.com"],
      secretSource: { kind: "env", value: OTHER_CONNECTION_SECRET },
    });
    caps.enqueueOutbox({
      appId: OTHER_APP_ID,
      connectionId: otherConn.id,
      destination: "https://mail.example.com/send",
      payload: { body: OUTBOX_MARKER },
    });
  } finally {
    caps.close();
  }
  const comments = CommentStore.openForKernel(dataRoot);
  try {
    comments.addComment({
      appId: OTHER_APP_ID,
      anchorForm: "view",
      anchorParts: ["book-list"],
      body: COMMENT_MARKER,
    });
    comments.addComment({
      appId: APP_ID,
      anchorForm: "view",
      anchorParts: ["book-list"],
      body: TARGET_COMMENT_MARKER,
    });
  } finally {
    comments.close();
  }
  const ai = AiCapabilityStore.openForKernel(dataRoot);
  try {
    ai.enqueueJob({
      appId: APP_ID,
      capabilityId: "cap-target",
      workflowId: "wf-target",
      actor: null,
      prompt: "要約して",
      input: { text: TARGET_AI_JOB_MARKER },
      outputField: "title",
      fallback: "",
      targetTable: "books",
      targetRecordId: "r-1",
      chainDepth: 0,
    });
    ai.recordUsage({
      appId: APP_ID,
      capabilityId: "cap-target",
      workflowId: "wf-target",
      actor: TARGET_AI_USAGE_MARKER,
      model: "model-x",
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      status: "success",
      usageDate: "2026-09-26",
      calledAt: "2026-09-26T00:00:00.000Z",
    });
  } finally {
    ai.close();
  }
  // 対象のアプリの変更履歴(意図の本文に目印)。
  expect(
    applyDiff(dataRoot, APP_ID, {
      diff_id: "d-target-intent",
      intent: TARGET_CHANGELOG_MARKER,
      operations: [
        { op: "add_field", table: "books", field: { id: "memo", name: "メモ", type: "text" } },
      ],
    }).valid,
  ).toBe(true);
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("写しのバイト列に秘密と他のアプリが0件(完了条件 17)", () => {
  test("陽性対照: 整える前の写し(残す指定で当てただけ)では当たる", async () => {
    const keepParent = join(work, "raw");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(keepParent);
    const raw = dryRunDiff(dataRoot, APP_ID, additiveDiff(), { keepUnder: keepParent });
    expect(raw.valid).toBe(true);
    const found = hits(keepParent);
    // 全カテゴリが当たる(探し方が空振りしていない)。
    expect(found).toEqual(needles());
    // 他のアプリの app.sqlite は複写されないので、整える前から0件。
    const hay = allBytes(keepParent);
    expect(otherAuthSecrets.filter((needle) => hay.includes(needle))).toEqual([]);
    expect(otherAuthSecrets).toHaveLength(2);
  });

  test("整えた後の写しの置き場では0件", () => {
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    expect(result.kind).toBe("created");
    if (result.kind !== "created") return;
    expect(hits(join(previewRoot, result.meta.preview_id))).toEqual([]);
    const hay = allBytes(join(previewRoot, result.meta.preview_id));
    expect(otherAuthSecrets.filter((needle) => hay.includes(needle))).toEqual([]);
    // 本体からは消えていない(本体は1バイトも変えない)。
    expect(allBytes(dataRoot).includes(PASSWORD_HASH)).toBe(true);
  });
});

describe("real でも対象のアプリの本文・履歴・使用量を消す(`V20-M13` 点検の処置 軽1)", () => {
  test("real の写しの kernel.sqlite に、対象のアプリの outbox・コメント・AI の依頼と使用量・変更履歴が0行で、設定の表(接続)は残る", () => {
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    if (result.kind !== "created") throw new Error(JSON.stringify(result));
    const db = new Database(join(result.meta.shadow_data_root, "kernel.sqlite"), {
      readonly: true,
    });
    try {
      const counts: Record<string, number> = {};
      for (const t of ["outbox", "gp_comments", "ai_jobs", "ai_usage", "changelog"]) {
        counts[t] = (db.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
      }
      expect(counts).toEqual({ outbox: 0, gp_comments: 0, ai_jobs: 0, ai_usage: 0, changelog: 0 });
      const conn = db.query(`SELECT COUNT(*) AS n FROM "connections"`).get() as { n: number };
      expect(conn.n).toBe(1);
      expect(db.query(`SELECT "app_id" FROM "apps"`).all()).toEqual([{ app_id: APP_ID }]);
    } finally {
      db.close();
    }
    // 陽性対照: 本体には対象のアプリの行が在る(消したのは写しだけ)。
    const main = new Database(join(dataRoot, "kernel.sqlite"), { readonly: true });
    try {
      for (const t of ["outbox", "gp_comments", "ai_jobs", "ai_usage", "changelog"]) {
        const n = (
          main.query(`SELECT COUNT(*) AS n FROM "${t}" WHERE "app_id" = ?`).get(APP_ID) as {
            n: number;
          }
        ).n;
        expect(n, t).toBeGreaterThan(0);
      }
    } finally {
      main.close();
    }
  });
});

describe("写しの中身", () => {
  test("許可リストの表は残り、それ以外の _auth_* は空、頼んだ人のセッションが1行だけ在る", () => {
    expect([...PREVIEW_KEPT_AUTH_TABLES].sort()).toEqual(["_auth_user_roles", "_auth_users"]);
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    if (result.kind !== "created") throw new Error(JSON.stringify(result));
    const meta = findPreview(previewRoot, result.meta.preview_id);
    expect(meta).not.toBeNull();
    const db = new Database(appDbPath(result.meta.shadow_data_root, APP_ID), { readonly: true });
    try {
      const count = (t: string) =>
        (db.query(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
      expect(count("_auth_users")).toBe(2);
      expect(count("_auth_user_roles")).toBe(1);
      for (const t of [
        "_auth_password_credentials",
        "_auth_webauthn_credentials",
        "_auth_pending_challenges",
        "_auth_invitations",
        "_auth_activity",
      ]) {
        expect(count(t)).toBe(0);
      }
      const sessions = db
        .query(`SELECT "id", "user_id", "expires_at" FROM "_auth_sessions"`)
        .all() as {
        id: string;
        user_id: string;
        expires_at: string;
      }[];
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.user_id).toBe(aliceId);
      expect(sessions[0]?.id).toBe(result.meta.session_id);
      expect(sessions[0]?.expires_at).toBe(result.meta.expires_at);
      // 当てた後の姿である(列が足されている)。
      const cols = (db.query(`PRAGMA table_info("books")`).all() as { name: string }[]).map(
        (c) => c.name,
      );
      expect(cols).toContain("isbn");
      expect(count("books")).toBe(1);
    } finally {
      db.close();
    }
    // snapshots/ は置き場ごと無い。
    expect(existsSync(appSnapshotsDir(result.meta.shadow_data_root, APP_ID))).toBe(false);
  });

  test("kernel.sqlite には対象のアプリの行だけが残り、接続の資格情報の欄は空", () => {
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    if (result.kind !== "created") throw new Error(JSON.stringify(result));
    const db = new Database(join(result.meta.shadow_data_root, "kernel.sqlite"), {
      readonly: true,
    });
    try {
      const tables = (
        db
          .query(
            `SELECT "name" FROM "sqlite_master" WHERE "type"='table' AND "name" NOT LIKE 'sqlite_%'`,
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
      for (const t of tables) {
        const cols = (db.query(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map(
          (c) => c.name,
        );
        if (cols.includes("app_id")) {
          const other = db
            .query(`SELECT COUNT(*) AS n FROM "${t}" WHERE "app_id" IS NOT ?`)
            .get(APP_ID) as {
            n: number;
          };
          expect(`${t}:${other.n}`).toBe(`${t}:0`);
        }
      }
      const apps = db.query(`SELECT "app_id" FROM "apps"`).all() as { app_id: string }[];
      expect(apps.map((a) => a.app_id)).toEqual([APP_ID]);
      const conn = db.query(`SELECT "secret_source_value" FROM "connections"`).all() as {
        secret_source_value: string;
      }[];
      expect(conn).toHaveLength(1);
      expect(conn[0]?.secret_source_value).toBe("");
    } finally {
      db.close();
    }
  });

  test("WAL は空になっている(消した行が WAL に残らない)", () => {
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    if (result.kind !== "created") throw new Error(JSON.stringify(result));
    for (const p of [
      `${appDbPath(result.meta.shadow_data_root, APP_ID)}-wal`,
      `${join(result.meta.shadow_data_root, "kernel.sqlite")}-wal`,
    ]) {
      if (existsSync(p)) {
        expect(statSync(p).size).toBe(0);
      }
    }
  });
});

describe("断る側", () => {
  test("頼んだ人を写しの利用者に写せないときは、作らずに理由を返す(置き場も残さない)", () => {
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "real",
      requesterUserId: "no-such-user",
      previewRoot,
    });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.reason).toContain("写せなかった");
    expect(existsSync(previewRoot) ? readdirSync(previewRoot) : []).toEqual([]);
  });

  test("scrubPreviewCopy を直に呼んでも、写せない利用者なら何も足さない", async () => {
    const keepParent = join(work, "raw2");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(keepParent);
    const raw = dryRunDiff(dataRoot, APP_ID, additiveDiff(), { keepUnder: keepParent });
    if (!raw.valid || raw.kept === undefined) throw new Error("kept が無い");
    const scrubbed = scrubPreviewCopy({
      shadowDataRoot: raw.kept.data_root,
      appId: APP_ID,
      requesterUserId: "no-such-user",
      sessionExpiresAt: new Date().toISOString(),
    });
    expect(scrubbed.ok).toBe(false);
  });

  test("拒否される差分では置き場を残さず、errors は残す指定の無いドライランと同じ", () => {
    const bad = {
      diff_id: "d-bad",
      intent: "無い表に列を足す",
      operations: [
        { op: "add_field", table: "ghosts", field: { id: "x", name: "X", type: "text" } },
      ],
    };
    const plain = dryRunDiff(dataRoot, APP_ID, bad);
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: bad,
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
    });
    expect(result.kind).toBe("rejected");
    if (result.kind !== "rejected" || plain.valid) return;
    expect(result.errors).toEqual(plain.errors);
    expect(existsSync(previewRoot) ? readdirSync(previewRoot) : []).toEqual([]);
  });
});

describe("見本のモードの差し込み口(T02a は仮実装・T03 で見本を入れる)", () => {
  test("sample では差し込み口が当てた後のマニフェストで呼ばれ、既定は作り手の表を見本の5行にする", () => {
    const calls: string[] = [];
    const spied = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "sample",
      requesterUserId: aliceId,
      previewRoot,
      fillSample: (root, appId, manifest) => {
        calls.push(
          `${appId}:${manifest.app.tables.map((t) => t.id).join(",")}:${existsSync(root)}`,
        );
      },
    });
    expect(spied.kind).toBe("created");
    expect(calls).toEqual([`${APP_ID}:books:true`]);

    const byDefault = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "sample",
      requesterUserId: aliceId,
      previewRoot,
    });
    if (byDefault.kind !== "created") throw new Error(JSON.stringify(byDefault));
    expect(byDefault.meta.mode).toBe("sample");
    const db = new Database(appDbPath(byDefault.meta.shadow_data_root, APP_ID), { readonly: true });
    try {
      // 【V20-M13-T03 で書き換えた期待値。旧: `.toBe(0)`(T02a の仮実装は作り手の表を空にするだけだった)】
      // 既定の差し込み口は見本の行を5行入れる(`fillSampleCopy`)。実データの1行は残らない。
      expect((db.query(`SELECT COUNT(*) AS n FROM "books"`).get() as { n: number }).n).toBe(5);
      expect(
        (
          db.query(`SELECT COUNT(*) AS n FROM "books" WHERE "title" LIKE '%の本'`).get() as {
            n: number;
          }
        ).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  test("real では差し込み口を呼ばない", () => {
    const calls: string[] = [];
    createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "real",
      requesterUserId: aliceId,
      previewRoot,
      fillSample: () => {
        calls.push("called");
      },
    });
    expect(calls).toEqual([]);
  });
});

describe("V20-M15 点検 中1: stripDesignChoices が断る分岐を守る", () => {
  test("choices を外すと patterns の空配列だけが残って検証に落ち、下見は refused。理由に置き場の絶対パスを含まず、置き場を1つも残さない", () => {
    const beforeManifestBytes = readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8");
    const result = createPreview({
      dataRoot,
      appId: APP_ID,
      diff: additiveDiff(),
      mode: "sample",
      requesterUserId: aliceId,
      previewRoot,
      // 写しの manifest.json を、choices を外すと patterns の空配列だけが残る形に壊す
      // (stripDesignChoices が読む対象そのものを、fillSample がそれより先に書き換える)。
      fillSample: (root, appId, manifest) => {
        const path = appManifestPath(root, appId);
        const patched = {
          ...manifest,
          app: {
            ...manifest.app,
            design_memory: { choices: [{ name: "x", tradeoff: "y" }], patterns: [] },
          },
        };
        writeFileSync(path, `${JSON.stringify(patched, null, 2)}\n`, "utf-8");
      },
    });
    if (result.kind !== "refused") throw new Error(JSON.stringify(result));
    // 断ったのが stripDesignChoices の理由であること(他の断りで緑にならない)。
    expect(result.reason).toContain(
      "選んだ記録(design_memory.choices)を外した定義を確かめられなかった",
    );
    expect(result.reason).not.toContain(previewRoot);
    expect(result.reason).not.toContain(dataRoot);
    // 下見の置き場の根に、下見のディレクトリが1つも残らない。
    expect(existsSync(previewRoot) ? readdirSync(previewRoot) : []).toEqual([]);
    // 本物のアプリの定義は1バイトも変わらない。
    expect(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")).toBe(beforeManifestBytes);
  });
});
