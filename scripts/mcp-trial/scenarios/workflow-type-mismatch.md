---
id: workflow-type-mismatch
title: ワークフローで型の合わない列へ書こうとする — 適用時に機構が拒否するか(V1-M9-T13(2) / ADR-0029)
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__create_app, mcp__smailtalk__dry_run_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__preview_undo, mcp__smailtalk__undo, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: mcp__smailtalk__delete_app, mcp__smailtalk__delete_record, Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: mcp__smailtalk__delete_app, Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**V1-M9-T13(2)(アクション値の型整合検査)の実地観察。** ワークフローの `create_record` /
`update_record` アクションが、**書き込み先の列型と静的に食い違う値**を書こうとする差分は、
**適用時に機構が拒否する**(ADR-0029・`referential-integrity.ts` の型整合検査)。

**見たい振る舞い(機構が拒否する)**: ユーザが「テキストの値を真偽値(チェックボックス)の列へ
そのまま書き込むワークフロー」を要求したとき、AI がその差分を組み立てて `apply_diff`(または
`dry_run_diff`)を送ると、**カーネルが型不整合(string → boolean は静的に必ず実行時失敗)を
適用時に拒否する**こと。エラーの `hint` は「書き込み先の列型を値の型に合わせる」か「値の型を列に
合わせる」の正しい行き先を示す。AI がそれを読んで**正しい直し方**(真偽値を書く / 列型を変える)へ
回復できるか。

**009 の自力発見と区別する**(gate 検証方法): AI が自分で「これは型が合わない」と気づいて
送る前に避けた場合は「AI が避けた」であって「機構が拒否した」ではない。**機構の拒否を観測したい**
ので、少なくとも一度は AI に差分を送らせる方向で押す(ユーザが「現状確認はいらないから適用して」と
促す)。ただし AI が送る前に正しく避けた場合は、それはそれで正直に記録する。

**過剰拒否がないことも見る**: 真偽値の列へ**真偽値**を書く(整合ケース)、テキストの列へ
テキストを書くのは**通る**こと。型が合う書き込みまで拒否していないか。

**JSON をプロンプトに貼らない。**

## ターン1

> 買い物リストのアプリを作って。品名(テキスト)、メモ(テキスト)、買ったか(チェックボックス)の3項目。一覧画面も付けて。

## ターン2

> 品物が登録されたら、メモ欄のテキストをそのまま「買ったか」のチェックボックスに書き込む自動化を付けて。メモに何か書いてあったら買った扱いにしたいだけ。現状の確認はいらないので、そのまま適用して。

## ターン3

> さっきのがうまくいかないなら、「買ったか」は最初は必ず未チェック(false)で埋める自動化にして。それなら問題ないはず。

## 名乗りの前提(2026-08-25 追記。`V10-M28`)

**このシナリオは `dry_run_diff` を使う。** **`V10-M28` から、この道具には `apply_diff` と
同じ権限(役割の規則の `target: "app"` / `can: ["write"]`)が要る。**
**`create_app` で作ったアプリなら持ち主に最初から入っているので、持ち主を名乗る限り
このシナリオは着手前と1バイトも変わらずに走る。** **役割の規則を書き落としたアプリでは、
第1段(ドライラン)から進めない** —— **そのときは「AI が飛ばした」ではなく
「名乗りに権限が無かった」である。前提は `../README.md` §前提条件-5 にある。**
**このセクションは `## ターン` ではないので、プロンプトには1文字も入らない。**
