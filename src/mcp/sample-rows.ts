/**
 * **見本の行を作る純粋関数**(`V20-M13-T03`。計画 §9-5・§10-6 / `D-V20-44`「見本だけにする」)。
 *
 * マニフェストと、下見を頼んだ人の利用者 ID を受けて、**表ごとの見本の行の並び**を返す。
 * **DB もファイルも読まない。時計も乱数も使わない**(同じ入力で同じ出力)。
 * 行を写しに入れるのは `src/mcp/preview.ts` の `insertSamplePlan`(生の SQL)である。
 *
 * **置き場は `src/mcp/`**(計画 §10-6: `src/kernel/` に置かない)。
 *
 * ## 型ごとの見本(`i` は表の中の 1 始まりの行番号)
 *
 * | 型 | 見本 |
 * |---|---|
 * | `text` | `見本 i` |
 * | `long_text` | `見本の長文 i` |
 * | `number` | `i × 10` |
 * | `boolean` | 奇数の行は真・偶数の行は偽(交互) |
 * | `date` | `2026-01-01` から1日ずつ |
 * | `select` | 選択肢の並びの順に回す |
 * | `reference` | 参照先の見本の行を順に指す(依存の順に作る。自己参照・循環・作り手の表の外は空) |
 * | `image` / `file` | 空(写しに `blobs/` が無い) |
 *
 * ## 開けた制約(マニフェストの項目のキーの全量から)
 *
 * 項目が宣言できる制約は **型・`required`・`unique`(`true` / `"owner"`)・`select` の選択肢・
 * `reference` の参照先** だけである(値域・最小最大・パターンを書くキーは無い)。
 * 見本は選択肢の中から選び、参照は実在する見本の行を指し、一意の欄は重ならない値にする。
 * **満たせない値は空(`null`)にし、{@link SampleGap} に理由を書く**(必須の欄なら、その行は
 * カーネルの検証では「必須です」で落ちる形のまま写しに入る —— 画面で空の欄として見える)。
 *
 * ## 持ち主と付与
 *
 * - `st_owner`(文字)の欄は、全行を頼んだ人にする(個人スコープの表で頼んだ人に見える)。
 * - アクセス権管理を有効にして宣言した表(`ADR-0299`。宣言の読み手はサーバの `accessControlOf` 1本)は、利用者の表(`members.table`)の1行目の
 *   ログインアカウントを頼んだ人にし、付与の表(`grant.table`)に**見本の行1本につき付与1行**を
 *   作成者の権限(`creator_permission`)で入れる(相手はその名簿の1行目。グループだけで渡す形は
 *   今日のカーネルが定義ごと断るので、相手は空にして理由を書く)。**付与の表の行数は「使う表の数 × 5」になる**
 *   (1つの付与の表を複数の表が使えるため。対象の欄はその行が渡す表の欄だけを埋め、他の表の
 *   対象の欄は空にする —— 1行で別の表の行にも渡さないため)。
 */

import { createHash } from "node:crypto";
import type { Field, Manifest, Table } from "../kernel/types.ts";
import { type AccessControlDeclaration, accessControlOf } from "../server/owner-scope.ts";

/** 表ごとの見本の行数(`D-V20-44`「決まった数の見本の行」)。 */
export const SAMPLE_ROWS_PER_TABLE = 5;

/** 日付の見本の起点。 */
export const SAMPLE_BASE_DATE = "2026-01-01";

/** 行の作成・更新時刻の見本の起点(1行ごとに1分ずつ進める)。 */
const SAMPLE_BASE_TIMESTAMP_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

/** 行の持ち主の欄の綴り(`src/server/owner-scope.ts` の `OWNER_FIELD` と同じ)。 */
const OWNER_FIELD = "st_owner";

/**
 * **【`V23-M4-T05`】更新者の欄の綴り**(`src/server/owner-scope.ts` の `UPDATED_BY_FIELD` と同じ)。
 * 見本の行は生の SQL で入れる(カーネルが押さない)ので、持ち主と同じく頼んだ人にする
 * (型が text で必須でないときだけ。それ以外はただの項目の見本)。
 */
const UPDATED_BY_FIELD = "st_updated_by";

export type SampleValue = string | number | boolean | null;

export type SampleRow = {
  _id: string;
  _created_at: string;
  _updated_at: string;
  /** 欄 ID → 見本の値(カーネルの `createRecord` にそのまま渡せる論理値。真偽は `true` / `false`)。 */
  values: Record<string, SampleValue>;
};

export type SampleTable = { table: string; rows: SampleRow[] };

/** 見本の値を空にした理由の種類。 */
export type SampleGapKind =
  /** 画像・添付(写しに `blobs/` が無い)。 */
  | "no_blobs"
  /** 自分の表を指す参照。 */
  | "self_reference"
  /** 参照の循環を切った欄。 */
  | "cycle"
  /** 作り手の表でない表を指す参照。 */
  | "reference_outside"
  /** 一意の欄で、重ならない値が尽きた(真偽は2つ・選択肢はその数・付与の相手は1人)。 */
  | "unique_exhausted"
  /** 作成者の権限が付与の表の権限の選択肢に無い。 */
  | "grant_permission_not_option"
  /** 付与の相手を名簿の行で決められない(利用者の表・グループの欄が宣言に無い)。 */
  | "grant_unreachable"
  /** 1つの付与の表を複数の表が使うとき、他の表の対象の欄が必須で空にできない。 */
  | "grant_shared_target_required";

export type SampleGap = {
  table: string;
  field: string;
  kind: SampleGapKind;
  /** 空にした行の番号(1 始まり)。 */
  rows: number[];
  /** その欄が必須か(必須なら、その行はカーネルの検証では「必須です」で落ちる)。 */
  required: boolean;
  reason: string;
};

export type SamplePlan = {
  /** 依存の順(参照先が先)。 */
  tables: SampleTable[];
  gaps: SampleGap[];
};

const GAP_REASON: Record<SampleGapKind, string> = {
  no_blobs: "下見の写しには画像・添付の実体(blobs)が無いので、画像・添付の欄は空にしました。",
  self_reference: "自分の表を指す参照は、見本では空にしました(行を作る順が決まらないため)。",
  cycle: "参照が循環しているので、この欄で循環を切って空にしました。",
  reference_outside: "作り手の表でない表を指す参照なので、見本の行を指せず空にしました。",
  unique_exhausted: "一意の欄で、重ならない見本の値が尽きたので、この行は空にしました。",
  grant_permission_not_option:
    "作成者の権限が付与の表の権限の選択肢に無いので、付与の権限を空にしました(この表の見本は頼んだ人に見えない場合があります)。",
  grant_unreachable:
    "付与の相手を名簿の行で決められないので、付与の相手を空にしました(この表の見本は頼んだ人に見えない場合があります)。",
  grant_shared_target_required:
    "1つの付与の表を複数の表が使っていて、他の表の対象の欄が必須なので、空にできずに空のまま残しました。",
};

/** 表と行番号から決まる行 ID(UUID の形。同じ入力で同じ値)。 */
export function sampleRowId(tableId: string, index: number): string {
  const hex = createHash("sha256")
    .update(`smailtalk-sample\u0000${tableId}\u0000${index}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function timestampOf(index: number): string {
  return new Date(SAMPLE_BASE_TIMESTAMP_MS + (index - 1) * 60_000).toISOString();
}

function dateOf(index: number): string {
  const base = Date.parse(`${SAMPLE_BASE_DATE}T00:00:00Z`);
  return new Date(base + (index - 1) * 86_400_000).toISOString().slice(0, 10);
}

type AccessControl = AccessControlDeclaration;

/** 有効な宣言だけを返す(読み手はサーバの {@link accessControlOf}。宣言の綴りをここに写さない)。 */
function enabledAccessControl(table: Table): AccessControl | undefined {
  return accessControlOf(table);
}

/**
 * 見本の行を作る。**純粋関数**(DB もファイルも時計も乱数も使わない。入力を書き換えない)。
 */
export function buildSampleRows(manifest: Manifest, requesterUserId: string): SamplePlan {
  const tables = manifest.app.tables;
  const byId = new Map(tables.map((t) => [t.id, t]));

  // --- 付与の表: どの表の付与を受けるか(マニフェストの順)----------------------------
  const grantUsers = new Map<string, Table[]>();
  for (const table of tables) {
    const declared = enabledAccessControl(table);
    const grantTable = declared?.grant?.table;
    if (declared === undefined || grantTable === undefined || !byId.has(grantTable)) continue;
    grantUsers.set(grantTable, [...(grantUsers.get(grantTable) ?? []), table]);
  }

  const rowCount = (tableId: string): number =>
    SAMPLE_ROWS_PER_TABLE * Math.max(1, grantUsers.get(tableId)?.length ?? 0);

  // --- 依存の順(深さ優先・マニフェストの順。戻りの辺は切る)------------------------
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const cut = new Map<string, SampleGapKind>(); // `${table}\u0000${field}` → 理由
  const visit = (table: Table): void => {
    state.set(table.id, "visiting");
    for (const field of table.fields) {
      if (field.type !== "reference") continue;
      const key = `${table.id}\u0000${field.id}`;
      const target = byId.get(field.reference_table);
      if (field.reference_table === table.id) {
        cut.set(key, "self_reference");
      } else if (target === undefined) {
        cut.set(key, "reference_outside");
      } else if (state.get(target.id) === "visiting") {
        cut.set(key, "cycle");
      } else if (state.get(target.id) === undefined) {
        visit(target);
      }
    }
    state.set(table.id, "done");
    order.push(table.id);
  };
  for (const table of tables) {
    if (state.get(table.id) === undefined) visit(table);
  }

  const gaps: SampleGap[] = [];
  const gapIndex = new Map<string, SampleGap>();
  const addGap = (table: Table, field: Field, kind: SampleGapKind, row: number): void => {
    const key = `${table.id}\u0000${field.id}\u0000${kind}`;
    const existing = gapIndex.get(key);
    if (existing !== undefined) {
      if (!existing.rows.includes(row)) existing.rows.push(row);
      return;
    }
    const gap: SampleGap = {
      table: table.id,
      field: field.id,
      kind,
      rows: [row],
      required: field.required === true,
      reason: GAP_REASON[kind],
    };
    gapIndex.set(key, gap);
    gaps.push(gap);
  };

  // --- 1. 型ごとの見本 -----------------------------------------------------------
  const valueFor = (table: Table, field: Field, index: number): SampleValue => {
    switch (field.type) {
      case "text":
        return field.id === OWNER_FIELD ||
          (field.id === UPDATED_BY_FIELD && field.required !== true)
          ? requesterUserId
          : `見本 ${index}`;
      case "long_text":
        return `見本の長文 ${index}`;
      case "number":
        return index * 10;
      case "boolean":
        return index % 2 === 1;
      case "date":
        return dateOf(index);
      case "select":
        return field.options[(index - 1) % field.options.length] ?? null;
      case "reference": {
        const reason = cut.get(`${table.id}\u0000${field.id}`);
        if (reason !== undefined) {
          addGap(table, field, reason, index);
          return null;
        }
        const n = rowCount(field.reference_table);
        return sampleRowId(field.reference_table, ((index - 1) % n) + 1);
      }
      case "image":
      case "file":
        addGap(table, field, "no_blobs", index);
        return null;
    }
  };

  const planned = new Map<string, SampleRow[]>();
  for (const tableId of order) {
    const table = byId.get(tableId) as Table;
    const rows: SampleRow[] = [];
    for (let index = 1; index <= rowCount(tableId); index += 1) {
      const values: Record<string, SampleValue> = {};
      for (const field of table.fields) {
        values[field.id] = valueFor(table, field, index);
      }
      rows.push({
        _id: sampleRowId(tableId, index),
        _created_at: timestampOf(index),
        _updated_at: timestampOf(index),
        values,
      });
    }
    planned.set(tableId, rows);
  }

  // --- 2. 付与の要る表: 名簿の1行目を頼んだ人に・付与の行を作成者の権限で -------------
  for (const [grantTableId, users] of grantUsers) {
    const grantTable = byId.get(grantTableId) as Table;
    const grantRows = planned.get(grantTableId) as SampleRow[];
    users.forEach((table, position) => {
      const declared = enabledAccessControl(table) as AccessControl;
      const grant = declared.grant;
      const members = declared.members;
      const memberRows = members === undefined ? undefined : planned.get(members.table);
      if (members !== undefined && memberRows?.[0] !== undefined) {
        memberRows[0].values[members.account] = requesterUserId;
      }
      // 相手: 名簿の1行目(`grant.member`)。**グループだけで渡す形は今日のカーネルが定義ごと断る**
      // (`referential-integrity.ts`: 「行を作った人に権限が1つも渡らない」)ので、相手を決めずに空にする。
      const recipientField = grant.member ?? grant.group;
      const recipient: string | null =
        grant.member !== undefined ? (memberRows?.[0]?._id ?? null) : null;
      const permissionField = grantTable.fields.find((f) => f.id === grant.permission);
      const permissionOk =
        permissionField?.type === "select" &&
        permissionField.options.includes(declared.creator_permission);
      const ownRows = planned.get(table.id) as SampleRow[];
      for (let i = 0; i < SAMPLE_ROWS_PER_TABLE; i += 1) {
        const rowNumber = position * SAMPLE_ROWS_PER_TABLE + i + 1;
        const row = grantRows[rowNumber - 1] as SampleRow;
        // 他の表の対象の欄は空にする(1行で別の表の行にも渡さない)。
        for (const other of users) {
          if (other === table) continue;
          const otherTarget = (enabledAccessControl(other) as AccessControl).grant.target;
          const field = grantTable.fields.find((f) => f.id === otherTarget);
          if (field === undefined || otherTarget === grant.target) continue;
          if (field.required === true) {
            addGap(grantTable, field, "grant_shared_target_required", rowNumber);
            continue;
          }
          row.values[otherTarget] = null;
        }
        row.values[grant.target] = ownRows[i]?._id ?? null;
        if (recipientField !== undefined) {
          row.values[recipientField] = recipient;
          if (recipient === null) {
            const field = grantTable.fields.find((f) => f.id === recipientField);
            if (field !== undefined) addGap(grantTable, field, "grant_unreachable", rowNumber);
          }
        }
        if (permissionField !== undefined) {
          row.values[permissionField.id] = permissionOk ? declared.creator_permission : null;
          if (!permissionOk) {
            addGap(grantTable, permissionField, "grant_permission_not_option", rowNumber);
          }
        }
      }
    });
  }

  // --- 3. 一意(true / "owner")を最後に確かめる -----------------------------------
  for (const tableId of order) {
    const table = byId.get(tableId) as Table;
    const rows = planned.get(tableId) as SampleRow[];
    for (const field of table.fields) {
      if (field.unique !== true && field.unique !== "owner") continue;
      const seen = new Set<string>();
      rows.forEach((row, position) => {
        const value = row.values[field.id];
        if (value === null || value === undefined) return;
        const scope =
          field.unique === "owner" && typeof row.values[OWNER_FIELD] === "string"
            ? (row.values[OWNER_FIELD] as string)
            : "";
        const key = `${scope}\u0000${JSON.stringify(value)}`;
        if (seen.has(key)) {
          row.values[field.id] = null;
          addGap(table, field, "unique_exhausted", position + 1);
          return;
        }
        seen.add(key);
      });
    }
  }

  return {
    tables: order.map((tableId) => ({ table: tableId, rows: planned.get(tableId) as SampleRow[] })),
    gaps,
  };
}
