# ActionGate cURL example

Start ActionGate with `pnpm dev:api`, then run:

```bash
./examples/curl/authorize.sh
```

The script proposes a sandbox refund and prints the complete authorization response. It reads `ACTIONGATE_URL` and `ACTIONGATE_API_KEY` from the environment when provided, otherwise it uses the safe local defaults from `.env.example`.
