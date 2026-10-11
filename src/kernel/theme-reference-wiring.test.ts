import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest, readCurrentManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest, Theme } from "./types.ts";
import { validateDiff, validateManifest, validateManifestFull } from "./validate.ts";

/**
 * **テーマの参照の解決を `checkTheme` に結線したことの実証**(`V20-M9-T02`+`T03`)。
 *
 * 条文 = `ADR-0474` §Decision 1-4 / 1-5(`incoming` のときだけ掛ける。順は「解決 → 拒否があれば返す →
 * 解いた実値でコントラスト検査」)と `ADR-0047` 限定8(`stored` には掛けない)・限定9(全か無か)。
 * 手本は `theme-history.test.ts` の「完了条件8」(V3-M1-T03)と `validate.test.ts` の
 * 「V3-M1-T03: コントラスト検査の結線」。**全か無かの4点は1点ずつ別々の test に分ける。**
 *
 * **この本は `theme-reference.ts` を import しない** —— 解決器が無い日にも1件ずつ赤くなる形にするため
 * (解決器の純関数の振る舞いは `theme-reference.test.ts`)。
 */

/** コントラスト検査を通る27枠(既定配色ではない。`validate.test.ts` の `THEME_SLOTS_PASSING` の写し)。 */
function passingSlots(): Record<string, string> {
  return {
    danger: "#a00000",
    body_text: "#000000",
    label_text: "#595959",
    placeholder_text: "#595959",
    secondary_text: "#595959",
    border_color: "#767676",
    page_background: "#ffffff",
    highlight_surface: "#f2f2f2",
    primary_fill: "#ffffff",
    on_primary: "#000000",
    overlay_background: "#ffffff",
    overlay_text: "#000000",
    body_font: "system-ui, sans-serif",
    note_font_size: "0.875rem",
    secondary_font_size: "0.85em",
    body_line_height: "1.6",
    space_1: "0.25rem",
    space_2: "0.5rem",
    space_3: "0.75rem",
    space_4: "1rem",
    space_5: "1.25rem",
    space_6: "2rem",
    border_width: "1px",
    control_radius: "4px",
    surface_shadow: "none",
    focus_ring: "#005fcc",
    focus_ring_width: "2px",
  };
}

function manifestWithSlots(slots: Record<string, string>): Manifest {
  return {
    app: {
      id: "ref-demo",
      name: "参照の実証",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "題名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
      theme: { slots },
    },
  };
}

function expectInvalid(result: ValidationResult): ValidationError[] {
  expect(result.valid).toBe(false);
  if (result.valid) {
    throw new Error("expected invalid");
  }
  return result.errors;
}

/** 主ボタンだけを濃い青にし、白い文字を載せる(`D-V20-28` の狙い)。生の色を別名で指す。 */
function brandSlots(): Record<string, string> {
  return {
    ...passingSlots(),
    palette_ocean_700: "#1d4ed8",
    palette_brand: "$palette_ocean_700",
    palette_white: "#ffffff",
    primary_fill: "$palette_brand",
    on_primary: "$palette_white",
  };
}

// ===========================================================================
// validateManifestFull(incoming / stored)
// ===========================================================================

describe("V20-M9-T02: incoming で3種の拒否が返る(ADR-0474 §1-4)", () => {
  test("未解決の参照は incoming で拒否され、枠と参照を名指しする(色として読めない、ではない)", () => {
    const slots = { ...passingSlots(), body_text: "$palette_nope" };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/theme/slots/body_text");
    expect(errors[0]?.message).toContain("解決できない参照");
    expect(errors[0]?.message).toContain("$palette_nope");
    expect(errors[0]?.message).not.toContain("色として読めません");
  });

  test("循環(長さ1)は incoming で拒否され、道筋を名指しする", () => {
    const slots = { ...passingSlots(), palette_a: "$palette_a", body_text: "$palette_a" };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors.every((e) => e.message.includes("循環参照"))).toBe(true);
    expect(errors.some((e) => e.message.includes("palette_a → palette_a"))).toBe(true);
  });

  test("循環(長さ2)は incoming で拒否され、道筋を名指しする", () => {
    const slots = { ...passingSlots(), palette_a: "$palette_b", palette_b: "$palette_a" };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors.map((e) => e.path).sort()).toEqual([
      "/app/theme/slots/palette_a",
      "/app/theme/slots/palette_b",
    ]);
    expect(errors.some((e) => e.message.includes("palette_a → palette_b → palette_a"))).toBe(true);
  });

  test("深すぎる参照(4回)は incoming で拒否され、上限3を名指しする", () => {
    const slots = {
      ...passingSlots(),
      body_text: "$palette_1",
      palette_1: "$palette_2",
      palette_2: "$palette_3",
      palette_3: "$palette_4",
      palette_4: "#000000",
    };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("/app/theme/slots/body_text");
    expect(errors[0]?.message).toContain("参照が深すぎ");
    expect(errors[0]?.message).toContain("3");
  });

  test("深さちょうど3は incoming で通る", () => {
    const slots = {
      ...passingSlots(),
      body_text: "$palette_1",
      palette_1: "$palette_2",
      palette_2: "$palette_3",
      palette_3: "#000000",
    };
    expect(validateManifestFull(manifestWithSlots(slots))).toEqual({ valid: true });
  });

  test("どの役割からも指されていない生の色の未解決も incoming で拒否する", () => {
    const slots = { ...passingSlots(), palette_orphan: "$palette_missing" };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors.map((e) => e.path)).toEqual(["/app/theme/slots/palette_orphan"]);
    expect(errors[0]?.message).toContain("解決できない参照");
  });

  test("どの役割からも指されていない生の色の循環も incoming で拒否する", () => {
    const slots = { ...passingSlots(), palette_a: "$palette_b", palette_b: "$palette_a" };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors.every((e) => e.message.includes("循環参照"))).toBe(true);
  });

  test("解決の拒否があるときはコントラストの誤りを混ぜない(解決 → 拒否があれば返す)", () => {
    // 白地に白文字(コントラストでも落ちる)と、未解決の参照を同時に持たせる。
    const slots = { ...passingSlots(), label_text: "#ffffff", body_text: "$palette_nope" };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors.every((e) => !e.message.includes("コントラスト比"))).toBe(true);
  });
});

describe("V20-M9-T02: 解いた実値でコントラスト検査を掛ける", () => {
  test("参照越しの読めない配色(body_text と page_background が同じ生の色)は拒否される", () => {
    const slots = {
      ...passingSlots(),
      palette_paper: "#ffffff",
      body_text: "$palette_paper",
      page_background: "$palette_paper",
    };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    const bodyText = errors.find((e) => e.path === "/app/theme/slots/body_text");
    expect(bodyText?.message).toContain("下回ります");
    // メッセージには解いた実値が出る(参照の綴りのまま「色として読めない」と報じない)。
    expect(bodyText?.message).toContain("#ffffff");
    expect(errors.every((e) => !e.message.includes("色として読めません"))).toBe(true);
  });

  test("参照越しの読める配色(主ボタンを濃い青・白い文字にし、生の色を別名で指す)は valid", () => {
    expect(validateManifestFull(manifestWithSlots(brandSlots()))).toEqual({ valid: true });
  });

  test("参照越しの主ボタンの組(on_primary × primary_fill)も測る: 白地の主ボタンに白文字は拒否", () => {
    const slots = { ...brandSlots(), palette_ocean_700: "#ffffff" };
    const errors = expectInvalid(validateManifestFull(manifestWithSlots(slots)));
    expect(errors.map((e) => e.path)).toEqual(["/app/theme/slots/on_primary"]);
    expect(errors[0]?.message).toContain("primary_fill");
  });
});

describe("V20-M9-T02: stored では解決の拒否を掛けない(ADR-0047 限定8)", () => {
  test("未解決の参照を持つマニフェストは stored として読める", () => {
    const slots = { ...passingSlots(), body_text: "$palette_nope" };
    expect(validateManifestFull(manifestWithSlots(slots), "stored")).toEqual({ valid: true });
  });

  test("循環と深すぎる参照を持つマニフェストも stored として読める", () => {
    const slots = {
      ...passingSlots(),
      palette_a: "$palette_b",
      palette_b: "$palette_a",
      label_text: "$palette_1",
      palette_1: "$palette_2",
      palette_2: "$palette_3",
      palette_3: "$palette_4",
      palette_4: "#595959",
    };
    expect(validateManifestFull(manifestWithSlots(slots), "stored")).toEqual({ valid: true });
  });
});

describe("V20-M9-T02: 値域(構造の検証)", () => {
  test("役割は参照先になれない($body_text の綴りは invalid)", () => {
    const slots = { ...passingSlots(), label_text: "$body_text" };
    const errors = expectInvalid(validateManifest(manifestWithSlots(slots)));
    expect(errors.some((e) => e.path.startsWith("/app/theme/slots/label_text"))).toBe(true);
  });

  test("set_theme の差分でも $body_text の綴りは invalid", () => {
    const diff = {
      diff_id: "d-1",
      intent: "見た目",
      operations: [
        { op: "set_theme", theme: { slots: { ...passingSlots(), label_text: "$body_text" } } },
      ],
    };
    expect(validateDiff(diff).valid).toBe(false);
  });
});

// ===========================================================================
// applyDiff: 全か無か(4点を1点ずつ)と、stored の読み
// ===========================================================================

const APP_ID = "ref-demo";
let dataRoot: string;
let store: KernelMetaStore;

function baseManifest(): Manifest {
  const manifest = manifestWithSlots(passingSlots());
  delete manifest.app.theme;
  return manifest;
}

function setThemeDiff(diffId: string, slots: Record<string, string>): Diff {
  const theme: Theme = { slots };
  return { diff_id: diffId, intent: "見た目を指定する", operations: [{ op: "set_theme", theme }] };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 未解決の参照を持つ(3種の拒否のうち1種で落ちる)差分。 */
function unresolvedDiff(): Diff {
  return setThemeDiff("d-0003", { ...passingSlots(), primary_fill: "$palette_nope" });
}

/** 在るものが1バイトも動かないことを示すため、テーマとフィールドを1つずつ入れておく。 */
function prepare(): void {
  const first = applyDiff(dataRoot, APP_ID, setThemeDiff("d-0001", brandSlots()));
  expect(first.valid, JSON.stringify(first)).toBe(true);
  const second = applyDiff(dataRoot, APP_ID, {
    diff_id: "d-0002",
    intent: "メモに日付を足す",
    operations: [
      { op: "add_field", table: "notes", field: { id: "due", name: "期限", type: "date" } },
    ],
  });
  expect(second.valid, JSON.stringify(second)).toBe(true);
}

function rejectUnresolved(): void {
  const result = applyDiff(dataRoot, APP_ID, unresolvedDiff());
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  expect(result.errors.map((e) => e.path)).toEqual(["/app/theme/slots/primary_fill"]);
  expect(result.errors[0]?.message).toContain("解決できない参照");
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-theme-reference-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "参照の実証", { app_id: APP_ID });
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V20-M9-T02: 解決の拒否は「全か無か」(ADR-0047 限定9。4点を1点ずつ)", () => {
  test("(1) manifest.json が1バイトも変わらない", () => {
    prepare();
    const path = appManifestPath(dataRoot, APP_ID);
    const before = { hash: sha256(path), bytes: readFileSync(path).byteLength };
    rejectUnresolved();
    expect({ hash: sha256(path), bytes: readFileSync(path).byteLength }).toEqual(before);
  });

  test("(2) app.sqlite が1バイトも変わらない", () => {
    prepare();
    const path = appDbPath(dataRoot, APP_ID);
    const before = { hash: sha256(path), bytes: readFileSync(path).byteLength };
    rejectUnresolved();
    expect({ hash: sha256(path), bytes: readFileSync(path).byteLength }).toEqual(before);
  });

  test("(3) スナップショットが増えない", () => {
    prepare();
    const before = listSnapshots(dataRoot, APP_ID);
    expect(before.length).toBeGreaterThan(0);
    rejectUnresolved();
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(before);
  });

  test("(4) _changelog に行が増えない", () => {
    prepare();
    const before = store.listChangelog(APP_ID);
    expect(before.length).toBeGreaterThan(0);
    rejectUnresolved();
    expect(store.listChangelog(APP_ID)).toEqual(before);
  });

  test("参照越しの読める配色は apply_diff で適用でき、参照の綴りがそのまま保存される", () => {
    prepare();
    const saved = JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
    // 解いた実値で書き換えない(表示層がブラウザの変数参照として解く。ADR-0474 §1-6)。
    expect(saved.app.theme?.slots).toEqual(brandSlots());
  });
});

describe("V20-M9-T02: 手で書いた定義ファイルの未解決の参照は stored として読める(ADR-0047 限定8)", () => {
  test("readCurrentManifest が例外を投げず、参照の綴りをそのまま返す", () => {
    const path = appManifestPath(dataRoot, APP_ID);
    const manifest = JSON.parse(readFileSync(path, "utf-8")) as Manifest;
    manifest.app.theme = { slots: { ...passingSlots(), body_text: "$palette_nope" } };
    writeFileSync(path, JSON.stringify(manifest, null, 2));
    const current = readCurrentManifest(dataRoot, APP_ID);
    expect(current.app.theme?.slots.body_text).toBe("$palette_nope");
  });
});
