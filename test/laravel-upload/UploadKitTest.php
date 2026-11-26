<?php

use App\CrmAi\Bridge;
use Composer\Autoload\ClassLoader;
use Illuminate\Filesystem\Filesystem;
use Illuminate\Foundation\Auth\User;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Blade;
use Illuminate\Support\ServiceProvider;
use Orchestra\Testbench\TestCase;

class UploadKitTestProvider extends ServiceProvider
{
    public function boot(): void
    {
        $this->app->register(\App\Providers\CrmAiServiceProvider::class);
    }
}

class UploadKitTest extends TestCase
{
    private const SITE = '11111111-1111-4111-8111-111111111111';
    private const TOKEN = 'upload-kit-site-token-fixture';
    private $temporaryDirectory;
    private $loader;

    protected function setUp(): void
    {
        $this->temporaryDirectory = sys_get_temp_dir().'/crm-ai-test-'.bin2hex(random_bytes(12));
        $files = new Filesystem;
        $files->copyDirectory(__DIR__.'/../../integrations/laravel-upload', $this->temporaryDirectory);
        $files->ensureDirectoryExists($this->temporaryDirectory.'/bootstrap/cache');
        $files->put($this->temporaryDirectory.'/composer.json', json_encode(['autoload' => ['psr-4' => ['App\\' => 'app/']]]));
        $config = $this->temporaryDirectory.'/config/crm-ai.php';
        $line = 'CRM_SITE_TOKEN="https://crm.example.test|'.self::SITE.'|'.self::TOKEN.'"';
        $files->put($config, str_replace("'connection' => ''", "'connection' => ".var_export($line, true), $files->get($config)));
        $this->loader = new ClassLoader;
        $this->loader->addPsr4('App\\', $this->temporaryDirectory.'/app');
        $this->loader->register(true);
        parent::setUp();
    }

    protected function getEnvironmentSetUp($app): void
    {
        $app->setBasePath($this->temporaryDirectory);
        $app->useAppPath($this->temporaryDirectory.'/app');
        $app->useConfigPath($this->temporaryDirectory.'/config');
        $app->useStoragePath($this->temporaryDirectory.'/storage');
        $moduleConfig = include $this->temporaryDirectory.'/config/crm-ai.php';
        $app['config']->set([
            'crm-ai' => $moduleConfig,
            'app.key' => 'base64:'.base64_encode(str_repeat('F', 32)),
            'session.driver' => 'array',
            'cache.default' => 'array',
            'view.compiled' => $this->temporaryDirectory.'/views',
            'view.paths' => [$this->temporaryDirectory.'/resources/views'],
        ]);
    }

    protected function getPackageProviders($app): array
    {
        return [UploadKitTestProvider::class];
    }

    protected function tearDown(): void
    {
        parent::tearDown();
        $this->loader->unregister();
        $resolved = realpath($this->temporaryDirectory);
        if ($resolved && realpath(dirname($resolved)) === realpath(sys_get_temp_dir()) && strpos(basename($resolved), 'crm-ai-test-') === 0) {
            (new Filesystem)->deleteDirectory($resolved);
        }
    }

    public function testTheCopiedDirectoryWorksWithCompiledRoutesAndKeepsSecretsOnProtectedRoutes(): void
    {
        $router = app('router');
        $routes = $router->getRoutes();
        self::assertContains('web', $routes->getByName('crm-ai.authorize')->gatherMiddleware());
        foreach ($routes as $route) {
            $route->prepareForSerialization();
        }
        $router->setCompiledRoutes($routes->compile());

        $this->getJson('/crm-ai/credentials')->assertUnauthorized();
        $this->postJson('/crm-ai/authorize', [])->assertUnauthorized();
        Gate::before(function () { return false; });

        $this->actingAs((new User)->forceFill(['id' => 3]));
        self::assertNotSame('', app(Bridge::class)->scriptTag());
        $this->getJson('/crm-ai/credentials')->assertOk();
        $this->postJson('/crm-ai/authorize', [])->assertStatus(422);

        $this->actingAs((new User)->forceFill(['id' => 1]));
        $this->get('/crm-ai/settings')->assertOk()->assertSee('Tạo khóa máy chủ');
        $this->post('/crm-ai/signing-key')->assertRedirect('/crm-ai/settings');
        $publicKey = $this->get('/crm-ai/settings')->assertOk()->assertSee('BEGIN PUBLIC KEY');
        self::assertStringNotContainsString('PRIVATE KEY', $publicKey->getContent());
        $path = storage_path('app/private/crm-ai/signing.pem');
        $private = file_get_contents($path);
        $this->post('/crm-ai/signing-key')->assertRedirect('/crm-ai/settings');
        self::assertSame($private, file_get_contents($path));

        $fields = ['base_url' => 'https://ai.example.com/v1', 'api_key' => 'personal-key-fixture', 'model' => 'vendor/model'];
        $this->put('/crm-ai/settings', $fields)->assertRedirect('/crm-ai/settings');
        $this->put('/crm-ai/settings', array_replace($fields, ['api_key' => '', 'model' => 'vendor/updated']))
            ->assertRedirect('/crm-ai/settings');
        self::assertStringNotContainsString($fields['api_key'], file_get_contents(storage_path('app/private/crm-ai/credentials.enc')));
        $this->get('/crm-ai/settings')->assertOk()->assertDontSee($fields['api_key'])->assertSee('vendor/updated');

        $this->actingAs((new User)->forceFill(['id' => 2]));
        $this->putJson('/crm-ai/settings', array_replace($fields, ['model' => 'vendor/updated']))->assertRedirect('/crm-ai/settings');
        $credentials = $this->getJson('/crm-ai/credentials')->assertOk()->assertJson(['api_key' => $fields['api_key'], 'model' => 'vendor/updated']);
        self::assertStringContainsString('no-store', $credentials->headers->get('Cache-Control'));

        $body = '{"model":"vendor/model","keyword":"Thử nghiệm"}';
        $result = $this->postJson('/crm-ai/authorize', ['body' => $body, 'id' => 'job-fixture'])->assertOk();
        [$time, $nonce, $proof] = explode('.', $result->json('proof'));
        $message = implode("\n", [
            'site-request-v1', self::SITE, hash('sha256', self::TOKEN), 'POST', '/v1/widget/'.self::SITE.'/previews',
            strtolower(request()->getSchemeAndHttpHost()), hash('sha256', $body), 'job-fixture', '', $time, $nonce,
        ]);
        $publicPem = openssl_pkey_get_details(openssl_pkey_get_private($private))['key'];
        self::assertSame(1, openssl_verify($message, base64_decode(strtr($proof, '-_', '+/')), $publicPem, OPENSSL_ALGO_SHA256));
        $this->postJson('/crm-ai/authorize', ['body' => '{"model":[]}', 'id' => 'job-fixture'])->assertStatus(422);

        $html = Blade::render('<form id="news-main-form">@include(\'crm-ai.writer\')</form>@include(\'admin.layouts.js\')');
        self::assertStringContainsString('https://crm.example.test/widget/v1/ai-writer.js?site='.self::SITE, $html);
        self::assertStringContainsString('/crm-ai/authorize', $html);
        self::assertStringContainsString('AIWriter.mount', $html);
        self::assertStringNotContainsString(self::TOKEN, $html);
        self::assertStringNotContainsString($fields['api_key'], $html);
    }
}
