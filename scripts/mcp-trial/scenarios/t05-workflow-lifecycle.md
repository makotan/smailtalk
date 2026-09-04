---
id: t05-workflow-lifecycle
title: 会話のみでワークフローの作成・動作確認・undo が完遂するか
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

V1-M2-T05 の完了条件の本体である「**会話のみでワークフロー作成 → 動作確認 → undo が
完遂する**」を1本で通す。ADR-0013 で足した語彙が、**ソースを読めない条件下で、
ツール説明文だけを頼りに到達可能か**を実地で確かめる。

**「はず」を確かめるのがこのシナリオである。** `apply_diff` の説明文はワークフロー語彙を
明示的に説明しているので、Read / Grep が禁止でも AI は説明文だけで `add_workflow` に
到達できる**はず**である。到達できなければ、説明文が不足しているということになる。

**JSON をプロンプトに貼らない。**自然な日本語で頼み、AI 側で語彙へ翻訳させる。
「ワークフロー」という語だけは使う(ユーザがそう言うのは自然だからである)。

## 観測する点(judge は判定しない。人間が stream.jsonl を読んで判定する)

- (a) AI が `apply_diff` で `add_workflow` を含む差分を作れたか。何往復かかったか
- (b) **履歴テーブルを自分で `add_table` したか。**カーネルはテーブルを1つも自動生成しない。
  作らずに `history_table` を指定すれば差分全体が拒否される
- (c) レコード投入で実際に発火し、出力先のテーブルに行が増えたか
- (d) undo が効いたか。そして **undo でワークフローの実行履歴がどうなったか**

**(d) は特に重要である。** undo は差分の逆適用ではなく、その apply の直前の
データベース全体の書き戻しである。したがって「自動化を取り消す」と undo で戻る範囲は
一致しない —— **その apply 以降に入ったレコードも実行履歴も一緒に消える。**
AI がこの非対称をユーザに正しく説明するかどうかも見る。

## 限界(このシナリオで確かめられないこと)

- **`schedule` トリガーは MCP 経由では発火できない。**呼び出し元が
  `src/kernel/workflow-scheduler.ts` のみであり、`apply_diff` からは到達しない。
  ここで確かめられるのは `on_create` / `on_update` の2種だけである
- 標本は1試行である。ここで得られるものは「1回そうだった」でしかない(F-41)

## ターン1

> 社内の備品を貸し出す管理アプリを作って。
> 備品のテーブルには、備品名・保管場所・状態を持たせて。
> 一覧画面も付けて、動作確認用にサンプルの備品を3件入れておいて。
> 見られるURLも教えて。

## ターン2

> 次に自動化を入れたい。
> 新しい備品が登録されたら、点検メモのテーブルにその備品ぶんの行が
> 自動で1件できるようにして。点検メモには備品名と、まだ点検していないことが
> 分かる欄があればいい。
> あと、この自動化がいつ動いたか後から確認したいので、そのための記録も残るようにして。

**観測点**: (a) と (b)。`add_workflow` に到達したか。`history_table` 用のテーブルを
同じ差分で `add_table` したか。差分が拒否されて往復した場合は、その回数と
エラー文面を記録する(単位A で足した説明文が自己修正に効いたかの材料になる)。

## ターン3

> ちゃんと動くか確かめたい。備品を1件、新しく登録してみて。
> そのあと点検メモのテーブルと、自動化の記録を両方見せて。

**観測点**: (c)。`insert_sample_data` または `update_record` 経由でレコードが入り、
`list_records` で点検メモ側の行が増えていることが確認できるか。
実行履歴に1行(status = success)が入っているか。
**発火しなかった場合、AI がそれに気づいて報告するか**も見る
(「できたふり」で成功を報告したら重大な退行である)。

## ターン4

> やっぱりこの自動化はいらない。取り消して。
> 取り消したあと、備品と点検メモと自動化の記録がそれぞれどうなったかも教えて。

**観測点**: (d)。AI が `undo` を選ぶか `remove_workflow` を選ぶかは指定しない ——
**どちらを選んだかも観測対象である**(「取り消す」という日本語は両方に読める)。

- `undo` を選んだ場合: 実行前に `preview_undo` で失われるレコードを提示して同意を
  求めたか。undo 後に実行履歴とターン3のレコードが消えていることを正しく報告したか
- `remove_workflow` を選んだ場合: 「定義は消えるが、既に書かれた行と実行履歴は残る」を
  正しく説明したか

**どちらの場合も、消える範囲の説明が実際の結果と食い違っていたら不合格である。**

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
