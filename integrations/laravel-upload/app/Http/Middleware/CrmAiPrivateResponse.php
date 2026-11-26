<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;

class CrmAiPrivateResponse
{
    public function handle(Request $request, Closure $next)
    {
        if (app()->bound('debugbar')) {
            app('debugbar')->disable();
        }

        $response = $next($request);
        $response->headers->set('Cache-Control', 'private, no-store');
        return $response;
    }
}
