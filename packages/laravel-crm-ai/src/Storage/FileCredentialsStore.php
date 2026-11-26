<?php

namespace NodeService\CrmAi\Storage;

use Illuminate\Contracts\Encryption\Encrypter;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Filesystem\Filesystem;
use NodeService\CrmAi\Contracts\CredentialsStore;
use RuntimeException;

class FileCredentialsStore implements CredentialsStore
{
    public function __construct(
        private readonly string $path,
        private readonly Filesystem $files,
        private readonly Encrypter $encrypter,
    ) {}

    public function ready(): bool
    {
        return true;
    }

    public function install(): void
    {
        $this->files->ensureDirectoryExists(dirname($this->path), 0700);
    }

    public function read(): ?array
    {
        if (! $this->files->exists($this->path)) {
            return null;
        }
        $value = json_decode($this->encrypter->decryptString($this->files->get($this->path)), true, 512, JSON_THROW_ON_ERROR);
        if (! is_array($value)) {
            throw new RuntimeException('Invalid CRM AI credentials storage.');
        }
        return $value;
    }

    public function update(callable $change): array
    {
        $this->install();
        $lock = fopen($this->path.'.lock', 'c');
        if ($lock === false) {
            throw new RuntimeException('Cannot lock CRM AI credentials.');
        }
        try {
            if (! flock($lock, LOCK_EX)) {
                throw new RuntimeException('Cannot lock CRM AI credentials.');
            }
            try {
                $current = $this->read();
            } catch (DecryptException) {
                $current = [];
            }
            $value = $change($current);
            $encrypted = $this->encrypter->encryptString(json_encode($value, JSON_THROW_ON_ERROR));
            $this->files->replace($this->path, $encrypted, 0600);
            return $value;
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }
}
