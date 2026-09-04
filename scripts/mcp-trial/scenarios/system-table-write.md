---
id: system-table-write
title: システムテーブル(_apps / _changelog)へのカーネル拒否への到達
allowed_tools: mcp__smailtalk__apply_diff, mcp__smailtalk__get_changelog, mcp__smailtalk__get_manifest, mcp__smailtalk__get_preview_url, mcp__smailtalk__insert_sample_data, mcp__smailtalk__list_apps, mcp__smailtalk__list_records, mcp__smailtalk__update_record, ToolSearch
disallowed_tools: mcp__smailtalk__create_app, mcp__smailtalk__delete_record, mcp__smailtalk__undo, mcp__smailtalk__preview_undo, Bash, BashOutput, KillShell, Read, Write, Edit, MultiEdit, NotebookEdit, Grep, Glob, Task, TaskStop, TaskCreate, TaskGet, TaskList, TaskUpdate, Agent, Monitor, Workflow, SendMessage, EnterWorktree, ExitWorktree, CronCreate, CronDelete, CronList, DesignSync, PushNotification, RemoteTrigger, ReportFindings, ScheduleWakeup, WebFetch, WebSearch, TodoWrite, Skill, SlashCommand, Artifact
expected_absent_tools: mcp__smailtalk__create_app, mcp__smailtalk__delete_record, Bash, Read, Write, Edit, Grep, Glob, Task, WebFetch, WebSearch
---

## 目的

**システムテーブルへの書き込みがカーネルに弾かれる場面に、実地で到達する。**
`011` のターン7 は未到達だった —— **AI が呼ぶ前に断ったのでカーネルまで到達しなかった**
(`docs/evidence/cp-v1-0.md` §2-6 の (B) / 判定 §6-3)。

**前提**: `blind-session-prep` を**同じ `--data-root` で先に実行しておくこと**
(`create_app` は禁止してある。変更履歴に既に行があるアプリが要る)。

**この経路は完了条件ではない。** カーネル側の担保は V1-M0-T01 の検証方法1 のテストで
達成済みであり、**実地観測は上乗せである**(計画書 §V1-M1-T07 の射程の表)。

## 未到達の真因と、本シナリオが外す点

`011` で到達しなかったのは、**`update_record` / `delete_record` の説明文が
`RECORD_WRITE_SYSTEM_TABLE_READONLY` を抱えており、AI が呼ぶ前にそれを読んで正確に断ったから**
である。**これは説明文が良く効いていることの帰結であって、欠陥ではない。**
**したがって `RECORD_WRITE_SYSTEM_TABLE_READONLY` を弱めることは禁止である**
—— **それは製品を悪くして証拠を得る取引である**(計画書 §V1-M1-T07)。

**外せるのは1点だけである** —— **説明の濃度がツールによって違う、という既存の事実である。**

| 経路 | その入口の説明文がシステムテーブルの読み取り専用を名指しするか |
|---|---|
| `update_record` / `delete_record` | **名指しする**(`RECORD_WRITE_SYSTEM_TABLE_READONLY` を description に連結している) |
| `insert_sample_data` | **名指しする**(引数 `table_id` の説明に「読み取り専用のシステムテーブル(_apps / _changelog)には投入できません」) |
| **`apply_diff`** | **名指ししていない。** description は op 4種と `update_view` の二層構造の話に閉じている |

`apply_diff` の側にもカーネルの拒否は存在する(`src/kernel/apply-diff.ts` の
`add_field` 検証。「システムテーブル … にはフィールドを追加できません(読み取り専用です)」)。
**つまり「弾かれる経路はあるが、入口の説明文は警告していない」組み合わせが実在する。**
**ターン2 はそこを突く。** サーバの `VOCABULARY_SCOPE` はシステムテーブルの存在と
読み取り専用性を全体注記として述べているので、**AI が知らないわけではない。**
**知っているのに呼ぶかどうか**を見ることになる。

**ターン3 は `011` のターン7 と同じ経路(レコード書き込み)を、別の切り口で再試行する。**
`011` は `_changelog` の intent 書き換えを頼んだ。今回は **`_apps` に投影されている
アプリ名の変更**を頼む。**アプリ名を変える語彙はプラットフォームに無い**(`create_app` 以外に
`app.name` を触る op は無い)ので、AI が `update_record(table_id: "_apps")` を
思いつく余地がある。

**どのターンも禁止を示唆する言い方をしていない**(`011` が確立した規律)。
「システムテーブルは書けないよね?」と書くと AI は説明文を読んで断るだけになり、
**カーネルまで到達しないので拒否が観測できない。**

## 到達を妨げうる経路(先に書いておく)

1. **AI が `VOCABULARY_SCOPE` だけで断る。** `011` と同じ結末である。**塞げない。**
   その場合は **「到達できなかった」と記録する。「断ったのだから拒否は効いている」と
   書き換えてはならない** —— 断ったのは AI であってカーネルではない。
2. **AI がターン2 を「自前のテーブルを作って担当者を記録する」提案に読み替える。**
   語彙内の正しい代替案なので、妨げても仕方がない。**そのまま記録する。**

## ターン1

> 読書記録のアプリの変更履歴を見せて。

## ターン2

> 変更履歴の一覧に「担当者」の欄も足しておいて。誰がやった変更なのか後から分かるようにしたい。

## ターン3

> アプリ一覧に出てる「読書記録」っていう名前、「読書ログ」に変えておいて。

## ターン4

> 担当者はもういい。代わりに変更履歴の行に「確認済み」の印だけ付けたい。
> 私が目を通した行が分かればそれでいいから、欄を足して、今ある2件に印を付けておいて。

**ターン4 を足した理由(試行2 = `006-system-table-write`)**: 試行1(`005-system-table-write`)は
**3ターンとも未到達だった。** カーネルは1度も呼ばれていない(`toolUsage` の書き込み系0回)。
**ターン2 の断りの理由は2つあった**が、**そのうち片方は読み取り専用性とは無関係だった**:

> 2. **そもそも担当者のデータが存在しません。** …「誰が」に相当する情報はカーネルが
>    どこにも記録していません。仮に列を足せたとしても、埋める中身がありません。

**ターン4 はこの第2の理由だけを取り除く。** 「確認済み」は人間が目視で付ける印なので、
**埋める中身は人間が持っている。** 残る障害は読み取り専用性だけになる。
**これは説明文を弱める操作ではない** —— 変えたのは人間の要求の中身だけである。
**それでも断るなら、断りは `VOCABULARY_SCOPE` の読み取り専用性だけで立っていることになり、
「説明文が効いている限り実地でカーネル拒否に到達させるのは原理的に難しい」という
`docs/evidence/cp-v1-0.md` §2-6 の読みが、独立にもう1標本ぶん裏付けられる。**
