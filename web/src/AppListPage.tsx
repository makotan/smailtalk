/**
 * アプリ一覧(V0-P3-T03)。
 *
 * `GET /api/apps` の結果をそのまま並べるだけ。どんなアプリが存在するかは
 * 実行時に台帳から決まるので、ここにアプリ名を書くことはない。
 *
 * ## 【V4-M15-T14】読み込み中に骨組みを出す(`ADR-0087` / `ADR-0089`)
 *
 * **着手前は `<p>読み込み中…</p>` の1行だけで、skeleton も spinner も0件だった**
 * (`03` §4-1)。**足したのは `Skeleton` の3本だけである** —— **文言は1文字も変えていない。**
 * `Skeleton` は `aria-hidden` なので読み上げには出ない。**件数が分からない時点なので、
 * 行数を装って多く出さない**(`ListViewRenderer` と同じ扱い)。
 *
 * **エラーの器は `ErrorList` が既に `Alert variant="destructive"` を持っている** ——
 * **ここで二重に包まない**(枠が二重に出る)。
 */
import { useEffect, useState } from "react";
import { type AppRecord, fetchApps } from "./api.ts";
import { type AsyncState, toValidationErrors } from "./async.ts";
import { ErrorList } from "./ErrorList.tsx";
import { RouteLink } from "./navigation.tsx";
import { Skeleton } from "./ui/surfaces.tsx";
import { cn } from "./ui/utils.ts";

export function AppListPage() {
  const [state, setState] = useState<AsyncState<AppRecord[]>>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchApps().then(
      (apps) => {
        if (!cancelled) {
          setState({ status: "ready", value: apps });
        }
      },
      (reason: unknown) => {
        if (!cancelled) {
          setState({ status: "error", errors: toValidationErrors(reason) });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <div className={cn("flex flex-col gap-s2 font-sans")}>
        <p className={cn("m-0", "text-note text-muted-foreground")}>読み込み中…</p>
        {["row-1", "row-2", "row-3"].map((slot) => (
          <Skeleton key={slot} className="h-6 w-full" />
        ))}
      </div>
    );
  }
  if (state.status === "error") {
    return <ErrorList errors={state.errors} />;
  }
  if (state.value.length === 0) {
    return <p className={cn("m-0", "font-sans text-muted-foreground")}>アプリがまだありません。</p>;
  }

  return (
    // **既存の `class`(`app-list` / `meta`)を1つも消していない。**
    <ul
      className={cn("app-list", "flex flex-col gap-s1 font-sans text-foreground")}
      data-testid="app-list"
    >
      {state.value.map((app) => (
        <li key={app.app_id} className={cn("flex flex-wrap items-baseline gap-s2")}>
          <RouteLink to={{ kind: "app", appId: app.app_id }}>{app.name}</RouteLink>
          <span className={cn("meta", "text-note text-muted-foreground")}>{app.app_id}</span>
        </li>
      ))}
    </ul>
  );
}
