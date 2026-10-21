const groups = [
  { id: 'dashboard', title: '经营中心', sections: ['dashboard'] },
  { id: 'reports', title: '数据报表', sections: ['reports'] },
  { id: 'workdesk', title: '服务工作台', sections: ['workdesk'] },
  { id: 'cashier', title: '收银与订单', sections: ['pos', 'shifts', 'orders', 'bills', 'group-buy', 'printing'] },
  { id: 'tables', title: '桌台管理', sections: ['tables'] },
  { id: 'members', title: '会员中心', sections: ['members', 'storage', 'wallet', 'rewards', 'coupons', 'messages'] },
  { id: 'products', title: '商品与库存', sections: ['products', 'losses'] },
  { id: 'settings', title: '系统设置', sections: ['mini-page', 'accounts', 'logs', 'settings', 'backups'] }
];

export function canAccessAdminSection(account, section) {
  if (!groups.some(group => group.sections.includes(section))) return false;
  const permission = ['bills', 'printing'].includes(section) ? 'orders' : section === 'shifts' ? 'pos' : section;
  return !!account?.permissions?.includes(permission);
}

const availableGroups = account => groups.map(group => ({ ...group, sections: group.sections.filter(section => canAccessAdminSection(account, section)) })).filter(group => group.sections.length);

export function defaultAdminSection(account) {
  const preferred = ['dashboard', 'pos', 'orders'].find(section => canAccessAdminSection(account, section));
  if (preferred) return preferred;
  const available = availableGroups(account);
  return available.find(group => group.id !== 'workdesk')?.sections[0] || available[0]?.sections[0];
}

export function workspaceHome(account, pathname) {
  if (['/staff', '/admin/staff'].includes(pathname) && canAccessAdminSection(account, 'workdesk')) return 'workdesk';
  const cashier = availableGroups(account).find(group => group.id === 'cashier')?.sections[0];
  if (['/cashier', '/admin/cashier'].includes(pathname) && cashier) return cashier;
  if (account?.workspace === 'waiter' && canAccessAdminSection(account, 'workdesk')) return 'workdesk';
  if (account?.workspace === 'cashier' && cashier) return cashier;
  return defaultAdminSection(account);
}

// Remember navigation only within this login page. Account changes and logout
// clear it, and every remembered target is checked against current permissions.
export function createAdminNavigation() {
  let accountId, lastAdminSection;
  const remembered = new Map();
  const reset = () => { accountId = undefined; lastAdminSection = undefined; remembered.clear(); };
  const sync = account => {
    if (accountId !== account?.id) { reset(); accountId = account?.id; }
  };
  return {
    reset,
    visit(account, section) {
      sync(account);
      if (!canAccessAdminSection(account, section) || section === 'workdesk') return;
      const group = groups.find(group => group.sections.includes(section));
      remembered.set(group.id, section);
      lastAdminSection = section;
    },
    groups(account, currentSection) {
      sync(account);
      return availableGroups(account).map(group => ({
        ...group,
        active: group.sections.includes(currentSection),
        target: group.sections.includes(currentSection) ? currentSection : group.sections.includes(remembered.get(group.id)) ? remembered.get(group.id) : group.sections[0]
      }));
    },
    returnSection(account) {
      sync(account);
      return canAccessAdminSection(account, lastAdminSection) ? lastAdminSection : defaultAdminSection(account);
    }
  };
}
