---
id: blind-broken-reference
title: 参照切れエラー(F-19)への到達 —— 別セッションで作ったアプリに対する単一ターン
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__list_apps, mcp__smailtalk__get_preview_url, ToolSearch
disallowed_tools: mcp__smailtalk__get_manifest, mcp__smailtalk__list_records, mcp__smailtalk__get_changelog, mcp__smailtalk__create_app, mcp__smailtalk__insert_sample_data, mcp__smailtalk__update_record, mcp__smailtalk__delete_record, mcp__smailtalk__undo, mcp__smailtalk__preview_undo, Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: mcp__smailtalk__get_manifest, mcp__smailtalk__list_records, mcp__smailtalk__get_changelog, mcp__smailtalk__create_app, Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**F-19(参照切れ拒否エラーの `path` が、送った差分ではなく畳み込んだ結果のマニフェストを
根とする)に、実地で到達する。**

**前提**: `blind-session-prep` を**同じ `--data-root` で先に実行しておくこと。**
このシナリオは自分ではアプリを作らない(`create_app` は禁止してある)。

## 未到達の真因と、本シナリオが外す点

`006-broken-reference` は `get_manifest` と `list_records` を禁止したのに到達しなかった。
**ツールを剥がしても効かなかった理由は構造的である** —— **書き込み系ツールの成功レスポンス
自身が畳み込み後の完全なマニフェストを返す。** `create_app` は `manifest` を丸ごと返し、
`apply_diff` は適用後の状態を返す。**アプリを作ったのが AI 自身である以上、同一セッション内では
AI は常にマニフェストを知っている。** だから AI は「本棚のテーブルは存在していません」と
言い切れた(`docs/evidence/cp-v1-0.md` §2-2)。**これは推論の賢さではなく、単に見えていたのである。**

**本シナリオが外すのは「同一セッションであること」の側だけである。**
アプリは `blind-session-prep` が**別セッション**で作る。本セッションの AI は
書き込み系レスポンスを1件も見ていない状態で始まり、`list_apps`(app_id / 名前 / 作成日時 /
状態しか返さない)だけが唯一の手がかりになる。**テーブル構成を知る経路が構造的に無い。**

**説明文もエラーも1バイトも変えていない。** 変えたのは検証シナリオの側だけである
(計画書 §V1-M1-T07 の「保つべき設計」)。

## 到達を妨げうる残りの経路(先に書いておく)

1. **AI が `add_table` と `add_field` を1つの差分にまとめる。** 参照先を自分で作ってしまえば
   参照切れは起きない。**人間ターンで「テーブルは新しく作らないで」と明示して塞ぐ。**
   これは説明文でもエラーでもなく**人間の要求**なので、製品を弱めていない。
2. **AI が確認手段が無いことを理由に止まる**(F-39 の再現)。**塞げない。**
   塞ごうとすると「前提の食い違いを差し戻す」という保つべき挙動を壊すことになる。
   **止まった場合は「到達できなかった」と記録する。**

## ターン1

> 前に別の会話で作ってもらった読書記録のアプリに、本から本棚への参照を足しておいて。
> 本のテーブルは books で、本棚のテーブルは shelves という ID でもう作ってあるから、
> books に参照の項目を1つ足すだけでいい。項目のIDは shelf、表示名は本棚で。
> テーブルは新しく作らないで。急いでいるので現状の確認はいらない。そのまま適用して。

## ターン2

> 私の勘違いだった。shelves のテーブルは作っていいから、本棚の名前だけ持たせて、参照まで通して。

**ターン2 を足した理由(試行2 = `007-blind-broken-reference`)**: 試行1(`002-blind-broken-reference`)は
**到達した。** カーネルは畳み込み後のマニフェストを根とする
`/app/tables/0/fields/3/reference_table` を返し、AI はそれを正しく読んだ。
**しかし「自己修正できたか」は判定できなかった** —— 修正の手段が
`shelves` を作ることしか無く、**それを人間ターンが明示的に禁じていたからである。**
AI が止まったのは能力不足ではなく指示の遵守である。

**ターン2 はその禁止だけを解除する。** 計画書 §V1-M1-T07 の検証方法は
「参照切れ拒否エラーが AI に返っていることを確認。**そのうえで AI が自己修正できたかを
別途判定する**」であり、**ターン1 だけでは後半を判定できない。**
**ターン2 は AI の応答の中身に依存しない** —— 「勘違いだった / 作っていい」は
参照先が無いとカーネルが言った以上どの回でも人間が言いうる発話である。
