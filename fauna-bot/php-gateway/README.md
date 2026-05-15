# Fauna Teams PHP Gateway

This is the deployable PHP edge app for `bot.pointlabel.com`.

It keeps the shared Microsoft Bot Framework app ID and password on your server, accepts Teams traffic at `/api/messages`, and forwards each activity to the user's current Fauna tunnel at `https://<subdomain>.loca.lt/api/messages`. The local Fauna app answers through the gateway, so the Microsoft app password never has to be stored in Fauna or bundled into the Teams app package.

## Why This Gateway Is Needed

Teams does not read the messaging endpoint from the sideloaded zip. The zip only declares the Teams app and bot ID. Teams sends messages to the endpoint configured on the Azure Bot registration for that bot ID.

That means per-user `*.loca.lt` routing has to happen behind one stable endpoint:

```text
Teams -> Azure Bot registration -> https://bot.pointlabel.com/api/messages -> https://<user>.loca.lt/api/messages
```

## Deploy

1. Upload this directory to the web root for `bot.pointlabel.com`.
2. Copy `.env.example` to `.env` on the server.
3. Put your Microsoft app ID, client secret, and route registration token in `.env`.
4. Keep `.env` out of source control and block direct web access to it if your host does not already do that.
5. Set your Azure Bot messaging endpoint to:

   ```text
   https://bot.pointlabel.com/api/messages
   ```

6. Download the Teams package from:

   ```text
   https://bot.pointlabel.com/download-app
   ```

The gateway also supports `config.php` for hosts that prefer PHP config files. If both `.env` and `config.php` exist, `config.php` wins.

Example `.env`:

```dotenv
FAUNA_BOT_APP_ID=00000000-0000-0000-0000-000000000000
FAUNA_BOT_APP_PASSWORD=server-only-client-secret
FAUNA_GATEWAY_ADMIN_TOKEN=long-random-token-used-by-fauna-to-register-routes
FAUNA_GATEWAY_HOST=bot.pointlabel.com
FAUNA_ALLOWED_TARGET_SUFFIXES=.loca.lt
FAUNA_ROUTE_TTL_SECONDS=21600
```

## Register A Runtime Tunnel

Fauna should generate a random `FAUNA_GATEWAY_SECRET`, start the local bot in gateway mode, start localtunnel, then register the current route:

```bash
curl -X POST https://bot.pointlabel.com/api/routes/register \
  -H "Authorization: Bearer $FAUNA_GATEWAY_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "routeKey": "teams-user:<tenant-id>:<aad-object-id>",
    "target": "https://your-subdomain.loca.lt/api/messages",
    "routeSecret": "a-random-per-runtime-secret"
  }'
```

Start the local bot like this:

```bash
FAUNA_GATEWAY_MODE=1 \
FAUNA_GATEWAY_SECRET="a-random-per-runtime-secret" \
PORT=3978 \
npm start
```

The PHP gateway signs every forwarded request with `X-Fauna-Gateway-Signature: sha256=<hmac>`, and the local bot rejects anything that does not match `FAUNA_GATEWAY_SECRET`.

## Credential Boundary

- `MicrosoftAppId`: public enough to appear in the Teams manifest.
- `MicrosoftAppPassword`: secret; keep only in `bot.pointlabel.com/config.php` or server environment variables.
- `FAUNA_GATEWAY_ADMIN_TOKEN`: secret; used by Fauna to register current tunnels.
- `FAUNA_GATEWAY_SECRET`: per-runtime route secret; safe to generate locally because it is not the Microsoft bot secret.

The user-facing Fauna app should only know the gateway URL, its generated tunnel URL, and the per-runtime gateway secret. It should never receive the Microsoft app password.
