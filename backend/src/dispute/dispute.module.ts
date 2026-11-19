import { Module } from '@nestjs/common';
import { DisputeSagaService } from './dispute-saga.service';
import { DisputeSagaController } from './dispute-saga.controller';
import { EscrowDisputeController } from './escrow-dispute.controller';
import { EscrowModule } from '../escrow/escrow.module';
import { WebhookModule } from '../webhook/webhook.module';
import { ReputationModule } from '../reputation/reputation.module';
import { NotificationModule } from '../notification/notification.module';
import { MonitoringModule } from '../monitoring/monitoring.module';
import { IpfsPinningModule } from '../ipfs-pinning/ipfs-pinning.module';
import { IpfsPinningService } from '../ipfs-pinning/ipfs-pinning.service';
import { DISPUTE_EVIDENCE_PINNER } from './dispute-evidence.pinner';

@Module({
  imports: [
    EscrowModule,
    WebhookModule,
    ReputationModule,
    NotificationModule,
    MonitoringModule,
    IpfsPinningModule,
  ],
  controllers: [DisputeSagaController, EscrowDisputeController],
  providers: [
    DisputeSagaService,
    {
      provide: DISPUTE_EVIDENCE_PINNER,
      useExisting: IpfsPinningService,
    },
  ],
  exports: [DisputeSagaService],
})
export class DisputeModule {}
