<?php

use App\Http\Controllers\CrmAiController;
use App\Http\Middleware\CrmAiPrivateResponse;
use Illuminate\Support\Facades\Route;

Route::prefix(config('crm-ai.prefix', 'crm-ai'))
    ->name('crm-ai.')
    ->middleware(array_merge(['web', CrmAiPrivateResponse::class], config('crm-ai.middleware', ['auth'])))
    ->group(function (): void {
        Route::post('authorize', [CrmAiController::class, 'authorizeWriting'])->middleware('throttle:30,1')->name('authorize');
        Route::get('credentials', [CrmAiController::class, 'credentials'])->name('credentials');
        Route::get('settings', [CrmAiController::class, 'settings'])->name('settings');
        Route::put('settings', [CrmAiController::class, 'saveSettings'])->name('save-settings');
        Route::post('signing-key', [CrmAiController::class, 'createSigningKey'])->middleware('throttle:5,1')->name('signing-key');
    });
