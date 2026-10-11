import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDiff } from "./apply-diff.ts";
import { applyManifest } from "./apply-manifest.ts";
import { createApp } from "./create-app.ts";
import type { ValidationError, ValidationResult } from "./errors.ts";
import { KernelMetaStore } from "./meta-store.ts";
import { listSnapshots } from "./snapshot.ts";
import { appDbPath, appManifestPath } from "./storage-paths.ts";
import type { Diff, Manifest } from "./types.ts";
import { validateManifestFull } from "./validate.ts";

/**
 * **暗い側の組 `slots_dark` を、明るい側と同じ強さでコントラスト検査に掛けることの実証**
 * (`V20-M10-T01` + `T04`)。
 *
 * 条文 = `ADR-0458` §Decision 2(暗い側の組は役割の層をそのまま参照する)と
 * `ADR-0474` §1-4 / §1-5(`incoming` のときだけ解決 → 解いた実値でコントラスト検査)と
 * `ADR-0046` 限定4(閾値は2つ。モード別の例外を作らない)と `ADR-0047` 限定8 / 限定9。
 * 手本は `theme-reference-wiring.test.ts`(`V20-M9-T02`)。**全か無かの4点は1点ずつ別々の test に分ける。**
 *
 * **参照 `$palette_…` は1つの組の中で閉じる** —— `slots_dark` の中の参照は `slots_dark` の中の
 * 生の色だけで解く(`slots` の生の色を `slots_dark` から指せない)。
 */

/** 明るい側でコントラスト検査を通る27枠(`validate.test.ts` の `THEME_SLOTS_PASSING` の写し)。 */
function lightSlots(): Record<string, string> {
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

/** 暗い側でコントラスト検査を通る27枠(色以外の14枠は明るい側と同じ値)。 */
function darkSlots(): Record<string, string> {
  return {
    ...lightSlots(),
    danger: "#ff7b7b",
    body_text: "#e6e6e6",
    label_text: "#a3a3a3",
    placeholder_text: "#a3a3a3",
    secondary_text: "#a3a3a3",
    border_color: "#8a8a8a",
    page_background: "#121212",
    highlight_surface: "#1f1f1f",
    primary_fill: "#121212",
    on_primary: "#e6e6e6",
    overlay_background: "#121212",
    overlay_text: "#e6e6e6",
    focus_ring: "#6cb6ff",
  };
}

type ThemeInput = { slots: Record<string, string>; slots_dark?: Record<string, string> };

function manifestWithTheme(theme: ThemeInput): Manifest {
  return {
    app: {
      id: "dark-demo",
      name: "暗い側の実証",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [{ id: "title", name: "題名", type: "text", required: true }],
        },
      ],
      views: [{ id: "note-list", type: "list_view", table: "notes", columns: ["title"] }],
      theme,
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

const DARK = "/app/theme/slots_dark/";
const LIGHT = "/app/theme/slots/";

// ===========================================================================
// validateManifestFull(incoming / stored)
// ===========================================================================

describe("V20-M10-T04: 両方のモードをコントラスト検査に掛ける(ADR-0046 限定4 / ADR-0458)", () => {
  test("(a) 暗い側だけが閾値を割るテーマは拒否され、誤りは slots_dark だけを指す", () => {
    // 暗い地に暗い文字(#333333 on #121212)。明るい側は通る。
    const dark = { ...darkSlots(), body_text: "#333333" };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: dark })),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.path.startsWith(DARK))).toBe(true);
    expect(errors.some((e) => e.path === `${DARK}body_text`)).toBe(true);
    expect(errors.find((e) => e.path === `${DARK}body_text`)?.message).toContain("4.5:1");
  });

  test("(b) 明るい側だけが閾値を割るテーマも拒否され(今日どおり)、誤りは slots だけを指す", () => {
    const light = { ...lightSlots(), body_text: "#ffffff" };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: light, slots_dark: darkSlots() })),
    );
    expect(errors.every((e) => e.path.startsWith(LIGHT))).toBe(true);
    expect(errors.some((e) => e.path === `${LIGHT}body_text`)).toBe(true);
  });

  test("両方が割れるテーマは、両方の誤りを1度に返す(片方で止めない)", () => {
    const light = { ...lightSlots(), body_text: "#ffffff" };
    const dark = { ...darkSlots(), body_text: "#121212" };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: light, slots_dark: dark })),
    );
    expect(errors.some((e) => e.path === `${LIGHT}body_text`)).toBe(true);
    expect(errors.some((e) => e.path === `${DARK}body_text`)).toBe(true);
  });

  test("両方が閾値を満たすテーマは incoming でも通る", () => {
    expect(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: darkSlots() })),
    ).toEqual({ valid: true });
  });

  test("(c) 非テキストの閾値(3:1)も暗い側に同じ強さで掛かる(モード別の例外を作らない)", () => {
    // 暗い地(#1f1f1f)に暗い枠線(#3a3a3a)は 3:1 を割る(明るい既定の #ddd と同じ型)。
    const dark = { ...darkSlots(), border_color: "#3a3a3a" };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: dark })),
    );
    expect(errors.every((e) => e.path === `${DARK}border_color`)).toBe(true);
    expect(errors.some((e) => e.message.includes("3:1"))).toBe(true);
  });

  test("暗い側で割れるテーマも stored としては読める(ADR-0047 限定8)", () => {
    const dark = { ...darkSlots(), body_text: "#333333" };
    expect(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: dark }), "stored"),
    ).toEqual({ valid: true });
  });
});

describe("V20-M10-T01: 参照 $palette_… は1つの組の中で閉じる(ADR-0474 の規則を2つの器に当てる)", () => {
  test("slots_dark の中の参照は slots_dark の中の生の色で解かれる", () => {
    const dark = {
      ...darkSlots(),
      palette_ink: "#e6e6e6",
      palette_night: "#121212",
      body_text: "$palette_ink",
      page_background: "$palette_night",
    };
    expect(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: dark })),
    ).toEqual({ valid: true });
  });

  test("slots_dark の中の参照を解いた実値でコントラスト検査を掛ける(同じ生の色の地と文字は拒否)", () => {
    const dark = {
      ...darkSlots(),
      palette_night: "#121212",
      body_text: "$palette_night",
      page_background: "$palette_night",
    };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: dark })),
    );
    const bodyText = errors.find((e) => e.path === `${DARK}body_text`);
    expect(bodyText?.message).toContain("下回ります");
    expect(bodyText?.message).toContain("#121212");
  });

  test("slots の生の色を slots_dark から指すと「解決できない参照」で拒否され、slots_dark を指す", () => {
    const light = { ...lightSlots(), palette_brand: "#1d4ed8" };
    const dark = { ...darkSlots(), focus_ring: "$palette_brand" };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: light, slots_dark: dark })),
    );
    expect(errors.map((e) => e.path)).toEqual([`${DARK}focus_ring`]);
    expect(errors[0]?.message).toContain("解決できない参照");
  });

  test("slots_dark の生の色を slots から指すことも同じく拒否される(向きによらず閉じる)", () => {
    const light = { ...lightSlots(), focus_ring: "$palette_sky" };
    const dark = { ...darkSlots(), palette_sky: "#6cb6ff" };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: light, slots_dark: dark })),
    );
    expect(errors.map((e) => e.path)).toEqual([`${LIGHT}focus_ring`]);
    expect(errors[0]?.message).toContain("解決できない参照");
  });

  test("slots_dark の中の循環は incoming で拒否され、slots_dark を指す", () => {
    const dark = { ...darkSlots(), palette_a: "$palette_b", palette_b: "$palette_a" };
    const errors = expectInvalid(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: dark })),
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((e) => e.path.startsWith(DARK))).toBe(true);
    expect(errors.some((e) => e.message.includes("循環参照"))).toBe(true);
  });

  test("slots_dark の未解決の参照を持つマニフェストも stored としては読める(ADR-0047 限定8)", () => {
    const dark = { ...darkSlots(), body_text: "$palette_nope" };
    expect(
      validateManifestFull(manifestWithTheme({ slots: lightSlots(), slots_dark: dark }), "stored"),
    ).toEqual({ valid: true });
  });
});

// ===========================================================================
// applyDiff: 全か無か(4点を1点ずつ)
// ===========================================================================

const APP_ID = "dark-demo";
let dataRoot: string;
let store: KernelMetaStore;

function baseManifest(): Manifest {
  const manifest = manifestWithTheme({ slots: lightSlots() });
  delete manifest.app.theme;
  return manifest;
}

function setThemeDiff(diffId: string, theme: ThemeInput): Diff {
  return { diff_id: diffId, intent: "見た目を指定する", operations: [{ op: "set_theme", theme }] };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 暗い側だけが閾値を割る(明るい側は通る)差分。 */
function darkBrokenDiff(): Diff {
  return setThemeDiff("d-0003", {
    slots: lightSlots(),
    slots_dark: { ...darkSlots(), body_text: "#333333" },
  });
}

/** 在るものが1バイトも動かないことを示すため、両方のモードを持つテーマとフィールドを1つずつ入れておく。 */
function prepare(): void {
  const first = applyDiff(
    dataRoot,
    APP_ID,
    setThemeDiff("d-0001", { slots: lightSlots(), slots_dark: darkSlots() }),
  );
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

function rejectDarkBroken(): void {
  const result = applyDiff(dataRoot, APP_ID, darkBrokenDiff());
  expect(result.valid).toBe(false);
  if (result.valid) {
    return;
  }
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors.every((e) => e.path.startsWith(DARK))).toBe(true);
  expect(result.errors.some((e) => e.path === `${DARK}body_text`)).toBe(true);
}

beforeEach(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "gp-theme-dark-"));
  store = KernelMetaStore.open(dataRoot);
  createApp(store, "暗い側の実証", { app_id: APP_ID });
  expect(applyManifest(dataRoot, APP_ID, baseManifest()).valid).toBe(true);
});

afterEach(async () => {
  store.close();
  await rm(dataRoot, { recursive: true, force: true });
});

describe("V20-M10-T04 (d): 暗い側の拒否も「全か無か」(ADR-0047 限定9。4点を1点ずつ)", () => {
  test("(1) manifest.json が1バイトも変わらない", () => {
    prepare();
    const path = appManifestPath(dataRoot, APP_ID);
    const before = { hash: sha256(path), bytes: readFileSync(path).byteLength };
    rejectDarkBroken();
    expect({ hash: sha256(path), bytes: readFileSync(path).byteLength }).toEqual(before);
  });

  test("(2) app.sqlite が1バイトも変わらない", () => {
    prepare();
    const path = appDbPath(dataRoot, APP_ID);
    const before = { hash: sha256(path), bytes: readFileSync(path).byteLength };
    rejectDarkBroken();
    expect({ hash: sha256(path), bytes: readFileSync(path).byteLength }).toEqual(before);
  });

  test("(3) スナップショットが増えない", () => {
    prepare();
    const before = listSnapshots(dataRoot, APP_ID);
    expect(before.length).toBeGreaterThan(0);
    rejectDarkBroken();
    expect(listSnapshots(dataRoot, APP_ID)).toEqual(before);
  });

  test("(4) _changelog に行が増えない", () => {
    prepare();
    const before = store.listChangelog(APP_ID);
    expect(before.length).toBeGreaterThan(0);
    rejectDarkBroken();
    expect(store.listChangelog(APP_ID)).toEqual(before);
  });

  test("両方のモードが読める配色は apply_diff で適用でき、slots_dark がそのまま保存される", () => {
    prepare();
    const saved = JSON.parse(readFileSync(appManifestPath(dataRoot, APP_ID), "utf-8")) as Manifest;
    expect(saved.app.theme).toEqual({ slots: lightSlots(), slots_dark: darkSlots() });
  });
});
