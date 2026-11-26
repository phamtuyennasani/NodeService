<?php

namespace NodeService\CrmAi\Tests;

use Illuminate\Filesystem\Filesystem;
use Illuminate\Foundation\Auth\User;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Route;
use NodeService\CrmAi\CrmAi;
use NodeService\CrmAi\CrmAiServiceProvider;
use Orchestra\Testbench\TestCase;

class CrmAiTest extends TestCase
{
    private string $directory;
    private const SITE = '11111111-1111-4111-8111-111111111111';
    private const TOKEN = 'package-server-token-fixture';

    protected function setUp(): void
    {
        $this->directory = sys_get_temp_dir().'/crm-ai-test-'.bin2hex(random_bytes(12));
        mkdir($this->directory, 0700);
        parent::setUp();
        Gate::define('crm-ai.write', fn ($user) => $user->id === 1);
        Gate::define('crm-ai.manage', fn ($user) => $user->id === 1);
        Http::preventStrayRequests();
    }

    protected function getPackageProviders($app): array
    {
        return [CrmAiServiceProvider::class];
    }

    protected function getEnvironmentSetUp($app): void
    {
        $app->useConfigPath($this->directory.'/config');
        $app['config']->set([
            'app.key' => 'base64:'.base64_encode(str_repeat('p', 32)),
            'app.url' => 'https://editor.example.test',
            'session.driver' => 'array', 'cache.default' => 'array',
            'crm-ai.enabled' => true, 'crm-ai.url' => 'https://crm.example.test',
            'crm-ai.site_id' => self::SITE, 'crm-ai.token' => self::TOKEN,
            'crm-ai.connection_path' => $this->directory.'/connection.json',
            'crm-ai.signing_key_path' => $this->directory.'/signing.pem',
            'crm-ai.credentials_path' => $this->directory.'/credentials.enc',
        ]);
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        $resolved = realpath($this->directory);
        if ($resolved && realpath(dirname($resolved)) === realpath(sys_get_temp_dir()) && str_starts_with(basename($resolved), 'crm-ai-test-')) {
            (new Filesystem)->deleteDirectory($resolved);
        }
    }

    private function login(int $id = 1): void
    {
        $this->actingAs((new User)->forceFill(['id' => $id, 'name' => 'Editor']));
    }

    public function test_install_is_database_independent_and_preserves_existing_keys_and_configuration(): void
    {
        $this->artisan('crm-ai:install')->assertSuccessful();
        $key = file_get_contents($this->directory.'/signing.pem');
        $this->assertFileExists($this->directory.'/config/crm-ai.php');
        $this->artisan('crm-ai:install')->assertSuccessful();
        $this->assertSame($key, file_get_contents($this->directory.'/signing.pem'));
        $this->assertStringStartsWith('-----BEGIN PUBLIC KEY-----', app(CrmAi::class)->publicSigningKey());
        $this->assertFalse(app(CrmAi::class)->form()['has_api_key']);
    }

    public function test_default_routes_require_authentication_permissions_and_web_csrf_middleware(): void
    {
        $route = Route::getRoutes()->getByName('crm-ai.authorize');
        $this->assertContains('web', $route->middleware());
        $this->assertContains('auth', $route->middleware());
        $this->postJson('/crm-ai/authorize', [])->assertUnauthorized();
        $this->login(2);
        $this->postJson('/crm-ai/authorize', [])->assertForbidden();
        $this->putJson('/crm-ai/settings', [])->assertForbidden();
        $this->assertSame('', trim(Blade::render('<x-crm-ai::writer form="#form" :fields="[\'Title\' => \'[name=title]\']" />')));
    }

    public function test_writer_component_renders_the_signed_remote_script_and_field_mapping(): void
    {
        $this->login();
        $html = Blade::render('<x-crm-ai::writer form="#form" :fields="[\'Title\' => \'[name=title]\']" />');
        $this->assertStringContainsString('data-authorize-url=', $html);
        $this->assertStringContainsString('window.AIWriter.mount', $html);
        $this->assertStringContainsString('[name=title]', $html);
        $this->assertStringNotContainsString(self::TOKEN, $html);
        $this->assertStringContainsString('api_key: null', $html);
    }

    public function test_file_settings_encrypt_credentials_keep_blank_keys_and_allow_explicit_removal(): void
    {
        $this->login();
        $fields = ['base_url' => 'https://ai.example.com/v1', 'api_key' => 'private-key-fixture', 'model' => 'vendor/model'];
        $this->from('/settings')->put('/crm-ai/settings', $fields)->assertRedirect();
        $this->assertStringNotContainsString($fields['api_key'], file_get_contents($this->directory.'/credentials.enc'));
        $this->put('/crm-ai/settings', [...$fields, 'api_key' => '', 'model' => 'changed-model'])->assertRedirect();
        $this->assertSame($fields['api_key'], app(CrmAi::class)->credentials()['api_key']);
        $this->assertSame('changed-model', app(CrmAi::class)->credentials()['model']);
        $html = Blade::render('<x-crm-ai::settings />');
        $this->assertStringNotContainsString($fields['api_key'], $html);
        preg_match_all('/<input[^>]+name="([^"]+)"/', $html, $inputs);
        $this->assertSame(['base_url', 'api_key', 'model'], array_values(array_diff($inputs[1], ['_token', '_method'])));
        $this->put('/crm-ai/settings', ['remove_credentials' => true])->assertRedirect();
        $this->assertSame([], app(CrmAi::class)->credentials());
    }

    public function test_one_env_setting_connects_the_signed_client_using_the_raw_token(): void
    {
        config([
            'crm-ai.enabled' => null, 'crm-ai.url' => null, 'crm-ai.site_id' => null,
            'crm-ai.token' => 'https://crm.example.test|'.self::SITE.'|'.self::TOKEN,
        ]);
        $this->assertFileDoesNotExist($this->directory.'/config/crm-ai.php');
        $this->artisan('crm-ai:public-key')->assertSuccessful();
        $crm = app(CrmAi::class);
        Http::fake(['https://crm.example.test/v1/models' => Http::response([])]);
        $crm->http()->get('/v1/models')->throw();
        Http::assertSent(function ($request) use ($crm) {
            [$created, $nonce, $signature] = explode('.', $request->header('X-Site-Proof')[0]);
            $message = implode("\n", ['site-request-v1', self::SITE, hash('sha256', self::TOKEN),
                'GET', '/v1/models', '', hash('sha256', ''), '', '', $created, $nonce]);

            return $request->hasHeader('Authorization', 'Bearer '.self::TOKEN)
                && openssl_verify($message, base64_decode(strtr($signature, '-_', '+/')), $crm->publicSigningKey(), OPENSSL_ALGO_SHA256) === 1;
        });
        $this->login();
        $html = Blade::render('<x-crm-ai::writer form="#form" :fields="[]" />');
        $this->assertStringContainsString('https://crm.example.test/widget/v1/ai-writer.js?site='.self::SITE, $html);
        $this->assertStringNotContainsString(self::TOKEN, $html);
        config(['crm-ai.enabled' => false]);
        $this->assertNull($crm->scriptUrl());
    }

    public function test_invalid_connection_values_fail_closed_with_legacy_settings_present(): void
    {
        $crm = app(CrmAi::class);
        foreach (['http://crm.example.test', 'https://user:pass@crm.example.test', 'https://crm.example.test/path', 'https://crm.example.test?other=1'] as $url) {
            config(['crm-ai.token' => $url.'|'.self::SITE.'|'.self::TOKEN]);
            $this->assertFalse($crm->enabled(), $url);
            $this->assertNull($crm->connection('url'));
            $this->assertNull($crm->scriptUrl());
        }
    }

    public function test_invalid_credentials_are_rejected_and_unreadable_storage_can_be_replaced_explicitly(): void
    {
        $this->login();
        $fields = ['base_url' => 'https://ai.example.com/v1', 'api_key' => 'replacement-key', 'model' => 'model'];
        foreach (['http://ai.example.com', 'https://127.0.0.1/v1', 'https://ai.example.com/v1?key=secret'] as $url) {
            $this->putJson('/crm-ai/settings', [...$fields, 'base_url' => $url])->assertUnprocessable();
        }
        file_put_contents($this->directory.'/credentials.enc', 'unreadable');
        $this->assertTrue(app(CrmAi::class)->form()['decryption_failed']);
        $this->put('/crm-ai/settings', $fields)->assertRedirect();
        $this->assertSame('replacement-key', app(CrmAi::class)->credentials()['api_key']);
    }

    public function test_authorization_signs_exact_bytes_and_does_not_return_backend_secrets(): void
    {
        $this->login();
        $crm = app(CrmAi::class);
        $crm->installSigningKey();
        $body = '{"model":"service-model","keyword":"nội dung"}';
        $response = $this->postJson('/crm-ai/authorize', ['body' => $body, 'id' => 'one-request'])->assertOk();
        [$created, $nonce, $signature] = explode('.', $response->json('proof'));
        $message = implode("\n", ['site-request-v1', self::SITE, hash('sha256', self::TOKEN), 'POST',
            '/v1/widget/'.self::SITE.'/previews', 'http://localhost', hash('sha256', $body), 'one-request', '', $created, $nonce]);
        $this->assertSame(1, openssl_verify($message, base64_decode(strtr($signature, '-_', '+/')), $crm->publicSigningKey(), OPENSSL_ALGO_SHA256));
        $this->assertStringNotContainsString(self::TOKEN, $response->getContent());
        $this->assertStringContainsString('no-store', $response->headers->get('Cache-Control'));
        $this->postJson('/crm-ai/authorize', ['body' => '[]', 'id' => 'bad'])->assertUnprocessable();
    }

    public function test_html_validation_errors_do_not_flash_api_keys_or_authorization_payloads(): void
    {
        $this->login();
        $this->from('/settings')->put('/crm-ai/settings', [
            'base_url' => 'invalid', 'api_key' => 'secret-validation-fixture', 'model' => 'model',
        ])->assertRedirect()->assertSessionHasErrorsIn('crmAi', 'base_url');
        $this->assertNull(session('_old_input.api_key'));
        $this->assertSame('model', session('_old_input.model'));
        $this->post('/crm-ai/authorize', ['body' => '{"api_key":"nested-secret"}'])->assertUnprocessable();
        $this->assertNull(session('_old_input.body'));
    }

    public function test_multilingual_widget_renders_source_and_target_mapping_and_authorizes_the_full_translation_snapshot(): void
    {
        $this->login();
        app(CrmAi::class)->installSigningKey();
        $html = Blade::render('<x-crm-ai::writer form="#article" :fields="$fields" :languages="$languages" :fields-by-locale="$localized" />', [
            'fields' => ['Title' => '#en-title', 'Content' => '#en-body'],
            'languages' => ['source' => 'en', 'targets' => ['vi']],
            'localized' => ['vi' => ['Title' => '#vi-title', 'Content' => '#vi-body']],
        ]);
        $this->assertStringContainsString('"source":"en"', $html);
        $this->assertStringContainsString('"targets":["vi"]', $html);
        $this->assertStringContainsString('fieldsByLocale:', $html);
        $this->assertStringContainsString('#vi-body', $html);
        $body = json_encode(['model' => 'model', 'keyword' => 'article', 'languages' => ['source' => 'en', 'targets' => ['vi']],
            'locale' => 'vi', 'translation_source' => ['Title' => 'Approved', 'Content' => '<p>'.str_repeat('reviewed text ', 2000).'</p>']]);
        $this->assertGreaterThan(16000, strlen($body));
        $this->postJson('/crm-ai/authorize', ['body' => $body, 'id' => 'translation'])->assertOk();
    }

    public function test_http_client_signs_the_actual_body_and_idempotency_header(): void
    {
        $crm = app(CrmAi::class);
        $crm->installSigningKey();
        Http::fake(['*' => Http::response(['status' => 'queued'], 202)]);
        $crm->http()->withHeaders(['Idempotency-Key' => 'api-one'])->post('/v1/article-jobs', ['keyword' => 'nội dung', 'model' => 'model']);
        Http::assertSent(function ($request) use ($crm) {
            [$created, $nonce, $signature] = explode('.', $request->header('X-Site-Proof')[0]);
            $message = implode("\n", ['site-request-v1', self::SITE, hash('sha256', self::TOKEN), 'POST',
                '/v1/article-jobs', '', hash('sha256', $request->body()), 'api-one', '', $created, $nonce]);
            return openssl_verify($message, base64_decode(strtr($signature, '-_', '+/')), $crm->publicSigningKey(), OPENSSL_ALGO_SHA256) === 1;
        });
    }

    public function test_language_templates_render_without_repeated_locale_mappings(): void
    {
        $this->login();
        $html = Blade::render('<x-crm-ai::writer form="#article" :fields="$fields" :languages="$languages" />', [
            'fields' => ['Title' => '[name="name[$lang]"]', 'Content' => '[name="content[$lang]"]'],
            'languages' => ['source' => 'en', 'targets' => ['vi', 'ja']],
        ]);
        $this->assertStringContainsString('name[$lang]', $html);
        $this->assertStringContainsString('content[$lang]', $html);
        $this->assertStringContainsString('"source":"en"', $html);
        $this->assertStringContainsString('"targets":["vi","ja"]', $html);
    }

    public function test_article_identity_can_be_restored_from_a_saved_website_record(): void
    {
        $this->login();
        $html = Blade::render('<x-crm-ai::writer form="#article" :fields="$fields" article-ref="news:123" :source-job-id="$source" />', [
            'fields' => ['Title' => '#title'], 'source' => self::SITE,
        ]);
        $this->assertStringContainsString('articleRef: "news:123"', $html);
        $this->assertStringContainsString('sourceJobId: "'.self::SITE.'"', $html);
        $this->assertStringNotContainsString(self::TOKEN, $html);
    }
}
