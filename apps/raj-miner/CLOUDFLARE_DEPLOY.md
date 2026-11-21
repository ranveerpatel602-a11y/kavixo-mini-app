# Deploy RAJ Miner Preview to Cloudflare Pages

This is a static, non-financial UI preview (mock points only).

## Cloudflare Pages settings
- Repository: `ranveerpatel602-a11y/kavixo-mini-app`
- Production branch: `raj-miner-isolated`
- Root directory: `apps/raj-miner`
- Build command: leave blank
- Build output directory: `/` (serve the root of this directory)
- Framework preset: None

Connect via Cloudflare Dashboard > Workers & Pages > Create application > Pages > Connect to Git.
Select the repo and configure the settings above, then Save and Deploy.

Cloudflare Git integration requires the account owner to sign in and authorize GitHub. I cannot authenticate to your Cloudflare account or complete the final dashboard click from this session.

This preview intentionally contains only mock UI and no token payout/withdrawal or wallet-transfer functionality.
