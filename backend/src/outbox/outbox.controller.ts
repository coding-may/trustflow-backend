import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody, ApiBearerAuth } from '@nestjs/swagger';
import { OutboxService } from './outbox.service';
import { OutboxEventState, OutboxEventType } from './outbox.entity';
import { CreateOutboxEventSchema } from './outbox.dto';
import { JwtAuthGuard } from '../auth/auth.guard';

@ApiTags('Outbox')
@ApiBearerAuth('JWT-auth')
@Controller()
@UseGuards(JwtAuthGuard)
export class OutboxController {
  constructor(private readonly outboxService: OutboxService) {}

  @Get('admin/outbox/events')
  @ApiOperation({
    summary: 'List all outbox events',
    description: 'Returns all outbox events, optionally filtered by state.',
  })
  @ApiResponse({ status: 200, description: 'List of outbox events' })
  async getEvents() {
    return this.outboxService.getEvents();
  }

  @Get('admin/outbox/events/:id')
  @ApiOperation({
    summary: 'Get outbox event by ID',
    description: 'Returns a single outbox event with its current state and attempt count.',
  })
  @ApiParam({ name: 'id', description: 'Outbox event ID' })
  @ApiResponse({ status: 200, description: 'Outbox event details' })
  async getEvent(@Param('id') id: string) {
    const event = await this.outboxService.getEvent(id);
    if (!event) return { error: 'Event not found' };
    return event;
  }

  @Post('admin/outbox/events')
  @ApiOperation({
    summary: 'Create outbox event',
    description: 'Creates a new outbox event for asynchronous processing.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['eventType', 'payload'],
      properties: {
        eventType: {
          type: 'string',
          enum: ['ESCROW_CREATED', 'ESCROW_RELEASED', 'DISPUTE_RAISED', 'DISPUTE_RESOLVED', 'EVIDENCE_SUBMITTED', 'MILESTONE_APPROVED'],
        },
        payload: { type: 'string', description: 'JSON string payload' },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Outbox event created' })
  async createEvent(@Body() body: typeof CreateOutboxEventSchema._type) {
    return this.outboxService.createEvent(body.eventType as OutboxEventType, body.payload);
  }

  @Post('admin/outbox/replay/:id')
  @ApiOperation({
    summary: 'Replay a dead-lettered event',
    description: 'Resets and re-processes a dead-lettered outbox event.',
  })
  @ApiParam({ name: 'id', description: 'Outbox event ID to replay' })
  @ApiResponse({ status: 200, description: 'Replay result with success status' })
  async replayEvent(@Param('id') id: string) {
    return this.outboxService.replayEvent(id);
  }

  @Post('admin/outbox/replay-all')
  @ApiOperation({
    summary: 'Replay all dead-lettered events',
    description: 'Re-processes all events currently in the dead letter queue.',
  })
  @ApiResponse({ status: 200, description: 'Breakdown of succeeded and failed replays' })
  async replayAll() {
    return this.outboxService.replayAll();
  }

  @Post('admin/outbox/cleanup')
  @ApiOperation({
    summary: 'Purge delivered outbox messages past their retention window',
    description:
      'Removes delivered events whose deliveredAt is older than the configured retention ' +
      '(measured from delivery time, not creation time). Returns the number purged.',
  })
  @ApiResponse({ status: 200, description: 'Number of events purged' })
  async cleanup() {
    const purged = await this.outboxService.purgeDeliveredOutboxMessages();
    return { purged };
  }
}
