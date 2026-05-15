<?php

return [
    // Shared Azure Bot / Microsoft Entra app registration. Keep these only on
    // bot.pointlabel.com, never inside the Fauna desktop app or Teams zip.
    'microsoft_app_id' => '00000000-0000-0000-0000-000000000000',
    'microsoft_app_password' => 'put-client-secret-here',

    // Stable Teams app package ID. This is not the Azure Bot App ID.
    'teams_app_id' => '11111111-1111-4111-8111-111111111111',

    // Used by Fauna desktop to register its current localtunnel target.
    'admin_token' => 'replace-with-a-long-random-token',

    // Public host for this gateway.
    'gateway_host' => 'bot.pointlabel.com',

    // Route targets are restricted to these suffixes unless changed here.
    'allowed_target_suffixes' => ['.loca.lt'],

    // Routes expire so stale tunnels do not hang around forever.
    'route_ttl_seconds' => 21600,
];
