<?php

declare(strict_types=1);

const ROUTES_FILE = __DIR__ . '/storage/routes.json';
const JWKS_CACHE_FILE = __DIR__ . '/storage/botframework-jwks.json';
const TOKEN_CACHE_FILE = __DIR__ . '/storage/connector-token.json';

$config = load_config();
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    if ($method === 'GET' && $path === '/health') {
        json_response(['status' => 'ok', 'routes' => count(load_routes()), 'time' => gmdate('c')]);
    }

    if ($method === 'GET' && ($path === '/download-app' || $path === '/app.zip')) {
        send_teams_zip($config);
    }

    if ($method === 'GET' && $path === '/manifest.json') {
        json_response(build_manifest($config));
    }

    if ($method === 'POST' && $path === '/api/routes/register') {
        require_admin($config);
        register_route($config);
    }

    if ($method === 'POST' && $path === '/api/messages') {
        handle_bot_activity($config);
    }

    json_response(['error' => 'Not found'], 404);
} catch (Throwable $exception) {
    error_log('[fauna-gateway] ' . $exception->getMessage());
    json_response(['error' => $exception->getMessage()], 500);
}

function load_config(): array
{
    load_env_file(__DIR__ . '/.env');
    $fileConfig = file_exists(__DIR__ . '/config.php') ? require __DIR__ . '/config.php' : [];
    return array_merge([
        'microsoft_app_id' => getenv('FAUNA_BOT_APP_ID') ?: '',
        'microsoft_app_password' => getenv('FAUNA_BOT_APP_PASSWORD') ?: '',
        'teams_app_id' => getenv('FAUNA_TEAMS_APP_ID') ?: '',
        'admin_token' => getenv('FAUNA_GATEWAY_ADMIN_TOKEN') ?: '',
        'gateway_host' => getenv('FAUNA_GATEWAY_HOST') ?: ($_SERVER['HTTP_HOST'] ?? 'bot.pointlabel.com'),
        'allowed_target_suffixes' => explode(',', getenv('FAUNA_ALLOWED_TARGET_SUFFIXES') ?: '.loca.lt'),
        'route_ttl_seconds' => (int)(getenv('FAUNA_ROUTE_TTL_SECONDS') ?: 21600),
    ], is_array($fileConfig) ? $fileConfig : []);
}

function load_env_file(string $path): void
{
    if (!file_exists($path)) return;

    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $line = trim($line);
        if ($line === '' || str_starts_with($line, '#')) continue;

        [$name, $value] = array_pad(explode('=', $line, 2), 2, '');
        $name = trim($name);
        if ($name === '') continue;

        $value = trim($value);
        if ((str_starts_with($value, '"') && str_ends_with($value, '"'))
            || (str_starts_with($value, "'") && str_ends_with($value, "'"))) {
            $value = substr($value, 1, -1);
        }

        if (getenv($name) === false) {
            putenv($name . '=' . $value);
            $_ENV[$name] = $value;
        }
    }
}

function handle_bot_activity(array $config): void
{
    require_bot_framework_auth($config);

    $rawBody = file_get_contents('php://input') ?: '';
    $activity = json_decode($rawBody, true);
    if (!is_array($activity)) json_response(['error' => 'Invalid JSON activity'], 400);

    $route = find_route_for_activity($activity);
    if (!$route) {
        $keys = route_candidates($activity);
        $message = "Fauna is not paired for this Teams identity yet. Open Fauna, start the Teams gateway tunnel, and register this route key: " . ($keys[0] ?? 'unavailable');
        send_connector_activity($config, $activity, ['type' => 'message', 'text' => $message]);
        json_response(['status' => 'unpaired']);
    }

    $targetResponse = forward_to_target($route, $rawBody);
    foreach (normalize_target_activities($targetResponse) as $replyActivity) {
        send_connector_activity($config, $activity, $replyActivity);
    }

    json_response(['status' => 'ok']);
}

function register_route(array $config): void
{
    $payload = read_json_body();
    $target = normalize_target_url((string)($payload['target'] ?? ''), $config);
    $routeSecret = (string)($payload['routeSecret'] ?? $payload['route_secret'] ?? '');
    if ($routeSecret === '') json_response(['error' => 'routeSecret is required'], 400);

    $routeKey = (string)($payload['routeKey'] ?? $payload['route_key'] ?? '');
    if ($routeKey === '' && isset($payload['tenantId'], $payload['teamsUserAadObjectId'])) {
        $routeKey = 'teams-user:' . $payload['tenantId'] . ':' . $payload['teamsUserAadObjectId'];
    }
    if ($routeKey === '' && isset($payload['tenantId'], $payload['teamsFromId'])) {
        $routeKey = 'teams-from:' . $payload['tenantId'] . ':' . $payload['teamsFromId'];
    }
    if ($routeKey === '' && isset($payload['conversationId'])) {
        $routeKey = 'conversation:' . $payload['conversationId'];
    }
    if ($routeKey === '') json_response(['error' => 'routeKey, tenantId + teamsUserAadObjectId, or conversationId is required'], 400);

    $routes = load_routes();
    $now = time();
    $routes[$routeKey] = [
        'target' => $target,
        'routeSecret' => $routeSecret,
        'createdAt' => $now,
        'expiresAt' => $now + max(300, (int)$config['route_ttl_seconds']),
    ];
    save_routes($routes);

    json_response([
        'status' => 'registered',
        'routeKey' => $routeKey,
        'target' => $target,
        'expiresAt' => gmdate('c', $routes[$routeKey]['expiresAt']),
    ]);
}

function require_admin(array $config): void
{
    $expected = (string)$config['admin_token'];
    if ($expected === '') json_response(['error' => 'Gateway admin token is not configured'], 500);

    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    $provided = preg_match('/^Bearer\s+(.+)$/i', $authorization, $matches) ? trim($matches[1]) : '';
    if (!hash_equals($expected, $provided)) json_response(['error' => 'Unauthorized'], 401);
}

function require_bot_framework_auth(array $config): void
{
    if ((getenv('FAUNA_DEV_ALLOW_UNSIGNED') ?: '') === '1') return;

    $appId = (string)$config['microsoft_app_id'];
    if ($appId === '') json_response(['error' => 'Microsoft app ID is not configured'], 500);

    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
    if (!preg_match('/^Bearer\s+(.+)$/i', $authorization, $matches)) {
        json_response(['error' => 'Missing Bot Framework bearer token'], 401);
    }

    $token = trim($matches[1]);
    $parts = explode('.', $token);
    if (count($parts) !== 3) json_response(['error' => 'Malformed bearer token'], 401);

    $header = json_decode(base64url_decode($parts[0]), true);
    $claims = json_decode(base64url_decode($parts[1]), true);
    if (!is_array($header) || !is_array($claims)) json_response(['error' => 'Invalid bearer token'], 401);

    $now = time();
    if (($claims['aud'] ?? '') !== $appId) json_response(['error' => 'Invalid token audience'], 401);
    if (($claims['exp'] ?? 0) < $now || (($claims['nbf'] ?? 0) > $now + 300)) json_response(['error' => 'Expired bearer token'], 401);

    $issuer = (string)($claims['iss'] ?? '');
    $allowedIssuers = ['https://api.botframework.com', 'https://sts.windows.net/d6d49420-f39b-4df7-a1dc-d59a935871db/'];
    if (!in_array($issuer, $allowedIssuers, true)) json_response(['error' => 'Invalid token issuer'], 401);

    $publicKey = find_jwk_public_key((string)($header['kid'] ?? ''));
    $verified = openssl_verify($parts[0] . '.' . $parts[1], base64url_decode($parts[2]), $publicKey, OPENSSL_ALGO_SHA256);
    if ($verified !== 1) json_response(['error' => 'Invalid token signature'], 401);
}

function find_route_for_activity(array $activity): ?array
{
    $routes = load_routes();
    $changed = false;
    $now = time();
    foreach ($routes as $key => $route) {
        if (($route['expiresAt'] ?? 0) < $now) {
            unset($routes[$key]);
            $changed = true;
        }
    }
    if ($changed) save_routes($routes);

    foreach (route_candidates($activity) as $candidate) {
        if (isset($routes[$candidate])) return $routes[$candidate];
    }
    return null;
}

function route_candidates(array $activity): array
{
    $tenantId = (string)($activity['channelData']['tenant']['id'] ?? '');
    $aadObjectId = (string)($activity['from']['aadObjectId'] ?? '');
    $fromId = (string)($activity['from']['id'] ?? '');
    $conversationId = (string)($activity['conversation']['id'] ?? '');
    $candidates = [];
    if ($tenantId !== '' && $aadObjectId !== '') $candidates[] = 'teams-user:' . $tenantId . ':' . $aadObjectId;
    if ($tenantId !== '' && $fromId !== '') $candidates[] = 'teams-from:' . $tenantId . ':' . $fromId;
    if ($conversationId !== '') $candidates[] = 'conversation:' . $conversationId;
    return $candidates;
}

function forward_to_target(array $route, string $rawBody): array
{
    $secret = (string)($route['routeSecret'] ?? '');
    $signature = hash_hmac('sha256', $rawBody, $secret);
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nX-Fauna-Gateway: bot.pointlabel.com\r\nX-Fauna-Gateway-Signature: sha256={$signature}\r\n",
            'supportsFiles' => false,
            'timeout' => 65,
            'ignore_errors' => true,
        ],
    ]);

    $response = file_get_contents((string)$route['target'], false, $context);
    $statusLine = $http_response_header[0] ?? 'HTTP/1.1 502';
    if (!preg_match('/\s(2\d\d)\s/', $statusLine)) {
        throw new RuntimeException('Route target returned ' . $statusLine);
    }

    $decoded = json_decode($response ?: '{}', true);
    return is_array($decoded) ? $decoded : ['text' => (string)$response];
}

function normalize_target_activities(array $targetResponse): array
{
    if (isset($targetResponse['activities']) && is_array($targetResponse['activities'])) return $targetResponse['activities'];
    if (isset($targetResponse['activity']) && is_array($targetResponse['activity'])) return [$targetResponse['activity']];
    if (isset($targetResponse['text'])) return [['type' => 'message', 'text' => (string)$targetResponse['text']]];
    return [];
}

function send_connector_activity(array $config, array $sourceActivity, array $replyActivity): void
{
    $serviceUrl = rtrim((string)($sourceActivity['serviceUrl'] ?? ''), '/');
    $conversationId = (string)($sourceActivity['conversation']['id'] ?? '');
    if ($serviceUrl === '' || $conversationId === '') throw new RuntimeException('Activity is missing serviceUrl or conversation.id');
    $replyActivity['type'] = $replyActivity['type'] ?? 'message';
    $replyActivity['replyToId'] = $sourceActivity['id'] ?? null;

    $url = $serviceUrl . '/v3/conversations/' . rawurlencode($conversationId) . '/activities';
    $token = get_connector_token($config);
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\nAuthorization: Bearer {$token}\r\n",
            'content' => json_encode($replyActivity, JSON_UNESCAPED_SLASHES),
            'timeout' => 20,
            'ignore_errors' => true,
        ],
    ]);

    $response = file_get_contents($url, false, $context);
    $statusLine = $http_response_header[0] ?? 'HTTP/1.1 502';
    if (!preg_match('/\s(2\d\d)\s/', $statusLine)) {
        throw new RuntimeException('Connector send failed: ' . $statusLine . ' ' . (string)$response);
    }
}

function get_connector_token(array $config): string
{
    $cached = read_json_file(TOKEN_CACHE_FILE);
    if (($cached['expiresAt'] ?? 0) > time() + 60 && isset($cached['access_token'])) return $cached['access_token'];

    $body = http_build_query([
        'grant_type' => 'client_credentials',
        'client_id' => (string)$config['microsoft_app_id'],
        'client_secret' => (string)$config['microsoft_app_password'],
        'scope' => 'https://api.botframework.com/.default',
    ]);
    $context = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/x-www-form-urlencoded\r\n",
            'content' => $body,
            'timeout' => 20,
            'ignore_errors' => true,
        ],
    ]);
    $response = file_get_contents('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token', false, $context);
    $decoded = json_decode($response ?: '{}', true);
    if (!isset($decoded['access_token'])) throw new RuntimeException('Could not get Bot Framework connector token');

    write_json_file(TOKEN_CACHE_FILE, [
        'access_token' => $decoded['access_token'],
        'expiresAt' => time() + (int)($decoded['expires_in'] ?? 3300),
    ]);
    return $decoded['access_token'];
}

function find_jwk_public_key(string $kid)
{
    $jwks = read_json_file(JWKS_CACHE_FILE);
    if (!$jwks || ($jwks['cachedAt'] ?? 0) < time() - 86400) {
        $metadata = json_decode(file_get_contents('https://login.botframework.com/v1/.well-known/openidconfiguration') ?: '{}', true);
        $jwksUri = (string)($metadata['jwks_uri'] ?? '');
        if ($jwksUri === '') throw new RuntimeException('Could not discover Bot Framework JWKS URI');
        $jwks = json_decode(file_get_contents($jwksUri) ?: '{}', true);
        $jwks['cachedAt'] = time();
        write_json_file(JWKS_CACHE_FILE, $jwks);
    }

    foreach (($jwks['keys'] ?? []) as $key) {
        if (($key['kid'] ?? '') === $kid && isset($key['x5c'][0])) {
            $certificate = "-----BEGIN CERTIFICATE-----\n" . chunk_split($key['x5c'][0], 64, "\n") . "-----END CERTIFICATE-----\n";
            $publicKey = openssl_pkey_get_public($certificate);
            if ($publicKey) return $publicKey;
        }
    }
    throw new RuntimeException('Could not find Bot Framework signing key');
}

function send_teams_zip(array $config): void
{
    if (!class_exists('ZipArchive')) json_response(['error' => 'PHP ZipArchive extension is required'], 500);

    $zipPath = tempnam(sys_get_temp_dir(), 'fauna-teams-zip-');
    $zip = new ZipArchive();
    if ($zip->open($zipPath, ZipArchive::OVERWRITE) !== true) throw new RuntimeException('Could not create app zip');
    $zip->addFromString('manifest.json', json_encode(build_manifest($config), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    $zip->addFromString('color.png', read_icon_asset('color.png', generate_png(192, 192, [16, 185, 129, 255])));
    $zip->addFromString('outline.png', read_icon_asset('outline.png', generate_png(32, 32, [255, 255, 255, 255])));
    $zip->close();

    header('Content-Type: application/zip');
    header('Content-Disposition: attachment; filename="fauna-teams-bot.zip"');
    header('Content-Length: ' . filesize($zipPath));
    readfile($zipPath);
    unlink($zipPath);
    exit;
}

function read_icon_asset(string $filename, string $fallback): string
{
    $path = __DIR__ . '/' . $filename;
    if (is_file($path)) {
        $contents = file_get_contents($path);
        if ($contents !== false && $contents !== '') return $contents;
    }
    return $fallback;
}

function build_manifest(array $config): array
{
    $appId = (string)$config['microsoft_app_id'];
    $teamsAppId = (string)($config['teams_app_id'] ?: stable_uuid_from_app_id($appId));
    $host = (string)$config['gateway_host'];
    return [
        '$schema' => 'https://developer.microsoft.com/json-schemas/teams/v1.17/MicrosoftTeams.schema.json',
        'manifestVersion' => '1.17',
        'version' => '1.0.0',
        'id' => $teamsAppId,
        'name' => ['short' => 'Fauna', 'full' => 'Fauna AI Assistant'],
        'description' => [
            'short' => 'Your Fauna AI assistant, everywhere',
            'full' => 'Chat with Fauna from Teams through the Point Label gateway. The Microsoft bot credentials stay on the gateway and your desktop only registers its temporary tunnel route.',
        ],
        'icons' => ['color' => 'color.png', 'outline' => 'outline.png'],
        'accentColor' => '#10B981',
        'developer' => [
            'name' => 'Point Label',
            'websiteUrl' => 'https://' . $host,
            'privacyUrl' => 'https://' . $host . '/privacy',
            'termsOfUseUrl' => 'https://' . $host . '/terms',
        ],
        'bots' => [[
            'botId' => $appId,
            'scopes' => ['personal', 'groupChat'],
            'supportsFiles' => false,
            'isNotificationOnly' => false,
            'commandLists' => [[
                'scopes' => ['personal', 'groupChat'],
                'commands' => [
                    ['title' => 'help', 'description' => 'Show everything Fauna can do'],
                    ['title' => 'status', 'description' => 'Check if Fauna desktop is connected'],
                    ['title' => 'shell', 'description' => 'Run a shell command on your desktop'],
                    ['title' => 'browse', 'description' => 'Open a URL in Fauna browser'],
                    ['title' => 'models', 'description' => 'List available AI models'],
                ],
            ]],
        ]],
        'permissions' => ['identity'],
        'webApplicationInfo' => [
            'id' => $appId,
            'resource' => 'api://botid-' . $appId,
        ],
        'validDomains' => [$host],
    ];
}

function stable_uuid_from_app_id(string $appId): string
{
    $hex = substr(hash('sha256', 'fauna-teams-app:' . $appId), 0, 32);
    $hex[12] = '4';
    $hex[16] = dechex((hexdec($hex[16]) & 0x3) | 0x8);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20, 12);
}

function normalize_target_url(string $target, array $config): string
{
    if ($target === '') json_response(['error' => 'target is required'], 400);
    if (!str_starts_with($target, 'https://')) $target = 'https://' . ltrim($target, '/');
    $parts = parse_url($target);
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    if ($host === '') json_response(['error' => 'Invalid target URL'], 400);

    $allowed = false;
    foreach ((array)$config['allowed_target_suffixes'] as $suffix) {
        $suffix = strtolower(trim((string)$suffix));
        if ($suffix !== '' && str_ends_with($host, $suffix)) $allowed = true;
    }
    if (!$allowed) json_response(['error' => 'Target host is not allowed'], 400);
    if ($path === '' || $path === '/') $path = '/api/messages';
    if ($path !== '/api/messages') json_response(['error' => 'Target path must be /api/messages'], 400);
    return 'https://' . $host . $path;
}

function read_json_body(): array
{
    $payload = json_decode(file_get_contents('php://input') ?: '{}', true);
    if (!is_array($payload)) json_response(['error' => 'Invalid JSON'], 400);
    return $payload;
}

function load_routes(): array
{
    ensure_storage_dir();
    return read_json_file(ROUTES_FILE) ?: [];
}

function save_routes(array $routes): void
{
    write_json_file(ROUTES_FILE, $routes);
}

function read_json_file(string $path): array
{
    if (!file_exists($path)) return [];
    $contents = file_get_contents($path);
    $decoded = json_decode($contents ?: '{}', true);
    return is_array($decoded) ? $decoded : [];
}

function write_json_file(string $path, array $data): void
{
    ensure_storage_dir();
    file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), LOCK_EX);
}

function ensure_storage_dir(): void
{
    if (!is_dir(__DIR__ . '/storage')) mkdir(__DIR__ . '/storage', 0700, true);
}

function json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES);
    exit;
}

function base64url_decode(string $value): string
{
    return base64_decode(strtr($value, '-_', '+/') . str_repeat('=', (4 - strlen($value) % 4) % 4)) ?: '';
}

function generate_png(int $width, int $height, array $rgba): string
{
    $row = chr(0) . str_repeat(chr($rgba[0]) . chr($rgba[1]) . chr($rgba[2]) . chr($rgba[3]), $width);
    $data = str_repeat($row, $height);
    return "\x89PNG\r\n\x1a\n"
        . png_chunk('IHDR', pack('NNCCCCC', $width, $height, 8, 6, 0, 0, 0))
        . png_chunk('IDAT', gzcompress($data))
        . png_chunk('IEND', '');
}

function png_chunk(string $type, string $data): string
{
    return pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
}
