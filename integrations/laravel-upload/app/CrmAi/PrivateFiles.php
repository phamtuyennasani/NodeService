<?php

namespace App\CrmAi;

use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Filesystem\Filesystem;
use Illuminate\Support\Facades\Crypt;
use RuntimeException;

class PrivateFiles
{
    private $files;
    private $directory;
    private $signingPath;

    public function __construct(Filesystem $files)
    {
        $this->files = $files;
        $this->directory = storage_path('app/private/crm-ai');
        $this->signingPath = $this->directory.'/signing.pem';
    }

    public function credentials(): array
    {
        $path = $this->directory.'/credentials.enc';
        if (! $this->files->exists($path)) {
            return [];
        }
        $value = json_decode(Crypt::decryptString($this->files->get($path)), true);
        if (! is_array($value)) {
            throw new DecryptException('Không đọc được cấu hình AI.');
        }
        return $value;
    }

    public function clearCredentials(): void
    {
        $this->locked('credentials', function () {
            $this->files->replace($this->directory.'/credentials.enc', Crypt::encryptString('[]'));
        });
    }

    public function saveCredentials(string $url, string $key, string $model): bool
    {
        return $this->locked('credentials', function () use ($url, $key, $model) {
            if ($key === '') {
                try {
                    $key = $this->credentials()['api_key'] ?? '';
                } catch (DecryptException $error) {
                    return false;
                }
            }
            if ($key === '') {
                return false;
            }
            $values = ['base_url' => $url, 'api_key' => $key, 'model' => $model];
            $this->files->replace($this->directory.'/credentials.enc', Crypt::encryptString(json_encode($values, JSON_THROW_ON_ERROR)));
            return true;
        });
    }

    public function signingKey()
    {
        $path = $this->signingPath;
        $pem = $this->files->isFile($path) ? $this->files->get($path) : null;
        $key = is_string($pem) ? @openssl_pkey_get_private($pem) : false;
        $details = $key === false ? false : openssl_pkey_get_details($key);
        if ($key === false || ($details['ec']['curve_name'] ?? '') !== 'prime256v1') {
            throw new RuntimeException('Khóa máy chủ chưa sẵn sàng.');
        }
        return $key;
    }

    public function publicKey(): ?string
    {
        if (! $this->files->isFile($this->signingPath)) {
            return null;
        }
        return openssl_pkey_get_details($this->signingKey())['key'];
    }

    public function ensureSigningKey(): void
    {
        $this->locked('signing', function () {
            if ($this->publicKey() !== null) {
                return;
            }
            $config = tempnam(sys_get_temp_dir(), 'crm-openssl-');
            if ($config === false) {
                throw new RuntimeException('Không thể tạo cấu hình OpenSSL.');
            }
            try {
                $this->files->put($config, "[req]\ndistinguished_name=dn\n[dn]\n");
                $options = [
                    'private_key_type' => OPENSSL_KEYTYPE_EC,
                    'private_key_bits' => 2048,
                    'curve_name' => 'prime256v1',
                    'config' => $config,
                ];
                $key = openssl_pkey_new($options);
                if ($key === false || ! openssl_pkey_export($key, $pem, null, $options)) {
                    throw new RuntimeException('Không thể tạo khóa P-256.');
                }
                $this->files->replace($this->signingPath, $pem);
                chmod($this->signingPath, 0600);
            } finally {
                $this->files->delete($config);
            }
        });
    }

    private function locked(string $name, callable $callback)
    {
        if (! is_dir($this->directory) && ! @mkdir($this->directory, 0700, true) && ! is_dir($this->directory)) {
            throw new RuntimeException('Không thể tạo thư mục lưu CRM AI.');
        }
        $lock = fopen($this->directory.'/'.$name.'.lock', 'c');
        if ($lock === false) {
            throw new RuntimeException('Không thể mở khóa ghi CRM AI.');
        }
        try {
            if (! flock($lock, LOCK_EX)) {
                throw new RuntimeException('Không thể khóa file CRM AI.');
            }
            return $callback();
        } finally {
            fclose($lock);
        }
    }
}
