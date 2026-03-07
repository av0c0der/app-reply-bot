# AGENTS.md

## Deployment Access

- Store remote deployment SSH settings in the local `.env` file.
- Use these environment variables when a task involves deploying this project: `DEPLOY_SSH_USER`, `DEPLOY_SSH_HOST`, `DEPLOY_SSH_KEY_PATH`, `DEPLOY_SSH_KEY_PASSPHRASE`, `DEPLOY_APP_PATH`.
- Keep concrete deployment values out of tracked files. Real server details belong only in the local `.env`.
- Before deployment, SSH to the host, change into `$DEPLOY_APP_PATH`, then run the required deploy commands there.
- If the SSH key is protected with a macOS Keychain-backed passphrase, prefer loading it into the agent first so future SSH commands can run non-interactively.
