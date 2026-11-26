<?php

namespace NodeService\CrmAi\Contracts;

interface CredentialsStore
{
    public function ready(): bool;

    public function install(): void;

    public function read(): ?array;

    public function update(callable $change): array;
}
