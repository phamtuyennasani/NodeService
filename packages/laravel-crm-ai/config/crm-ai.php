<?php

return [
    'enabled' => env('CRM_WIDGET_ENABLED'),
    'url' => env('CRM_API_URL'),
    'site_id' => env('CRM_SITE_ID'),
    'token' => env('CRM_SITE_TOKEN'),
    'connection_path' => storage_path('app/private/crm-widget.json'),
    'signing_key_path' => storage_path('app/private/crm-signing.pem'),
    'credentials_path' => storage_path('app/private/crm-ai-credentials.enc'),
    // Set ['source' => 'en', 'targets' => ['vi', 'ja']] from the host website.
    'languages' => null,
    'own' => [
        'base_url' => env('CRM_AI_BASE_URL'),
        'api_key' => env('CRM_AI_API_KEY'),
        'model' => env('CRM_AI_MODEL'),
    ],
    'credentials' => [
        // Set a model only when using an existing encrypted settings column.
        'model' => null,
        'id' => 1,
        'attribute' => 'crm_ai_credentials',
    ],
    'routes' => [
        'prefix' => 'crm-ai',
        'middleware' => ['web', 'auth'],
        'authorize_uri' => 'authorize',
        'settings_uri' => 'settings',
    ],
    'abilities' => [
        'write' => ['crm-ai.write'],
        'manage' => ['crm-ai.manage'],
    ],
    'settings_redirect' => null,
    'protected_paths' => [],
];
