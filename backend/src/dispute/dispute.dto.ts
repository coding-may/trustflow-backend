import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBase64,
  IsString,
  IsNotEmpty,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  IsIn,
  MinLength,
  MaxLength,
  IsOptional,
  IsNumber,
  Min,
  Max,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from 'class-validator';
import { DisputeStep, DisputeVerdict, JurorVote, SagaStepRecord } from './dispute.types';
import { StrKey } from '@stellar/stellar-sdk';
import { MAX_BASE64_CONTENT_LENGTH } from '../ipfs-pinning/ipfs-pinning.types';

@ValidatorConstraint({ name: 'isStellarAddress', async: false })
export class IsStellarAddressValidator implements ValidatorConstraintInterface {
  validate(value: string): boolean {
    return StrKey.isValidEd25519PublicKey(value);
  }

  defaultMessage(): string {
    return 'Invalid Stellar address format';
  }
}

export class EscalateDisputeDto {
  /**
   * Set by the server from the authenticated wallet (#633) — never read from
   * the request. Still accepted in the body so existing clients that send it
   * are not rejected by `forbidNonWhitelisted`, but its value is discarded.
   */
  @ApiPropertyOptional({
    description: 'Ignored — the initiator is the authenticated wallet.',
    deprecated: true,
  })
  @IsOptional()
  @IsString()
  initiator!: string;

  @ApiProperty({ description: 'Reason for the dispute', minLength: 10, maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class AssignJurorsDto {
  @ApiProperty({
    description: '3–7 juror Stellar addresses',
    type: [String],
    minItems: 3,
    maxItems: 7,
  })
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(7)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @Validate(IsStellarAddressValidator, { each: true })
  jurors!: string[];
}

export class CastVoteDto {
  @ApiProperty({ description: 'Stellar address of the voting juror' })
  @IsString()
  @IsNotEmpty()
  @Validate(IsStellarAddressValidator)
  jurorAddress!: string;

  @ApiProperty({ enum: ['depositor', 'beneficiary', 'split'] })
  @IsString()
  @IsIn(['depositor', 'beneficiary', 'split'])
  vote!: 'depositor' | 'beneficiary' | 'split';
}

export class ExecutePayoutDto {
  @ApiPropertyOptional({
    description: 'Depositor share percentage for a split verdict (0–100)',
    example: 50,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  splitPercentage?: number;
}

/**
 * Evidence attachment payload. Uses the same shared base64 size limit as the deliverable
 * upload endpoint, so an oversized file is rejected by validation *before* any bytes are
 * decoded or forwarded to pinning storage.
 */
export class SubmitEvidenceDto {
  @ApiProperty({
    description:
      'Base64-encoded evidence file. Maximum decoded size is 10 MB (~13.6 MB base64), ' +
      'the same shared limit used by deliverable uploads.',
    example: 'SGVsbG8sIFRydXN0RmxvdyE=',
  })
  @IsBase64()
  @IsNotEmpty()
  @MaxLength(MAX_BASE64_CONTENT_LENGTH, {
    message: 'content exceeds the maximum allowed size of 10 MB (decoded)',
  })
  content!: string;

  @ApiPropertyOptional({ description: 'Original filename, stored for display purposes only' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  filename?: string;
}

export class DisputeEvidenceDto {
  @ApiProperty() cid!: string;
  @ApiProperty() size!: number;
  @ApiPropertyOptional() filename?: string;
  @ApiProperty() submittedBy!: string;
  @ApiProperty() submittedAt!: string;
}

export class SagaStepRecordDto implements SagaStepRecord {
  @ApiProperty({ enum: DisputeStep }) step!: DisputeStep;
  @ApiProperty() startedAt!: string;
  @ApiPropertyOptional() completedAt?: string;
  @ApiPropertyOptional() failedAt?: string;
  @ApiPropertyOptional() compensatedAt?: string;
  @ApiPropertyOptional() error?: string;
}

export class DisputeSagaResponseDto {
  @ApiProperty() sagaId!: string;
  @ApiProperty() escrowId!: string;
  @ApiProperty() initiator!: string;
  @ApiProperty() reason!: string;
  @ApiProperty({ enum: DisputeStep }) currentStep!: DisputeStep;
  @ApiPropertyOptional() escalationTxHash?: string;
  @ApiPropertyOptional({ type: [String] }) assignedJurors?: string[];
  @ApiPropertyOptional() votes?: JurorVote[];
  @ApiPropertyOptional({ enum: DisputeVerdict }) verdict?: DisputeVerdict;
  @ApiPropertyOptional() payoutTxHash?: string;
  @ApiPropertyOptional({ type: [DisputeEvidenceDto] }) evidence?: DisputeEvidenceDto[];
  @ApiProperty({ type: [SagaStepRecordDto] }) stepHistory!: SagaStepRecordDto[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiPropertyOptional() completedAt?: string;
  @ApiPropertyOptional() failedAt?: string;
  @ApiPropertyOptional() compensationReason?: string;
}
