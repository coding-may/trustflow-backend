import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { MigrationRunnerService } from './migration-runner.service';
import { MigrationRegistryService } from './migration-registry.service';
import {
  RunMigrationDto,
  MarkMigrationAppliedDto,
  MigrationRunResponseDto,
  MigrationDefinitionResponseDto,
} from './migration.dto';
import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminGuard } from '../admin/admin.guard';

@ApiTags('Schema Migrations')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('migrations')
export class MigrationController {
  constructor(
    private readonly runner: MigrationRunnerService,
    private readonly registry: MigrationRegistryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List registered schema migrations' })
  @ApiResponse({ status: 200, type: [MigrationDefinitionResponseDto] })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  listDefinitions() {
    return this.registry.list();
  }

  @Get('runs')
  @ApiOperation({ summary: 'List all migration runs' })
  @ApiResponse({ status: 200, type: [MigrationRunResponseDto] })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  listRuns() {
    return this.runner.findAll();
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'Get a migration run by ID, including live backfill progress' })
  @ApiParam({ name: 'runId', example: 'mig-1234567890-abcd1234' })
  @ApiResponse({ status: 200, type: MigrationRunResponseDto })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  getRun(@Param('runId') runId: string) {
    return this.runner.findById(runId);
  }

  @Post(':name/run')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Execute an expand → backfill → contract migration',
    description:
      'Runs the named migration end to end in small batches so the target table is never locked. ' +
      'If any phase fails, compensating actions automatically roll back the expand/contract changes.',
  })
  @ApiParam({ name: 'name', example: 'gigs-add-priority-column' })
  @ApiResponse({ status: 201, type: MigrationRunResponseDto })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  @ApiResponse({ status: 404, description: 'Migration not registered' })
  @ApiResponse({ status: 409, description: 'Migration already has an active run' })
  run(@Param('name') name: string, @Body() dto: RunMigrationDto) {
    return this.runner.run(name, dto);
  }

  @Post('runs/:runId/rollback')
  @ApiOperation({
    summary: 'Manually roll back a completed or failed migration run',
    description: 'Invokes the rollbackContract/rollbackExpand compensating actions on demand.',
  })
  @ApiParam({ name: 'runId', example: 'mig-1234567890-abcd1234' })
  @ApiResponse({ status: 200, type: MigrationRunResponseDto })
  @ApiResponse({ status: 400, description: 'Run already rolled back' })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  @ApiResponse({ status: 409, description: 'Run still in progress' })
  rollback(@Param('runId') runId: string) {
    return this.runner.rollback(runId);
  }

  @Post(':name/mark-applied')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark a migration as applied out-of-band',
    description:
      'Records an out-of-band schema change in the migration registry with a mandatory audit note, ' +
      'preventing the runner from attempting a redundant double-apply.',
  })
  @ApiParam({ name: 'name', example: 'gigs-add-priority-column' })
  @ApiResponse({ status: 200, type: MigrationRunResponseDto })
  @ApiResponse({ status: 400, description: 'Missing or invalid justification note' })
  @ApiResponse({ status: 403, description: 'Caller is authenticated but not an admin address' })
  @ApiResponse({ status: 404, description: 'Migration not registered' })
  @ApiResponse({ status: 409, description: 'Migration already has an active run' })
  markApplied(
    @Param('name') name: string,
    @Body() dto: MarkMigrationAppliedDto,
  ) {
    return this.runner.markApplied(name, dto);
  }
}
