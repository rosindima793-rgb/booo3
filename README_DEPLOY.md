Deploy package for CrazyOctagon price bot

This folder contains a minimal set of files to run the price bot in GitHub Actions.

Included:
- bot_local_monad/ (the bot code)
- .github/workflows/push_prices.yml (workflow to run the bot)
- .env.example (example environment file)
- scripts/grant_pricer_direct.js
- scripts/set_sponsor_direct.js

Quick steps to deploy to a new GitHub repo:

1) Create a new empty repository on GitHub (example URL will be used below).
2) On your machine (PowerShell):
   cd path/to/deploy-bot
   git init
   git add .
   git commit -m "Initial bot deploy"
   git remote add origin https://github.com/yourname/your-repo.git
   git branch -M main
   git push -u origin main

3) In GitHub settings -> Secrets -> Actions, add:
   - ORACLE_PK = <private key of bot key with PRICER_ROLE> (required for apply)
   - AUTO_APPLY = true (optional) — if you set this secret to `true`, the scheduled workflow will automatically run with `--apply` and perform on‑chain updates. ONLY enable after you tested locally and ensured the ORACLE_PK has minimal privileges and funds.
   - TRADE_MODE = on|off (optional) — if you want trading enabled in CI, set to `on`. Default in workflow is `off`.

Behavior summary:
- By default the scheduled workflow runs a dry‑run every 25 minutes (no on‑chain transactions). This gives automatic price calculations and logs without mutating the chain.
- If you explicitly set `AUTO_APPLY=true` as a repository secret, the scheduled workflow will perform on‑chain updates automatically. Use with caution.
- You can also run the workflow manually via "Run workflow" and pass `APPLY=true` to do a one‑off apply.

Security recommendations:
- Do NOT store `ADMIN_PK` in repository secrets. Keep admin keys offline.
- Make sure `ORACLE_PK` has only `PRICER_ROLE` and the minimal funds required to pay gas. If possible, lock permissions on that account.
- Test locally with `node push_prices.js` (dry run) and with a manual `--apply` once before enabling `AUTO_APPLY`.
