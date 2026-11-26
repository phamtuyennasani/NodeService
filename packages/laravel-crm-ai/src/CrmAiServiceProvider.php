<?php

namespace NodeService\CrmAi;

use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Route;
use Illuminate\Support\ServiceProvider;
use NodeService\CrmAi\Console\InstallCommand;
use NodeService\CrmAi\Console\PublicKeyCommand;
use NodeService\CrmAi\Contracts\CredentialsStore;
use NodeService\CrmAi\Http\CrmAiController;
use NodeService\CrmAi\Http\ProtectCredentials;
use NodeService\CrmAi\Storage\FileCredentialsStore;
use NodeService\CrmAi\Storage\ModelCredentialsStore;

class CrmAiServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(__DIR__.'/../config/crm-ai.php', 'crm-ai');
        $this->app->singleton(SigningKey::class, fn () => new SigningKey(config('crm-ai.signing_key_path')));
        $this->app->singleton(CredentialsStore::class, function ($app) {
            $model = config('crm-ai.credentials.model');
            return $model
                ? new ModelCredentialsStore($model, config('crm-ai.credentials.id'), config('crm-ai.credentials.attribute'))
                : new FileCredentialsStore(config('crm-ai.credentials_path'), $app['files'], $app['encrypter']);
        });
        $this->app->singleton(CrmAi::class);
        $this->app->alias(CrmAi::class, 'crm-ai');
    }

    public function boot(): void
    {
        $this->loadViewsFrom(__DIR__.'/../resources/views', 'crm-ai');
        $published = resource_path('views/vendor/crm-ai/components');
        if (is_dir($published)) {
            Blade::anonymousComponentPath($published, 'crm-ai');
        }
        Blade::anonymousComponentPath(__DIR__.'/../resources/views/components', 'crm-ai');
        $this->publishes([__DIR__.'/../config/crm-ai.php' => config_path('crm-ai.php')], 'crm-ai-config');
        $this->publishes([__DIR__.'/../resources/views' => resource_path('views/vendor/crm-ai')], 'crm-ai-views');
        $this->app['router']->prependMiddlewareToGroup('web', ProtectCredentials::class);
        $model = config('crm-ai.credentials.model');
        if ($model) {
            $protect = static function ($record): void {
                $attribute = config('crm-ai.credentials.attribute');
                $record->mergeCasts([$attribute => 'encrypted:array'])->makeHidden($attribute);
            };
            $model::retrieved($protect);
            $model::saving($protect);
        }
        if (! $this->app->routesAreCached()) {
            Route::prefix(config('crm-ai.routes.prefix'))->middleware(config('crm-ai.routes.middleware'))->group(function (): void {
                Route::post(config('crm-ai.routes.authorize_uri'), [CrmAiController::class, 'authorizeWriting'])
                    ->middleware('throttle:30,1')->name('crm-ai.authorize');
                Route::put(config('crm-ai.routes.settings_uri'), [CrmAiController::class, 'update'])->name('crm-ai.settings.update');
            });
        }
        if ($this->app->runningInConsole()) {
            $this->commands([InstallCommand::class, PublicKeyCommand::class]);
        }
    }
}
