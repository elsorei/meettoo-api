import { z } from 'zod';

// ── Event types ──
export const eventTypeEnum = z.enum(['appointment', 'commitment', 'reminder']);
export const eventStatusEnum = z.enum(['pending', 'confirmed', 'cancelled', 'suspended', 'completed']);
export const confirmationEnum = z.enum(['pending', 'accepted', 'declined']);

// ── Create event ──
// linkedDeadline: opzionale. Se presente, dopo aver creato l'evento principale
// viene generata una scadenza correlata (commitment) datata `offsetDays` giorni
// prima, sull'agenda dello stesso owner, senza partecipanti né blocco orario.
export const linkedDeadlineSchema = z.object({
  offsetDays: z.number().int().min(0).max(365),
  title: z.string().min(1).max(500).optional(),
});

export const createEventSchema = z.object({
  type: eventTypeEnum,
  title: z.string().min(1, 'Title is required').max(500),
  description: z.string().optional(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Time must be HH:MM or HH:MM:SS').optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Time must be HH:MM or HH:MM:SS').optional(),
  hasAlarm: z.boolean().default(false),
  alarmDatetime: z.string().datetime().optional(),
  confirmationDeadline: z.string().optional(),
  participants: z.array(z.object({
    userId: z.string().uuid(),
    role: z.enum(['organizer', 'participant', 'reserve']).default('participant'),
  })).optional(),
  metadata: z.record(z.any()).optional(),
  recurrenceRule: z.string().max(500).optional(),
  forOperatorUserId: z.string().uuid().optional(), // crea evento sull'agenda di un altro operatore
  isPrivate: z.boolean().optional().default(false), // 🔒 evento privato: solo owner/partecipanti/admin lo vedono
  alarmMinutesBefore: z.number().int().min(0).max(10080).optional(), // promemoria: minuti prima dell'inizio
  linkedDeadline: linkedDeadlineSchema.nullable().optional(), // crea scadenza correlata
}).refine((data) => {
  if (data.type !== 'reminder') {
    return !!data.startTime && !!data.endTime;
  }
  return true;
}, { message: 'Appointments and commitments require startTime and endTime' })
.refine((data) => {
  if (data.startTime && data.endTime) {
    return data.startTime < data.endTime;
  }
  return true;
}, { message: 'startTime must be before endTime' });

// ── Update event ──
export const updateEventSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional().nullable(),
  hasAlarm: z.boolean().optional(),
  alarmDatetime: z.string().datetime().optional().nullable(),
  confirmationDeadline: z.string().datetime().optional().nullable(),
  metadata: z.record(z.any()).optional(),
  participants: z.array(z.object({
    userId: z.string().uuid(),
    role: z.enum(['organizer', 'participant', 'reserve']).default('participant'),
  })).optional(),
  recurrenceRule: z.string().max(500).optional().nullable(),
  isPrivate: z.boolean().optional(), // 🔒 toggle privacy per evento
  alarmMinutesBefore: z.number().int().min(0).max(10080).optional().nullable(), // promemoria: minuti prima
});

// ── Change status ──
export const changeStatusSchema = z.object({
  status: eventStatusEnum,
});

// ── Confirm participation ──
export const confirmParticipationSchema = z.object({
  confirmation: confirmationEnum,
});

// ── Convert event type ──
export const convertEventSchema = z.object({
  newType: eventTypeEnum,
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
}).refine((data) => {
  if (data.newType !== 'reminder') {
    return !!data.startTime && !!data.endTime;
  }
  return true;
}, { message: 'Converting to appointment/commitment requires startTime and endTime' });

// ── Move event (drag & drop) ──
export const moveEventSchema = z.object({
  eventDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
});

// ── List events query ──
export const listEventsQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  type: eventTypeEnum.optional(),
  status: eventStatusEnum.optional(),
  operatorId: z.string().uuid().optional(),
  clientId: z.string().uuid().optional(),
  closed: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ── Availability check query ──
export const availabilityQuerySchema = z.object({
  userId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  endTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  excludeEventId: z.string().uuid().optional(),
});

// ── Add participant ──
export const addParticipantSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['organizer', 'participant', 'reserve']).default('participant'),
});

// ── Attachments ──
// Param schema per endpoint che operano su un evento (event-level).
export const attachmentEventParamSchema = z.object({
  id: z.string().uuid(),
});

// Param schema per endpoint che operano su un singolo allegato (download/delete).
export const attachmentParamsSchema = z.object({
  id: z.string().uuid(),
  attId: z.string().uuid(),
});

// ── Types ──
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type UpdateEventInput = z.infer<typeof updateEventSchema>;
export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
