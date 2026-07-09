# 日報を毎日正午に自動配信する（GAS時計トリガー設定ガイド）

GitHub内蔵のスケジュールは時刻が数十分〜数時間ずれます（無料/publicリポジトリの仕様）。
そこで、**今あるGoogle Apps Script（スプレッドシートのやつ）の「時計トリガー」** から、
毎日正午にGitHubのワークフローを起動します。新しいサービス登録は不要・画面はすべて日本語です。

所要 約10分・一度きりの設定です。

---

## ステップ1: GitHubトークン（PAT）を作る

GASがあなたの代わりにワークフローを起動するための鍵です。

1. https://github.com/settings/personal-access-tokens/new を開く（Fine-grained token）
2. 次のとおり設定:
   - **Token name**: `gas-lark-report`（任意）
   - **Expiration**: `No expiration`（または長め。切れると止まります）
   - **Resource owner**: `mirai-oss`
   - **Repository access**: `Only select repositories` → **`mirai-oss/tori-dashboard`** を選択
   - **Repository permissions** → **Actions** を **`Read and write`** に変更（他は変更不要）
3. **Generate token** を押し、表示された `github_pat_xxxxx...` を**コピー**
   （この画面を離れると二度と見えません）

---

## ステップ2: GASにコードを追加

1. スプレッドシートを開き、上部メニュー **拡張機能 → Apps Script** を開く
2. 左の**ファイル一覧の「＋」→「スクリプト」** で新規ファイルを作成（名前は `LarkCron` 等）
3. リポジトリの [`gas/LarkCron.gs`](gas/LarkCron.gs) の内容を**全部コピーして貼り付け → 保存（💾）**

> ⚠ 既存の `Code.gs` は触りません。別ファイルとして足すだけです。

---

## ステップ3: トークンをGASに登録

1. Apps Scriptエディタ左の **⚙ プロジェクトの設定** を開く
2. 下の方の **「スクリプト プロパティ」→「スクリプト プロパティを追加」**
   - **プロパティ**: `GH_TOKEN`
   - **値**: ステップ1でコピーした `github_pat_xxxx...`
3. **スクリプト プロパティを保存**

---

## ステップ4: 認可＆送信テスト

1. エディタ上部の関数選択で **`testDaily`** を選び、**「実行」** を押す
2. 初回は「承認が必要です」→ あなたのGoogleアカウントで**許可**（外部通信の権限）
3. 実行後、GitHub → Actions に「Lark自動レポート」の新しい実行が現れ、
   少ししてLarkに日報カードが届けば成功 🎉

---

## ステップ5: 毎日自動で動くようにトリガー設定

1. Apps Scriptエディタ左の **⏰ トリガー**（時計アイコン）を開く
2. 右下 **「トリガーを追加」**
   - 実行する関数: **`larkReportTick`**
   - 実行するデプロイ: `Head`
   - イベントのソース: **時間主導型**
   - 時間ベースのトリガーのタイプ: **分ベースのタイマー**
   - 間隔: **15分おき**
3. **保存**

これで完了です。以後、Googleが確実にトリガーを回し、
**日報=毎日12:00 / 週報=1,8,15,22,29日12:15 / 月報=毎月1日12:30** に自動配信されます。

---

## ステップ6（重要）: GitHub側の古いスケジュールを止める

これをしないと、GitHubの遅延スケジュールが後から発火して**日報が二重に届く**ことがあります。

- [ワークフロー編集画面](https://github.com/mirai-oss/tori-dashboard/edit/main/.github/workflows/lark-report.yml) を開く
- 中身を全部消し、[`scripts/lark-report.workflow.yml`](scripts/lark-report.workflow.yml) の「Raw」全文を貼り付け → **Commit changes**
  （このファイルは既に `schedule:` を無効化済みです）

---

## 困ったとき

- テスト実行でエラー → トークンの権限が **Actions: Read and write** か、`GH_TOKEN` の値が正しいか確認
- Larkに来ない → GitHub Actions の実行ログで「カードを送信しました」が出ているか確認
- 手動で送りたい → GitHub → Actions →「Lark自動レポート」→ Run workflow で種別を選択
- 過去の特定日を送り直したい → 私（Claude）に「6/15の週報を送って」等と依頼（`REPORT_DATE`対応）
