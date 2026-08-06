# ダッシュボードGASの appsscript.json について

## ⚠️ 絶対に「全文置き換え」しないこと

2026-08-06 に事故が発生しています。
SSOログインの権限エラー（`UrlFetchApp.fetch を呼び出す権限がありません`）を直すために
参考用のマニフェストを丸ごと貼り替えたところ、**BigQueryのサービス設定が消え**、
翌朝の `dinii-orders`（Dinii注文明細 → BigQuery）が `BigQuery is not defined` で失敗しました。

**このファイルは追記の参考であって、置き換え用ではありません。**
必ず今の `appsscript.json` を開き、**足りない項目だけを足してください。**

## このプロジェクトが必要とするもの

### 高度なサービス（消すと BigQuery が動かなくなる）

```json
"dependencies": {
  "enabledAdvancedServices": [
    { "userSymbol": "BigQuery", "serviceId": "bigquery", "version": "v2" }
  ]
}
```

### OAuthスコープ（用途）

| スコープ | 何に使うか |
|---|---|
| `https://www.googleapis.com/auth/spreadsheets` | スプレッドシートの読み書き |
| `https://www.googleapis.com/auth/script.external_request` | **SSOログイン**（UrlFetchApp で Supabase に問い合わせ） |
| `https://www.googleapis.com/auth/script.scriptapp` | トリガー |
| `https://www.googleapis.com/auth/drive` | DriveApp |
| `https://www.googleapis.com/auth/bigquery` | **BigQueryへの投入**（dinii-orders） |

### ウェブアプリの公開設定

```json
"webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" }
```

`executeAs` が `USER_ACCESSING` だと、ダッシュボードからの匿名アクセスで
外部通信ができず SSOログインが失敗します。

## マニフェストを触ったあとに必ず確認すること

1. JSONの構文（カンマ抜けが起きやすい）
2. **`dinii-orders` の疎通**（BigQueryが生きているか）
3. 統合アカウントでのログイン
4. 再認可 → **デプロイを管理 → 新バージョン → デプロイ**（保存だけでは公開版に反映されません）
