<?php

namespace NodeService\CrmAi\Storage;

use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Schema\Blueprint;
use NodeService\CrmAi\Contracts\CredentialsStore;

class ModelCredentialsStore implements CredentialsStore
{
    public function __construct(
        private readonly string $model,
        private readonly int|string|null $id,
        private readonly string $attribute,
    ) {}

    private function record(): Model
    {
        return new $this->model;
    }

    public function ready(): bool
    {
        $record = $this->record();
        $schema = $record->getConnection()->getSchemaBuilder();
        return $schema->hasTable($record->getTable()) && $schema->hasColumn($record->getTable(), $this->attribute);
    }

    public function install(): void
    {
        $record = $this->record();
        $schema = $record->getConnection()->getSchemaBuilder();
        if (! $schema->hasTable($record->getTable())) {
            throw new \RuntimeException('Create the configured settings table before installing CRM AI.');
        }
        if (! $schema->hasColumn($record->getTable(), $this->attribute)) {
            $schema->table($record->getTable(), function (Blueprint $table): void {
                $table->text($this->attribute)->nullable();
            });
        }
    }

    public function read(): ?array
    {
        $query = $this->record()->newQuery();
        $record = $this->id === null ? $query->first() : $query->find($this->id);
        return $record?->mergeCasts([$this->attribute => 'encrypted:array'])->getAttribute($this->attribute);
    }

    public function update(callable $change): array
    {
        $model = $this->record();
        return $model->getConnection()->transaction(function () use ($model, $change): array {
            $query = $model->newQuery()->lockForUpdate();
            $record = ($this->id === null ? $query->first() : $query->find($this->id)) ?? $model->newInstance();
            if ($this->id !== null) {
                $record->setAttribute($record->getKeyName(), $this->id);
            }
            $record->mergeCasts([$this->attribute => 'encrypted:array'])->makeHidden($this->attribute);
            try {
                $current = $record->getAttribute($this->attribute);
            } catch (DecryptException) {
                $current = [];
            }
            $value = $change($current);
            $record->setAttribute($this->attribute, $value);
            $record->save();
            return $value;
        }, 3);
    }
}
