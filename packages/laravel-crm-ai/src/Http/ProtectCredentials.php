<?php

namespace NodeService\CrmAi\Http;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class ProtectCredentials
{
    public function handle(Request $request, Closure $next): Response
    {
        $prefix = trim(config('crm-ai.routes.prefix'), '/');
        $patterns = array_merge((array) config('crm-ai.protected_paths'), [
            trim($prefix.'/'.config('crm-ai.routes.authorize_uri'), '/'),
            trim($prefix.'/'.config('crm-ai.routes.settings_uri'), '/'),
        ]);
        $protected = $request->is(...$patterns);
        if ($protected && app()->bound('debugbar')) {
            app('debugbar')->disable();
        }
        $response = $next($request);
        if ($protected || $request->attributes->get('crm_ai_sensitive')) {
            $response->headers->set('Cache-Control', 'no-store, private');
        }
        return $response;
    }
}
