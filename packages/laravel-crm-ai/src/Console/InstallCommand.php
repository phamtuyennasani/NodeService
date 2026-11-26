<?php

namespace NodeService\CrmAi\Console;

use Illuminate\Console\Command;
use Illuminate\Filesystem\Filesystem;
use Illuminate\Support\Str;
use NodeService\CrmAi\CrmAi;

class InstallCommand extends Command
{
    protected $signature = 'crm-ai:install {--configure : Enter CRM connection settings}';
    protected $description = 'Install CRM AI storage, configuration and the website signing key';

    public function handle(CrmAi $crm, Filesystem $files): int
    {
        $target = config_path('crm-ai.php');
        if (! $files->exists($target)) {
            $files->ensureDirectoryExists(dirname($target));
            $files->copy(__DIR__.'/../../config/crm-ai.php', $target);
        }
        if ($this->option('configure')) {
            if (! $this->input->isInteractive()) {
                $this->error('Run --configure interactively to enter the site token securely.');
                return self::FAILURE;
            }
            $url = rtrim((string) $this->ask('CRM URL', $crm->connection('url')), '/');
            $site = (string) $this->ask('Website ID', $crm->connection('site_id'));
            $token = (string) $this->secret('Website token');
            $local = app()->environment('local', 'testing') && preg_match('~^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$~', $url);
            if ((! CrmAi::validBaseUrl($url) && ! $local) || ! Str::isUuid($site) || ! preg_match('/\A[A-Za-z0-9_-]{16,256}\z/', $token)) {
                $this->error('Enter a valid CRM URL, website UUID and site token.');
                return self::FAILURE;
            }
            $path = config('crm-ai.connection_path');
            $private = $files->exists($path) ? json_decode($files->get($path), true, 512, JSON_THROW_ON_ERROR) : [];
            $private = array_replace((array) $private, ['enabled' => true, 'url' => $url, 'site_id' => $site, 'token' => $token]);
            $files->ensureDirectoryExists(dirname($path), 0700);
            $files->replace($path, json_encode($private, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR), 0600);
        }
        $crm->installSchema();
        $crm->installSigningKey();
        $this->info('CRM AI installed. Register this public key in CRM > Website > Connection API.');
        $this->line($crm->publicSigningKey());
        $this->info('Configure write/manage abilities in config/crm-ai.php, then add the crm-ai::writer Blade component.');
        return self::SUCCESS;
    }
}
