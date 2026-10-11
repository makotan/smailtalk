/**
 * **未ログインに渡すマニフェストの写し**(`V21-M2B`。`ADR-0482` の `AN-G2` §2-3 / §2-6 / §4-1)。
 *
 * **隠す項目の集合 H(T) を決めるのは `owner-scope.ts` の `anonymousHiddenFieldIds` 1本である**
 * (判定の家は1本。`ADR-0482` §2-6 の末尾)。 **本ファイルは H を読んで写しを作るだけで、
 * 未ログインかどうかも、どの項目を隠すかも判定しない。**
 *
 * **ここに置いた理由**: 写しは画面の定義の区切り(`group_by`)・合計の列まで扱うが、
 * `owner-scope.ts` は「母集団の判定は群を知らない」ことを綴りで固定されている
 * (`record-population-home.test.ts` の (C-1) / `src/kernel/list-group-by.test.ts` の (h))。
 *
 * **呼んでよいのは未ログインの読取の口だけである**(`app.ts` の一覧・単件・画像の配信・
 * `GET /public`)。 **ログインした人の口は写しを1度も使わない**(`D-V21-16`)。
 */
import { isDeepStrictEqual } from "node:util";
import type { ListRecordsOptions, Manifest, RecordResult, Table } from "../kernel/index.ts";
import { anonymousHiddenFieldIds, judgeRoleAccess } from "./owner-scope.ts";

/** 値の木のどこかに `{ field: <H の項目> }` が在るか(絞り込み・表示条件の走査。非 export)。 */
function mentionsHiddenField(value: unknown, hidden: ReadonlySet<string>): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => mentionsHiddenField(item, hidden));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  for (const [key, inner] of Object.entries(value)) {
    if (key === "field" && typeof inner === "string" && hidden.has(inner)) {
      return true;
    }
    if (mentionsHiddenField(inner, hidden)) {
      return true;
    }
  }
  return false;
}

/** 並べ替えの宣言から H の項目を名指しした鍵を落とす。 残らなければ `undefined`(非 export)。 */
function sortWithoutHidden(sort: unknown, hidden: ReadonlySet<string>): unknown {
  if (Array.isArray(sort)) {
    const kept = sort.filter((key) => !mentionsHiddenField(key, hidden));
    return kept.length === 0 ? undefined : kept;
  }
  return mentionsHiddenField(sort, hidden) ? undefined : sort;
}

/** 項目 ID を鍵にした対応表から H の鍵を落とす。 空になれば `undefined`(非 export)。 */
function fieldMapWithoutHidden(map: unknown, hidden: ReadonlySet<string>): unknown {
  if (typeof map !== "object" || map === null || Array.isArray(map)) {
    return map;
  }
  const kept = Object.entries(map).filter(([key]) => !hidden.has(key));
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

/**
 * 並べ方の木(`layout`)から H の項目の葉を落とす。 **ボタンの葉(`action:<名前>`)は落とさない。**
 * 1つの葉しか持てない位置(`sidebar` の `side` / `main`)が H の項目なら、木ごと渡さない
 * (`undefined`。画面は並べ方の木の無い既定の並びで描く)。
 */
function layoutWithoutHidden(node: unknown, hidden: ReadonlySet<string>): unknown {
  if (typeof node === "string") {
    return hidden.has(node) ? undefined : node;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      const kept: unknown[] = [];
      for (const child of value) {
        if (typeof child === "string" && hidden.has(child)) {
          continue;
        }
        const projected = layoutWithoutHidden(child, hidden);
        if (projected === undefined) {
          return undefined;
        }
        kept.push(projected);
      }
      out[key] = kept;
    } else if (key === "side" || key === "main") {
      const projected = layoutWithoutHidden(value, hidden);
      if (projected === undefined) {
        return undefined;
      }
      out[key] = projected;
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * **画面の定義1件から、未ログインに隠す項目を名指しした項を落とす**(`ADR-0482` §2-6 の表の3行目・
 * §4-1 の「落とす範囲」)。 **非 export**({@link manifestForAnonymous} だけが呼ぶ)。
 *
 * - `columns` / `fields` / `search_fields`: H の項目を除く(`search_fields` が空になればキーごと落とす)
 * - `sort`: H の項目を名指しした鍵を落とす / `filter`: H の項目を1つでも名指ししていればキーごと落とす
 * - `sum_field` / `group_by`: H の項目ならキーごと落とす
 * - `field_sections`: 各まとまりから H の項目を除き、空のまとまりを落とす
 * - `field_width` / `preset_column_align` / `preset_column_width` / `reference_pickers`: H の鍵を落とす
 * - `layout`: {@link layoutWithoutHidden}
 * - `actions`: H の項目を書く(`set`)・H の項目で出し分ける(`visible_when`)ボタンを落とす
 * - `related`: 子の表の H に子一覧の絞りの項目(`via`)が入っていれば、その子一覧を落とす
 *   (未ログインが読むと 400 になるため)。 残す子一覧の `columns` / `sort` から子の表の H を落とす
 *
 * **集計表(`report_view`)の `report` は触らない** —— 集計表は未ログインで 401 のまま
 * (`D-V8-127`)なので、`GET /public` にも行を1行も渡さない(`ADR-0482` §1-2)。
 */
function viewWithoutHidden(
  view: Record<string, unknown>,
  hiddenOf: (tableId: unknown) => ReadonlySet<string>,
): Record<string, unknown> {
  const hidden = hiddenOf(view.table);
  const out: Record<string, unknown> = { ...view };
  const setOrDrop = (key: string, value: unknown): void => {
    if (value === undefined) {
      delete out[key];
    } else {
      out[key] = value;
    }
  };
  if (hidden.size > 0) {
    for (const key of ["columns", "fields"]) {
      if (Array.isArray(out[key])) {
        out[key] = (out[key] as unknown[]).filter(
          (id) => typeof id !== "string" || !hidden.has(id),
        );
      }
    }
    if (Array.isArray(out.search_fields)) {
      const kept = (out.search_fields as unknown[]).filter(
        (id) => typeof id !== "string" || !hidden.has(id),
      );
      setOrDrop("search_fields", kept.length === 0 ? undefined : kept);
    }
    if (out.sort !== undefined) {
      setOrDrop("sort", sortWithoutHidden(out.sort, hidden));
    }
    if (out.filter !== undefined && mentionsHiddenField(out.filter, hidden)) {
      delete out.filter;
    }
    if (typeof out.sum_field === "string" && hidden.has(out.sum_field)) {
      delete out.sum_field;
    }
    if (out.group_by !== undefined && mentionsHiddenField(out.group_by, hidden)) {
      delete out.group_by;
    }
    if (typeof out.field_sections === "object" && out.field_sections !== null) {
      const sections: [string, unknown][] = [];
      for (const [title, section] of Object.entries(out.field_sections)) {
        if (Array.isArray(section)) {
          const kept = section.filter((id) => typeof id !== "string" || !hidden.has(id));
          if (kept.length > 0) {
            sections.push([title, kept]);
          }
        } else if (typeof section === "object" && section !== null) {
          const fields = (section as { fields?: unknown }).fields;
          const kept = Array.isArray(fields)
            ? fields.filter((id) => typeof id !== "string" || !hidden.has(id))
            : [];
          if (kept.length > 0) {
            sections.push([title, { ...section, fields: kept }]);
          }
        }
      }
      setOrDrop("field_sections", sections.length === 0 ? undefined : Object.fromEntries(sections));
    }
    for (const key of [
      "field_width",
      "preset_column_align",
      "preset_column_width",
      "reference_pickers",
    ]) {
      if (out[key] !== undefined) {
        setOrDrop(key, fieldMapWithoutHidden(out[key], hidden));
      }
    }
    if (out.layout !== undefined) {
      setOrDrop("layout", layoutWithoutHidden(out.layout, hidden));
    }
    if (Array.isArray(out.actions)) {
      out.actions = (out.actions as unknown[]).filter(
        (action) =>
          typeof action !== "object" ||
          action === null ||
          (!mentionsHiddenField((action as { set?: unknown }).set, hidden) &&
            !mentionsHiddenField((action as { visible_when?: unknown }).visible_when, hidden)),
      );
    }
  }
  if (Array.isArray(out.related)) {
    const kept: unknown[] = [];
    for (const related of out.related as unknown[]) {
      if (typeof related !== "object" || related === null) {
        kept.push(related);
        continue;
      }
      const child = related as Record<string, unknown>;
      const childHidden = hiddenOf(child.table);
      if (childHidden.size === 0) {
        kept.push(related);
        continue;
      }
      if (typeof child.via === "string" && childHidden.has(child.via)) {
        continue;
      }
      const projected: Record<string, unknown> = { ...child };
      if (Array.isArray(projected.columns)) {
        projected.columns = (projected.columns as unknown[]).filter(
          (id) => typeof id !== "string" || !childHidden.has(id),
        );
      }
      if (projected.sort !== undefined) {
        const sort = sortWithoutHidden(projected.sort, childHidden);
        if (sort === undefined) {
          delete projected.sort;
        } else {
          projected.sort = sort;
        }
      }
      kept.push(projected);
    }
    if (kept.length === 0) {
      delete out.related;
    } else {
      out.related = kept;
    }
  }
  return out;
}

/**
 * **未ログインに渡すマニフェストの写し** —— 各表 T の H(T) の項目を「無い項目」にする
 * (`ADR-0482` §2-3 / §2-6)。
 *
 * - 表: `fields` から H を除く。 `representative_field` が H ならキーを落とす。
 *   `reference_search_fields` から H を除く(空ならキーを落とす)。
 * - 画面: {@link viewWithoutHidden}。
 *
 * **H が1つも無いアプリでは、受け取ったマニフェストをそのまま返す**(同じ参照。
 * 宣言の無いアプリの未ログインの応答は1バイトも変わらない)。 **役割の宣言(`roles`)は写しでも
 * 同じ**(規則の判定を変えない)。
 *
 * **呼んでよいのは未ログインの読取の口だけである**(ログインした人の見え方を変えない。`D-V21-16`)。
 */
export function manifestForAnonymous(manifest: Manifest): Manifest {
  const hiddenByTable = new Map<string, ReadonlySet<string>>();
  for (const table of manifest.app.tables ?? []) {
    const tableId = table?.id;
    if (typeof tableId !== "string") {
      continue;
    }
    const hidden = anonymousHiddenFieldIds(manifest, tableId);
    if (hidden.size > 0) {
      hiddenByTable.set(tableId, hidden);
    }
  }
  if (hiddenByTable.size === 0) {
    return manifest;
  }
  const none: ReadonlySet<string> = new Set();
  const hiddenOf = (tableId: unknown): ReadonlySet<string> =>
    typeof tableId === "string" ? (hiddenByTable.get(tableId) ?? none) : none;
  const copy = structuredClone(manifest);
  copy.app.tables = copy.app.tables.map((table) => {
    const hidden = hiddenOf(table.id);
    if (hidden.size === 0) {
      return table;
    }
    const projected: Table = {
      ...table,
      fields: table.fields.filter((field) => !hidden.has(field.id)),
    };
    // **`representative_field` は `Table` の型に現れない**(`src/kernel/types.ts` の注記)ので、
    // 形を問わずに鍵で見る。
    const loose = projected as unknown as Record<string, unknown>;
    if (typeof loose.representative_field === "string" && hidden.has(loose.representative_field)) {
      delete loose.representative_field;
    }
    if (projected.reference_search_fields !== undefined) {
      const kept = projected.reference_search_fields.filter((id) => !hidden.has(id));
      if (kept.length === 0) {
        delete projected.reference_search_fields;
      } else {
        projected.reference_search_fields = kept;
      }
    }
    return projected;
  });
  copy.app.views = copy.app.views.map(
    (view) =>
      viewWithoutHidden(
        view as unknown as Record<string, unknown>,
        hiddenOf,
      ) as unknown as typeof view,
  );
  return copy;
}

/**
 * **【2026-10-02。`V23-M9-T02`。ユーザ決定 `D-V23-235`・`D-V23-261`(`D-V23-256` を置き換えた)。
 * `ADR-0549` §Decision 1-3 と、その第2箇条を引き直した `ADR-0550` §Decision 4-1】**
 * 未ログインの読み手が一覧の要求の引数で名指しすると断る「消せない」「直接作れない」の印の2列。
 * **H(T) には入れない**(行の値の伏せ・画面の定義の写しは今日どおり。`ADR-0549` 式4)。
 */
const ANONYMOUS_REQUEST_MARKERS: readonly string[] = ["st_undeletable", "st_no_direct_create"];

/** 並べ替えを鍵の並びにする(`normalizeSort` と同じ。層をまたぐ import を増やさないための写し。非 export)。 */
function sortKeysOf(sort: unknown): { field: unknown; order: unknown }[] {
  if (sort === undefined) {
    return [];
  }
  const keys = Array.isArray(sort) ? sort : [sort];
  return keys.map((key) => {
    const loose = (key ?? {}) as { field?: unknown; order?: unknown };
    return { field: loose.field, order: loose.order };
  });
}

/**
 * 名乗りの無い要求が、未ログインに開く詳細画面の関連一覧の読み方と同じか(`D-V23-264`。非 export)。
 * 絞り込みは等値の並びで1つだけ(項目が関連の `via`。葉はちょうど `{ field, equals }`)、並べ替えは関連の宣言の `sort` と
 * 長さ・順序・項目・向きまで全部同じ。
 */
function sameAsPublicRelatedSort(
  source: Manifest,
  table: Table,
  parsed: RecordResult<ListRecordsOptions>,
): boolean {
  if (!parsed.ok) {
    return false;
  }
  const filter = parsed.value.filter as unknown;
  if (!Array.isArray(filter) || filter.length !== 1) {
    return false;
  }
  // 葉はちょうど `{ field, equals }` の2キー(`D-V23-264` の「via の等値1つ」。`in`・`contains`・`gte`・`not` 等は断る。
  // T13b・独立点検B 中1)。
  const leaf = filter[0] as Record<string, unknown> | null;
  if (
    leaf === null ||
    typeof leaf !== "object" ||
    Array.isArray(leaf) ||
    Object.keys(leaf).length !== 2 ||
    !("field" in leaf) ||
    !("equals" in leaf)
  ) {
    return false;
  }
  const via = leaf.field;
  const requested = sortKeysOf(parsed.value.sort);
  return (source.app.views ?? []).some((candidate) => {
    const view = candidate as unknown as Record<string, unknown> | undefined;
    if (view?.type !== "detail_view" || typeof view.id !== "string") {
      return false;
    }
    const related = Array.isArray(view.related) ? (view.related as Record<string, unknown>[]) : [];
    if (
      !related.some(
        (entry) =>
          entry?.table === table.id &&
          entry.via === via &&
          isDeepStrictEqual(requested, sortKeysOf(entry.sort)),
      )
    ) {
      return false;
    }
    return judgeRoleAccess({
      manifest: source,
      roles: null,
      target: { target: "view", view: view.id },
      verb: "read",
    }).allowed;
  });
}

/**
 * 要求の引数が印の2列を名指ししたとき、名乗った画面の宣言と同じかを種類ごとに見る(非 export)。
 * **名指しが無ければ `false`**(断らない)。 **一致の定義は `ADR-0550` §Decision 4-1 の 1〜5。**
 */
function markerQueryRejected(
  source: Manifest,
  table: Table,
  params: URLSearchParams,
  parse: (table: Table) => RecordResult<ListRecordsOptions>,
): boolean {
  const markers: ReadonlySet<string> = new Set(
    table.fields
      .map((field) => field.id)
      .filter((fieldId) => ANONYMOUS_REQUEST_MARKERS.includes(fieldId)),
  );
  if (markers.size === 0) {
    return false;
  }
  let jsonFilter: unknown;
  const jsonFilterRaw = params.get("filter");
  if (jsonFilterRaw !== null) {
    try {
      jsonFilter = JSON.parse(jsonFilterRaw);
    } catch {
      jsonFilter = undefined;
    }
  }
  const namesSort = params.getAll("sort").some((fieldId) => markers.has(fieldId));
  const namesFilter =
    [...params.keys()].some(
      (key) => key.startsWith("filter.") && markers.has(key.slice("filter.".length)),
    ) || mentionsHiddenField(jsonFilter, markers);
  const groupBy = params.get("group_by");
  const namesGroup = groupBy !== null && markers.has(groupBy);
  const sum = params.get("sum");
  const namesSum = sum !== null && markers.has(sum);
  if (!namesSort && !namesFilter && !namesGroup && !namesSum) {
    return false;
  }
  const viewId = params.get("view");
  // 0. 名乗りの無い要求(`D-V23-264`): 詳細画面の中の関連一覧は `?view=` を名乗らずに子の表へ送る。
  //    印の2列の名指しが並べ替えだけで、絞り込みが等値1つ(関連の `via`)だけで、並べ替えが
  //    未ログインに開く詳細画面のどれかの関連一覧(この表と `via`)の宣言と同じときだけ通す。
  if (viewId === null || viewId === "") {
    return !(
      namesSort &&
      !namesFilter &&
      !namesGroup &&
      !namesSum &&
      sameAsPublicRelatedSort(source, table, parse(table))
    );
  }
  // 1. 名乗った画面: `list_view` で、対象の表が URL の表と同じ。 名乗りが無ければ断る。
  const view = (source.app.views ?? []).find((candidate) => candidate?.id === viewId) as
    | Record<string, unknown>
    | undefined;
  if (view === undefined || view.type !== "list_view" || view.table !== table.id) {
    return true;
  }
  const parsed = parse(table);
  if (!parsed.ok) {
    return true;
  }
  // 2. 並べ替え: 長さ・順序・項目・向きまで全部同じ。
  if (namesSort && !isDeepStrictEqual(sortKeysOf(parsed.value.sort), sortKeysOf(view.sort))) {
    return true;
  }
  // 3. 絞り込み: (a) 宣言と深く等しい / (b) `{ and: [宣言, 印を名指ししない検索の語] }`。
  if (namesFilter) {
    const requested = parsed.value.filter as unknown;
    const declared = view.filter;
    const declaredNode = Array.isArray(declared) ? { and: declared } : declared;
    const sameAsDeclared = declared !== undefined && isDeepStrictEqual(requested, declared);
    const conjunct = (requested ?? {}) as Record<string, unknown>;
    const parts = conjunct.and;
    const declaredPlusSearch =
      declared !== undefined &&
      Object.keys(conjunct).length === 1 &&
      Array.isArray(parts) &&
      parts.length === 2 &&
      isDeepStrictEqual(parts[0], declaredNode) &&
      !mentionsHiddenField(parts[1], markers);
    if (!sameAsDeclared && !declaredPlusSearch) {
      return true;
    }
  }
  // 4. 区切り: 項目と粒度が同じ。
  if (namesGroup) {
    const declared = (view.group_by ?? {}) as { field?: unknown; granularity?: unknown };
    const granularity = params.get("granularity") ?? undefined;
    if (declared.field !== groupBy || declared.granularity !== granularity) {
      return true;
    }
  }
  // 5. 合計: 宣言の `sum_field` と同じ。
  if (namesSum && view.sum_field !== sum) {
    return true;
  }
  return false;
}

/**
 * **未ログインの一覧の口で使う写し**(`V23-M9-T02`。`D-V23-235`・`D-V23-261`)。
 *
 * - `source` は未ログインの写しを作る前の元の定義、`copy` は {@link manifestForAnonymous} の写し。
 * - 要求の引数が印の2列を名指しし、名乗った画面(`?view=`)の宣言と同じでなければ、`copy` の
 *   その表から2列を落とした写しを返す —— 一覧の口は以後これで検査するので、存在しない項目を
 *   名指ししたときと同じ 400 になり、`allowed_values` にも2列が出ない。
 * - 名乗りの無い要求は、詳細画面の関連一覧の読み方(`via` の等値1つと、未ログインに開く詳細画面の関連一覧の
 *   宣言と同じ並べ替え)だけ通す(`D-V23-264`。関連一覧は名乗ると表が違うので断られるため名乗らない)。
 * - 合計は「存在しない項目と同じ」が正(`D-V23-265`。H の無い表の未ログインの窓では存在しない列も 200 で合計 0)。
 * - それ以外(2列を名指ししない・宣言と同じ・2列を持たない表)は `copy` をそのまま返す(今日どおり)。
 * - `parse` は一覧の口の引数の読み手(`app.ts` の `parseListOptions`)。 型は元の表で読む。
 *
 * **呼んでよいのは未ログインの窓の一覧の口だけである**(ログインした人は今日どおり。`D-V23-235`)。
 */
export function anonymousMarkerQueryManifest(
  source: Manifest,
  copy: Manifest,
  tableId: string,
  params: URLSearchParams,
  parse: (table: Table) => RecordResult<ListRecordsOptions>,
): Manifest {
  const table = source.app.tables.find((candidate) => candidate?.id === tableId);
  if (table === undefined || !markerQueryRejected(source, table, params, parse)) {
    return copy;
  }
  return {
    ...copy,
    app: {
      ...copy.app,
      tables: copy.app.tables.map((candidate) =>
        candidate.id === tableId
          ? {
              ...candidate,
              fields: candidate.fields.filter(
                (field) => !ANONYMOUS_REQUEST_MARKERS.includes(field.id),
              ),
            }
          : candidate,
      ),
    },
  };
}
