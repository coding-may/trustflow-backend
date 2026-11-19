import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import {
  BackfillProgress,
  MigrationPhase,
  MigrationStatus,
  MigrationStepRecord,
} from './migration.types';

export class RunMigrationDto {
  @ApiPropertyOptional({
    description: 'Number of rows to process per backfill batch',
    example: 100,
    minimum: 1,
    maximum: 5000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  batchSize?: number;

  @ApiPropertyOptional({
    description:
      'Delay in milliseconds between backfill batches, to further reduce load on the target table',
    example: 0,
    minimum: 0,
    maximum: 60000,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(60000)
  batchDelayMs?: number;

  @ApiPropertyOptional({
    description:
      'Preview the migration without applying any changes: counts pending rows and reports ' +
      'what would run, but never executes expand/backfill/contract',
    example: false,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class BackfillProgressDto implements BackfillProgress {
  @ApiProperty() totalRows!: number;
  @ApiProperty() processedRows!: number;
  @ApiProperty() failedRows!: number;
  @ApiPropertyOptional() cursor?: string;
  @ApiProperty() batchSize!: number;
  @ApiPropertyOptional() startedAt?: string;
  @ApiPropertyOptional() updatedAt?: string;
  @ApiPropertyOptional() completedAt?: string;
}

export class MigrationStepRecordDto implements MigrationStepRecord {
  @ApiProperty({ enum: MigrationPhase }) phase!: MigrationPhase;
  @ApiProperty() startedAt!: string;
  @ApiPropertyOptional() completedAt?: string;
  @ApiPropertyOptional() failedAt?: string;
  @ApiPropertyOptional() error?: string;
}

export class MarkMigrationAppliedDto {
  @ApiProperty({
    description: 'Mandatory justification / audit note explaining why this migration was applied out-of-band',
    example: 'Applied manually via psql console during incident INC-1234',
  })
  @IsString()
  @IsNotEmpty({ message: 'Audit note / reason is required' })
  reason!: string;

  @ApiPropertyOptional({
    description: 'Alternative field for justification / audit note',
  })
  @IsOptional()
  @IsString()
  justification?: string;
}

export class MigrationRunResponseDto {
  @ApiProperty() runId!: string;
  @ApiProperty() migrationName!: string;
  @ApiProperty() targetTable!: string;
  @ApiProperty({ enum: MigrationStatus }) status!: MigrationStatus;
  @ApiPropertyOptional({ enum: MigrationPhase }) currentPhase?: MigrationPhase;
  @ApiProperty({ type: BackfillProgressDto }) progress!: BackfillProgressDto;
  @ApiProperty({ type: [MigrationStepRecordDto] }) stepHistory!: MigrationStepRecordDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() completedAt?: string;
  @ApiPropertyOptional() failedAt?: string;
  @ApiPropertyOptional() rollbackReason?: string;
  @ApiPropertyOptional({
    description: 'Audit note provided when a migration is marked applied manually',
  })
  auditNote?: string;
}

export class MigrationDefinitionResponseDto {
  @ApiProperty() name!: string;
  @ApiProperty() targetTable!: string;
  @ApiProperty() description!: string;
}
