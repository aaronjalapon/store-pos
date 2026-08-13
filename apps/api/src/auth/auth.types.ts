import type { Role } from '@gma/contracts';

export interface SessionPrincipal {
  userId: string;
  storeId: string;
  deviceId: string;
  role: Role;
  displayName: string;
  email: string | null;
  staffCode: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: SessionPrincipal;
  }
}
