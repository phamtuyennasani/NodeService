<?php

namespace NodeService\CrmAi\Console;

use Illuminate\Console\Command;
use NodeService\CrmAi\CrmAi;

class PublicKeyCommand extends Command
{
    protected $signature = 'crm-ai:public-key';
    protected $description = 'Print the public signing key to register in CRM';

    public function handle(CrmAi $crm): int
    {
        $crm->installSigningKey();
        $this->line($crm->publicSigningKey());
        return self::SUCCESS;
    }
}
