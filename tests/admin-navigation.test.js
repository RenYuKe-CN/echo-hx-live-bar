import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessAdminSection, createAdminNavigation, workspaceHome } from '../src/admin-navigation.js';

const account = (permissions, extra = {}) => ({ id: 1, workspace: 'admin', permissions, ...extra });
const target = (navigation, user, id) => navigation.groups(user).find(group => group.id === id)?.target;

test('combined service and cashier permissions lead directly to separate work areas', () => {
  const navigation = createAdminNavigation(), user = account(['workdesk', 'orders', 'pos']);
  assert.equal(target(navigation, user, 'workdesk'), 'workdesk');
  assert.equal(target(navigation, user, 'cashier'), 'pos');
  assert.deepEqual(navigation.groups(user).find(group => group.id === 'cashier').sections, ['pos', 'shifts', 'orders', 'bills', 'printing']);
  assert.equal(workspaceHome(user, '/admin'), 'pos');
});

test('restricted accounts see only their granted work areas and valid landing pages', () => {
  const navigation = createAdminNavigation();
  assert.deepEqual(navigation.groups(account(['workdesk'])).map(group => group.id), ['workdesk']);
  assert.equal(target(navigation, account(['orders']), 'cashier'), 'orders');
  assert.equal(target(navigation, account(['group-buy']), 'cashier'), 'group-buy');
  assert.equal(target(navigation, account(['pos']), 'workdesk'), undefined);
  const user = account(['orders', 'refunds']);
  assert.equal(canAccessAdminSection(user, 'refunds'), false);
  assert.equal(canAccessAdminSection(user, 'printing'), true);
  assert.equal(canAccessAdminSection(user, 'workdesk'), false);
  assert.equal(canAccessAdminSection(user, 'shifts'), false);
});

test('switching groups remembers the last section and returning from service restores the previous admin page', () => {
  const navigation = createAdminNavigation(), user = account(['dashboard', 'workdesk', 'pos', 'orders', 'products']);
  navigation.visit(user, 'orders');navigation.visit(user, 'workdesk');
  assert.equal(navigation.returnSection(user), 'orders');
  navigation.visit(user, 'products');
  assert.equal(target(navigation, user, 'cashier'), 'orders');
  assert.equal(navigation.returnSection(user), 'products');
  assert.equal(navigation.groups(user, 'pos').find(group => group.id === 'cashier').target, 'pos');
});

test('remembered pages cannot cross accounts, logout or revoked permissions', () => {
  const navigation = createAdminNavigation(), user = account(['dashboard', 'workdesk', 'pos', 'orders']);
  navigation.visit(user, 'orders');
  const restricted = { ...user, permissions: ['workdesk', 'pos'] };
  assert.equal(navigation.returnSection(restricted), 'pos');
  assert.equal(target(navigation, restricted, 'cashier'), 'pos');
  assert.equal(target(navigation, { ...user, id: 2 }, 'cashier'), 'pos');
  navigation.visit(user, 'orders');navigation.reset();
  assert.equal(target(navigation, user, 'cashier'), 'pos');
  assert.equal(navigation.returnSection(user), 'dashboard');
});

test('explicit work area links and configured login defaults retain their permission checks', () => {
  const user = account(['dashboard', 'workdesk', 'pos', 'orders']);
  assert.equal(workspaceHome(user, '/admin/staff'), 'workdesk');
  assert.equal(workspaceHome(user, '/admin/cashier'), 'pos');
  assert.equal(workspaceHome({ ...user, workspace: 'waiter' }, '/admin'), 'workdesk');
  assert.equal(workspaceHome({ ...user, workspace: 'cashier' }, '/admin'), 'pos');
  assert.equal(workspaceHome(user, '/admin'), 'dashboard');
  assert.equal(workspaceHome(account(['orders']), '/admin/cashier'), 'orders');
  assert.equal(workspaceHome(account(['reports'], { workspace: 'waiter' }), '/admin/staff'), 'reports');
});
