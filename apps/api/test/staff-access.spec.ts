import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import type { Role } from '@gma/contracts';
import { BackupsController } from '../src/backups/backups.controller';
import { StaffController } from '../src/staff/staff.controller';
import { SuperadminController } from '../src/superadmin/superadmin.controller';
import { RolesGuard } from '../src/auth/roles.guard';
import { SessionAuthGuard } from '../src/auth/session-auth.guard';

function contextFor(role: Role): ExecutionContext {
  const request = { principal: { role } };
  return {
    getHandler: () => StaffController.prototype.create,
    getClass: () => StaffController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('staff access authorization', () => {
  const guard = new RolesGuard(new Reflector());

  it.each(['owner', 'admin'] as const)('%s can access staff operations', (role) => {
    expect(guard.canActivate(contextFor(role))).toBe(true);
  });

  it('cashiers cannot access staff operations', () => {
    expect(() => guard.canActivate(contextFor('cashier'))).toThrow('You do not have access to this action');
  });

  it.each(['owner', 'admin', 'cashier'] as const)('%s cannot access superadmin operations', (role) => {
    const context = {
      getHandler: () => SuperadminController.prototype.listStores,
      getClass: () => SuperadminController,
      switchToHttp: () => ({ getRequest: () => ({ principal: { role } }) }),
    } as unknown as ExecutionContext;
    expect(() => guard.canActivate(context)).toThrow('You do not have access to this action');
  });

  it('allows superadmins to access superadmin operations', () => {
    const context = {
      getHandler: () => SuperadminController.prototype.listStores,
      getClass: () => SuperadminController,
      switchToHttp: () => ({ getRequest: () => ({ principal: { role: 'superadmin' } }) }),
    } as unknown as ExecutionContext;
    expect(guard.canActivate(context)).toBe(true);
  });

  it.each([BackupsController, StaffController, SuperadminController])('runs session authentication before role authorization for %p', (controller) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([SessionAuthGuard, RolesGuard]);
  });
});
