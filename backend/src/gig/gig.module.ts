import { Module, forwardRef } from '@nestjs/common';
import { GigController } from './gig.controller';
import { GigService } from './gig.service';
import { GigExpiryWorkerService } from './gig-expiry-worker.service';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { OutboxModule } from '../outbox/outbox.module';
import { EscrowModule } from '../escrow/escrow.module';

@Module({
  imports: [MonitoringModule, OutboxModule, forwardRef(() => EscrowModule)],
  controllers: [GigController],
  providers: [GigService, GigExpiryWorkerService],
  exports: [GigService],
})
export class GigModule {}
