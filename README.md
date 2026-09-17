# farm-log

農作業日誌アプリ。Vercel Blobを使って複数端末で記録を同期できます。

## Vercel設定

- Private Blob Storeをプロジェクトへ接続
- `FARM_LOG_SYNC_KEY`をProductionとPreviewの暗号化環境変数に設定
- Blob SDKはVercel上ではOIDC認証を優先して使用
