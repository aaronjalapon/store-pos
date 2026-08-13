import { SetMetadata } from '@nestjs/common';
import type { Role } from '@gma/contracts';

export const ROLE_METADATA_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLE_METADATA_KEY, roles);
