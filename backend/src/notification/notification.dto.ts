import { z } from 'zod';

export const NotificationPreferenceSchema = z.object({
  emailEnabled: z.boolean().default(true),
  pushEnabled: z.boolean().default(true),
  disputeAlerts: z.boolean().default(true),
  evidenceReminders: z.boolean().default(true),
  milestoneNotifications: z.boolean().default(true),
});

export type NotificationPreferenceDto = z.infer<typeof NotificationPreferenceSchema>;

export const UpdatePreferenceSchema = z.object({
  emailEnabled: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  disputeAlerts: z.boolean().optional(),
  evidenceReminders: z.boolean().optional(),
  milestoneNotifications: z.boolean().optional(),
});

export type UpdatePreferenceDto = z.infer<typeof UpdatePreferenceSchema>;

export const SendNotificationSchema = z.object({
  recipientEmail: z.string().email(),
  recipientAddress: z.string().min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
  type: z.enum(['dispute_opened', 'evidence_required', 'dispute_resolved', 'deadline_warning']),
  escrowId: z.string().min(1),
  actionUrl: z.string().url().optional(),
});

export type SendNotificationDto = z.infer<typeof SendNotificationSchema>;
