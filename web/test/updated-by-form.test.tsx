/**
 * **フォームに `st_updated_by`(更新者)の入力欄を出さない**(`V23-M4-T05`。`D-V23-98`。
 * 門A `ADR-0524` §Decision 1-5 と限定19)。
 *
 * 型が text で必須でない `st_updated_by` は、プラットフォームが行の作成と更新のたびに押す欄である。
 * 送っても捨てられるので、`form` の `fields` に書いてあっても入力欄を出さない(書けない)。
 * 型が text でないか必須なら、ただの項目なので今日どおり入力欄を出す。
 */
import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { FormView, Manifest } from "../../src/kernel/types.ts";
import type { Role } from "../src/api.ts";
import { RoleProvider } from "../src/auth/authz.tsx";
import { FormRenderer } from "../src/views/FormRenderer.tsx";

const APP_ID = "updated-by-form";
const EDITOR_ROLE: Role = "editor";
const UB = "st_updated_by";

function manifest(updatedBy: Record<string, unknown>): Manifest {
  return {
    app: {
      id: APP_ID,
      name: "更新者のフォーム",
      tables: [
        {
          id: "notes",
          name: "メモ",
          fields: [
            { id: "title", name: "件名", type: "text" },
            { id: UB, name: "更新者", ...updatedBy },
          ],
        },
      ],
      views: [{ id: "note-form", type: "form", table: "notes", fields: ["title", UB] }],
    },
  } as unknown as Manifest;
}

function formView(source: Manifest): FormView {
  const view = source.app.views.find((candidate) => candidate.id === "note-form");
  if (view === undefined || view.type !== "form") {
    throw new Error("fixture broken: form view がない");
  }
  return view;
}

function renderForm(source: Manifest) {
  return render(
    <RoleProvider role={EDITOR_ROLE}>
      <FormRenderer appId={APP_ID} manifest={source} view={formView(source)} />
    </RoleProvider>,
  );
}

afterEach(() => {
  cleanup();
});

test("(form-hidden) text で必須でない st_updated_by は、fields に書いても入力欄を出さない", async () => {
  renderForm(manifest({ type: "text" }));
  await waitFor(() => {
    expect(screen.getByTestId("field-label-title")).toBeDefined();
  });
  expect(screen.queryAllByTestId(`field-label-${UB}`).length).toBe(0);
});

test("(form-plain-number) 型が text でない st_updated_by は、ただの項目なので入力欄を出す", async () => {
  renderForm(manifest({ type: "number" }));
  await waitFor(() => {
    expect(screen.getByTestId("field-label-title")).toBeDefined();
  });
  expect(screen.queryAllByTestId(`field-label-${UB}`).length).toBe(1);
});

test("(form-plain-required) 必須の st_updated_by は、ただの項目なので入力欄を出す", async () => {
  renderForm(manifest({ type: "text", required: true }));
  await waitFor(() => {
    expect(screen.getByTestId("field-label-title")).toBeDefined();
  });
  expect(screen.queryAllByTestId(`field-label-${UB}`).length).toBe(1);
});
