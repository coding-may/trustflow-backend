import { ApiProperty } from '@nestjs/swagger';
import {
  ReputationBreakdownEntry,
  ReputationEventLogEntry,
  ReputationEventType,
  ReputationScoreBreakdown,
  ReputationScoreView,
} from './reputation.types';

export class ReputationEventLogEntryDto implements ReputationEventLogEntry {
  @ApiProperty({ enum: ReputationEventType }) type!: ReputationEventType;
  @ApiProperty() counterparty!: string;
  @ApiProperty({ description: 'Signed contribution to the score from this single event' })
  contribution!: number;
  @ApiProperty() occurredAt!: string;
  @ApiProperty({ description: 'Base weight for this event type before amount scaling/dampening' })
  baseWeight!: number;
  @ApiProperty({
    description: 'sqrt(amountXLM) scaling factor, capped at REPUTATION_MAX_AMOUNT_WEIGHT',
  })
  amountWeight!: number;
  @ApiProperty({
    description: 'Sybil dampening applied for repeated interactions with this counterparty',
  })
  dampeningFactor!: number;
}

export class ReputationBreakdownEntryDto
  extends ReputationEventLogEntryDto
  implements ReputationBreakdownEntry
{
  @ApiProperty({
    description:
      "This event's contribution decayed from its own occurredAt to now — illustrative only, " +
      'since the materialized score decays as one aggregate rather than per event',
  })
  decayedContribution!: number;
}

export class ReputationScoreBreakdownResponseDto implements ReputationScoreBreakdown {
  @ApiProperty({ example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })
  address!: string;

  @ApiProperty({ description: 'Current time-decayed, Sybil-dampened trust score', example: 42.5 })
  score!: number;

  @ApiProperty({ description: 'Total escrow/dispute events that have contributed to this score' })
  eventCount!: number;

  @ApiProperty() lastUpdatedAt!: string;

  @ApiProperty({ type: [ReputationBreakdownEntryDto] })
  events!: ReputationBreakdownEntryDto[];
}

export class ReputationScoreResponseDto implements ReputationScoreView {
  @ApiProperty({ example: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX' })
  address!: string;

  @ApiProperty({
    description:
      'Time-decayed, Sybil-dampened trust score derived from escrow completion and dispute history',
    example: 42.5,
  })
  score!: number;

  @ApiProperty({ description: 'Total escrow/dispute events that have contributed to this score' })
  eventCount!: number;

  @ApiProperty({
    description: 'Number of distinct counterparties this address has interacted with',
  })
  distinctCounterparties!: number;

  @ApiProperty({ type: [ReputationEventLogEntryDto] })
  recentEvents!: ReputationEventLogEntryDto[];

  @ApiProperty() lastUpdatedAt!: string;
}
