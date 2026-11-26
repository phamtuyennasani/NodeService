<?php

namespace App\CrmAi;

use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\IpUtils;

class Bridge
{
    public function connection(): ?array
    {
        $value = trim(config('crm-ai.connection', ''));
        if (preg_match('/\ACRM_SITE_TOKEN="([^"]+)"\z/', $value, $line)) {
            $value = $line[1];
        }
        [$url, $site, $token] = array_pad(explode('|', $value, 3), 3, '');
        if (! preg_match('/\A[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\z/i', $site)
            || ! preg_match('/\A[A-Za-z0-9_-]{16,256}\z/', $token) || ! filter_var($url, FILTER_VALIDATE_URL)) {
            return null;
        }

        $parts = parse_url($url);
        if (! is_array($parts) || isset($parts['user']) || isset($parts['pass'])
            || isset($parts['query']) || isset($parts['fragment']) || strpos($url, '\\') !== false
            || ! in_array($parts['path'] ?? '', ['', '/'], true)) {
            return null;
        }

        $local = app()->environment('local', 'testing')
            && in_array($parts['host'] ?? '', ['localhost', '127.0.0.1', '[::1]'], true);
        $scheme = $parts['scheme'] ?? '';
        if ($scheme !== 'https' && ! ($local && $scheme === 'http')) {
            return null;
        }

        return ['url' => rtrim($url, '/'), 'site_id' => strtolower($site), 'token_hash' => hash('sha256', $token)];
    }

    public function scriptTag(): string
    {
        $request = request();
        if ($request->user() === null || ! ($connection = $this->connection())) {
            return '';
        }

        $origin = strtolower($request->getSchemeAndHttpHost());
        $expires = (string) (time() + 3600);
        $site = $connection['site_id'];
        $signature = hash_hmac('sha256', "widget\n{$site}\n{$origin}\n{$expires}", $connection['token_hash']);
        $src = $connection['url'].'/widget/v1/ai-writer.js?'.http_build_query([
            'site' => $site, 'expires' => $expires, 'signature' => $signature,
        ], '', '&', PHP_QUERY_RFC3986);

        return view('crm-ai.script', ['src' => $src])->render();
    }

    public static function validProviderUrl(string $value): bool
    {
        $url = parse_url($value);
        if (! is_array($url) || ($url['scheme'] ?? '') !== 'https' || empty($url['host'])
            || isset($url['user']) || isset($url['pass']) || isset($url['query']) || isset($url['fragment'])
            || strpos($value, '\\') !== false || ! filter_var($value, FILTER_VALIDATE_URL)) {
            return false;
        }

        $host = strtolower(trim($url['host'], '[]'));
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) !== false
                && ! IpUtils::checkIp($host, ['100.64.0.0/10', '198.18.0.0/15', '192.0.0.0/24', '::ffff:0:0/96']);
        }
        if (! str_contains($host, '.') || preg_match('/\A[0-9.]+\z/', $host)) {
            return false;
        }
        foreach (['localhost', 'local', 'test', 'internal', 'lan', 'home', 'onion', 'arpa'] as $suffix) {
            if (str_ends_with($host, '.'.$suffix)) {
                return false;
            }
        }
        return true;
    }

    public function proof(array $connection, Request $request, string $body, string $id, PrivateFiles $files): string
    {
        $time = (string) time();
        $nonce = bin2hex(random_bytes(16));
        $message = implode("\n", [
            'site-request-v1', $connection['site_id'], $connection['token_hash'], 'POST',
            '/v1/widget/'.$connection['site_id'].'/previews', strtolower($request->getSchemeAndHttpHost()),
            hash('sha256', $body), $id, '', $time, $nonce,
        ]);
        if (! openssl_sign($message, $signature, $files->signingKey(), OPENSSL_ALGO_SHA256)) {
            throw new \RuntimeException('Không thể ký yêu cầu viết.');
        }
        return $time.'.'.$nonce.'.'.rtrim(strtr(base64_encode($signature), '+/', '-_'), '=');
    }
}
