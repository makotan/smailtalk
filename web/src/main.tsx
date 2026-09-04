/**
 * ブラウザ側のエントリポイント(V0-P3-T03)。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
// **配られる CSS の集合は2本である**(ADR-0088 限定2 / 限定6。集合の定義と全量性は
// `web/test/style-sources.test.ts` が持つ)。**並びは「生成 → 手書き」である** ——
// `tailwind.css` の出力は全部 `@layer` の中にあり `styles.css` は層の外にあるので、
// 読み込み順に関わらず `styles.css` の規則が勝つ。並びは読む人のためのものである。
import "./tailwind.css";
import "./styles.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("#root が index.html にありません。");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
