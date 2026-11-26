<?php

namespace NodeService\CrmAi;

use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Http\Client\PendingRequest;
use Illuminate\Http\Client\Request as ClientRequest;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use NodeService\CrmAi\Contracts\CredentialsStore;
use Symfony\Component\HttpFoundation\IpUtils;

class CrmAi
{
    public function __construct(
        private readonly CredentialsStore $store,
        private readonly SigningKey $signingKey,
    ) {}

    public function connection(string $key): mixed
    {
        $token = config('crm-ai.token');
        if (is_string($token) && str_contains($token, '|')) {
            $connection = $this->parseConnectionToken($token);

            return $key === 'enabled'
                ? $connection !== null && filter_var(config('crm-ai.enabled') ?? true, FILTER_VALIDATE_BOOLEAN)
                : ($connection[$key] ?? null);
        }

        $configured = config('crm-ai.'.$key);
        if ($configured !== null) {
            return $configured;
        }
        $path = config('crm-ai.connection_path');
        $private = is_file($path) ? json_decode(file_get_contents($path), true) : [];
        return is_array($private) ? ($private[$key] ?? null) : null;
    }

    private function parseConnectionToken(string $value): ?array
    {
        [$url, $site, $token] = array_pad(explode('|', $value, 3), 3, '');
        if (! Str::isUuid($site) || ! preg_match('/\\A[A-Za-z0-9_-]{16,256}\\z/', $token)
            || preg_match('/[\\x00-\\x20\\x7f\\\\\\\\]/', $url) || ! filter_var($url, FILTER_VALIDATE_URL)) {
            return null;
        }

        $parts = parse_url($url);
        if (! is_array($parts) || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])
            || ! in_array($parts['path'] ?? '', ['', '/'], true)) {
            return null;
        }

        $local = app()->environment('local', 'testing')
            && in_array($parts['host'], ['localhost', '127.0.0.1', '[::1]'], true);
        $scheme = $parts['scheme'] ?? '';
        if ($scheme !== 'https' && ! ($local && $scheme === 'http')) {
            return null;
        }

        return ['url' => rtrim($url, '/'), 'site_id' => $site, 'token' => $token];
    }

    public function enabled(): bool
    {
        return filter_var($this->connection('enabled'), FILTER_VALIDATE_BOOLEAN);
    }

    public function canWrite(): bool
    {
        return (bool) auth()->user()?->canAny((array) config('crm-ai.abilities.write'));
    }

    public function canManage(): bool
    {
        foreach ((array) config('crm-ai.abilities.manage') as $ability) {
            if (auth()->user()?->can($ability)) {
                return true;
            }
        }
        return false;
    }

    private function sensitive(): void
    {
        request()->attributes->set('crm_ai_sensitive', true);
        if (app()->bound('debugbar')) {
            app('debugbar')->disable();
        }
    }

    public function installSchema(): void
    {
        $this->store->install();
    }

    public function credentials(): array
    {
        if (! $this->store->ready()) {
            return [];
        }
        try {
            $stored = $this->store->read();
        } catch (DecryptException) {
            return [];
        }
        return $this->compatible($stored ?? $this->configuredCredentials());
    }

    private function configuredCredentials(): array
    {
        $path = config('crm-ai.connection_path');
        $private = is_file($path) ? json_decode(file_get_contents($path), true) : [];
        $legacy = is_array($private) ? (array) ($private['own'] ?? []) : [];
        $values = [];
        foreach (['base_url', 'api_key', 'model'] as $field) {
            $values[$field] = config('crm-ai.own.'.$field) ?? ($legacy[$field] ?? '');
        }
        return $values;
    }

    public function form(): array
    {
        $this->sensitive();
        $failed = false;
        try {
            $stored = $this->store->ready() ? $this->store->read() : [];
            $credentials = $this->compatible($stored ?? $this->configuredCredentials());
        } catch (DecryptException) {
            $credentials = [];
            $failed = true;
        }
        return [
            'schema_ready' => $this->store->ready(),
            'base_url' => $credentials['base_url'] ?? '',
            'model' => $credentials['model'] ?? '',
            'has_api_key' => ! empty($credentials['api_key']),
            'decryption_failed' => $failed,
        ];
    }

    private function compatible(array $value): array
    {
        if ($value === []) {
            return [];
        }
        return [
            'provider' => 'openai-compatible',
            'base_url' => rtrim(trim((string) ($value['base_url'] ?? '')), '/'),
            'api_key' => (string) ($value['api_key'] ?? ''),
            'model' => (string) ($value['model'] ?? ''),
        ];
    }

    public function mountCredentials(): array
    {
        $empty = ['base_url' => null, 'api_key' => null, 'model' => null];
        if (! $this->canWrite()) {
            return $empty;
        }
        $this->sensitive();
        $configured = $this->credentials();
        $credentials = [];
        foreach (['base_url' => 500, 'api_key' => 2048, 'model' => 160] as $field => $max) {
            $value = $configured[$field] ?? null;
            if (! is_string($value) || trim($value) === '' || strlen(trim($value)) > $max) {
                return $empty;
            }
            $credentials[$field] = trim($value);
        }
        if (! self::validBaseUrl($credentials['base_url'])
            || preg_match('/\A[^\x00-\x20\x7f]+\z/u', $credentials['model']) !== 1
            || preg_match('/[\r\n\x00]/', $credentials['api_key'])) {
            return $empty;
        }
        return $credentials;
    }

    public static function validBaseUrl(mixed $value): bool
    {
        if (! is_string($value) || strlen($value) > 500 || preg_match('/[\x00-\x20\x7f\\\\]/', $value)) {
            return false;
        }
        $parts = parse_url($value);
        if (! is_array($parts) || ($parts['scheme'] ?? '') !== 'https' || empty($parts['host'])
            || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])) {
            return false;
        }
        $host = strtolower(trim($parts['host'], '[]'));
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false
                && ! IpUtils::checkIp($host, ['100.64.0.0/10', '198.18.0.0/15', '192.0.0.0/24', '::ffff:0:0/96']);
        }
        if (! filter_var($host, FILTER_VALIDATE_DOMAIN, FILTER_FLAG_HOSTNAME) || ! str_contains($host, '.')
            || preg_match('/\A[0-9.]+\z/', $host)) {
            return false;
        }
        foreach (['localhost', 'local', 'test', 'internal', 'lan', 'home', 'onion', 'arpa'] as $suffix) {
            if ($host === $suffix || str_ends_with($host, '.'.$suffix)) {
                return false;
            }
        }
        return true;
    }

    public function scriptUrl(): ?string
    {
        $url = rtrim((string) $this->connection('url'), '/');
        $parts = parse_url($url);
        $local = app()->environment('local', 'testing')
            && in_array($parts['host'] ?? '', ['localhost', '127.0.0.1', '[::1]'], true);
        $site = (string) $this->connection('site_id');
        $token = $this->connection('token');
        if (! $this->enabled() || ! Str::isUuid($site) || ! is_string($token) || $token === ''
            || ! is_array($parts) || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment'])
            || ! (($parts['scheme'] ?? '') === 'https' || ($local && ($parts['scheme'] ?? '') === 'http'))) {
            return null;
        }
        $this->sensitive();
        $origin = strtolower(request()->getSchemeAndHttpHost());
        $expires = now()->getTimestamp() + 3600;
        $signature = hash_hmac('sha256', "widget\n{$site}\n{$origin}\n{$expires}", hash('sha256', $token));
        return $url.'/widget/v1/ai-writer.js?'.http_build_query([
            'site' => $site, 'expires' => $expires, 'signature' => $signature,
        ], '', '&', PHP_QUERY_RFC3986);
    }

    public function installSigningKey(): void
    {
        $this->signingKey->install();
    }

    public function publicSigningKey(): string
    {
        return $this->signingKey->publicKey();
    }

    public function requestProof(string $method, string $target, string $body = '', string $origin = '', string $idempotency = '', string $ifMatch = ''): string
    {
        $created = (string) time();
        $nonce = bin2hex(random_bytes(16));
        $message = implode("\n", [
            'site-request-v1', (string) $this->connection('site_id'), hash('sha256', (string) $this->connection('token')),
            $method, $target, $origin, hash('sha256', $body), $idempotency, $ifMatch, $created, $nonce,
        ]);
        return $created.'.'.$nonce.'.'.$this->signingKey->sign($message);
    }

    public function http(): PendingRequest
    {
        if ($this->scriptUrl() === null) {
            throw new \RuntimeException('Configure the CRM URL, site ID and token before using the API.');
        }
        return Http::baseUrl(rtrim((string) $this->connection('url'), '/'))
            ->withToken((string) $this->connection('token'))->acceptJson()->asJson()->connectTimeout(5)->timeout(20)
            ->beforeSending(function (ClientRequest $request) {
                $uri = $request->toPsrRequest()->getUri();
                $target = $uri->getPath().($uri->getQuery() !== '' ? '?'.$uri->getQuery() : '');
                $proof = $this->requestProof($request->method(), $target, $request->body(),
                    $request->header('Origin')[0] ?? '', $request->header('Idempotency-Key')[0] ?? '', $request->header('If-Match')[0] ?? '');
                return $request->toPsrRequest()->withHeader('X-Site-Proof', $proof);
            });
    }
}
