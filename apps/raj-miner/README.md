# RAJ Miner (isolated app workspace)

This directory is reserved for the separate RAJ Miner app. The existing KAVIXO app at the repository root is not modified by this workspace.

## Separation
- Keep RAJ Miner source and assets under `apps/raj-miner/`.
- Deploy RAJ Miner as its own Railway service with this directory as the service root.
- Use a separate database and environment-variable set from KAVIXO.
- Never copy KAVIXO secrets, database credentials, or Telegram bot tokens into this workspace.

## Current status
This is an isolation scaffold only. The uploaded RAJ Miner archive has not yet been ported into this folder. Before porting, review and remove live token/crypto payout, withdrawal, or reward-transfer flows. A safe UI-only version can be built and tested with mock data.
